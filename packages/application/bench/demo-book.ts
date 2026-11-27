/** A sample book for screenshots, recordings and demos: a fictional one-person design studio, September
 * 2026, built through the application's own HTTP boundary (the same calls a client makes), so what it
 * shows is the product and not a drawing of it. Everything in it is invented: the names, the memos,
 * the amounts, the owner. Stripe is the test stand-in, with its story moved to September and its
 * identifiers made to look like Stripe's.
 *
 *   bun packages/application/bench/demo-book.ts --out DIR [--phase worked|inbox|agent|august|closing]
 *
 * The phases build on one another and each is a complete book in `DIR/<phase>.sqlite`:
 *   worked   September booked and reconciled: bank files imported, rules at work, Stripe's payouts posted;
 *   inbox    and the first days of October waiting in For review, rules already suggesting;
 *   agent    and three drafts from an agent holding a draft-only token, waiting for the owner.
 * Two more are not among them, and are for a recording of an agent closing the month:
 *   august   the same studio before September's files are imported (opening balances, Stripe synced, the usual
 *            vendors as rules, a backup that was checked and tried, and accepting a suggestion set to save a
 *            draft), with the three bank files beside the book in `DIR/files`: the book the agent is given;
 *   closing  the same studio after the agent: September posted, and the three reconciliations started with
 *            every line selected and a difference of 0.00, for the owner to finish.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ApplicationHttp } from "../src/http.ts";
import { LocalBookService } from "../src/local.ts";
import { configureSafety } from "../src/safety/jobs.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../src/schema.ts";
import { useClock } from "../src/slices/statements/ports.ts";
import { configureStripeRuntime } from "../src/slices/stripe/runtime.ts";
import { WRITE_OPERATIONS } from "../src/client-contracts.gen.ts";
import { fakeStripe } from "../test/stripe/fake-stripe.ts";
import { buildScenario, fakeKey, type Scenario } from "../test/stripe/fixtures.ts";
// biome-ignore lint/suspicious/noExplicitAny: answers are read as loose JSON, the way the tests read them.
type Json = any;

const args = process.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const out = resolve(option("out") ?? "dist/demo-book");
const phase = (option("phase") ?? "agent") as "worked" | "inbox" | "agent" | "august" | "closing";
// The studio has had months to teach its rules the usual vendors, in the book the agent is given and in the one it leaves.
const taught = phase === "august" || phase === "closing";
// Each run builds in a folder of its own that it clears first, and leaves only the finished book beside it.
const work = join(out, "work");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// ----- exact money ---------------------------------------------------------------------------------

const cents = (text: string): bigint => {
  const match = /^(-?)(\d+)\.(\d{2})$/.exec(text);
  if (!match) throw new Error(`Not exact money: ${text}`);
  const value = BigInt(match[2] as string) * 100n + BigInt(match[3] as string);
  return match[1] === "-" ? -value : value;
};
const dec = (value: bigint): string => {
  const magnitude = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}`;
};

// ----- the clock and Stripe: September, then October ------------------------------------------------

/** Stripe's test story is written for March 2026; every time in it moves forward by this many days. */
const SHIFT_DAYS = 184;
const shifted = (scenario: Scenario): Scenario => {
  const delta = SHIFT_DAYS * 86_400;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]));
    return typeof value === "number" && value > 1.7e9 && value < 1.95e9 ? value + delta : value;
  };
  return walk(scenario) as Scenario;
};

/** The test story includes a payout that failed, to test that case. A sample book is of an ordinary month,
 * so the failed payout and its reversal are left out, and what it was to carry is simply not paid out yet. */
const withoutFailedPayouts = (scenario: Scenario): Scenario => {
  const failed = new Set(
    (scenario.payouts as Json[]).filter((p) => p.status === "failed").map((p) => p.id),
  );
  return {
    ...scenario,
    payouts: (scenario.payouts as Json[]).filter((p) => !failed.has(p.id)),
    entries: (scenario.entries as Json[])
      .filter(
        (entry) =>
          !(failed.has(entry.bt.source) && ["payout", "payout_failure"].includes(entry.bt.type)),
      )
      .map((entry) => (failed.has(entry.payout) ? { ...entry, payout: null } : entry)),
  } as Scenario;
};

/** The test story's identifiers say what they are ("po_1Fixture00000000000107"). A sample book is shown to
 * people, so each becomes one of the shape Stripe's own take: the same prefix, then letters and digits, and
 * the same every run. Every place an identifier appears changes with it, so the story still holds. */
const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const lookalike = (id: string): string => {
  const digest = new Bun.CryptoHasher("sha256").update(`sample book ${id}`).digest();
  let body = "";
  for (let at = 0; at < 16; at++) body += ID_ALPHABET[(digest[at] as number) % ID_ALPHABET.length];
  return `${id.slice(0, id.indexOf("_1Fixture"))}_1${body}`;
};
const withLookalikeIds = (scenario: Scenario): Scenario => {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string")
      return value.replace(/\b[a-z]+(?:_[a-z]+)*_1Fixture[A-Za-z]*\d+\b/g, lookalike);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]));
    return value;
  };
  return walk(scenario) as Scenario;
};

const clock = { ms: Date.UTC(2026, 9, 2, 16, 0, 0) }; // Friday 2 October 2026, 10:00 in Denver
const now = () => new Date(clock.ms);
const scenario = withLookalikeIds(withoutFailedPayouts(shifted(buildScenario())));
const KEY = fakeKey("DEMO");
const stripe = fakeStripe(scenario, { key: KEY, now: () => Math.floor(clock.ms / 1000) });

const book = join(work, "book.sqlite");
const service = await LocalBookService.open(book, { now });
useClock(service, now);
configureSafety(service, { waitMs: 60_000 });
configureStripeRuntime(service, {
  keySource: { read: () => ({ key: KEY, source: "environment" }) },
  fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
    stripe.fetch(input, init)) as typeof fetch,
  now: () => now().toISOString(),
  sleep: async () => {},
  random: () => 0.5,
});
const http = new ApplicationHttp(
  service,
  { bookId: service.bookId, permissions: BUSINESS_PERMISSIONS },
  { clock: now },
);
const WRITES: ReadonlySet<string> = new Set(WRITE_OPERATIONS);

async function call(name: string, input: unknown = {}, credential?: string) {
  const operationId = WRITES.has(name) ? crypto.randomUUID() : undefined;
  const response = await http.fetch(
    new Request(`http://127.0.0.1:4010/v1/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: "local-book",
        input,
        ...(operationId ? { operationId } : {}),
      }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Json };
}
async function ok(name: string, input: unknown = {}, credential?: string): Promise<Json> {
  const reply = await call(name, input, credential);
  if (reply.status !== 200 || reply.body.ok !== true)
    throw new Error(
      `${name} answered ${reply.status}: ${JSON.stringify(reply.body.error ?? reply.body).slice(0, 600)}`,
    );
  return reply.body.data;
}
async function upload(text: string, name: string): Promise<string> {
  const response = await http.fetch(
    new Request("http://127.0.0.1:4010/v1/uploads", {
      method: "POST",
      headers: { "content-type": "text/csv", "x-upload-name": encodeURIComponent(name) },
      body: new TextEncoder().encode(text),
    }),
  );
  const body = (await response.json()) as Json;
  if (response.status !== 200)
    throw new Error(`upload ${name}: ${JSON.stringify(body).slice(0, 300)}`);
  return body.data.sha256 as string;
}
const log = (message: string) => console.log(`  ${message}`);

// ----- the statements ------------------------------------------------------------------------------

type Line = readonly [date: string, amount: string, memo: string, type?: string];
const mdy = (date: string) => `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`;
const csvCell = (cell: string) => (/[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);

/** The bank's own export: newest first, month/day/year, debits negative, a running balance. */
function bankCsv(lines: readonly Line[], opening: bigint): string {
  let balance = opening;
  const rows = lines.map(([date, amount, memo, type]) => {
    balance += cents(amount);
    return [
      cents(amount) < 0n ? "DEBIT" : "CREDIT",
      mdy(date),
      memo,
      amount,
      type ?? "MISC",
      dec(balance),
      "",
      "",
    ]
      .map(csvCell)
      .join(",");
  });
  return [
    "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #",
    ...rows.reverse(),
  ].join("\n");
}
/** The card issuer's export: three columns, charges positive, payments negative. */
function cardCsv(lines: readonly Line[]): string {
  const rows = lines.map(([date, amount, memo]) =>
    [mdy(date), memo, dec(-cents(amount))].map(csvCell).join(","),
  );
  return ["Date,Description,Amount", ...rows].join("\n");
}

const OPENING = { checking: "14820.55", savings: "6000.00", card: "842.17" } as const;

// September, checking. The Stripe transfers are added from the payouts themselves, so they match to the cent.
const SEPTEMBER: Line[] = [
  ["2026-09-01", "-750.00", "RENT ACH FERNWORKS COWORKING", "ACH_DEBIT"],
  ["2026-09-02", "2400.00", "ACH CREDIT HARBOR & WREN LLC INV 1042", "ACH_CREDIT"],
  ["2026-09-03", "-49.00", "SPOOLBASE HOSTING 877-555-0142 OR", "DEBIT_CARD"],
  ["2026-09-03", "-12.00", "FIELDNOTE APP", "DEBIT_CARD"],
  ["2026-09-04", "-54.99", "PIXELLEAF STUDIO SUITE", "DEBIT_CARD"],
  ["2026-09-05", "-128.40", "PAPERWORKS SUPPLY CO PORTLAND OR", "DEBIT_CARD"],
  ["2026-09-07", "-23.18", "COBALT COFFEE ROASTERS PORTLAND OR", "DEBIT_CARD"],
  ["2026-09-09", "1350.00", "ACH CREDIT LINDEN SCHOOL PTA INV 1043", "ACH_CREDIT"],
  ["2026-09-10", "-86.00", "PARCELWAY SHIPPING 8005550111", "DEBIT_CARD"],
  ["2026-09-11", "-312.00", "HEARTHSTONE INSURANCE PREMIUM", "ACH_DEBIT"],
  ["2026-09-12", "-15.00", "MONTHLY SERVICE FEE", "FEE_TRANSACTION"],
  ["2026-09-14", "-64.50", "MARSH EQUIPMENT RENTAL PORTLAND OR", "DEBIT_CARD"],
  ["2026-09-15", "-1500.00", "ZELLE PAYMENT TO JAMIE WILLOW", "QUICKPAY_DEBIT"],
  ["2026-09-16", "3100.00", "ACH CREDIT NORTHFIELD DENTAL INV 1044", "ACH_CREDIT"],
  ["2026-09-17", "-200.00", "ONLINE TRANSFER TO SAVINGS ...4471", "ACCT_XFER"],
  ["2026-09-18", "-39.99", "KERNING CO FONT LICENSE", "DEBIT_CARD"],
  ["2026-09-19", "-178.50", "FERN & FOX PRINTING PORTLAND OR", "DEBIT_CARD"],
  ["2026-09-21", "-61.20", "LAKESHORE UTILITIES", "ACH_DEBIT"],
  ["2026-09-23", "950.00", "MOBILE DEPOSIT", "CHECK_DEPOSIT"],
  ["2026-09-24", "-420.00", "ADVERTISING *GLEAMLY ADS", "DEBIT_CARD"],
  ["2026-09-26", "-240.00", "PAYMENT TO BUSINESS CREDIT CARD", "ACCT_XFER"],
  ["2026-09-28", "-35.00", "STATE BUSINESS LICENSE RENEWAL OR", "DEBIT_CARD"],
];
const SEPTEMBER_CARD: Line[] = [
  ["2026-09-06", "-31.45", "PARKSIDE DINER PORTLAND OR"],
  ["2026-09-08", "-89.99", "GRIDLOCK CLOUD SERVICES"],
  ["2026-09-13", "-122.00", "BRIGHTWAY OFFICE SUPPLY"],
  ["2026-09-20", "-47.60", "COBALT COFFEE ROASTERS PORTLAND OR"],
  ["2026-09-26", "240.00", "PAYMENT THANK YOU"],
];
const SAVINGS: Line[] = [
  ["2026-09-17", "200.00", "ONLINE TRANSFER FROM CHECKING ...3320", "ACCT_XFER"],
  ["2026-09-30", "4.82", "INTEREST PAYMENT", "INTEREST"],
];
const OCTOBER_CARD: Line[] = [
  ["2026-10-02", "-64.00", "GRIDLOCK CLOUD SERVICES"],
  ["2026-10-04", "-38.20", "PARKSIDE DINER PORTLAND OR"],
  ["2026-10-07", "-141.75", "BRIGHTWAY OFFICE SUPPLY"],
];
const OCTOBER: Line[] = [
  ["2026-10-01", "-750.00", "RENT ACH FERNWORKS COWORKING", "ACH_DEBIT"],
  ["2026-10-01", "-49.00", "SPOOLBASE HOSTING 877-555-0142 OR", "DEBIT_CARD"],
  ["2026-10-02", "2850.00", "ACH CREDIT HARBOR & WREN LLC INV 1045", "ACH_CREDIT"],
  ["2026-10-02", "-12.00", "FIELDNOTE APP", "DEBIT_CARD"],
  ["2026-10-03", "-54.99", "PIXELLEAF STUDIO SUITE", "DEBIT_CARD"],
  ["2026-10-05", "-312.40", "PAPERWORKS SUPPLY CO PORTLAND OR", "DEBIT_CARD"],
  ["2026-10-06", "-19.60", "COBALT COFFEE ROASTERS PORTLAND OR", "DEBIT_CARD"],
  ["2026-10-06", "-420.00", "ADVERTISING *GLEAMLY ADS", "DEBIT_CARD"],
  ["2026-10-07", "-72.25", "PARCELWAY SHIPPING 8005550111", "DEBIT_CARD"],
  ["2026-10-08", "-312.00", "HEARTHSTONE INSURANCE PREMIUM", "ACH_DEBIT"],
  ["2026-10-08", "-15.00", "MONTHLY SERVICE FEE", "FEE_TRANSACTION"],
  ["2026-10-09", "-24.90", "LEMONGRASS THAI PORTLAND OR", "DEBIT_CARD"],
];

console.log(`Building the sample book (${phase}) in ${out}`);

// ----- 1. the book ---------------------------------------------------------------------------------

const template = await ok("templates.get", {
  templateId: "sole-proprietor",
  basis: "cash",
  taxYear: 2026,
  addOns: ["online-business"],
});
// Stripe sometimes moves money that is not a sale, a fee or a refund (an adjustment, a reserve). The studio
// has an account for it, so such a movement is proposed like any other line instead of waiting for a choice.
// A template carries no bank or card account (since 2026-11-05 an account is made from what a person brings),
// so the studio brings its own three, named as its bank names them.
const accounts = [
  {
    code: "1000",
    name: "Business checking",
    role: "asset",
    tags: { cashFlowClass: "cash", kind: "bank" },
  },
  {
    code: "1010",
    name: "Business savings",
    role: "asset",
    tags: { cashFlowClass: "cash", kind: "bank" },
  },
  {
    code: "2000",
    name: "Business credit card",
    role: "liability",
    tags: { cashFlowClass: "operating", kind: "card" },
  },
  ...template.accounts,
  {
    code: "6027",
    name: "Stripe adjustments",
    role: "expense",
    tags: { taxLine: "scheduleC.line27b", roleKey: "stripe.adjustments" },
  },
];
await ok("book.setup", {
  name: "Willow Lane Studio",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  basis: "cash",
  accounts: accounts.map((a: Json) => ({
    code: a.code,
    name: a.name,
    role: a.role,
    ...(a.parentCode ? { parentCode: a.parentCode } : {}),
    tags: a.tags,
  })),
});
// The studio's owner wants to look before anything posts, so in the book an agent is given accepting a suggestion saves a draft.
if (phase === "august") await ok("book.update", { acceptMode: "draft" });
const accountIds = ["1000", "1010", "2000"];
await ok("cutover.set", { cutoverDate: "2026-09-01", accountIds });
const balances = [
  { accountId: "1000", balance: OPENING.checking },
  { accountId: "1010", balance: OPENING.savings },
  { accountId: "2000", balance: OPENING.card },
];
const planned = await ok("opening.plan", { cutoverDate: "2026-09-01", balances });
await ok("operations.commit", { planId: planned.plan.planId, planHash: planned.plan.planHash });
log("opening balances posted");

// ----- 2. Stripe, then the bank files ---------------------------------------------------------------

await ok("stripe.configure", {});
const sync = await ok("stripe.sync");
log(`stripe: ${JSON.stringify(sync).slice(0, 160)}`);
const payouts = (scenario.payouts as Json[]).filter((p) => p.status === "paid");
const deposits: Line[] = payouts.map((p) => [
  new Date(Number(p.arrival_date) * 1000).toISOString().slice(0, 10),
  dec(BigInt(Number(p.amount))),
  `STRIPE TRANSFER ST-${String(p.id).slice(-12).toUpperCase()}`,
  "ACH_CREDIT",
]);
const checking = [...SEPTEMBER, ...deposits].sort((a, b) => a[0].localeCompare(b[0]));

async function importFile(text: string, name: string, account: string, presetId?: string) {
  const sha256 = await upload(text, name);
  const input = { sha256, ledgerAccountId: account, ...(presetId ? { presetId } : {}) };
  const preview = await ok("import.preview", { ...input, pageSize: 100 });
  if (!preview.valid)
    throw new Error(`${name}: ${JSON.stringify(preview.diagnostics).slice(0, 400)}`);
  const committed = await ok("import.commit", input);
  log(`${name}: ${committed.waiting} lines waiting in For review`);
}
// The august phase is the book before September's files are imported, for a recording of someone importing them.
if (phase !== "august") {
  await importFile(
    bankCsv(checking, cents(OPENING.checking)),
    "business-checking-september.csv",
    "1000",
  );
  await importFile(cardCsv(SEPTEMBER_CARD), "business-card-september.csv", "2000", "amex-card");
  await importFile(
    bankCsv(SAVINGS, cents(OPENING.savings)),
    "business-savings-september.csv",
    "1010",
  );
}

// ----- 3. rules, then the review ---------------------------------------------------------------------

const contains = (...values: string[]) =>
  values.map((value) => ({ field: "description", operator: "contains", value }));
const RULES: { name: string; account: string; body: Json }[] = [
  {
    name: "Rent: Fernworks Coworking",
    account: "6120",
    body: { conditions: contains("FERNWORKS") },
  },
  {
    name: "Software and subscriptions",
    account: "6200",
    body: {
      match: "any",
      conditions: contains("SPOOLBASE", "FIELDNOTE", "PIXELLEAF", "KERNING CO", "GRIDLOCK CLOUD"),
    },
  },
  {
    name: "Bank service fee",
    account: "6210",
    body: {
      conditions: [{ field: "description", operator: "startsWith", value: "MONTHLY SERVICE FEE" }],
    },
  },
  {
    name: "Customer payments",
    account: "4000",
    body: {
      match: "any",
      conditions: contains("HARBOR & WREN", "LINDEN SCHOOL", "NORTHFIELD DENTAL"),
    },
  },
  { name: "Insurance", account: "6060", body: { conditions: contains("HEARTHSTONE") } },
  { name: "Advertising", account: "6000", body: { conditions: contains("GLEAMLY") } },
  { name: "Utilities", account: "6180", body: { conditions: contains("LAKESHORE UTILITIES") } },
  { name: "Printing and materials", account: "5200", body: { conditions: contains("FERN & FOX") } },
];
// By August the owner has had months to teach the rules the usual vendors, so what is left to ask about in September is what is new or unclear.
const USUAL_VENDORS: { name: string; account: string; body: Json }[] = [
  {
    name: "Meals",
    account: "6170",
    body: { match: "any", conditions: contains("COBALT COFFEE", "PARKSIDE DINER") },
  },
  {
    name: "Office and shipping",
    account: "6090",
    body: { match: "any", conditions: contains("PAPERWORKS SUPPLY", "PARCELWAY", "BRIGHTWAY") },
  },
  { name: "Equipment rental", account: "6110", body: { conditions: contains("MARSH EQUIPMENT") } },
  { name: "Licenses", account: "6150", body: { conditions: contains("STATE BUSINESS LICENSE") } },
  { name: "Savings interest", account: "4900", body: { conditions: contains("INTEREST PAYMENT") } },
];
const rulesToWrite = taught ? [...RULES, ...USUAL_VENDORS] : RULES;
for (const rule of rulesToWrite)
  await ok("rules.create", {
    rule: {
      name: rule.name,
      action: { kind: "categorize", accountId: rule.account },
      ...rule.body,
    },
  });
log(`${rulesToWrite.length} rules written`);
if (phase === "august") {
  // The book stops here: the bank's files are written beside it, and a backup is made, checked and tried, so that the agent has a book that is kept.
  writeFiles({
    "business-checking-september.csv": bankCsv(checking, cents(OPENING.checking)),
    "business-card-september.csv": cardCsv(SEPTEMBER_CARD),
    "business-savings-september.csv": bankCsv(SAVINGS, cents(OPENING.savings)),
  });
  log(`backup: ${JSON.stringify(await job("backup.create")).slice(0, 100)}`);
  log(`verified: ${JSON.stringify(await job("backup.verify")).slice(0, 100)}`);
  log(`drill: ${JSON.stringify(await job("backup.drill")).slice(0, 100)}`);
  finish();
}

async function items(filter: Json = {}): Promise<Json[]> {
  const all: Json[] = [];
  for (let page = 1; page < 40; page++) {
    const data = await ok("inbox.list", { filter, page, pageSize: 200, sort: "date_asc" });
    all.push(...data.items);
    if (all.length >= data.count || data.items.length === 0) break;
  }
  return all;
}
async function postAll(filter: Json) {
  for (let call = 0; call < 100; call++) {
    const report = await ok("inbox.post", { filter });
    if (!report.remaining) return;
  }
}
const waiting = (all: Json[]) =>
  all.filter((item) => ["new", "proposed", "drafted"].includes(String(item.status)));

// Stripe's payouts: one entry each. Rules do the rest of what they can. A person decides the others.
await ok("inbox.accept", {
  filter: { provider: "stripe", covered: false },
  proposer: "stripe",
  minConfidence: 100,
});
await postAll({ provider: "stripe" });
// Each Stripe transfer in the bank file names the payout it is: matched to the cent, then posted with it.
await ok("inbox.accept", {
  filter: { provider: "csv", status: ["proposed"] },
  proposer: "stripe",
  minConfidence: 90,
});
await ok("inbox.accept", { filter: {}, proposer: "rule", minConfidence: 100 });
const byMemo = (all: Json[], needle: string) =>
  all.filter((item) => String(item.line.description).includes(needle));
const decide = async (needle: string, accountId: string) => {
  const found = byMemo(waiting(await items()), needle);
  if (found.length)
    await ok("inbox.categorize", { itemIds: found.map((item) => item.id), accountId });
  log(`${needle} → ${accountId} (${found.length})`);
};
await decide("PAPERWORKS SUPPLY", "6140");
await decide("COBALT COFFEE", "6170");
await decide("PARCELWAY", "6090");
await decide("MARSH EQUIPMENT", "6110");
await decide("STATE BUSINESS LICENSE", "6150");
await decide("PARKSIDE DINER", "6170");
await decide("BRIGHTWAY", "6090");
await decide("MOBILE DEPOSIT", "4000");
// In the recording the owner says Jamie is a contractor; in the other books the payment is a draw.
await decide("ZELLE PAYMENT TO JAMIE", phase === "closing" ? "6030" : "3100");
// A transfer is one entry for both of its lines: accepting one side drafts the pair.
await ok("inbox.accept", { filter: { status: ["proposed"] }, proposer: "transfer" });
await postAll({});
const left = waiting(await items());
log(
  `September: ${left.length} lines still waiting${
    left.length
      ? ` (${left
          .map((i) => i.line.description)
          .join("; ")
          .slice(0, 160)})`
      : ""
  }`,
);
// The interest on savings is the bank's own word for it: one line, one account.
await decide("INTEREST PAYMENT", "4900");
await postAll({});

// ----- 4. reconcile each account to its September statement, to exactly 0.00 -------------------------------

const sum = (lines: readonly Line[]) => lines.reduce((total, line) => total + cents(line[1]), 0n);
const statements: { accountId: string; name: string; balance: bigint }[] = [
  {
    accountId: "1000",
    name: "Business checking",
    balance: cents(OPENING.checking) + sum(checking),
  },
  { accountId: "1010", name: "Business savings", balance: cents(OPENING.savings) + sum(SAVINGS) },
  // A card's balance owed is positive; its statement lists charges positive and payments negative.
  {
    accountId: "2000",
    name: "Business credit card",
    balance: cents(OPENING.card) - sum(SEPTEMBER_CARD),
  },
];
for (const statement of statements) {
  const draft = await ok("reconcile.start", {
    accountId: statement.accountId,
    statementDate: "2026-09-30",
    statementBalance: dec(statement.balance),
  });
  const all = await ok("reconcile.setCleared", {
    id: draft.id,
    expectedVersion: draft.version,
    reset: "all",
  });
  if (!all.canComplete)
    throw new Error(`${statement.name}: difference ${all.difference}, not 0.00`);
  // An agent's token cannot finish one: that is the owner's, so the closing book leaves it started.
  if (phase === "closing") {
    log(`${statement.name} started at ${dec(statement.balance)}, difference ${all.difference}`);
    continue;
  }
  const done = await ok("reconcile.complete", { id: draft.id, expectedVersion: all.version });
  log(`${statement.name} reconciled to ${dec(statement.balance)}, difference ${done.difference}`);
}
if (phase === "closing") finish();

/** A long operation (a backup), asked again under one identity until it finishes, as a client does. */
async function job(name: string, input: unknown = {}) {
  const operationId = crypto.randomUUID();
  for (let attempt = 0; attempt < 1200; attempt++) {
    const response = await http.fetch(
      new Request(`http://127.0.0.1:4010/v1/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: "local-book",
          input,
          operationId,
        }),
      }),
    );
    const body = (await response.json()) as Json;
    if (response.status !== 200 || body.ok !== true)
      throw new Error(`${name}: ${JSON.stringify(body).slice(0, 300)}`);
    if (body.data.state !== "running") return body.data;
    await Bun.sleep(50);
  }
  throw new Error(`${name} did not finish`);
}

/** The bank's files, as downloaded: written beside the book, so a recording can import them through the screens. */
function writeFiles(files: Record<string, string>) {
  const folder = join(out, "files");
  mkdirSync(folder, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text);
}

function finish(): never {
  service.close();
  copyFileSync(book, join(out, `${phase}.sqlite`));
  // A backup made along the way sits beside the book; it travels with it, so the Backups screen has it.
  const backups = join(work, "backups");
  rmSync(join(out, `${phase}.backups`), { recursive: true, force: true });
  if (existsSync(backups)) cpSync(backups, join(out, `${phase}.backups`), { recursive: true });
  console.log(`Wrote ${join(out, `${phase}.sqlite`)}`);
  process.exit(0);
}

const septemberClose = cents(OPENING.checking) + sum(checking);
writeFiles({
  "business-checking-september.csv": bankCsv(checking, cents(OPENING.checking)),
  "business-card-september.csv": cardCsv(SEPTEMBER_CARD),
  "business-savings-september.csv": bankCsv(SAVINGS, cents(OPENING.savings)),
  "business-checking-october.csv": bankCsv(OCTOBER, septemberClose),
  "business-card-october.csv": cardCsv(OCTOBER_CARD),
});
if (phase === "worked") finish();

// ----- 5. the first days of October: a file waiting in For review, rules already at work -----------------

clock.ms = Date.UTC(2026, 9, 9, 17, 0, 0); // Friday 9 October, the day the file was downloaded
await importFile(bankCsv(OCTOBER, septemberClose), "business-checking-october.csv", "1000");
await importFile(cardCsv(OCTOBER_CARD), "business-card-october.csv", "2000", "amex-card");
if (phase === "inbox") finish();

// ----- 6. an agent with a draft-only token leaves three drafts for the owner -------------------------------

const issued = await ok("tokens.create", {
  label: "Claude Code on my laptop",
  permissions: ["read", "draft"],
});
const secret = issued.secret as string;
const draft = (
  date: string,
  reference: string,
  narration: string,
  debit: string,
  credit: string,
  amount: string,
) =>
  ok(
    "drafts.create",
    {
      data: {
        date,
        reference,
        narration,
        lines: [
          { accountId: debit, debit: amount, credit: "" },
          { accountId: credit, debit: "", credit: amount },
        ],
      },
    },
    secret,
  );
await draft(
  "2026-10-05",
  "DRAFT-1",
  "Q3 estimated tax payment to the IRS (owner's draw, not an expense)",
  "3100",
  "1000",
  "1100.00",
);
await draft(
  "2026-10-06",
  "DRAFT-2",
  "Annual renewal of two domain names, paid on the card",
  "6200",
  "2000",
  "74.00",
);
await draft(
  "2026-10-08",
  "DRAFT-3",
  "Refund of one month of Pixelleaf, credited to checking",
  "1000",
  "6200",
  "54.99",
);
log("three drafts from the agent");

// ----- 7. a backup, so the Backups screen has something to show ---------------------------------------

const backup = await job("backup.create");
log(`backup: ${JSON.stringify(backup).slice(0, 120)}`);
finish();
