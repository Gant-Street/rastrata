/** A hand-run audit of the application's words: start the API and the web server in a block of ports of
 * your own, seed a book through the real API, open every route at 1440x800 and 390x844 in both themes,
 * write each page's visible text and a screenshot, and list what should not be on a page: a
 * year-month-day date, a 64-character hash, a retired word (the vocabulary is in
 * packages/ui/unit/vocabulary.ts).
 *
 *   RASTRATA_PORT_OFFSET=2200 bun apps/web/tooling/audit-words.ts [--out /tmp/words] [--reuse] [--text]
 *
 *   --out DIR   where the text, the screenshots and findings.txt go (default /tmp/rastrata-words)
 *   --reuse     crawl the book already in DIR/book.sqlite instead of seeding a new one
 *   --empty     crawl before there is a book at all (the first run), with nothing seeded
 *   --text      write the text only, no screenshots
 *
 * Read the .txt files: they are what each screen says, in order. The screenshots are for looking at; they
 * are not kept in the repository. */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const option = (name: string, fallback: string): string => {
  const at = args.indexOf(name);
  return at >= 0 ? (args[at + 1] ?? fallback) : fallback;
};

const offset = Number(process.env.RASTRATA_PORT_OFFSET ?? "");
if (!Number.isInteger(offset) || offset <= 0 || offset % 100 !== 0)
  throw new Error("Set RASTRATA_PORT_OFFSET to your own block (a multiple of 100, not 0).");
const apiPort = 4010 + offset;
const webPort = 4000 + offset;
const out = resolve(option("--out", "/tmp/rastrata-words"));
const database = join(out, "book.sqlite");
const reuse = flag("--reuse");
const empty = flag("--empty");
const textOnly = flag("--text");

mkdirSync(out, { recursive: true });
if (!reuse) for (const suffix of ["", "-wal", "-shm"]) rmSync(database + suffix, { force: true });

const children: ChildProcess[] = [];
function start(command: string, commandArgs: string[], env: Record<string, string>): void {
  children.push(
    spawn(command, commandArgs, { cwd: root, env: { ...process.env, ...env }, stdio: "ignore" }),
  );
}
const stopAll = (): void => {
  for (const child of children) child.kill("SIGTERM");
};
process.on("exit", stopAll);
process.on("SIGINT", () => {
  stopAll();
  process.exit(1);
});

async function waitFor(url: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(500);
  }
  throw new Error(`${url} did not come up`);
}

start("bun", ["../api/src/main.ts"], {
  RASTRATA_LOCAL_DEV: "1",
  RASTRATA_API_PORT: String(apiPort),
  RASTRATA_LOCAL_DB: database,
  RASTRATA_BACKUPS: "off",
  TZ: "UTC",
});
await waitFor(`http://127.0.0.1:${apiPort}/health`);
start("bun", ["tooling/dev.ts"], {
  PORT: String(webPort),
  RASTRATA_LOCAL_DEV: "1",
  RASTRATA_API_URL: `http://127.0.0.1:${apiPort}`,
  RASTRATA_LOCAL_DB: database,
  TZ: "UTC",
});
await waitFor(`http://127.0.0.1:${webPort}/`);

type Json = Record<string, unknown>;
async function call(name: string, input: unknown): Promise<Json> {
  const response = await fetch(`http://127.0.0.1:${apiPort}/v1/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: "rastrata-application-v1",
      bookId: "local-book",
      input,
      operationId: crypto.randomUUID(),
    }),
  });
  const body = (await response.json()) as { ok: boolean; data?: Json; error?: unknown };
  if (!body.ok || !body.data) throw new Error(`${name}: ${JSON.stringify(body.error)}`);
  return body.data;
}

async function post(date: string, narration: string, lines: [string, string, string][]) {
  const draft = await call("drafts.create", {
    data: {
      date,
      reference: narration.slice(0, 40),
      narration,
      lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit, credit })),
    },
  });
  const plan = await call("journal.prepare", { draftId: draft.id, expectedVersion: 1 });
  await call("operations.commit", { planId: plan.planId, planHash: plan.planHash });
}

async function seed(): Promise<void> {
  await call("book.setup", {
    name: "Willow Lane Studio",
    currency: "USD",
    fiscalYear: 2026,
    fiscalYearStartMonth: 1,
    basis: "cash",
    periodModel: "monthly",
    accounts: [
      { code: "1000", name: "Business checking", role: "asset", tags: { cashFlowClass: "cash" } },
      { code: "1100", name: "Business savings", role: "asset", tags: { cashFlowClass: "cash" } },
      {
        code: "2000",
        name: "Business credit card",
        role: "liability",
        tags: { cashFlowClass: "operating" },
      },
      {
        code: "3000",
        name: "Owner's equity",
        role: "equity",
        tags: { cashFlowClass: "financing" },
      },
      { code: "3100", name: "Owner's draw", role: "equity", tags: { cashFlowClass: "financing" } },
      { code: "4000", name: "Sales", role: "income", tags: { taxLine: "scheduleC.line1" } },
      { code: "6120", name: "Rent", role: "expense", tags: { taxLine: "scheduleC.line20b" } },
      { code: "6140", name: "Supplies", role: "expense", tags: { taxLine: "scheduleC.line22" } },
      { code: "6170", name: "Meals", role: "expense", tags: { taxLine: "scheduleC.line24b" } },
      {
        code: "6200",
        name: "Software and subscriptions",
        role: "expense",
        tags: { taxLine: "scheduleC.line18" },
      },
      { code: "6210", name: "Bank fees", role: "expense", tags: { taxLine: "scheduleC.line27b" } },
    ],
  });
  const attempt = async (label: string, work: () => Promise<unknown>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      console.log(`${label} skipped: ${String(error).slice(0, 160)}`);
    }
  };
  // A recorded start date and a posted opening entry: pages that only exist in such a book are read too.
  await attempt("a start date and an opening entry", async () => {
    await call("cutover.set", { cutoverDate: "2026-01-01" });
    const planned = await call("opening.plan", {
      cutoverDate: "2026-01-01",
      balances: [{ accountId: "1100", balance: "2500.00" }],
      offsetAccountId: "3000",
    });
    const plan = planned.plan as { planId: string; planHash: string };
    await call("operations.commit", { planId: plan.planId, planHash: plan.planHash });
  });
  await post("2026-01-02", "Owner contribution", [
    ["1000", "20000.00", ""],
    ["3000", "", "20000.00"],
  ]);
  await post("2026-01-05", "Opening savings transfer", [
    ["1100", "6000.00", ""],
    ["1000", "", "6000.00"],
  ]);
  await post("2026-02-10", "Design work for Northwind", [
    ["1000", "1800.00", ""],
    ["4000", "", "1800.00"],
  ]);
  await post("2026-02-14", "Coworking rent", [
    ["6120", "300.00", ""],
    ["1000", "", "300.00"],
  ]);
  await post("2026-02-20", "Office supplies", [
    ["6140", "86.40", ""],
    ["2000", "", "86.40"],
  ]);
  await post("2026-03-03", "March design fees", [
    ["1000", "2400.00", ""],
    ["4000", "", "2400.00"],
  ]);
  await post("2026-03-09", "Software subscription", [
    ["6200", "49.00", ""],
    ["1000", "", "49.00"],
  ]);

  const march: [string, string, string][] = [
    ["2026-03-02", "-44.00", "GITHUB INC SAN FRANCISCO CA"],
    ["2026-03-04", "498.75", "STRIPE TRANSFER ST-7E69"],
    ["2026-03-05", "-19.00", "LINEAR ORBIT"],
    ["2026-03-06", "-18.45", "CHIPOTLE 1234 AUSTIN TX"],
    ["2026-03-09", "-112.00", "UNKNOWN MERCHANT 4821"],
    ["2026-03-10", "-4.85", "STARBUCKS #04412 AUSTIN TX"],
    ["2026-03-12", "-15.00", "MONTHLY SERVICE FEE"],
    ["2026-03-16", "921.37", "STRIPE TRANSFER ST-7E58"],
    ["2026-03-18", "-48.76", "PERSONAL GROCERY MARKET"],
    ["2026-03-20", "-29.00", "NOTION LABS INC"],
    ["2026-03-25", "1350.00", "ACH CREDIT NORTHWIND LLC INV 2231"],
    ["2026-03-26", "-600.00", "CHECK 1041"],
  ];
  let balance = 2_000_000n;
  const cents = (amount: string): bigint => BigInt(amount.replace(".", ""));
  const text = (value: bigint): string => {
    const absolute = value < 0n ? -value : value;
    return `${value < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
  };
  const rows = march.map(([date, amount, memo]) => {
    balance += cents(amount);
    const [year, month, day] = date.split("-");
    return `${cents(amount) < 0n ? "DEBIT" : "CREDIT"},${month}/${day}/${year},"${memo}",${amount},ACH_DEBIT,${text(balance)},,`;
  });
  const csv = `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\n${rows.reverse().join("\n")}\n`;
  const upload = await fetch(`http://127.0.0.1:${apiPort}/v1/uploads`, {
    method: "POST",
    headers: { "content-type": "text/csv", "x-upload-name": "chase-march.csv" },
    body: csv,
  });
  const sha256 = ((await upload.json()) as { data: { sha256: string } }).data.sha256;
  const preview = await call("import.preview", { sha256, ledgerAccountId: "1000" });
  const detection = preview.detection as { preset?: { id: string } } | undefined;
  await call("import.commit", {
    sha256,
    ledgerAccountId: "1000",
    ...(detection?.preset ? { presetId: detection.preset.id } : {}),
  });
  const rule = (name: string, value: string, accountId: string) =>
    call("rules.create", {
      rule: {
        name,
        conditions: [{ field: "description", operator: "contains", value }],
        action: { kind: "categorize", accountId },
      },
    });
  await rule("Stripe transfers", "STRIPE TRANSFER", "4000");
  await rule("GitHub", "GITHUB", "6200");
  await rule("Bank service fee", "MONTHLY SERVICE FEE", "6210");
  await attempt("accept and post", async () => {
    const list = await call("inbox.list", {
      filter: { status: ["new", "proposed"] },
      pageSize: 50,
    });
    const items = (list.items ?? []) as { id: string; proposals?: unknown[] }[];
    const ready = items.filter((item) => (item.proposals?.length ?? 0) > 0).slice(0, 3);
    if (ready.length === 0) return;
    await call("inbox.accept", { itemIds: ready.map((item) => item.id) });
    await call("inbox.post", { itemIds: ready.map((item) => item.id) });
  });
  await attempt("a reconciliation draft", () =>
    call("reconcile.start", {
      accountId: "1100",
      statementDate: "2026-03-31",
      statementBalance: "6000.00",
    }),
  );
  await attempt("a token", () =>
    call("tokens.create", {
      label: "Claude Code",
      permissions: ["read", "draft"],
      expiresInDays: 30,
    }),
  );
  await attempt("a backup", () => call("backup.create", {}));
}

if (!reuse && !empty) await seed();

const routes = [
  "/",
  "/inbox",
  "/import",
  "/rules",
  "/rules/new",
  "/reconcile",
  "/journal",
  "/journal/new",
  "/accounts",
  "/periods",
  "/reports",
  "/reports?tab=balance-sheet",
  "/reports?tab=cash-flow",
  "/reports?tab=trial-balance",
  "/reports?tab=general-ledger",
  "/ledger",
  "/tax",
  "/opening",
  "/xero",
  "/tie-out",
  "/gaps",
  "/settings",
  "/settings/connections",
  "/settings/move",
  "/settings/stripe",
  "/settings/bankfeed",
  "/settings/backups",
  "/settings/agent",
  "/not-a-page",
];
// Detail pages need ids the book itself gave out.
const first = async (name: string, input: unknown, key: string): Promise<string[]> => {
  try {
    const list = await call(name, input);
    return ((list[key] ?? []) as { id: string }[]).slice(0, 2).map((item) => item.id);
  } catch {
    return [];
  }
};
if (!empty) {
  for (const id of await first("journal.list", { status: "Posted" }, "entries"))
    routes.push(`/journal/${encodeURIComponent(id)}`);
  for (const id of await first("reconcile.list", {}, "items")) routes.push(`/reconcile/${id}`);
  for (const id of await first("rules.list", {}, "rules")) routes.push(`/rules/${id}`);
}

const browser = await chromium.launch();
const sizes = [
  { name: "1440x800", width: 1440, height: 800 },
  { name: "390x844", width: 390, height: 844 },
] as const;
const themes = ["light", "dark"] as const;
const date = /\b\d{4}-\d{2}-\d{2}\b/;
const hash = /\b[0-9a-f]{64}\b/i;
const retired =
  /\binbox\b|\bnarration\b|\bcutover\b|\bgap log\b|\bagent access\b|\bbank feed\b|\bsource (event|id)\b|\bpopulation\b|\bfingerprint\b|\bbook revision\b|\bJournal\b(?! entr)|\bfiscal periods\b/i;

// The machine detail a page keeps under Details is allowed: the line beside the closed disclosure ("Book revision 9
// · fingerprint 4b64ad94…") and the names of its Copy buttons.
const underDetails =
  /^Book revision \d+ · fingerprint [0-9a-f]+…?$|^Copy (fingerprint|population|revision|plan|manifest|source event|book revision)\b/i;

const findings = new Set<string>();
// Where the old sense of "line" (a bank's transaction) is still said: information for a person reading the text
// files, since a line is right for an entry, a tax form and a command.
const lineSaid = /\blines?\b/i;
const linesSeen = new Set<string>();
for (const size of sizes)
  for (const theme of themes) {
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      timezoneId: "UTC",
      locale: "en-US",
      colorScheme: theme,
    });
    const page = await context.newPage();
    for (const route of routes) {
      await page
        .goto(`http://127.0.0.1:${webPort}${route}`, { waitUntil: "networkidle" })
        .catch(() => {});
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await page.waitForTimeout(300);
      const slug = `${route.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home"}-${size.name}-${theme}`;
      const text = await page.evaluate(() => document.body.innerText);
      writeFileSync(join(out, `${slug}.txt`), text);
      if (!textOnly) await page.screenshot({ path: join(out, `${slug}.png`), fullPage: true });
      if (size.name !== "1440x800" || theme !== "light") continue;
      for (const line of text.split("\n")) {
        if (date.test(line)) findings.add(`${route}: date: ${line.trim().slice(0, 160)}`);
        if (hash.test(line)) findings.add(`${route}: hash: ${line.trim().slice(0, 100)}`);
        if (retired.test(line) && !underDetails.test(line.trim()))
          findings.add(`${route}: retired word: ${line.trim().slice(0, 160)}`);
        if (lineSaid.test(line)) linesSeen.add(`${route}: line: ${line.trim().slice(0, 160)}`);
      }
      const names = await page.evaluate(() =>
        [...document.querySelectorAll("[aria-label],[placeholder]")].map(
          (element) =>
            `${element.getAttribute("aria-label") ?? ""} | ${element.getAttribute("placeholder") ?? ""}`,
        ),
      );
      for (const name of names)
        if (
          date.test(name) ||
          (retired.test(name) && !underDetails.test(name.split(" | ")[0] ?? ""))
        )
          findings.add(`${route}: name: ${name.slice(0, 160)}`);
    }
    await context.close();
  }
await browser.close();
writeFileSync(join(out, "findings.txt"), `${[...findings].join("\n")}\n`);
writeFileSync(join(out, "lines.txt"), `${[...linesSeen].join("\n")}\n`);
console.log(
  `${findings.size} findings (and ${linesSeen.size} lines that say line); the text and screenshots are in ${out}`,
);
stopAll();
process.exit(0);
