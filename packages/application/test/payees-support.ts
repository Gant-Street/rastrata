/** The acceptance month's book, built again for the tests of the payees lane: March 2026 for "Willow
 * Lane Studio", a one-person online business on the cash basis, with its three statements, the stand-in
 * Stripe, an entry written by hand and the lines booked the way the acceptance story books them.
 *
 * The acceptance story proves the lanes together and is one long test; this builds the same book (from
 * the same rows, `month.ts`) through the same public operations and nothing else, so a test can read
 * it. Every write carries an operation identity counted from one, so the same code makes the same
 * book, journal for journal, every time it runs: a golden file of what the book reports can be
 * compared byte for byte. */
import { WRITE_OPERATIONS } from "../src/client-contracts.gen.ts";
import { allItems, pairRows, postAll } from "./acceptance/drive.ts";
import {
  CARD,
  CHASE,
  CUTOVER,
  OPENING,
  BANK_AND_CARD,
  RENAMED,
  type Row,
  STRIPE_ACCOUNT,
  booked,
  cardCsv,
  chaseCsv,
  rhoCsv,
  rhoRows,
} from "./acceptance/month.ts";
import { type Json, type World, openWorld } from "./acceptance/world.ts";

const WRITES: ReadonlySet<string> = new Set(WRITE_OPERATIONS);

/** The date the books are read at: the end of the month, and the end of the year. */
export const MONTH_END = "2026-03-31";
export const YEAR_END = "2026-12-31";

/** A call that must succeed. Writes carry an identity counted from one. */
export interface Driver {
  readonly world: World;
  ok(name: string, input?: unknown): Promise<Json>;
  call(name: string, input?: unknown): Promise<{ status: number; body: Json }>;
  /** The next operation identity (a UUID-shaped string counted from one). */
  next(): string;
}

export function driver(world: World): Driver {
  let n = 0;
  const next = () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, "0")}`;
  return {
    world,
    next,
    ok: (name, input = {}) =>
      world.ok(name, input, WRITES.has(name) ? { operationId: next() } : {}),
    call: async (name, input = {}) => {
      const reply = await world.call(name, input, WRITES.has(name) ? { operationId: next() } : {});
      return { status: reply.status, body: reply.body };
    },
  };
}

/** An entry written by hand, prepared and posted; returns the journal's id. The draft is made with an
 * identity the test chooses, so the same book is the same every time. */
export async function enterByHand(
  d: Driver,
  entry: {
    readonly date: string;
    readonly reference: string;
    readonly narration: string;
    readonly lines: readonly { accountId: string; debit: string; credit: string }[];
  },
): Promise<string> {
  const draft = await d.ok("drafts.create", { data: entry });
  const plan = await d.ok("journal.prepare", { draftId: draft.id, expectedVersion: draft.version });
  if (!plan.valid) throw new Error(`the entry did not prepare: ${JSON.stringify(plan.problems)}`);
  const done = await d.ok("operations.commit", { planId: plan.planId, planHash: plan.planHash });
  if (done.disposition !== "committed")
    throw new Error(`the entry did not post: ${done.disposition}`);
  return plan.effects.journals[0].id as string;
}

export interface MonthBook {
  readonly d: Driver;
  readonly rows: readonly { readonly row: Row; readonly account: string; readonly item: Json }[];
  readonly handEntered: string;
  /** The Rho statement's rows (built from the stand-in Stripe's payouts). */
  readonly rho: readonly Row[];
}

/** The acceptance month, booked: the opening balances, three statements imported, six Stripe payouts
 * and their deposits, a rent payment written by hand and matched to its line, every other line
 * categorised and posted, and the personal charge set aside. Takes a few seconds. */
export async function bookTheMonth(world?: World): Promise<MonthBook & { readonly world: World }> {
  const w = world ?? (await openWorld());
  const d = driver(w);
  const rho = rhoRows(w.scenario);
  const files = [
    { name: "chase", account: "1000", rows: CHASE, text: chaseCsv(), preset: undefined },
    { name: "rho", account: "1010", rows: rho, text: rhoCsv(rho), preset: undefined },
    { name: "card", account: "2000", rows: CARD, text: cardCsv(), preset: "amex-card" },
  ] as const;

  // The book: the Schedule C online-business template with the founder's three names, a cutover and
  // opening balances.
  const template = await d.ok("templates.get", {
    templateId: "sole-proprietor",
    basis: "cash",
    taxYear: 2026,
    addOns: ["online-business"],
  });
  await d.ok("book.setup", {
    name: "Willow Lane Studio",
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
  await d.ok("cutover.set", { cutoverDate: CUTOVER, accountIds: ["1000", "1010", "2000"] });
  const balances = Object.entries(OPENING).map(([accountId, balance]) => ({ accountId, balance }));
  const planned = await d.ok("opening.plan", { cutoverDate: CUTOVER, balances });
  await d.ok("operations.commit", { planId: planned.plan.planId, planHash: planned.plan.planHash });

  // The three statements, uploaded and imported.
  for (const file of files) {
    const upload = await w.upload(file.text, `${file.name}.csv`);
    await d.ok("import.commit", {
      sha256: upload.body.data.sha256,
      ledgerAccountId: file.account,
      ...(file.preset ? { presetId: file.preset } : {}),
    });
  }

  // Stripe: configured, synced, the account for adjustments added, the six payouts accepted and posted.
  await d.ok("stripe.configure", {});
  await d.ok("stripe.sync");
  const when = (await d.ok("accounts.list")).suggestedEffectiveOn;
  const prepared = await d.ok("accounts.prepareCreate", {
    code: STRIPE_ACCOUNT["stripe.adjustments"],
    name: "Other Stripe adjustments",
    role: "expense",
    effectiveOn: when,
  });
  await d.ok("operations.commit", { planId: prepared.planId, planHash: prepared.planHash });
  await d.ok("accounts.setTags", {
    accountId: STRIPE_ACCOUNT["stripe.adjustments"],
    effectiveOn: when,
    tags: { roleKey: "stripe.adjustments", taxLine: "scheduleC.line27b" },
  });
  await d.ok("inbox.accept", {
    filter: { provider: "stripe", covered: false },
    proposer: "stripe",
    minConfidence: 100,
  });
  await postAll(w, { provider: "stripe" });

  // Which Inbox item each statement row became.
  const items = await allItems(w);
  const rows: { row: Row; account: string; item: Json }[] = [];
  for (const file of files) {
    const imported = file.rows.filter((row) => row.how !== "skipped");
    const { paired } = pairRows(items, file.account, imported);
    for (const row of booked(file.rows)) {
      const item = paired.get(row);
      if (item) rows.push({ row, account: file.account, item });
    }
  }
  const item = (row: Row) => rows.find((entry) => entry.row === row)?.item as Json;

  // The March rent was written in by hand on the 1st, and its line is matched to that entry.
  const entered = rows.find(({ row }) => row.how === "entered") as (typeof rows)[number];
  const rentAccount = (entered.row.dest as { to: string }).to;
  const amount = entered.row.amount.slice(1);
  const handEntered = await enterByHand(d, {
    date: entered.row.date,
    reference: "RENT",
    narration: "March rent, entered by hand",
    lines: [
      { accountId: rentAccount, debit: amount, credit: "" },
      { accountId: entered.account, debit: "", credit: amount },
    ],
  });
  await d.ok("inbox.accept", { itemIds: [entered.item.id], proposer: "journal-match" });

  // What the transfer matcher and the Stripe matcher suggest is accepted.
  await d.ok("inbox.accept", { filter: { status: ["proposed"] }, proposer: "transfer" });
  await d.ok("inbox.accept", {
    filter: { provider: "csv", status: ["proposed"] },
    proposer: "stripe",
    minConfidence: 90,
  });
  // The rest by the founder's own hand: one account for a list of lines, a split for the mixed ones.
  const personal = rows.find(({ row }) => "personal" in row.dest) as (typeof rows)[number];
  const onePlace = new Map<string, string[]>();
  for (const { row } of rows) {
    if (row.how === "entered" || !("to" in row.dest)) continue;
    onePlace.set(row.dest.to, [...(onePlace.get(row.dest.to) ?? []), item(row).id]);
  }
  for (const [accountId, itemIds] of onePlace)
    await d.ok("inbox.categorize", { itemIds, accountId });
  for (const { row } of rows) {
    if (!("split" in row.dest)) continue;
    await d.ok("inbox.categorize", {
      itemIds: [item(row).id],
      splits: row.dest.split.map(([accountId, part]) => ({ accountId, amount: part })),
    });
  }
  await d.ok("inbox.exclude", {
    itemIds: [personal.item.id],
    reason: "Personal subscription paid from the business account",
  });
  const posted = await postAll(w, { status: ["drafted"] });
  if (posted.failed > 0 || posted.problems.length > 0)
    throw new Error(`The month did not post: ${posted.problems.join("; ")}`);
  return { world: w, d, rows, handEntered, rho };
}

// ----- the 1099 vendors on that book ----------------------------------------------------------------

/** A vendor as `taxVendors.save` is asked for it. */
export interface VendorSpec {
  readonly name: string;
  readonly payeeKeys: readonly string[];
  readonly reporting?: "yes" | "no" | "undecided";
  readonly reason?: string;
  readonly w9?: string;
  readonly w9On?: string;
  readonly paidBy?: string;
  readonly classification?: string;
  readonly notes?: string;
}

/** The vendors the 1099 golden is made with: payees of the acceptance month, one that is edited, one
 * that needs nothing, one that matches nothing, and a payment by check. */
export const GOLDEN_VENDORS: readonly VendorSpec[] = [
  {
    name: "Jane Roe",
    payeeKeys: ["jane roe"],
    reporting: "yes",
    w9: "requested",
    w9On: "2026-03-02",
  },
  {
    name: "ATX Accounting PLLC",
    payeeKeys: ["atx accounting"],
    reporting: "yes",
    w9: "received",
    w9On: "2026-01-15",
    paidBy: "bank",
    classification: "partnership",
  },
  { name: "LegalZoom", payeeKeys: ["legalzoom"], reporting: "no", reason: "corporation" },
  { name: "Check writer", payeeKeys: ["check 1041"], notes: "Paid by check, number 1041" },
  { name: "Nobody yet", payeeKeys: ["nobody yet"] },
];

/** The 1099 view of the book without the two hashes that cover the book's own timestamps (the
 * report population and the ledger population): those timestamps are the wall clock's, so the hashes
 * differ from one run to the next. What is kept is every name, total, id, date, flag, sentence and
 * file, and the vendors hash, which covers what was recorded about the vendors. */
export function withoutPopulation<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (key, inner) =>
    key === "populationHash" || key === "ledgerPopulationHash" || key === "population"
      ? undefined
      : inner,
  );
}

/** A CSV file with the lines that carry a population hash made the same for every run. */
export const stableCsv = (content: string): string =>
  content
    .split("\r\n")
    .map((line) =>
      /^(Ledger population hash|Population hash),/.test(line)
        ? `${line.split(",")[0]},<hash>`
        : line,
    )
    .join("\r\n");

export interface Capture1099 {
  readonly vendorIds: Readonly<Record<string, string>>;
  readonly rows: readonly Record<string, unknown>[];
  readonly list: unknown;
  readonly vendorsCsv: string;
  readonly paymentsCsv: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly pack: {
    readonly vendorsCsv: string;
    readonly paymentsCsv: string;
    readonly check: unknown;
  };
}

/** The accounts a 1099 reads in the golden: contract labor and legal and professional services. */
export const GOLDEN_ACCOUNTS = ["6030", "6080"] as const;

/** Mark the accounts, record the vendors (an edit to the first one too) and read the 1099 list, its two
 * files, each vendor and the year-end pack's part of it. */
export async function capture1099(
  book: { readonly d: Driver; readonly world: World },
  vendors: readonly VendorSpec[] = GOLDEN_VENDORS,
): Promise<Capture1099> {
  const { d, world } = book;
  await d.ok("taxVendors.setAccounts", { add: [...GOLDEN_ACCOUNTS] });
  const vendorIds: Record<string, string> = {};
  for (const vendor of vendors) {
    const saved = await d.ok("taxVendors.save", vendor);
    vendorIds[vendor.name] = saved.vendor.id;
  }
  const first = vendors[0];
  if (first)
    await d.ok("taxVendors.save", {
      vendorId: vendorIds[first.name],
      expectedVersion: 1,
      w9: "received",
      w9On: "2026-03-20",
    });
  const rows = world.service.store
    .query(
      "SELECT seq, kind, subject, body, recorded_at, principal, operation_id FROM tax_events ORDER BY seq",
    )
    .all() as Record<string, unknown>[];
  const list = await d.ok("taxVendors.list", { taxYear: 2026 });
  const vendorsFile = await d.ok("taxVendors.export", { taxYear: 2026 });
  const paymentsFile = await d.ok("taxVendors.export", { taxYear: 2026, file: "payments" });
  const details: Record<string, unknown> = {};
  for (const [name, vendorId] of Object.entries(vendorIds))
    details[name] = withoutPopulation(await d.ok("taxVendors.get", { vendorId, taxYear: 2026 }));
  const pack = await d.ok("taxPack.build", { taxYear: 2026 });
  const file = (path: string) => pack.files.find((item: Json) => item.path === path)?.content;
  return {
    vendorIds,
    rows,
    list: withoutPopulation(list),
    vendorsCsv: stableCsv(vendorsFile.content),
    paymentsCsv: stableCsv(paymentsFile.content),
    details,
    pack: {
      vendorsCsv: stableCsv(file("tax/1099-vendors.csv")),
      paymentsCsv: stableCsv(file("tax/1099-payments.csv")),
      check: pack.checks.find((item: Json) => item.key === "vendors"),
    },
  };
}
