/** The founder's first month, end to end, through `ApplicationHttp` only and as the owner: the
 * lanes were built and tested apart, and this is where their pieces meet. One realistic month for a
 * US online business on the cash basis: a book from the Schedule C online-business template, a
 * cutover and opening balances, three statements (a Chase-style checking file, a Rho-style one and a
 * card file whose charges are positive), the stand-in Stripe, rules and the classifier, the Inbox,
 * reconciliation to each statement, the three statements of account, a month closed, a backup that
 * restores, and an agent with less access than the owner.
 *
 * Every expected figure is computed in `month.ts` from the fixtures, with integer cents; nothing
 * expected is read back from the system. The clock is injected (see `world.ts`), so the run is the
 * same on any day. The steps are one story and run in order: the first that fails stops the rest,
 * which are reported as not run. Assertions that a lane does not yet satisfy live in the known
 * issues at the end, each reproduced on its own as a test that is expected to fail. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  DISGUISES,
  MONEY,
  allItems,
  allJournals,
  enterByHand,
  legsOf,
  neg,
  pairRows,
  parseCsv,
  postAll,
  unsafeCells,
} from "./drive.ts";
import {
  APRIL,
  APRIL_FILE,
  CARD,
  CASH_CODES,
  CHASE,
  CHASE_OPENING_BEFORE_FEBRUARY,
  CUTOVER,
  HOSTILE,
  MONTH,
  OPENING,
  BANK_AND_CARD,
  RENAMED,
  type Row,
  STRIPE_ACCOUNT,
  aprilFileOpening,
  booked,
  cardCsv,
  cents,
  chaseCsv,
  closing,
  dec,
  expectedLedger,
  openingLedger,
  payoutEntries,
  profitLoss,
  rhoCsv,
  rhoRows,
} from "./month.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashCanonical } from "@rastrata/kernel";
import { LocalBookService, importOpenExport } from "../../src/local.ts";
import { operationCatalog, permitsOperation } from "../../src/schema.ts";
import { KEY, type Json, type World, askOwner, openWorld } from "./world.ts";

/** The date of the opening entry: the day before the cutover date. */
const OPENING_DATE = "2026-02-28";

let w: World;
let broken: string | null = null;

beforeAll(async () => {
  w = await openWorld();
});
afterAll(() => w?.close());

/** A step of the story. After the first failure the rest are not run: they depend on it. */
function step(name: string, body: () => Promise<void>, timeoutMs = 60_000): void {
  test(
    name,
    async () => {
      if (broken) {
        console.warn(`not run: "${broken}" failed`);
        return;
      }
      const started = performance.now();
      try {
        await body();
      } catch (error) {
        broken = name;
        throw error;
      } finally {
        if (process.env.ACCEPTANCE_TIMING)
          console.info(`${Math.round(performance.now() - started)} ms  ${name}`);
      }
    },
    timeoutMs,
  );
}

const sha256 = (text: string): string =>
  new Bun.CryptoHasher("sha256").update(new TextEncoder().encode(text)).digest("hex");

// ----- what the story builds up, step to step -----------------------------------------------------

let rhoMemo: readonly Row[] | null = null;
/** Rho's rows, built once so a row is the same object every time the story names it. */
const rho = (): readonly Row[] => {
  rhoMemo ??= rhoRows(w.scenario);
  return rhoMemo;
};
const FILES = [
  {
    name: "chase",
    account: "1000",
    rows: (): readonly Row[] => CHASE,
    text: (): string => chaseCsv(),
    preset: undefined,
  },
  { name: "rho", account: "1010", rows: rho, text: (): string => rhoCsv(rho()), preset: undefined },
  {
    name: "card",
    account: "2000",
    rows: (): readonly Row[] => CARD,
    text: (): string => cardCsv(),
    preset: "amex-card",
  },
] as const;
type Name = (typeof FILES)[number]["name"];

const received: Record<string, { sha256: string; input: Json; batchId: string }> = {};
/** The Inbox item each statement row became. */
const itemOf = new Map<Row, Json>();
const accountOf = new Map<Row, string>();
const ruleIds: Record<string, string> = {};
/** Each completed reconciliation, as read the moment it was done, by account code. */
const sealed: Record<string, Json> = {};
/** Things seen on the way that the known issues at the end come back to. */
const seen = {
  /** The accounts the close warned were unreconciled, before any was reconciled. */
  warnedBeforeReconciling: [] as string[],
  /** What the checklist said was worth a look when it said March was ready to close. */
  readyAttention: [] as string[],
};

const totalsOf = (rows: readonly Row[]) => {
  let moneyIn = 0n;
  let moneyOut = 0n;
  let inCount = 0;
  let outCount = 0;
  for (const row of rows) {
    const amount = cents(row.amount);
    if (amount > 0n) {
      moneyIn += amount;
      inCount += 1;
    } else {
      moneyOut += amount;
      outCount += 1;
    }
  }
  return {
    moneyIn: dec(moneyIn),
    moneyOut: dec(moneyOut),
    net: dec(moneyIn + moneyOut),
    inCount,
    outCount,
  };
};

// ----- the rules the founder writes ------------------------------------------------------------------

const contains = (...values: string[]) =>
  values.map((value) => ({ field: "description", operator: "contains", value }));

/** One rule per destination account, so a rule's expected lines are the rows that go there. */
const RULES = [
  {
    key: "software",
    name: "Software and subscriptions",
    account: "6200",
    agent: false,
    body: {
      match: "any",
      conditions: [
        ...contains(
          "GITHUB",
          "AMAZON WEB SERVICES",
          "FIGMA",
          "VERCEL",
          "NOTION",
          "SHOPIFY",
          "CANVA",
          "NAMECHEAP",
          "LINEAR ORBIT",
          "CLOUDFLARE",
          "DROPBOX",
          "MAILCHIMP",
          "ADOBE",
        ),
        // Whole word: "contains ZOOM" would also match LEGALZOOM, which is legal fees.
        { field: "description", operator: "wholeWord", value: "ZOOM" },
      ],
    },
  },
  {
    key: "rent",
    name: "Rent: WeWork",
    account: "6120",
    agent: false,
    body: { conditions: contains("WEWORK") },
  },
  {
    key: "fees",
    name: "Bank service fee",
    account: "6210",
    agent: false,
    body: {
      conditions: [{ field: "description", operator: "startsWith", value: "MONTHLY SERVICE FEE" }],
    },
  },
  {
    key: "customers",
    name: "Customer payments",
    account: "4000",
    agent: false,
    body: { match: "any", conditions: contains("ZELLE PAYMENT FROM", "NORTHWIND") },
  },
  {
    key: "ads",
    name: "Advertising",
    account: "6000",
    agent: true,
    body: { match: "any", conditions: contains("FACEBK", "GOOGLE *ADS", "LINKEDIN ADS") },
  },
] as const;

/** The rows that become entries: after the cutover and settled, with the file and account each is on. */
const bookedRows = (): { row: Row; account: string; file: Name }[] =>
  FILES.flatMap((file) =>
    booked(file.rows()).map((row) => ({ row, account: file.account, file: file.name })),
  );

/** Every account's balance as the book holds it, debit-positive, read through the Accounts list. */
async function balances(): Promise<Map<string, bigint>> {
  const list = await w.ok("accounts.list");
  return new Map(list.accounts.map((a: Json) => [a.code, cents(a.balance)]));
}

/** The difference between two ledgers, account by account, empty when they agree to the cent. */
function differences(
  actual: ReadonlyMap<string, bigint>,
  expected: ReadonlyMap<string, bigint>,
): string[] {
  const out: string[] = [];
  for (const code of new Set([...actual.keys(), ...expected.keys()]).values()) {
    const a = actual.get(code) ?? 0n;
    const e = expected.get(code) ?? 0n;
    if (a !== e) out.push(`${code}: book ${dec(a)}, expected ${dec(e)}`);
  }
  return out.sort();
}

describe("the founder's first month: March 2026, a one-person online business, cash basis", () => {
  // =============================================================================================
  step("a. the book: Schedule C online-business template, cutover, opening balances", async () => {
    // The template reads work before any book exists.
    const catalog = await w.ok("templates.list");
    expect(catalog.templates.map((t: Json) => t.id)).toContain("sole-proprietor");
    expect(catalog.disclaimer).toMatch(/not tax advice/i);
    const template = await w.ok("templates.get", {
      templateId: "sole-proprietor",
      basis: "cash",
      taxYear: 2026,
      addOns: ["online-business"],
    });
    expect(template).toMatchObject({ basis: "cash", taxYear: 2026, addOns: ["online-business"] });
    expect(template.disclaimer).toMatch(/not tax advice/i);
    // Each Stripe role key (the cross-lane contract) is on exactly one account, and so are the two keys
    // that mark the catch-all accounts (Other expenses, Other income).
    const roleKeys: string[] = template.accounts.flatMap((a: Json) =>
      a.tags.roleKey ? [a.tags.roleKey] : [],
    );
    expect(roleKeys.sort()).toEqual(
      [
        "catchall.expense",
        "catchall.income",
        "chargebacks",
        "payouts.in-transit",
        "refunds",
        "revenue.sales",
        "stripe.balance",
        "stripe.fees",
        "tax.sales",
      ].sort(),
    );
    for (const [role, code] of Object.entries(STRIPE_ACCOUNT)) {
      const account = template.accounts.find((a: Json) => a.tags.roleKey === role);
      if (account) expect(account.code, role).toBe(code);
    }
    // A template carries no bank or card account: the founder brings theirs (here, three they named).
    expect(template.accounts.map((a: Json) => a.code)).not.toContain("1000");
    expect(template.accounts.some((a: Json) => a.tags.kind)).toBe(false);

    const accounts = [
      ...BANK_AND_CARD,
      ...template.accounts.map((a: Json) => ({
        code: a.code,
        name: RENAMED[a.code] ?? a.name,
        role: a.role,
        ...(a.parentCode ? { parentCode: a.parentCode } : {}),
        tags: a.tags,
      })),
    ];
    await w.ok("book.setup", {
      name: "Willow Lane Studio",
      currency: "USD",
      fiscalYear: 2026,
      periodModel: "monthly",
      basis: "cash",
      accounts,
    });
    const capabilities = await w.ok("capabilities.get");
    expect(JSON.stringify(capabilities)).toContain('"cash"');
    const chart = await w.ok("accounts.list");
    expect(chart.accounts).toHaveLength(accounts.length);
    expect(chart.accounts.find((a: Json) => a.code === "1000")).toMatchObject({
      name: "Chase business checking",
      role: "asset",
      tags: { cashFlowClass: "cash" },
    });
    expect(chart.accounts.find((a: Json) => a.code === "4000").tags).toMatchObject({
      taxLine: "scheduleC.line1",
      roleKey: "revenue.sales",
    });

    // The cutover first: the three accounts that have statements get an import source that starts on
    // the cutover date, so anything earlier is set aside, visibly, and never dropped.
    const preview = await w.ok("cutover.get", {
      cutoverDate: CUTOVER,
      accountIds: ["1000", "1010", "2000"],
    });
    expect(preview.cutover).toBeNull();
    expect(preview.accounts.filter((a: Json) => a.chosen).map((a: Json) => a.code)).toEqual([
      "1000",
      "1010",
      "2000",
    ]);
    // What the cutover offers as accounts with statements is a guess about banks and cards, and it is
    // an honest one (finding 15): the two cash-tagged accounts and the credit card, and never
    // Inventory, Equipment or Sales tax payable, which are an asset and a liability and nothing more.
    const offered = (await w.ok("cutover.get", {})).accounts as Json[];
    expect(
      offered.filter((a) => a.reason !== "stripe").map((a) => [a.code, a.kind, a.reason]),
    ).toEqual([
      ["1000", "bank", "cash"],
      ["1010", "bank", "cash"],
      ["2000", "card", "card"],
    ]);
    const chartCodes = (chart.accounts as Json[]).map((a) => a.code);
    for (const code of ["1300", "1500", "2500"])
      expect(chartCodes, `the chart has ${code}`).toContain(code);
    expect(offered.map((a) => a.code)).not.toContain("1300");
    expect(offered.map((a) => a.code)).not.toContain("1500");
    expect(offered.map((a) => a.code)).not.toContain("2500");
    const set = await w.ok("cutover.set", {
      cutoverDate: CUTOVER,
      accountIds: ["1000", "1010", "2000"],
    });
    expect(set.state.cutover).toMatchObject({
      cutoverDate: CUTOVER,
      accountIds: ["1000", "1010", "2000"],
      by: "owner",
    });
    const sources = (await w.ok("inbox.sources")).sources;
    expect(sources.map((s: Json) => [s.accountKey, s.ledgerAccountId, s.startOn])).toEqual([
      ["csv:1000", "1000", CUTOVER],
      ["csv:1010", "1010", CUTOVER],
      ["csv:2000", "2000", CUTOVER],
    ]);

    // Opening balances: one ordinary balanced journal against Opening balance equity, dated the day
    // before the cutover date: the balances are those at the start of the cutover day.
    const balances = Object.entries(OPENING).map(([accountId, balance]) => ({
      accountId,
      balance,
    }));
    const review = await w.ok("opening.review", { cutoverDate: CUTOVER, balances });
    expect(review).toMatchObject({
      valid: true,
      totals: { debit: "17000.00", credit: "17000.00", balanced: true },
    });
    expect(review.offset).toMatchObject({ code: "3900", credit: "15750.00" });
    expect(review.entryDate).toBe(OPENING_DATE);
    const planned = await w.ok("opening.plan", { cutoverDate: CUTOVER, balances });
    expect(planned.plan.valid).toBe(true);
    expect((await w.ok("journal.list", { status: "Posted" })).count).toBe(0); // planning posts nothing
    const committed = await w.ok("operations.commit", {
      planId: planned.plan.planId,
      planHash: planned.plan.planHash,
    });
    expect(committed.disposition).toBe("committed");
    const journals = await allJournals(w);
    expect(journals).toHaveLength(1);
    const opening = await w.ok("journal.get", { journalId: journals[0]?.id });
    expect(opening).toMatchObject({ kind: "ordinary", date: OPENING_DATE, correction: null });
    const expectedOpening = openingLedger();
    const legs = legsOf(opening);
    expect([...legs].sort()).toEqual([...expectedOpening].filter(([, v]) => v !== 0n).sort());
    expect([...legs.values()].reduce((a, b) => a + b, 0n)).toBe(0n);
    // And it cannot be planned twice.
    const again = await w.call("opening.plan", { cutoverDate: CUTOVER, balances });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe("opening_invalid");
    expect(again.body.error.message).toMatch(/already posted/);
  });

  // =============================================================================================
  step(
    "b. three statements through uploads, preview and commit; hostile text; a re-import",
    async () => {
      for (const file of FILES) {
        const text = file.text();
        const upload = await w.upload(text, `${file.name}.csv`);
        expect(upload.status).toBe(200);
        // Addressed by its SHA-256, which the test computes itself.
        expect(upload.body.data).toMatchObject({
          sha256: sha256(text),
          size: new TextEncoder().encode(text).byteLength,
        });
        const twice = await w.upload(text, `${file.name}.csv`);
        expect(twice.body.data.sha256).toBe(upload.body.data.sha256);

        const rows = file.rows();
        const counted = booked(rows);
        const input = {
          sha256: upload.body.data.sha256,
          ledgerAccountId: file.account,
          ...(file.preset ? { presetId: file.preset } : {}),
        };
        const preview = await w.ok("import.preview", { ...input, pageSize: 100 });
        expect(preview.valid).toBe(true);
        expect(preview.counts).toMatchObject({
          new: counted.length,
          duplicate: 0,
          overlap: 0,
          invalid: 0,
          excluded: rows.filter((r) => r.how === "set-aside").length,
        });
        expect(preview.newTotals).toEqual(totalsOf(counted));
        if (file.name === "chase") {
          expect(preview.detection).toMatchObject({
            how: "preset",
            preset: { id: "chase-checking" },
          });
          // The statement's own closing balance is the oracle's, and the running balance chain holds.
          expect(preview.chain).toMatchObject({ order: "newest-first", breakCount: 0 });
          expect(preview.chain.opening).toBe(dec(CHASE_OPENING_BEFORE_FEBRUARY()));
          expect(preview.balances[0]).toMatchObject({
            asOf: "2026-03-31",
            reported: dec(closing(CHASE, "1000")),
          });
        }
        if (file.name === "rho") {
          expect(preview.detection).toMatchObject({ how: "preset", preset: { id: "rho" } });
          expect(preview.skipped.notFinal).toEqual([{ value: "Pending", count: 2 }]);
        }
        if (file.name === "card") {
          // Without saying it is an American Express-style file, the positive charges look like money in:
          // the preview says so in plain words, and does not guess.
          const bare = await w.ok("import.preview", {
            sha256: input.sha256,
            ledgerAccountId: file.account,
          });
          expect(bare.hints.join(" ")).toMatch(/flip the signs/);
          // Read as it stands, the file is exactly the mirror image of the book's own signs.
          const own = totalsOf(counted);
          expect(bare.newTotals).toMatchObject({
            moneyIn: dec(-cents(own.moneyOut)),
            moneyOut: dec(-cents(own.moneyIn)),
          });
          expect(preview.hints).toEqual([]);
          expect(preview.detection).toMatchObject({ how: "preset", preset: { id: "amex-card" } });
        }
        // What the preview says about the hostile rows, in words, without quoting them.
        const messages = preview.diagnostics.map((d: Json) => d.message).join("\n");
        if (file.name === "chase") {
          expect(messages).toMatch(/instruction to an assistant/);
          expect(messages).toMatch(/formula/);
        }
        if (file.name === "rho") expect(messages).toMatch(/text-direction or invisible characters/);
        expect(messages).not.toMatch(/ignore your rules|HYPERLINK|cmd\|/i);

        const committed = await w.ok("import.commit", input);
        expect(committed.waiting).toBe(counted.length);
        expect(committed.account.code).toBe(file.account);
        received[file.name] = { sha256: input.sha256, input, batchId: committed.batchId };

        // A re-import of the same file is idempotent: nothing new, nothing doubled.
        const total = (await w.ok("inbox.summary")).counts.total;
        const repeat = await w.ok("import.commit", input);
        expect(repeat.counts).toMatchObject({ new: 0, duplicate: 0 });
        expect(repeat.counts.overlap).toBe(preview.counts.lines);
        expect((await w.ok("inbox.summary")).counts.total).toBe(total);
      }
      // The same request retried under the same operation identity is the first answer, not a new batch.
      const id = crypto.randomUUID();
      const first = await w.ok("import.commit", received.chase?.input, { operationId: id });
      const retry = await w.ok("import.commit", received.chase?.input, { operationId: id });
      expect(retry).toEqual(first);

      // Every statement row became exactly one Inbox item, and every item is a row.
      const items = await allItems(w);
      for (const file of FILES) {
        const imported = file.rows().filter((r) => r.how !== "skipped"); // pending rows are never imported
        const { paired, unmatchedRows, spare } = pairRows(items, file.account, imported);
        expect(
          unmatchedRows.map((r) => r.memo),
          `${file.name}: rows with no item`,
        ).toEqual([]);
        expect(spare.length, `${file.name}: items with no row`).toBe(0);
        expect(paired.size).toBe(imported.length);
        for (const [row, item] of paired) {
          itemOf.set(row, item);
          accountOf.set(row, file.account);
          if (row.how === "set-aside") {
            expect(item.status).toBe("excluded");
            expect(item.exclusion.code).toBe("before_cutover");
          } else expect(["new", "proposed"]).toContain(item.status);
        }
      }
      // Two coffees on one day for one price are two lines, each with its own item.
      const coffees = CHASE.filter((r) => r.memo.startsWith("STARBUCKS"));
      expect(coffees).toHaveLength(2);
      expect(itemOf.get(coffees[0] as Row)?.id).not.toBe(itemOf.get(coffees[1] as Row)?.id);

      // Hostile text is kept as the bank wrote it and flagged where the ingest lane can see it; nothing
      // in it has been followed, and the raw file is addressed by the SHA-256 the upload returned.
      const formula = itemOf.get(CHASE.find((r) => r.memo === HOSTILE.formula) as Row) as Json;
      expect(formula.line.description).toBe(HOSTILE.formula);
      const bidi = itemOf.get(rho().find((r) => r.memo === HOSTILE.bidi) as Row) as Json;
      expect(bidi.line.description).toContain("‮");
      expect(bidi.flags).toContain("format_characters");
      // The import preview's warnings follow the line into the Inbox (finding 5), so an agent that reads
      // it sees them on the line, and can ask for exactly those lines. Text that starts as a formula
      // (four of the six hostile memos, in three files), the one that reads like an instruction to an
      // assistant, and nothing else: no ordinary memo is flagged.
      const hostile = (memo: string, rows: readonly Row[]) =>
        itemOf.get(rows.find((r) => r.memo === memo) as Row) as Json;
      const formulas = [
        hostile(HOSTILE.formula, CHASE),
        hostile(HOSTILE.plus, rho()),
        hostile(HOSTILE.at, CARD),
        hostile(HOSTILE.minus, CARD),
      ];
      for (const item of formulas)
        expect(item.flags as string[], String(item.line.description)).toContain("formula");
      const instruction = hostile(HOSTILE.instruction, CHASE);
      expect(instruction.flags).toContain("instruction");
      expect(instruction.flags).not.toContain("formula");
      const flagged = async (flag: string) =>
        (await allItems(w, { flag })).map((item) => item.id).sort();
      expect(await flagged("formula")).toEqual(formulas.map((item) => item.id).sort());
      expect(await flagged("instruction")).toEqual([instruction.id]);
      expect(await flagged("markup")).toEqual([]);
      expect(await flagged("link")).toEqual([]);
      const detail = await w.ok("inbox.get", { itemId: formula.id });
      expect(detail.provenance).toMatchObject({
        provider: "csv",
        accountKey: "csv:1000",
        rawSha256: received.chase?.sha256,
        rawName: "chase.csv",
      });
      // The Inbox shows nothing but the built-in suggestions so far: the transfer matcher's, and the starter
      // list's for the merchants it knows (a book that has learned nothing yet).
      const proposers = new Set(
        items.filter((i) => i.suggestion).map((i) => i.suggestion.proposer),
      );
      expect([...proposers].sort()).toEqual(["starter", "transfer"]);
      expect((await w.ok("inbox.summary")).counts).toMatchObject({ posted: 0, drafted: 0 });
    },
  );

  // =============================================================================================
  step(
    "c. Stripe: one summary journal per payout, its transactions covered, the deposits matched",
    async () => {
      const oracle = payoutEntries(w.scenario);
      expect(oracle.map((p) => p.label)).toEqual(["P1", "P2", "P3", "P4", "P5", "P6"]);
      // The oracle's own tie-out: what Stripe says each payout was is what its transactions net to.
      for (const payout of oracle)
        expect(payout.legs.get(STRIPE_ACCOUNT["payouts.in-transit"] as string), payout.label).toBe(
          payout.amount,
        );

      const configured = await w.ok("stripe.configure", {});
      expect(configured.ready).toBe(true);
      // Stripe begins on the cutover date, not before: the cutover was recorded before Stripe was
      // connected, and connecting it takes the date from there.
      expect(configured.settings.syncFrom).toBe(CUTOVER);
      for (const [role, code] of Object.entries(STRIPE_ACCOUNT)) {
        const found = configured.roles.find((r: Json) => r.role === role);
        // Each role is found from the role key on the chart's accounts; only the optional one is not there yet.
        if (role === "stripe.adjustments") expect(found).toMatchObject({ state: "missing" });
        else expect(found, role).toMatchObject({ state: "tagged", code });
      }
      expect((await w.ok("stripe.status")).settings.syncFrom).toBe(CUTOVER);

      const sync = await w.ok("stripe.sync");
      expect(sync.run).toMatchObject({
        disposition: "complete",
        payouts: oracle.length,
        transactions: w.scenario.entries.length,
        newLines: oracle.length + oracle.reduce((n, p) => n + p.members.length, 0),
        heldLines: 0,
        errorCode: null,
      });
      // Nothing the key could have written to is in the answer.
      expect(JSON.stringify(sync)).not.toMatch(/rk_live|Bearer/);

      // Every transaction of a payout is a covered line of that payout; the payouts are the only
      // events left to decide.
      const covered = await allItems(w, { provider: "stripe", covered: true });
      const payoutItems = await allItems(w, { provider: "stripe", covered: false });
      expect(payoutItems).toHaveLength(oracle.length);
      expect(covered).toHaveLength(oracle.reduce((n, p) => n + p.members.length, 0));
      for (const payout of oracle) {
        const members = covered.filter((i) => i.coveredBy?.providerId === payout.id);
        expect(members.map((i) => i.line.providerId).sort(), payout.label).toEqual(
          [...payout.members].sort(),
        );
      }
      expect((await w.ok("inbox.summary")).counts.covered).toBe(covered.length);

      // P2 holds an adjustment, which the chart has no account for yet: shown, not guessed.
      const p2 = oracle.find((p) => p.label === "P2") as (typeof oracle)[number];
      const p2Item = payoutItems.find((i) => i.line.providerId === p2.id) as Json;
      expect(p2Item.proposalCount).toBe(0);
      const status = await w.ok("stripe.status");
      expect(status.held.adjustments).toBe(1);
      expect(sync.run.notes.join(" ")).toMatch(/adjustments account/);

      // The founder adds the account at the date the Accounts screen suggests, and tags it with the role key.
      const when = (await w.ok("accounts.list")).suggestedEffectiveOn;
      expect(when).toBe("2026-03-01"); // the day after the latest entry (the opening balances, 2026-02-28)
      const prepared = await w.ok("accounts.prepareCreate", {
        code: STRIPE_ACCOUNT["stripe.adjustments"],
        name: "Other Stripe adjustments",
        role: "expense",
        effectiveOn: when,
      });
      expect(prepared.valid).toBe(true);
      const created = await w.ok("operations.commit", {
        planId: prepared.planId,
        planHash: prepared.planHash,
      });
      expect(created.disposition).toBe("committed");
      const tagged = await w.ok("accounts.setTags", {
        accountId: STRIPE_ACCOUNT["stripe.adjustments"],
        effectiveOn: when,
        tags: { roleKey: "stripe.adjustments", taxLine: "scheduleC.line27b" },
      });
      expect(tagged.changed).toBe(true);
      expect(
        (await w.ok("stripe.status")).roles.find((r: Json) => r.role === "stripe.adjustments"),
      ).toMatchObject({
        state: "tagged",
        code: STRIPE_ACCOUNT["stripe.adjustments"],
      });

      // Each payout is proposed as one entry whose legs are exactly the oracle's, and add up to the
      // payout amount on Payouts in transit and to nothing overall.
      for (const payout of oracle) {
        const item = (await allItems(w, { provider: "stripe", covered: false })).find(
          (i) => i.line.providerId === payout.id,
        ) as Json;
        const detail = await w.ok("inbox.get", { itemId: item.id });
        const proposal = detail.proposals.find((p: Json) => p.proposer === "stripe");
        expect(proposal, payout.label).toMatchObject({ kind: "event", confidence: 100 });
        const legs = new Map<string, bigint>(
          proposal.legs.map((l: Json) => [l.accountId, cents(l.amount)]),
        );
        expect([...legs].sort(), payout.label).toEqual([...payout.legs].sort());
        expect([...legs.values()].reduce((a, b) => a + b, 0n)).toBe(0n);
        expect(legs.get("1110")).toBe(payout.amount);
        expect(detail.coveredCount).toBe(payout.members.length);
      }

      // The deposits in the Rho file: each pairs with its own payout, to the cent and to the day. P4 and P5
      // net the same 19.12, so their two deposits are paired one to one by their dates, and the proposal
      // says how (finding 7: they used to be left unpaired as "ambiguous", and their payouts unmatched).
      const deposits = await allItems(w, {
        provider: "csv",
        ledgerAccountId: "1010",
        text: "STRIPE TRANSFER",
      });
      expect(deposits).toHaveLength(5);
      for (const deposit of deposits) {
        const detail = await w.ok("inbox.get", { itemId: deposit.id });
        const proposal = detail.proposals.find((p: Json) => p.proposer === "stripe");
        expect(proposal, deposit.line.description).toBeDefined();
        expect(proposal.legs).toEqual([
          { accountId: "1010", amount: deposit.line.amount },
          { accountId: "1110", amount: neg(deposit.line.amount) },
        ]);
        // The memo names the payout the deposit is for (ST-P4KD3P1): the oracle's own knowledge.
        const own = oracle.find((p) => String(deposit.line.description).includes(`ST-${p.label}K`));
        expect(own, deposit.line.description).toBeDefined();
        expect(proposal.confidence).toBe(97);
        expect(proposal.links).toEqual([{ key: "payout", value: own?.id }]);
        if (oracle.filter((p) => dec(p.amount) === deposit.line.amount).length > 1)
          expect(proposal.reasons.join(" ")).toContain(
            "the earlier payout takes the earlier deposit",
          );
      }

      // The owner accepts the six payouts and posts them.
      const accepted = await w.ok("inbox.accept", {
        filter: { provider: "stripe", covered: false },
        proposer: "stripe",
        minConfidence: 100,
      });
      expect(accepted).toMatchObject({ applied: 6, skipped: 0, failed: 0, remaining: 0 });
      const posted = await postAll(w, { provider: "stripe" });
      expect(posted).toMatchObject({ applied: 6, failed: 0 });

      // One journal per payout, not one per transaction, dated on arrival, equal to the oracle to the cent.
      const journals = await allJournals(w);
      expect(journals).toHaveLength(1 + oracle.length);
      for (const payout of oracle) {
        const item = (await allItems(w, { provider: "stripe", covered: false })).find(
          (i) => i.line.providerId === payout.id,
        ) as Json;
        expect(item.status).toBe("posted");
        const journal = await w.ok("journal.get", { journalId: item.journalId });
        expect(journal.date).toBe(payout.arrival);
        expect(journal.source.id).toBe(`stripe-payout-${payout.id}`);
        expect(journal.narration).toContain(payout.id);
        expect(journal.lines.length).toBe(payout.legs.size);
        expect([...legsOf(journal)].sort(), payout.label).toEqual([...payout.legs].sort());
        expect(legsOf(journal).get("1110")).toBe(payout.amount);
        // The journal says which transactions it stands for, and the claim can be recomputed.
        const detail = await w.ok("inbox.get", { itemId: item.id });
        const lines = payout.members
          .map(
            (id) =>
              `${id}:${BigInt(Number(w.scenario.entries.find((e) => e.bt.id === id)?.bt.net))}`,
          )
          .sort();
        const digest = hashCanonical({
          type: "StripePayoutMembers",
          payout: payout.id,
          members: lines,
        }).digest;
        expect(detail.provenance.evidenceReference).toMatch(
          /^ingest:bt_[0-9a-f]+:0 stripe:payout:/,
        );
        expect(detail.provenance.evidenceReference).toContain(
          `members=${payout.members.length}:sha256=${digest}`,
        );
        // And the lines it covers followed it to Posted, all under the same journal.
        const members = (await allItems(w, { provider: "stripe", covered: true })).filter(
          (i) => i.coveredBy?.providerId === payout.id,
        );
        for (const member of members)
          expect(member).toMatchObject({ status: "posted", journalId: item.journalId });
      }

      // Stripe's own balance agrees with what Rastrata knows to the cent, and the books hold what is in transit.
      const control = (await w.ok("stripe.status")).balance;
      const stripeBalance = w.scenario.entries
        .filter((e) => e.bt.currency === "usd")
        .reduce((sum, e) => sum + BigInt(Number(e.bt.net)), 0n);
      expect(control.snapshot.total).toBe(dec(stripeBalance));
      expect(control).toMatchObject({ ties: true, difference: "0.00" });
      expect(control.inTransit).toBe(dec(oracle.reduce((sum, p) => sum + p.amount, 0n)));
    },
  );

  // =============================================================================================
  step(
    "d. rules suggest on the right lines and only those; nothing posts without accept and post",
    async () => {
      expect(await allJournals(w)).toHaveLength(7); // the opening entry and six payouts
      // The classifier learned from those seven by itself when the Inbox was read: nobody trained it.
      expect(await w.ok("classifier.status")).toMatchObject({
        examples: 7,
        sources: { posted: 7, decisions: 0 },
      });

      for (const def of RULES) {
        const created = await w.ok("rules.create", {
          rule: {
            name: def.name,
            action: { kind: "categorize", accountId: def.account },
            ...def.body,
          },
          ...(def.agent ? { madeBy: { kind: "agent", name: "Claude Code" } } : {}),
        });
        ruleIds[def.key] = created.id;
        expect(created).toMatchObject({ status: "active", enabled: true, problems: [] });
        expect(created.createdBy.kind).toBe(def.agent ? "agent" : "person");
      }
      const list = await w.ok("rules.list", { usage: true });
      expect(list.rules.map((r: Json) => r.name)).toEqual(RULES.map((r) => r.name));
      const rows = bookedRows();
      for (const def of RULES) {
        // The rent line, entered by hand, is still a line the rent rule matches (step e comes back to it).
        const expected = rows.filter(
          ({ row }) =>
            (row.how === "rule" || row.how === "entered") &&
            "to" in row.dest &&
            row.dest.to === def.account,
        ).length;
        const record = list.rules.find((r: Json) => r.id === ruleIds[def.key]);
        expect(record.usage, def.name).toMatchObject({
          matched: expected,
          decided: expected,
          shadowed: 0,
        });
      }

      // A rule's suggestion is on exactly the lines the founder meant, with the legs to the cent and
      // the reason in words; on every other line (hostile ones included) there is none.
      for (const { row, account } of rows) {
        const detail = await w.ok("inbox.get", { itemId: (itemOf.get(row) as Json).id });
        const fromRules = detail.proposals.filter((p: Json) => p.proposer.startsWith("rule:"));
        if (row.how === "rule" || row.how === "entered") {
          const def = RULES.find(
            (d) => "to" in row.dest && d.account === row.dest.to,
          ) as (typeof RULES)[number];
          expect(fromRules, row.memo).toHaveLength(1);
          expect(fromRules[0]).toMatchObject({
            proposer: `rule:${ruleIds[def.key]}`,
            kind: "categorize",
            confidence: 100,
          });
          expect(fromRules[0].legs).toEqual([
            { accountId: account, amount: row.amount },
            { accountId: def.account, amount: neg(row.amount) },
          ]);
          expect(fromRules[0].reasons.join(" ")).toContain(def.name);
        } else expect(fromRules, row.memo).toEqual([]);
      }

      // "Create a rule from this line": the suggestion generalises it (the store number and the town are
      // left out, so it keeps matching next month) and says how many waiting lines it would decide:
      // exactly the four Chipotle lines of the month (three on Chase, one on the card).
      const chipotle = rows.filter(({ row }) => row.memo.startsWith("CHIPOTLE"));
      expect(chipotle).toHaveLength(4);
      const first = chipotle[0] as (typeof rows)[number];
      const suggested = await w.ok("rules.suggest", {
        description: first.row.memo,
        amount: first.row.amount,
        accountId: first.account,
        categoryAccountId: "6170",
      });
      expect(suggested.rule.conditions[0]).toMatchObject({
        field: "description",
        operator: "contains",
        value: "chipotle",
      });
      expect(suggested.basis.dropped).toContain("1234");
      const tried = await w.ok("rules.test", { rule: suggested.rule });
      expect(tried.problems).toEqual([]);
      expect(tried.inbox).toMatchObject({
        matched: chipotle.length,
        applies: chipotle.length,
        shadowed: 0,
        unusable: 0,
      });

      // Suggestions are not decisions: nothing is drafted, nothing posted, no entry added.
      expect((await w.ok("inbox.summary")).counts).toMatchObject({ drafted: 0, posted: 30 });
      expect(await allJournals(w)).toHaveLength(7);
      // What the classifier learned from the opening entry and the payouts says nothing about a bank
      // line, so it suggests nothing.
      const items = await allItems(w, { status: ["new", "proposed"] });
      expect(items.filter((i) => i.suggestion?.proposer === "classifier")).toEqual([]);
    },
  );

  // =============================================================================================
  step(
    "e. the Inbox: accept, categorize, split, exclude, post; the classifier's turn; provenance",
    async () => {
      const rows = bookedRows();
      const oracle = payoutEntries(w.scenario);
      const get = async (row: Row) =>
        (await w.ok("inbox.get", { itemId: (itemOf.get(row) as Json).id })).item as Json;
      const equal = rows.filter(
        ({ row }) =>
          "payout" in row.dest && oracle.filter((p) => p.amount === cents(row.amount)).length > 1,
      );
      expect(equal).toHaveLength(2); // P4 and P5 deposit the same 19.12, and so would P6, which failed
      const personal = rows.find(({ row }) => "personal" in row.dest) as (typeof rows)[number];
      const classifierRows = rows.filter(({ row }) => row.how === "classifier");
      expect(classifierRows).toHaveLength(3);
      const held = new Set<Row>([...classifierRows, personal].map((r) => r.row));

      // --- the March rent was written into the books by hand on the 1st, before the statement came.
      // The Inbox finds that entry for the line and puts it first, ahead of the rent rule's own 100%:
      // whatever else is suggested for a payment that is already booked would book it twice.
      const entered = rows.find(({ row }) => row.how === "entered") as (typeof rows)[number];
      const rentAccount = (entered.row.dest as { to: string }).to;
      const enteredItem = itemOf.get(entered.row) as Json;
      const handEntered = await enterByHand(w, {
        date: entered.row.date,
        reference: "RENT",
        narration: "March rent, entered by hand",
        lines: [
          { accountId: rentAccount, debit: neg(entered.row.amount), credit: "" },
          { accountId: entered.account, debit: "", credit: neg(entered.row.amount) },
        ],
      });
      const suggestions = await w.ok("inbox.get", { itemId: enteredItem.id });
      expect(
        suggestions.proposals.map((p: Json) => [
          p.proposer.startsWith("rule:") ? "rule" : p.proposer,
          p.kind,
          p.confidence,
        ]),
      ).toEqual([
        ["journal-match", "match", 95],
        ["rule", "categorize", 100],
      ]);
      expect(suggestions.proposals[0].matchJournalId).toBe(handEntered);
      // The list agrees, so the screen and an agent read the same first suggestion.
      expect((await allItems(w, { text: "WEWORK" }))[0]?.suggestion).toMatchObject({
        kind: "match",
      });
      expect(await allJournals(w)).toHaveLength(8); // and the entry is one entry

      // --- round 1: accept what the rules, the transfer matcher and the Stripe matcher suggest.
      const ruleRows = rows.filter(({ row }) => row.how === "rule");
      const byRules = await w.ok("inbox.accept", {
        filter: { status: ["new", "proposed"] },
        proposer: "rule",
        minConfidence: 90,
      });
      // Every line a rule decides but the rent: that one is skipped, in words, and left as it was.
      expect(byRules).toMatchObject({ applied: ruleRows.length, skipped: 1, failed: 0 });
      const refused = byRules.results.find((result: Json) => result.outcome === "skipped");
      expect(refused).toMatchObject({ itemId: enteredItem.id, code: "match_exists" });
      expect(refused.message).toContain("March rent, entered by hand");
      expect(refused.message).toContain(entered.row.date);
      expect((await get(entered.row)).status).toBe("proposed");
      // So does asking for a second entry by categorizing the line, however it is chosen.
      const byHand = await w.ok("inbox.categorize", {
        itemIds: [enteredItem.id],
        accountId: rentAccount,
      });
      expect(byHand).toMatchObject({ applied: 0, skipped: 1, failed: 0 });
      expect(byHand.results[0]).toMatchObject({ code: "match_exists" });
      // Accepting the match books nothing new: the line is linked to the entry the founder made.
      const byMatch = await w.ok("inbox.accept", {
        itemIds: [enteredItem.id],
        proposer: "journal-match",
      });
      expect(byMatch).toMatchObject({ applied: 1, skipped: 0, failed: 0 });
      expect(await get(entered.row)).toMatchObject({
        status: "posted",
        journalId: handEntered,
        decision: { kind: "match", by: "journal-match" },
      });
      expect(await allJournals(w)).toHaveLength(8);
      for (const { row } of ruleRows) {
        const item = await get(row);
        expect(item.status).toBe("drafted");
        expect(item.decision).toMatchObject({ kind: "accept", principal: "owner" });
        expect(item.decision.by).toMatch(/^rule:/);
      }
      // A transfer is one entry for both of its lines: accepting one side drafts the pair.
      const byMatcher = await w.ok("inbox.accept", {
        filter: { status: ["proposed"] },
        proposer: "transfer",
      });
      expect(byMatcher).toMatchObject({ applied: 2, failed: 0 });
      for (const pair of ["to-rho", "pay-card"]) {
        const sides = rows.filter(
          ({ row }) => "transfer" in row.dest && row.dest.transfer === pair,
        );
        expect(sides, pair).toHaveLength(2);
        const [one, other] = await Promise.all(sides.map(({ row }) => get(row)));
        expect(one).toMatchObject({ status: "drafted", pairItemId: other?.id });
        expect(other).toMatchObject({ status: "drafted", pairItemId: one?.id });
        expect(one?.draftId).toBe(other?.draftId);
      }
      // Every deposit of a payout, the two of equal payouts included: each names its own payout.
      const byStripe = await w.ok("inbox.accept", {
        filter: { provider: "csv", status: ["proposed"] },
        proposer: "stripe",
        minConfidence: 90,
      });
      expect(byStripe).toMatchObject({ applied: 5, failed: 0 });

      // --- the rest by the founder's own hand: one account for a list of lines, a split for the mixed ones.
      const onePlace = new Map<string, string[]>();
      for (const { row } of rows) {
        if (row.how !== "manual" || !("to" in row.dest) || held.has(row)) continue;
        onePlace.set(row.dest.to, [
          ...(onePlace.get(row.dest.to) ?? []),
          (itemOf.get(row) as Json).id,
        ]);
      }
      for (const [account, itemIds] of onePlace) {
        const done = await w.ok("inbox.categorize", { itemIds, accountId: account });
        expect(done, account).toMatchObject({ applied: itemIds.length, skipped: 0, failed: 0 });
      }
      for (const { row, account } of rows) {
        if (!("split" in row.dest)) continue;
        const parts = row.dest.split.map(([accountId, amount]) => ({ accountId, amount }));
        const done = await w.ok("inbox.categorize", {
          itemIds: [(itemOf.get(row) as Json).id],
          splits: parts,
        });
        expect(done).toMatchObject({ applied: 1, failed: 0 });
        // The draft is the line on its own account and each part on its own, adding up to nothing.
        const item = await get(row);
        const legs = new Map<string, bigint>(
          item.decision.legs.map((l: Json) => [l.accountId, cents(l.amount)]),
        );
        expect(legs.get(account)).toBe(cents(row.amount));
        for (const [code, amount] of row.dest.split)
          expect(legs.get(code), `${row.memo} ${code}`).toBe(
            -(cents(row.amount) < 0n ? -cents(amount) : cents(amount)),
          );
        expect([...legs.values()].reduce((a, b) => a + b, 0n)).toBe(0n);
      }
      // A split that does not add up is refused, to the cent, and changes nothing. (The classifier,
      // which learned by itself from the lines decided above, may suggest for the line by now.)
      const personalStatus = (await get(personal.row)).status;
      const wrong = await w.call("inbox.categorize", {
        itemIds: [(itemOf.get(personal.row) as Json).id],
        splits: [
          { accountId: "6200", amount: "10.00" },
          { accountId: "6290", amount: "5.48" },
        ],
      });
      expect(wrong.status === 200 ? wrong.body.data.applied : 0).toBe(0);
      expect((await get(personal.row)).status).toBe(personalStatus);

      // A personal charge on the business account is set aside, with a reason, and is not posted.
      const excluded = await w.ok("inbox.exclude", {
        itemIds: [(itemOf.get(personal.row) as Json).id],
        reason: "Personal subscription paid from the business account",
      });
      expect(excluded).toMatchObject({ applied: 1, failed: 0 });
      expect(await get(personal.row)).toMatchObject({
        status: "excluded",
        exclusion: {
          code: "manual",
          reason: "Personal subscription paid from the business account",
        },
      });

      // --- post: bounded calls that say what remains; nothing drafted is left, nothing failed.
      const drafted = (await w.ok("inbox.summary")).counts.drafted;
      expect(drafted).toBeGreaterThan(60);
      const first = await postAll(w, { status: ["drafted"] });
      // A transfer's two lines are drafted together and posted once: one entry stands for both.
      expect(first).toMatchObject({ applied: drafted - 2, failed: 0, skipped: 0, problems: [] });
      expect((await w.ok("inbox.summary")).counts.drafted).toBe(0);
      const remaining = (await allItems(w, { status: ["new", "proposed", "drafted"] }))
        .map((i) => `${i.ledgerAccountId}|${i.line.date}|${i.line.amount}`)
        .sort();
      expect(remaining).toEqual(
        classifierRows.map(({ row, account }) => `${account}|${row.date}|${row.amount}`).sort(),
      );
      // The book so far is the oracle's, to the cent, account by account.
      const files = { chase: CHASE, rho: rho(), card: CARD };
      expect(differences(await balances(), expectedLedger(files, oracle, held))).toEqual([]);

      // --- the classifier's turn: it learns from what is booked, and suggests for the lines left that
      // resemble it. It learns by itself whenever For review is read after the books moved; telling it
      // to learns at once, and says what it learned from.
      const trained = await w.ok("classifier.train", {});
      expect(trained).toMatchObject({ ready: true });
      expect(trained.examples).toBeGreaterThan(30);
      expect(trained.evaluation.scored).toBeGreaterThan(0);
      for (const { row, account } of classifierRows) {
        const detail = await w.ok("inbox.get", { itemId: (itemOf.get(row) as Json).id });
        const mine = detail.proposals.filter((p: Json) => p.proposer === "classifier");
        expect(mine, row.memo).toHaveLength(1);
        expect(mine[0]).toMatchObject({ kind: "categorize" });
        expect(mine[0].confidence).toBeGreaterThanOrEqual(80);
        expect(mine[0].reasons.join(" ")).toMatch(/lines you booked/);
        expect(mine[0].legs).toEqual([
          { accountId: account, amount: row.amount },
          { accountId: (row.dest as { to: string }).to, amount: neg(row.amount) },
        ]);
      }
      const byClassifier = await w.ok("inbox.accept", {
        itemIds: classifierRows.map(({ row }) => (itemOf.get(row) as Json).id),
        proposer: "classifier",
      });
      expect(byClassifier).toMatchObject({ applied: 3, failed: 0 });
      const second = await postAll(w, { status: ["drafted"] });
      expect(second).toMatchObject({ applied: 3, failed: 0 });
      // Every payout that was paid has its deposit now (finding 7): five matched, the returned one
      // reversed, none left "unmatched", and nothing is overdue.
      const payoutList = (await w.ok("stripe.payouts", {})).payouts as Json[];
      expect(payoutList.filter((p) => p.deposit === "matched")).toHaveLength(5);
      expect(payoutList.filter((p) => p.deposit === "reversed")).toHaveLength(1);
      expect((await w.ok("stripe.status")).payouts).toMatchObject({
        unmatched: 0,
        overdue: 0,
        reversed: 1,
      });

      // --- the Inbox is worked: everything is posted but the line set aside (and the seven before the cutover).
      const counts = (await w.ok("inbox.summary")).counts;
      const postedRows = rows.filter((r) => r !== personal);
      expect(counts).toMatchObject({
        new: 0,
        proposed: 0,
        drafted: 0,
        excluded: 8,
        beforeCutover: 7,
        toReview: 0,
      });
      expect(counts.posted).toBe(postedRows.length + 30);
      const journals = await allJournals(w);
      const pairs = 2;
      expect(journals).toHaveLength(1 + oracle.length + postedRows.length - pairs);
      expect(
        differences(await balances(), expectedLedger(files, oracle, new Set([personal.row]))),
      ).toEqual([]);

      // --- provenance: every posted line says where it came from, and the ledger agrees.
      const batchOf: Record<string, string> = { "1000": "chase", "1010": "rho", "2000": "card" };
      for (const { row, account } of postedRows) {
        const item = await get(row);
        expect(item.status, row.memo).toBe("posted");
        const detail = await w.ok("inbox.get", { itemId: item.id });
        const { provenance } = detail;
        expect(provenance.rawSha256).toBe(received[batchOf[account] as string]?.sha256);
        expect(provenance.evidenceReference).toBe(
          `ingest:${provenance.batchId}:${provenance.rawIndex}`,
        );
        expect(provenance.sourceEventId).toMatch(/^ingest-csv-[0-9a-f]{32}$/);
        if (row.how === "entered") {
          // The entry is the one the founder wrote by hand and the line is linked to it. Nothing was
          // made from the line, so the entry's source is the hand's, not the file's; the line's history
          // says who matched it.
          expect(item.journalId, row.memo).toBe(handEntered);
          expect(item.decision).toMatchObject({ kind: "match", by: "journal-match" });
          const mine = await w.ok("journal.get", { journalId: handEntered });
          expect(mine.source?.id ?? null).not.toBe(provenance.sourceEventId);
          expect(mine.narration).toBe("March rent, entered by hand");
          expect(detail.history.map((h: Json) => [h.kind, h.by])).toContainEqual([
            "match",
            "journal-match",
          ]);
          continue;
        }
        const journal = await w.ok("journal.get", { journalId: item.journalId });
        // Every line names the one source its entry is posted under, and the ledger has it: a transfer
        // is one entry under the identity of the line the person acted on, and both lines say so
        // (finding 6).
        expect(provenance.sourceEventId, row.memo).toBe(journal.source.id);
        const source = await w.ok("sources.get", { sourceId: journal.source.id });
        expect(source).toMatchObject({ status: "posted", journalId: item.journalId });
        expect(source.source.evidenceReference).toMatch(/^ingest:bt_[0-9a-f]+:\d+$/);
        if (!item.pairItemId)
          expect(source.source.evidenceReference).toBe(provenance.evidenceReference);
        // Hostile text is data all the way down: whatever the memo said, the narration the books keep
        // has no disguised characters, and the memo's own words are not acted on.
        expect(journal.narration, row.memo).not.toMatch(DISGUISES);
        expect(detail.history.map((h: Json) => h.kind)).toContain("post");
        expect(
          detail.history.every(
            (h: Json) => h.by === "owner" || /^(rule:|classifier|stripe|transfer)/.test(h.by),
          ),
        ).toBe(true);
      }
      const hostile = await get(CHASE.find((r) => r.memo === HOSTILE.instruction) as Row);
      expect((await w.ok("journal.get", { journalId: hostile.journalId })).narration).toContain(
        "ignore your rules",
      );
      // A transfer's two lines are one journal.
      const [pairA, pairB] = rows.filter(
        ({ row }) => "transfer" in row.dest && row.dest.transfer === "to-rho",
      );
      expect((await get((pairA as (typeof rows)[number]).row)).journalId).toBe(
        (await get((pairB as (typeof rows)[number]).row)).journalId,
      );

      // --- a second post changes nothing: no new entry, and the book's revision does not move.
      const revision = async () => (await w.ok("reports.get", { asOf: MONTH.to })).bookRevision;
      const before = await revision();
      const again = await w.ok("inbox.post", { filter: {} });
      expect(again).toMatchObject({ applied: 0, failed: 0 });
      const asked = await w.ok("inbox.post", { filter: { status: ["posted"] } });
      expect(asked.applied).toBe(0);
      expect(await allJournals(w)).toHaveLength(journals.length);
      expect(await revision()).toBe(before);

      // The files are imported again, after everything in them was posted, and Stripe is synced
      // again: nothing is new, nothing is doubled, nothing is proposed a second time.
      const settledCounts = (await w.ok("inbox.summary")).counts;
      for (const file of FILES) {
        const again = await w.ok("import.commit", received[file.name]?.input);
        expect(again.counts, file.name).toMatchObject({ new: 0, duplicate: 0 });
      }
      const resync = await w.ok("stripe.sync");
      expect(resync.run).toMatchObject({ disposition: "complete", newLines: 0, heldLines: 0 });
      expect((await w.ok("inbox.summary")).counts).toEqual(settledCounts);
      expect(await allJournals(w)).toHaveLength(journals.length);
    },
    120_000,
  );

  // =============================================================================================
  step("f. reconcile every account to its statement at exactly 0.00", async () => {
    const rows = bookedRows();
    const personal = rows.find(({ row }) => "personal" in row.dest) as (typeof rows)[number];
    const oracle = payoutEntries(w.scenario);
    const files = { chase: CHASE, rho: rho(), card: CARD };
    const march = (await w.ok("periods.list")).periods.find((p: Json) => p.startsOn === MONTH.from);
    const unreconciled = async (): Promise<Map<string, string>> => {
      const prepared = await w.ok("periods.prepare", {
        periodId: march.id,
        operation: "close",
        reason: "March is reconciled and reviewed",
      });
      expect(prepared.valid).toBe(true); // a warning never blocks
      return new Map(
        (prepared.warnings ?? [])
          .filter((x: Json) => x.code === "period_unreconciled")
          .map((x: Json) => [/^(\d+) /.exec(x.message)?.[1] as string, x.message as string]),
      );
    };

    // Before anything is reconciled, closing the month says which bank accounts have lines that are
    // not on a statement, and how many: the opening entry and each posted line.
    const before = await unreconciled();
    seen.warnedBeforeReconciling = [...before.keys()].sort();
    // Every account a statement was imported for, the card included though it is not cash: the close
    // warns about it as the cutover checklist blocks on it (finding 4).
    expect(seen.warnedBeforeReconciling).toEqual(["1000", "1010", "2000"]);
    // (the opening entry and every posted line of the file but the personal one)
    expect(before.get("1000")).toContain(`${booked(CHASE).length} postings`);
    expect(before.get("1010")).toContain(`${1 + booked(rho()).length} postings`);
    // The checklist agrees: the three statement accounts are blocked, and so is the missing backup.
    const checklist = await w.ok("cutover.checklist");
    expect(checklist).toMatchObject({
      cutover: { date: CUTOVER },
      opening: { status: "posted" },
      period: { label: "March 2026", ended: true },
    });
    expect(checklist.verdict.state).toBe("not_yet");
    expect(
      checklist.verdict.blocking
        .filter((b: Json) => b.code === "never_reconciled")
        .map((b: Json) => b.accountId)
        .sort(),
    ).toEqual(["1000", "1010", "2000"]);

    // --- Chase: 11,125.71 is what the statement says. The books say 15.49 more, because the
    // Netflix line was set aside as personal and the bank still paid it.
    const statement = dec(closing(CHASE, "1000"));
    const check = (await w.ok("inbox.balanceChecks")).checks[0];
    expect(check).toMatchObject({
      reported: statement,
      waiting: "0.00",
      excluded: personal.row.amount,
    });
    // The import's own check explains the whole gap: reported = ledger + waiting + excluded.
    expect(check.difference).toBe("0.00");
    const booksWithout = expectedLedger(files, oracle, new Set([personal.row])).get(
      "1000",
    ) as bigint;
    expect(check.ledger).toBe(dec(booksWithout));

    const draft = await w.ok("reconcile.start", {
      accountId: "1000",
      statementDate: MONTH.to,
      statementBalance: statement,
    });
    expect(draft).toMatchObject({
      status: "draft",
      statementBalance: statement,
      openingBalance: "0.00",
      bookBalance: dec(booksWithout),
    });
    expect(draft.lines).toHaveLength(booked(CHASE).length); // the opening entry and every posted line
    const selected = await w.ok("reconcile.setCleared", {
      id: draft.id,
      expectedVersion: draft.version,
      reset: "all",
    });
    expect(selected).toMatchObject({
      selectedTotal: dec(booksWithout),
      difference: personal.row.amount,
      canComplete: false,
    });
    const refused = await w.call("reconcile.complete", {
      id: draft.id,
      expectedVersion: selected.version,
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.error.message).toContain(personal.row.amount);

    // The founder books the line as what it was, an owner's draw, and refreshes the lines.
    const item = itemOf.get(personal.row) as Json;
    await w.ok("inbox.restore", {
      itemIds: [item.id],
      reason: "It is a personal expense: book it as a draw",
    });
    await w.ok("inbox.categorize", { itemIds: [item.id], accountId: "3100" });
    expect(await postAll(w, { status: ["drafted"] })).toMatchObject({ applied: 1, failed: 0 });
    const stale = await w.ok("reconcile.get", { id: draft.id });
    expect(stale.stale).toBe(true);
    const refreshed = await w.ok("reconcile.setStatement", {
      id: draft.id,
      expectedVersion: stale.version,
      statementDate: MONTH.to,
      statementBalance: statement,
    });
    expect(refreshed.lines).toHaveLength(booked(CHASE).length + 1);
    const all = await w.ok("reconcile.setCleared", {
      id: draft.id,
      expectedVersion: refreshed.version,
      reset: "all",
    });
    expect(all).toMatchObject({ difference: "0.00", canComplete: true, clearedBalance: statement });
    const done = await w.ok("reconcile.complete", { id: draft.id, expectedVersion: all.version });
    expect(done).toMatchObject({
      status: "completed",
      difference: "0.00",
      statementBalance: statement,
    });
    expect(done.recordHash).toMatch(/^[0-9a-f]{64}$/);
    expect(done.completedAt).not.toBeNull();
    // The Inbox shows what the reconciliation did (finding 14): each posted line of the Chase file is
    // on this record, with its statement date, and no other line says it is reconciled.
    const chasePosted = (await allItems(w, { status: ["posted"], provider: "csv" })).filter(
      (item) => item.ledgerAccountId === "1000",
    );
    const marked = (await allItems(w, { status: ["posted"] })).filter((item) => item.reconciled);
    expect(marked.map((item) => item.id).sort()).toEqual(chasePosted.map((item) => item.id).sort());
    expect(chasePosted).toHaveLength(done.lines.length - 1); // every line but the opening entry
    for (const item of marked)
      expect(item.reconciled).toEqual({ reconciliationId: done.id, statementDate: MONTH.to });
    const markedItem = marked[0] as Json;
    expect((await w.ok("inbox.get", { itemId: markedItem.id })).item.reconciled).toEqual({
      reconciliationId: done.id,
      statementDate: MONTH.to,
    });
    // Now the books, the oracle and the statement are one figure, and the import's check is quiet.
    expect(differences(await balances(), expectedLedger(files, oracle))).toEqual([]);
    expect((await w.ok("inbox.balanceChecks")).checks[0]).toMatchObject({
      excluded: "0.00",
      difference: "0.00",
      ledger: statement,
    });

    // --- Rho and the card: the statement's closing balance, typed as printed (a card's balance owed is positive).
    const records: Record<string, Json> = { "1000": done };
    for (const [account, rowsOf] of [
      ["1010", rho()],
      ["2000", CARD],
    ] as const) {
      const printed = dec(closing(rowsOf, account));
      const started = await w.ok("reconcile.start", {
        accountId: account,
        statementDate: MONTH.to,
        statementBalance: printed,
      });
      expect(started.lines).toHaveLength(1 + booked(rowsOf).length);
      expect(started.openingBalance).toBe("0.00");
      const picked = await w.ok("reconcile.setCleared", {
        id: started.id,
        expectedVersion: started.version,
        reset: "all",
      });
      expect(picked).toMatchObject({
        difference: "0.00",
        canComplete: true,
        clearedBalance: printed,
      });
      records[account] = await w.ok("reconcile.complete", {
        id: started.id,
        expectedVersion: picked.version,
      });
      expect(records[account]).toMatchObject({ status: "completed", statementBalance: printed });
    }
    // Every account's status is now: reconciled to the month end, nothing left uncleared.
    const status = (await w.ok("reconcile.status")).accounts;
    for (const code of ["1000", "1010", "2000"]) {
      const row = status.find((a: Json) => a.account.code === code);
      expect(row, code).toMatchObject({
        lastReconciledDate: MONTH.to,
        lastReconciledBalance: records[code]?.statementBalance,
        unclearedCount: 0,
        openReconciliationId: null,
      });
    }

    // The Inbox says so for every account: each posted line of a file is on its own account's record.
    for (const item of await allItems(w, { status: ["posted"], provider: "csv" }))
      expect(
        item.reconciled?.reconciliationId,
        `${item.ledgerAccountId} ${item.line.date} ${item.line.description}`,
      ).toBe(records[item.ledgerAccountId as string]?.id);

    // --- reversing an entry that is on a statement is allowed, and the plan says what it does to it.
    const rent = rows.find(
      ({ row }) => row.memo === "RENT PAYMENT ACH WEWORK" && row.date === "2026-03-01",
    ) as (typeof rows)[number];
    const rentItem = (await w.ok("inbox.get", { itemId: (itemOf.get(rent.row) as Json).id })).item;
    const reversal = await w.ok("journal.prepareReverse", {
      journalId: rentItem.journalId,
      accountingDate: MONTH.to,
      reason: "Probe: this line is on a reconciled statement",
    });
    expect(reversal.warnings.map((x: Json) => x.code)).toContain("cleared_posting_corrected");
    expect(JSON.stringify(reversal.warnings)).toContain(
      "1000 Chase business checking, statement ending 2026-03-31",
    );

    // --- immutability: a completed record cannot be edited, replaced or reached around.
    const id = (records["1000"] as Json).id;
    for (const [name, input] of [
      ["reconcile.setCleared", { id, expectedVersion: 1, reset: "none" }],
      [
        "reconcile.setStatement",
        { id, expectedVersion: 1, statementDate: MONTH.to, statementBalance: "1.00" },
      ],
      ["reconcile.discard", { id, expectedVersion: 1 }],
      [
        "reconcile.start",
        { accountId: "1000", statementDate: MONTH.to, statementBalance: statement },
      ],
    ] as const) {
      const refusedAgain = await w.call(name, input);
      expect(refusedAgain.status, name).toBeGreaterThanOrEqual(400);
      expect(refusedAgain.body.ok).toBe(false);
    }
    for (const sql of [
      "UPDATE recon_sessions SET statement_balance='5.00' WHERE id=?",
      "UPDATE recon_sessions SET record_hash='x' WHERE id=?",
      "DELETE FROM recon_sessions WHERE id=?",
      "UPDATE recon_lines SET amount='0.01' WHERE session_id=?",
      "DELETE FROM recon_lines WHERE session_id=?",
    ])
      expect(() => w.service.store.query(sql).run(id), sql).toThrow(/immutable/);
    // What a completed record says is fixed from here on; the story checks it again at the end.
    for (const [code, record] of Object.entries(records)) {
      sealed[code] = await w.ok("reconcile.get", { id: record.id });
      expect(sealed[code]).toMatchObject({ status: "completed", recordHash: record.recordHash });
    }

    // --- closing the month no longer warns about the accounts that were reconciled.
    const after = await unreconciled();
    for (const code of ["1000", "1010", "2000"]) expect(after.has(code), code).toBe(false);
  });

  // =============================================================================================
  step("g. profit and loss, balance sheet, cash flow and the CSV export, to the cent", async () => {
    const oracle = payoutEntries(w.scenario);
    const ledger = expectedLedger({ chase: CHASE, rho: rho(), card: CARD }, oracle);
    const figures = profitLoss(ledger);
    const report = await w.ok("reports.get", { from: MONTH.from, asOf: MONTH.to });
    expect(report).toMatchObject({
      basis: "cash",
      currency: "USD",
      periodStart: MONTH.from,
      asOf: MONTH.to,
      warnings: [],
    });

    // Profit and loss: every account's activity for the month is the oracle's, and so are the totals.
    // (Worked by hand from the fixtures: 4,556.00 of sales, 5.00 of refunds, 2.05 of interest.)
    const pl = report.profitAndLoss;
    for (const row of pl.rows)
      expect(row.amount, `profit and loss ${row.code}`).toBe(
        dec(figures.revenue.get(row.code) ?? figures.expenses.get(row.code) ?? 0n),
      );
    expect(pl).toMatchObject({
      revenue: dec(figures.totalRevenue),
      expenses: dec(figures.totalExpenses),
      netIncome: dec(figures.netIncome),
    });
    expect(pl.revenue).toBe("4553.05");
    expect(pl.netIncome).toBe("-1338.11");
    expect(pl.rows.find((r: Json) => r.code === "4100").amount).toBe("-5.00"); // refunds reduce revenue

    // The balance sheet at the month end: each account as the oracle holds it (a liability or equity
    // account shown the way it is read, positive when it owes), and the equation holds.
    const bs = report.balanceSheet;
    const sign = (role: string): bigint => (role === "asset" ? 1n : -1n);
    for (const row of bs.rows)
      expect(row.amount, `balance sheet ${row.code}`).toBe(
        dec(sign(row.role) * (ledger.get(row.code) ?? 0n)),
      );
    const total = (role: string): bigint =>
      bs.rows
        .filter((r: Json) => r.role === role)
        .reduce((sum: bigint, r: Json) => sum + cents(r.amount), 0n);
    expect(bs).toMatchObject({
      assets: dec(total("asset")),
      liabilities: dec(total("liability")),
      currentEarnings: dec(figures.netIncome),
      priorEarnings: "0.00",
      balanced: true,
      difference: "0.00",
    });
    expect(cents(bs.assets)).toBe(
      cents(bs.liabilities) + cents(bs.contributedEquity) + cents(bs.currentEarnings),
    );
    expect(bs.rows.find((r: Json) => r.code === "1000").amount).toBe(
      sealed["1000"]?.statementBalance,
    );
    expect(bs.rows.find((r: Json) => r.code === "2000").amount).toBe(
      sealed["2000"]?.statementBalance,
    );

    // The trial balance is the oracle's book, and balances.
    for (const row of report.trialBalance.rows)
      expect(cents(row.signedBalance), `trial balance ${row.code}`).toBe(
        ledger.get(row.code) ?? 0n,
      );
    expect(report.trialBalance).toMatchObject({ balanced: true });
    expect(report.trialBalance.debit).toBe(report.trialBalance.credit);

    // Cash flow: the cash accounts end where the oracle says, the statement ties to the balance
    // sheet, and the lines whose meaning does not depend on where the opening entry is dated are right
    // (equipment is investing, draws are financing, sales tax collected is operating).
    const flow = await w.ok("reports.cashFlow", { from: MONTH.from, asOf: MONTH.to });
    expect(flow).toMatchObject({ basis: "cash", available: true, ties: true, warnings: [] });
    const cashNow = CASH_CODES.reduce((sum, code) => sum + (ledger.get(code) ?? 0n), 0n);
    expect(flow.closingCash).toBe(dec(cashNow));
    expect(flow.closingCash).toBe(
      dec(
        CASH_CODES.reduce(
          (sum, code) => sum + cents(bs.rows.find((r: Json) => r.code === code).amount),
          0n,
        ),
      ),
    );
    for (const account of flow.cashAccounts as Json[])
      expect(String(account.closing), String(account.code)).toBe(
        dec(ledger.get(account.code) ?? 0n),
      );
    expect(cents(flow.openingCash) + cents(flow.netChange)).toBe(cents(flow.closingCash));
    const line = (section: string, code: string): string =>
      flow.sections.find((s: Json) => s.key === section).lines.find((l: Json) => l.code === code)
        ?.amount;
    expect(flow.sections.find((s: Json) => s.key === "operating").lines[0]).toMatchObject({
      group: "netIncome",
      amount: dec(figures.netIncome),
    });
    expect(flow.sections.find((s: Json) => s.key === "investing").total).toBe("-200.00");
    expect(line("investing", "1500")).toBe("-200.00");
    expect(line("financing", "3100")).toBe(dec(-(ledger.get("3100") ?? 0n)));
    expect(line("operating", "2500")).toBe(dec(-(ledger.get("2500") ?? 0n)));

    // The same figures come back as CSV, and no text a bank wrote can run as a formula in a spreadsheet.
    const exported = await w.ok("reports.export", {
      statement: "profit-loss",
      from: MONTH.from,
      asOf: MONTH.to,
    });
    const table = parseCsv(exported.content);
    const header = table.findIndex((cells) => cells[0] === "Account ID");
    for (const row of pl.rows) {
      const cells = table.slice(header + 1).find((cells) => cells[1] === row.code);
      expect(cells?.[4], `csv ${row.code}`).toBe(row.amount);
    }
    const ledgerCsv = parseCsv(
      (
        await w.ok("reports.export", {
          statement: "general-ledger",
          from: MONTH.from,
          asOf: MONTH.to,
        })
      ).content,
    );
    const first = ledgerCsv.findIndex((cells) => cells[0] === "Row");
    const detail = ledgerCsv.slice(first + 1).filter((cells) => cells[0] === "line");
    // One line per leg of every entry dated in the month: each payout's, and each statement line's two
    // (a split's parts, a transfer's one each side). The opening entry is dated the day before the
    // month starts, so it is where the ledger starts from, not one of its lines.
    const linesOfRow = (row: Row): number =>
      "transfer" in row.dest ? 1 : "split" in row.dest ? 1 + row.dest.split.length : 2;
    expect(detail.length).toBe(
      oracle.reduce((n, p) => n + p.legs.size, 0) +
        bookedRows().reduce((n, { row }) => n + linesOfRow(row), 0),
    );
    expect(unsafeCells(ledgerCsv)).toEqual([]);
    const descriptions = new Set(detail.map((cells) => cells[5]));
    for (const memo of [HOSTILE.formula, HOSTILE.at, HOSTILE.minus])
      expect(descriptions, memo).toContain(`'${memo}`);
    expect([...descriptions].some((d) => d?.startsWith(`'${HOSTILE.plus}`))).toBe(true);
    // Money stays a number: debits and credits are exact decimals, never quoted.
    for (const cells of detail) for (const cell of cells.slice(6, 9)) expect(cell).toMatch(MONEY);
  });

  // =============================================================================================
  step(
    "h. back up and prove it, close the month, back up again, export, restart",
    async () => {
      const oracle = payoutEntries(w.scenario);
      const ledger = expectedLedger({ chase: CHASE, rho: rho(), card: CARD }, oracle);
      const liveJournals = (await allJournals(w)).length;
      const march = (await w.ok("periods.list")).periods.find(
        (p: Json) => p.startsOn === MONTH.from,
      );

      // Reconciled, the only thing in the way of closing is a backup that has been proved.
      const asked = await w.ok("cutover.checklist");
      expect(asked.verdict.state).toBe("not_yet");
      expect(asked.verdict.blocking.map((b: Json) => b.code)).toEqual(["no_verified_backup"]);
      expect(asked.verdict.attention.map((b: Json) => b.code)).toContain("drill_never_run");

      // A backup is a whole copy of the book, taken while it is in use; the file on disk is the one the
      // record describes (its SHA-256 is computed here, not read back), and it holds no secret.
      const proved = async (withDrill: boolean): Promise<{ backup: Json; drill: Json | null }> => {
        const live = (await w.ok("backup.status")).liveHead;
        const made = await w.job("backup.create");
        expect(made).toMatchObject({ state: "done", kind: "backup" });
        const backup = made.backup;
        expect(backup).toMatchObject({
          head: live,
          fileState: "present",
          bookName: "Willow Lane Studio",
        });
        const directory = (await w.ok("backup.list")).directory;
        const bytes = readFileSync(join(directory, backup.fileName));
        expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(backup.sha256);
        expect(bytes.includes(KEY)).toBe(false);
        expect(bytes.includes("Bearer")).toBe(false);

        // Verifying replays every command through the kernel on a copy, and every check passes.
        const verified = await w.job("backup.verify", { backupId: backup.id });
        expect(verified.verification).toMatchObject({ passed: true, head: live });
        expect(verified.verification.journals).toBe((await allJournals(w)).length);
        expect(verified.verification.outcomes).toBe(Number(live.sequence));
        expect(verified.verification.checks.map((c: Json) => `${c.code}:${c.status}`)).toEqual(
          [
            "file_present",
            "file_sha256",
            "integrity",
            "ledger_stored",
            "ledger_replay",
            "ledger_head",
          ].map((code) => `${code}:passed`),
        );
        if (!withDrill) return { backup, drill: null };
        // The drill restores it to a scratch place and compares it with the live book: the head, the
        // chain and every account's balance.
        const ran = await w.job("backup.drill");
        expect(ran.drill).toMatchObject({
          passed: true,
          backupId: backup.id,
          changesSince: 0,
          mismatches: [],
          restoredHead: live,
          liveHead: live,
        });
        expect(ran.drill.accountsCompared).toBe((await w.ok("accounts.list")).accounts.length);
        expect(ran.drill.checks.every((c: Json) => c.status === "passed")).toBe(true);
        return { backup, drill: ran.drill };
      };
      const first = await proved(false);
      const status = await w.ok("backup.status");
      expect(status).toMatchObject({ backupCount: 1, changesSinceLatest: 0, lastDrill: null });
      expect(status.latestVerified.id).toBe(first.backup.id);
      expect(status.warnings.filter((x: Json) => x.tone === "error")).toEqual([]);

      // Now nothing blocks the close, and the checklist says so.
      const ready = await w.ok("cutover.checklist");
      expect(ready.verdict).toMatchObject({ state: "ready", blocking: [] });
      seen.readyAttention = ready.verdict.attention.map((b: Json) => b.code);
      // Nothing about Stripe deposits is waiting, so the checklist does not say that something is
      // "normal for a payout sent in the last day or two" (finding 7).
      expect(seen.readyAttention).not.toContain("stripe_deposits_unmatched");
      expect(seen.readyAttention).not.toContain("stripe_deposits_overdue");

      // --- close March: reconciled, so no reconcile warning; one sealed, previewed, hash-checked command.
      const prepared = await w.ok("periods.prepare", {
        periodId: march.id,
        operation: "close",
        reason: "March is reconciled to every statement and reviewed",
      });
      expect(prepared.valid).toBe(true);
      expect(
        (prepared.warnings ?? []).filter((x: Json) => x.code === "period_unreconciled"),
      ).toEqual([]);
      // January and February end before the books began (the cutover is on 1 March) and hold none of
      // them: closing March is not out of order, and the calendar says which periods they are
      // (finding 8). Everything from March on is the books' own.
      expect((prepared.warnings ?? []).map((x: Json) => x.code)).not.toContain(
        "earlier_period_open",
      );
      const calendar = await w.ok("periods.list");
      expect(calendar.calendar.booksBegan).toBe(CUTOVER);
      expect(
        calendar.periods.filter((p: Json) => p.beforeBooks).map((p: Json) => p.startsOn),
      ).toEqual(["2026-01-01", "2026-02-01"]);
      expect(calendar.calendar.fiscalYears[0]).toMatchObject({
        periodCount: 10,
        periodsBeforeBooks: 2,
      });
      const closed = await w.ok("operations.commit", {
        planId: prepared.planId,
        planHash: prepared.planHash,
      });
      expect(closed.disposition).toBe("committed");
      const after = (await w.ok("periods.list")).periods.find((p: Json) => p.id === march.id);
      expect(after).toMatchObject({ status: "closed" });
      expect(after.closePackageId).not.toBeNull();
      // The close recorded the books it closed over, and the Reports lane reproduces them exactly.
      const justBefore = String(Number(after.closingRevision) - 1);
      const hashes = await Promise.all(
        [{ from: MONTH.from }, {}].map(
          async (range) =>
            (await w.ok("reports.get", { asOf: MONTH.to, revision: justBefore, ...range }))
              .populationHash,
        ),
      );
      expect(hashes).toContain(after.reportPopulationHash);
      const reproduced = await w.ok("reports.get", { from: MONTH.from, asOf: MONTH.to });
      // The month is locked: an entry dated in it is refused, in words, and nothing is posted.
      const late = await w.ok("drafts.create", {
        data: {
          date: "2026-03-15",
          reference: "LATE",
          narration: "A late entry",
          lines: [
            { accountId: "6290", debit: "10.00", credit: "" },
            { accountId: "1000", debit: "", credit: "10.00" },
          ],
        },
      });
      const refused = await w.ok("journal.prepare", {
        draftId: late.id,
        expectedVersion: late.version,
      });
      expect(refused.valid).toBe(false);
      expect(JSON.stringify(refused.problems)).toMatch(/closed/i);
      expect(await allJournals(w)).toHaveLength(liveJournals);
      // Closing March is what proves the first month of the shadow run.
      expect((await w.ok("cutover.checklist")).shadowRun).toMatchObject({
        provenCount: 1,
        required: 2,
        complete: false,
      });

      // --- the book as it is now (the close is a command too) is backed up and proved again, and a
      // restored copy is this book, head for head.
      const second = await proved(true);
      expect(Number(second.backup.head.sequence)).toBeGreaterThan(
        Number(first.backup.head.sequence),
      );
      const list = await w.ok("backup.list");
      expect(list.backups.map((b: Json) => b.id)).toEqual([second.backup.id, first.backup.id]);
      const afterProof = await w.ok("backup.status");
      expect(afterProof.latestVerified.id).toBe(second.backup.id);
      expect(afterProof.lastDrill).toMatchObject({ passed: true, backupId: second.backup.id });
      // The checklist (now about April, which has not ended) no longer says a drill was never run.
      expect(
        (await w.ok("cutover.checklist")).verdict.attention.map((b: Json) => b.code),
      ).not.toContain("drill_never_run");

      // --- the open export: every journal, every sealed command, and CSV a spreadsheet cannot be fooled
      // by; it rebuilds an identical book by replay.
      const live = (await w.ok("backup.status")).liveHead;
      const exported = (await w.job("export.create")).export;
      expect(exported).toMatchObject({ format: "rastrata-export-v1", head: live });
      expect(exported.counts).toMatchObject({
        journals: liveJournals,
        commands: Number(live.sequence),
      });
      const names = exported.files.map((f: Json) => f.path);
      for (const name of [
        "README.md",
        "book.json",
        "journals.jsonl",
        "commands.jsonl",
        "chart.csv",
        "general-ledger.csv",
        "trial-balance.csv",
      ])
        expect(names, name).toContain(name);
      // The manifest names every file with its size and SHA-256, and hashes itself.
      expect(
        JSON.parse(readFileSync(join(exported.location, "manifest.json"), "utf8")),
      ).toMatchObject({
        format: "rastrata-export-v1",
      });
      const read = (name: string): string => readFileSync(join(exported.location, name), "utf8");
      expect(read("journals.jsonl").trim().split("\n")).toHaveLength(liveJournals);
      const tb = parseCsv(read("trial-balance.csv"));
      expect(unsafeCells(tb)).toEqual([]);
      const exportedLedger = parseCsv(read("general-ledger.csv"));
      expect(unsafeCells(exportedLedger)).toEqual([]);
      expect(exportedLedger.some((cells) => cells.includes(`'${HOSTILE.formula}`))).toBe(true);
      const rebuilt = join(w.directory, "rebuilt.sqlite");
      const imported = await importOpenExport({ directory: exported.location, to: rebuilt });
      expect(imported.head).toMatchObject({ chainHash: live.chainHash });
      const copy = await LocalBookService.open(rebuilt, { now: () => new Date(w.clock.ms) });
      try {
        const rebuiltList = await askOwner(copy, "accounts.list");
        const rebuiltBalances = new Map<string, bigint>(
          rebuiltList.accounts.map((a: Json) => [a.code, cents(a.balance)]),
        );
        expect(differences(rebuiltBalances, await balances())).toEqual([]);
        expect(
          (await askOwner(copy, "reports.get", { from: MONTH.from, asOf: MONTH.to }))
            .populationHash,
        ).toBe(reproduced.populationHash);
      } finally {
        copy.close();
      }

      // --- a restart loses nothing: every lane's own state is where it was.
      const before = {
        inbox: (await w.ok("inbox.summary")).counts,
        rules: (await w.ok("rules.list")).rulesRevision,
        classifier: (await w.ok("classifier.status")).modelVersion,
        report: (await w.ok("reports.get", { from: MONTH.from, asOf: MONTH.to })).populationHash,
        stripe: (await w.ok("stripe.status")).lastSync.id,
        records: Object.fromEntries(
          await Promise.all(
            Object.entries(sealed).map(async ([code, record]) => [
              code,
              (await w.ok("reconcile.get", { id: record.id })).recordHash,
            ]),
          ),
        ),
      };
      await w.restart();
      expect((await w.ok("inbox.summary")).counts).toEqual(before.inbox);
      expect((await w.ok("rules.list")).rulesRevision).toBe(before.rules);
      expect((await w.ok("classifier.status")).modelVersion).toBe(before.classifier);
      expect((await w.ok("reports.get", { from: MONTH.from, asOf: MONTH.to })).populationHash).toBe(
        before.report,
      );
      expect((await w.ok("stripe.status")).lastSync.id).toBe(before.stripe);
      expect((await w.ok("backup.status")).liveHead).toEqual(live);
      expect(differences(await balances(), ledger)).toEqual([]);
      for (const [code, record] of Object.entries(sealed)) {
        const again = await w.ok("reconcile.get", { id: record.id });
        expect(again.recordHash, code).toBe(before.records[code]);
        expect(again).toEqual(record); // completed records do not change: not by a close, a backup or a restart
      }
    },
    120_000,
  );

  // =============================================================================================
  step(
    "i. an agent with read and draft can propose, not post, close or mint tokens; bad tokens are 401",
    async () => {
      const issued = await w.ok("tokens.create", {
        label: "Claude Code",
        permissions: ["read", "draft"],
      });
      const secret = issued.secret as string;
      const tokenId = issued.token.id as string;
      expect(secret).toMatch(/^rst_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
      expect(issued.token).toMatchObject({
        label: "Claude Code",
        permissions: ["read", "draft"],
        status: "active",
        createdBy: "owner",
      });
      const as = (name: string, input: unknown = {}) => w.call(name, input, { credential: secret });
      const me = await as("book.get");
      expect(me.status).toBe(200);
      expect(me.body.data.principal).toMatchObject({
        kind: "token",
        tokenId,
        label: "Claude Code",
      });
      // What the agent is told it can call is exactly the read and draft operations of the whole catalog.
      const caps = await as("capabilities.get");
      expect(caps.body.data.permissions).toEqual(["read", "draft"]);
      const allowed = operationCatalog
        .filter((op) => permitsOperation(["read", "draft"], op))
        .map((op) => op.name)
        .sort();
      expect(caps.body.data.operations.map((op: Json) => op.name).sort()).toEqual(allowed);
      expect(allowed).toContain("inbox.categorize");
      for (const never of [
        "inbox.post",
        "periods.prepare",
        "reconcile.complete",
        "tokens.create",
        "backup.create",
      ])
        expect(allowed).not.toContain(never);

      // It imports April's first days, as an agent may (read and draft), and proposes: it accepts what
      // the rules suggest and categorizes the one line no rule covers. The bank's file starts three
      // days back, as exports do, so its first three lines are March's last: seen already, not new.
      const april = chaseCsv(APRIL_FILE, aprilFileOpening());
      const upload = await w.upload(april, "chase-april.csv", "text/csv", secret);
      expect(upload.status).toBe(200);
      const input = { sha256: upload.body.data.sha256, ledgerAccountId: "1000" };
      const preview = await as("import.preview", input);
      expect(preview.body.data).toMatchObject({
        valid: true,
        counts: { new: 4, overlap: 3, duplicate: 0, excluded: 0 },
      });
      // The statement's balance, read against the books: what is waiting explains the difference.
      expect(preview.body.data.balances[0]).toMatchObject({
        reported: dec(closing(CHASE, "1000") + APRIL.reduce((n, row) => n + cents(row.amount), 0n)),
        ledger: dec(closing(CHASE, "1000")),
        waiting: dec(APRIL.reduce((n, row) => n + cents(row.amount), 0n)),
        difference: "0.00",
      });
      expect((await as("import.commit", input)).status).toBe(200);
      const mine = await allItems(w, { status: ["new", "proposed"] });
      expect(mine).toHaveLength(4);
      const byRule = await as("inbox.accept", {
        filter: { status: ["new", "proposed"] },
        proposer: "rule",
        minConfidence: 90,
      });
      expect(byRule.body.data).toMatchObject({ applied: 3, failed: 0 });
      const bolt = mine.find((i) => i.line.description.startsWith("BOLT RIDE")) as Json;
      const categorized = await as("inbox.categorize", { itemIds: [bolt.id], accountId: "6160" });
      expect(categorized.body.data).toMatchObject({ applied: 1, failed: 0 });
      // Everything it did is recorded as the agent, never as the owner; it cannot pass as a person.
      const drafted = await allItems(w, { status: ["drafted"] });
      expect(drafted).toHaveLength(4);
      for (const item of drafted) expect(item.decision.principal).toBe(`agent:${tokenId}`);
      const rule = await as("rules.create", {
        rule: {
          name: "Rides",
          conditions: contains("BOLT RIDE"),
          action: { kind: "categorize", accountId: "6160" },
        },
        madeBy: { kind: "person", name: "Eric" },
      });
      expect(rule.status).toBe(200);
      expect(rule.body.data.createdBy.kind).toBe("agent");
      // It prepares a reconciliation of April's statement, and stops there: signing it off is the owner's.
      const reconciling = await as("reconcile.start", {
        accountId: "1000",
        statementDate: "2026-04-02",
        statementBalance: "1.00",
      });
      expect(reconciling.status).toBe(200);

      // --- what it cannot do: refused before anything is read or changed, with the same answer every time.
      const before = {
        journals: (await allJournals(w)).length,
        counts: (await w.ok("inbox.summary")).counts,
      };
      const plan = await w.ok("drafts.create", {
        data: {
          date: "2026-04-02",
          reference: "OWNER",
          narration: "An entry the owner prepared",
          lines: [
            { accountId: "6290", debit: "1.00", credit: "" },
            { accountId: "1000", debit: "", credit: "1.00" },
          ],
        },
      });
      const prepared = await w.ok("journal.prepare", {
        draftId: plan.id,
        expectedVersion: plan.version,
      });
      const denied: [string, unknown][] = [
        ["operations.commit", { planId: prepared.planId, planHash: prepared.planHash }],
        ["reconcile.complete", { id: sealed["1000"]?.id, expectedVersion: 1 }],
        ["reconcile.void", { id: sealed["1000"]?.id, reason: "no" }],
      ];
      // Every operation of every lane that needs more than read and draft, with an empty request.
      for (const op of operationCatalog)
        if (!permitsOperation(["read", "draft"], op) && op.name !== "operations.commit")
          denied.push([op.name, {}]);
      // (every permission above draft is covered, and every lane that has one of them)
      expect(
        new Set(
          operationCatalog
            .filter((op) => !permitsOperation(["read", "draft"], op))
            .map((op) => op.permission),
        ),
      ).toEqual(new Set(["post", "configure", "correct", "close", "provision"]));
      for (const [name, body] of denied) {
        const refused = await as(name, body);
        expect({ name, status: refused.status, code: refused.body.error?.code }).toEqual({
          name,
          status: 403,
          code: "permission_denied",
        });
      }
      expect(await allJournals(w)).toHaveLength(before.journals);
      expect((await w.ok("inbox.summary")).counts.posted).toBe(before.counts.posted);

      // --- bad credentials are 401 and never fall back to the owner.
      const second = await w.ok("tokens.create", {
        label: "Short",
        permissions: ["read"],
        expiresInDays: 1,
      });
      const revoked = await w.ok("tokens.create", {
        label: "Revoked",
        permissions: ["read", "draft"],
      });
      await w.ok("tokens.revoke", { tokenId: revoked.token.id, reason: "Not needed" });
      const forged = `${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`;
      const unknown = `rst_${"0".repeat(16)}_${"A".repeat(43)}`;
      for (const [why, credential] of [
        ["a secret with one character changed", forged],
        ["an unknown id", unknown],
        ["a revoked token", revoked.secret],
        ["not a token at all", "nope"],
        ["an owner key it cannot have", `rso_${"a".repeat(43)}`],
      ] as const) {
        const bad = await w.call("inbox.post", { filter: {} }, { credential });
        expect({ why, status: bad.status }).toEqual({ why, status: 401 });
        expect(JSON.stringify(bad.body)).not.toContain(secret);
      }
      // An expired token is refused the same way, by the one injected clock.
      w.clock.ms += 2 * 86_400_000;
      const stale = await w.call("book.get", {}, { credential: second.secret });
      expect(stale.status).toBe(401);
      w.clock.ms -= 2 * 86_400_000;

      // --- the owner sees it all: the agent's work, drafted, and its refusals in the trail.
      const trail = await w.ok("tokens.activity", { tokenId });
      const codes = new Set(trail.activity?.map((a: Json) => a.code) ?? JSON.stringify(trail));
      expect(JSON.stringify(trail)).toContain("permission_denied");
      expect(JSON.stringify(trail)).not.toContain(secret);
      const listed = await w.ok("tokens.list");
      expect(JSON.stringify(listed)).not.toContain(secret);
      expect(listed.tokens.find((t: Json) => t.id === tokenId)).toMatchObject({ status: "active" });
      expect(codes.size).toBeGreaterThan(0);

      // The owner reviews and posts what the agent proposed: the gate is where it should be.
      const posted = await postAll(w, { status: ["drafted"] });
      expect(posted).toMatchObject({ applied: 4, failed: 0, problems: [] });
      expect(await allJournals(w)).toHaveLength(before.journals + 4);
      const first = await w.ok("inbox.get", { itemId: bolt.id });
      expect(first.history.map((h: Json) => `${h.kind}:${h.by}`)).toEqual([
        `categorize:agent:${tokenId}`,
        "post:owner",
      ]);

      // The secret was shown once and is stored nowhere: not in a backup of the whole book.
      const backup = (await w.job("backup.create")).backup;
      const bytes = readFileSync(join((await w.ok("backup.list")).directory, backup.fileName));
      expect(bytes.includes(secret)).toBe(false);
      expect(bytes.includes(secret.slice(21))).toBe(false);
    },
    120_000,
  );
});

// ===================================================================================================
// What the story found. Each issue was pinned as a pair of tests (what happened, and what should)
// until its lane fixed it; each is now an ordinary test named "fixed issue N", so it cannot come back.

/** A second book, for an issue that needs one of its own: the same chart, nothing posted. */
async function freshBook(): Promise<World> {
  const fresh = await openWorld();
  const template = await fresh.ok("templates.get", {
    templateId: "sole-proprietor",
    basis: "cash",
    taxYear: 2026,
    addOns: ["online-business"],
  });
  await fresh.ok("book.setup", {
    name: "Second Co",
    currency: "USD",
    fiscalYear: 2026,
    periodModel: "monthly",
    basis: "cash",
    accounts: [
      ...BANK_AND_CARD,
      ...template.accounts.map((a: Json) => ({
        code: a.code,
        name: RENAMED[a.code] ?? a.name,
        role: a.role,
        ...(a.parentCode ? { parentCode: a.parentCode } : {}),
        tags: a.tags,
      })),
    ],
  });
  return fresh;
}

/** A value worked out once, by whichever of an issue's two tests asks first. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | null = null;
  return () => {
    value ??= make();
    return value;
  };
}

describe("known issues", () => {
  // 1 (fixed) --------------------------------------------------------------------------------------
  test("fixed issue 1 (shadow and stripe): a cutover recorded before Stripe is connected sets Stripe's first day", async () => {
    const fresh = await freshBook();
    try {
      await fresh.ok("cutover.set", { cutoverDate: CUTOVER, accountIds: ["1000", "1010", "2000"] });
      expect((await fresh.ok("stripe.configure", {})).settings.syncFrom).toBe(CUTOVER);
    } finally {
      fresh.close();
    }
  }, 60_000);

  // 2 (fixed) --------------------------------------------------------------------------------------
  test("fixed issue 2 (shadow and reports): the cash flow of the cutover month starts from the opening cash", async () => {
    if (broken) throw new Error("the story did not get this far");
    // The opening entry is dated the day before the cutover, so March's cash flow starts at the
    // opening cash (17,000.00) and shows March's own change; Opening balance equity is not financing.
    const flow = await w.ok("reports.cashFlow", { from: MONTH.from, asOf: MONTH.to });
    const ledger = expectedLedger(
      { chase: CHASE, rho: rho(), card: CARD },
      payoutEntries(w.scenario),
    );
    const opening = cents(OPENING["1000"] as string) + cents(OPENING["1010"] as string);
    const closingCash = CASH_CODES.reduce((sum, code) => sum + (ledger.get(code) ?? 0n), 0n);
    expect(flow.openingCash).toBe(dec(opening));
    expect(flow.netChange).toBe(dec(closingCash - opening));
    const financing = flow.sections.find((s: Json) => s.key === "financing");
    expect(financing.lines.find((l: Json) => l.code === "3900")).toBeUndefined();
  }, 60_000);

  // 3 ----------------------------------------------------------------------------------------------
  const coldStart = once(async () => {
    // A first week on Rho: eight software lines, booked by a rule; the classifier is trained; then a
    // Stripe deposit arrives, a merchant it has never seen.
    const fresh = await freshBook();
    try {
      const vendors = [
        "FIGMA",
        "VERCEL",
        "DROPBOX",
        "NAMECHEAP",
        "MAILCHIMP",
        "CLOUDFLARE",
        "LINEAR",
        "NOTION",
      ];
      const software: Row[] = vendors.map((vendor, i) => ({
        date: `2026-03-${String(2 + i).padStart(2, "0")}`,
        amount: `-${10 + i}.00`,
        memo: `${vendor} INC`,
        dest: { to: "6200" },
        how: "rule",
        party: `${vendor} INC`,
        type: "ACH-US",
      }));
      const first = await fresh.upload(rhoCsv(software), "rho-first-week.csv");
      await fresh.ok("import.commit", { sha256: first.body.data.sha256, ledgerAccountId: "1010" });
      await fresh.ok("rules.create", {
        rule: {
          name: "Software",
          match: "any",
          conditions: contains(...vendors),
          action: { kind: "categorize", accountId: "6200" },
        },
      });
      await fresh.ok("inbox.accept", {
        filter: { status: ["new", "proposed"] },
        proposer: "rule",
        minConfidence: 90,
      });
      await postAll(fresh, { status: ["drafted"] });
      await fresh.ok("classifier.train", {});
      const deposit: Row = {
        date: "2026-03-12",
        amount: "93.31",
        memo: "STRIPE TRANSFER ST-P1KD3P1",
        dest: { payout: "P1" },
        how: "matcher",
        party: "STRIPE",
        type: "ACH-US",
      };
      const second = await fresh.upload(rhoCsv([deposit]), "rho-deposit.csv");
      await fresh.ok("import.commit", { sha256: second.body.data.sha256, ledgerAccountId: "1010" });
      const [item] = await allItems(fresh, { status: ["new", "proposed"] });
      const detail = await fresh.ok("inbox.get", { itemId: (item as Json).id });
      return detail.proposals
        .filter((p: Json) => p.proposer === "classifier")
        .map((p: Json) => ({
          account: p.legs.find((l: Json) => l.accountId !== "1010")?.accountId as string,
          confidence: p.confidence as number,
          reasons: p.reasons.join(" ") as string,
        }));
    } finally {
      fresh.close();
    }
  });
  test("fixed issue 3 (rules and statements): in a first week the classifier says nothing about a merchant it has never seen", async () => {
    // The Rho layout writes the account's own name into every description, so "checking", "rho" and
    // "lane" are on every line, and every line booked so far went to Software. They used to read as a
    // perfect record for it (a suggestion at 80% or more); words most lines share are no evidence.
    // The documented promise: "a line in a new merchant ... gets no suggestion rather than a guess".
    expect(await coldStart()).toEqual([]);
  }, 60_000);

  // 8 (fixed) --------------------------------------------------------------------------------------
  test("fixed issue 8 (calendar and shadow): after a mid-year cutover a close does not warn that the months before the books began are open", async () => {
    if (broken) throw new Error("the story did not get this far");
    // March is closed and January and February, which hold none of the books' own activity, are
    // open: closing April is in order, and the periods before the books began are not "still open".
    const april = (await w.ok("periods.list")).periods.find(
      (p: Json) => p.startsOn === "2026-04-01",
    );
    const prepared = await w.ok("periods.prepare", {
      periodId: april.id,
      operation: "close",
      reason: "Probe",
    });
    expect((prepared.warnings ?? []).map((x: Json) => x.code)).not.toContain("earlier_period_open");
  }, 60_000);

  // 9 (fixed) --------------------------------------------------------------------------------------
  const handMade = once(async () => {
    // The tutorial's step 2: opening balances as one ordinary journal the day before the first month.
    const fresh = await freshBook();
    try {
      await fresh.ok("cutover.set", { cutoverDate: CUTOVER, accountIds: ["1000", "1010", "2000"] });
      const draft = await fresh.ok("drafts.create", {
        data: {
          date: "2026-02-28",
          reference: "OPENING",
          narration: "Opening balances",
          lines: [
            { accountId: "1000", debit: "12000.00", credit: "" },
            { accountId: "1010", debit: "5000.00", credit: "" },
            { accountId: "2000", debit: "", credit: "1250.00" },
            { accountId: "3900", debit: "", credit: "15750.00" },
          ],
        },
      });
      const plan = await fresh.ok("journal.prepare", {
        draftId: draft.id,
        expectedVersion: draft.version,
      });
      await fresh.ok("operations.commit", { planId: plan.planId, planHash: plan.planHash });
      const checklist = await fresh.ok("cutover.checklist");
      return checklist.verdict.blocking.map((b: Json) => b.code) as string[];
    } finally {
      fresh.close();
    }
  });
  test("fixed issue 9 (shadow and the first-month tutorial): opening balances entered by hand, as the tutorial says, are the opening entry for the cutover checklist", async () => {
    expect(await handMade()).not.toContain("opening_not_posted");
  }, 60_000);

  // 10 (fixed) -------------------------------------------------------------------------------------
  const lateAccount = once(async () => {
    const suggested = (await w.ok("accounts.list")).suggestedEffectiveOn as string;
    const prepared = await w.ok("accounts.prepareCreate", {
      code: "6296",
      name: "Late account",
      role: "expense",
      effectiveOn: MONTH.from,
    });
    return {
      suggested,
      valid: prepared.valid as boolean,
      message: String(prepared.problems?.[0]?.message ?? ""),
    };
  });
  test("fixed issue 10 (chart): an account dated before the latest entry is refused with the date to use instead", async () => {
    if (broken) throw new Error("the story did not get this far");
    const { suggested, valid, message } = await lateAccount();
    // The ledger's own words ("Configuration evolution must be prospective relative to canonical
    // journals") named no date; the refusal now says the books' latest date and the one to use.
    expect(valid).toBe(false);
    expect(message).toContain(`Use ${suggested} or later`);
    expect(message).not.toContain("Configuration evolution");
  }, 60_000);

  // 11 (fixed) -------------------------------------------------------------------------------------
  test("fixed issue 11 (shadow, ingest, rules and the other lanes): what a lane stamps is the injected clock's time, not the wall clock's", async () => {
    if (broken) throw new Error("the story did not get this far");
    const onTheDay = (value: unknown): boolean => String(value).startsWith("2026-04-02");
    expect(onTheDay((await w.ok("cutover.get")).cutover.recordedAt), "the cutover").toBe(true);
    const sources = (await w.ok("inbox.sources")).sources as Json[];
    expect(sources.length).toBeGreaterThan(1);
    for (const source of sources)
      expect(onTheDay(source.lastSubmittedAt), `Inbox source ${source.accountKey}`).toBe(true);
    const rules = (await w.ok("rules.list")).rules as Json[];
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(onTheDay(rule.createdAt), `rule ${rule.name}`).toBe(true);
    expect(onTheDay((await w.ok("classifier.status")).trainedAt), "the classifier").toBe(true);
    for (const [code, record] of Object.entries(sealed))
      expect(onTheDay(record.completedAt), `reconciliation of ${code}`).toBe(true);
  }, 60_000);

  // A line of a small Chase file, for the issues that need a book of their own.
  const miniRow = (date: string, amount: string, memo: string): Row => ({
    date,
    amount,
    memo,
    dest: { to: "6290" },
    how: "manual",
    type: "DEBIT_CARD",
  });
  const importMini = async (fresh: World, rows: readonly Row[], name: string): Promise<void> => {
    const file = await fresh.upload(chaseCsv(rows, 12_000_00n), name);
    await fresh.ok("import.commit", { sha256: file.body.data.sha256, ledgerAccountId: "1000" });
  };

  // 13 (fixed) -------------------------------------------------------------------------------------
  const lateLine = once(async () => {
    // March is closed; the next statement brings a March line nobody had seen.
    const fresh = await freshBook();
    try {
      await importMini(fresh, [miniRow("2026-03-10", "-20.00", "COFFEE ONE")], "march.csv");
      const [first] = await allItems(fresh, { status: ["new", "proposed"] });
      await fresh.ok("inbox.categorize", { itemIds: [(first as Json).id], accountId: "6290" });
      await postAll(fresh, { status: ["drafted"] });
      const march = (await fresh.ok("periods.list")).periods.find(
        (p: Json) => p.startsOn === MONTH.from,
      );
      const closePlan = await fresh.ok("periods.prepare", {
        periodId: march.id,
        operation: "close",
        reason: "Reviewed",
      });
      await fresh.ok("operations.commit", {
        planId: closePlan.planId,
        planHash: closePlan.planHash,
      });
      await importMini(
        fresh,
        [
          miniRow("2026-03-10", "-20.00", "COFFEE ONE"),
          miniRow("2026-03-29", "-12.00", "LATE BANK CHARGE"),
        ],
        "late.csv",
      );
      const [late] = await allItems(fresh, { status: ["new", "proposed"] });
      await fresh.ok("inbox.categorize", { itemIds: [(late as Json).id], accountId: "6290" });
      const posting = await postAll(fresh, { status: ["drafted"] });
      const after = (await fresh.ok("inbox.get", { itemId: (late as Json).id })).item;
      return { posting, status: after.status as string, postError: String(after.postError ?? "") };
    } finally {
      fresh.close();
    }
  });
  test("fixed issue 13 (ingest and calendar): a line dated in a closed month says which month and the way forward", async () => {
    const { posting, status, postError } = await lateLine();
    // The line stays drafted and waiting, with the reason in words that name the month and its dates
    // and say what to do (the ledger's own words were "Fiscal period period-03 is closed").
    expect(posting).toMatchObject({ applied: 0, failed: 1 });
    expect(status).toBe("drafted");
    expect(postError).toContain("March 2026 (2026-03-01 to 2026-03-31) is closed");
    expect(postError).toContain("Reopen March 2026 first");
    expect(postError).not.toContain("period-03");
  }, 60_000);
});
