/** Building books for the benches and the seeding script: a chart of any size, configuration
 * revisions, and journals through the bulk path (about a millisecond a journal; posting through the
 * API would take hours). It is the part of `bench/scale.ts` that a book needs before it is measured,
 * kept in one place so `bench/cold-load.ts` and `scripts/seed-books.ts` build the same books.
 *
 * The default journals are the bulk poster's own (cash against sales, dated through the year), so a
 * number measured here is comparable with `bench/scale.ts`. `spread` makes journals touch the whole
 * chart, with a few accounts taking most of the postings, as a real book does.
 *
 * It reaches the service's private signing members on purpose: this is bench support. */
import { Database } from "bun:sqlite";
import { commandId, instant, localDate, sealCommand } from "@rastrata/kernel";
import type { BookSetup, InitialAccount } from "../../src/contracts.ts";
import { LocalBookService } from "../../src/local.ts";
import { BULK_BOOK, postBulk, type BulkEntry } from "../../test/support/bulk-book.ts";
import { randomFrom } from "./random.ts";

/** The four accounts every bulk book has, as setup accounts. */
const BASE_ACCOUNTS: readonly InitialAccount[] = BULK_BOOK.accounts.map((account) => ({
  code: account.code,
  name: account.name,
  role: account.role,
}));

/** The roles of the accounts a chart has beyond the four, in the proportions of a small business:
 * mostly expense accounts, then income and the balance sheet. The same list for every book. */
const EXTRA_ROLES: readonly InitialAccount["role"][] = [
  "expense",
  "expense",
  "expense",
  "expense",
  "expense",
  "expense",
  "income",
  "income",
  "asset",
  "liability",
];
const EXTRA_BASE: Record<string, number> = {
  asset: 1100,
  liability: 2000,
  equity: 3100,
  income: 4100,
  expense: 6000,
};

/** A chart of `count` accounts (never fewer than the four every bulk book has). */
export function chartAccounts(count: number): InitialAccount[] {
  const extra = Math.max(0, count - BASE_ACCOUNTS.length);
  const used: Record<string, number> = {};
  const accounts: InitialAccount[] = [...BASE_ACCOUNTS];
  for (let index = 0; index < extra; index += 1) {
    const role = EXTRA_ROLES[index % EXTRA_ROLES.length] ?? "expense";
    const ordinal = used[role] ?? 0;
    used[role] = ordinal + 1;
    accounts.push({
      code: String((EXTRA_BASE[role] ?? 6000) + ordinal),
      name: `${role[0]?.toUpperCase()}${role.slice(1)} account ${ordinal + 1}`,
      role,
    });
  }
  return accounts;
}

/** A book setup with `accounts` accounts, like the books people actually keep. */
export function chartSetup(
  accounts: number,
  options: { readonly name?: string; readonly fiscalYear?: number } = {},
): BookSetup {
  return {
    name: options.name ?? BULK_BOOK.name,
    currency: "USD",
    fiscalYear: options.fiscalYear ?? BULK_BOOK.fiscalYear,
    periodModel: "monthly",
    accounts: chartAccounts(accounts),
  };
}

/** Add `count` configuration revisions (as an account edit or a calendar extension does) before any
 * journal. */
export async function reconfigure(book: LocalBookService, count: number): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: bench support reaches the service's signing members
  const internals = book as any;
  for (let index = 0; index < count; index += 1) {
    const state = (await book.readAggregate()).aggregate.state;
    const policy = state.policies[0];
    if (!policy) throw new Error("The book has no policies");
    const now = new Date().toISOString();
    const receipt = await book.ledger.execute(
      await internals.credential(),
      sealCommand({
        id: commandId(`reconfigure-${index}`),
        type: "replaceConfiguration",
        protocolVersion: policy.version,
        bookId: state.identity.bookId,
        expectedBookRevision: state.bookRevision,
        expectedConfigurationRevision: state.configurationRevision,
        actorId: internals.actor,
        issuedAt: instant(now),
        completedAt: instant(now),
        committedAt: instant(now),
        effectiveOn: state.periods[0]?.startsOn ?? localDate("2026-01-01"),
        periods: state.periods,
        admissionSnapshot: state.admissionSnapshot,
        policies: state.policies,
        quantizationPolicies: state.quantizationPolicies,
        accountingPolicies: state.accountingPolicySnapshot.policies,
      }),
    );
    if (receipt.value.result.disposition !== "committed") throw new Error("Configuration rejected");
  }
}

/** Journals over the whole chart: debits to assets and expenses, credits to income, liabilities and
 * equity, a few accounts taking most of the postings, amounts from $5 to $2,500, dated through the
 * fiscal year (a year that starts in January, as the bulk books do). */
export function spreadEntries(
  accounts: readonly InitialAccount[],
  fiscalYear: number,
  seed: number,
): (n: number) => BulkEntry {
  const random = randomFrom(seed);
  const debits = accounts.filter((a) => a.role === "asset" || a.role === "expense");
  const credits = accounts.filter(
    (a) => a.role === "income" || a.role === "liability" || a.role === "equity",
  );
  // Squaring a uniform draw puts about half of the postings on the first fifth of the accounts.
  const pick = (list: readonly InitialAccount[]): string =>
    list[Math.floor(random() ** 2 * list.length)]?.code ?? "1000";
  return (n) => ({
    date: `${fiscalYear}-${String(1 + (n % 12)).padStart(2, "0")}-${String(1 + (n % 27)).padStart(2, "0")}`,
    debit: pick(debits),
    credit: pick(credits),
    cents: BigInt(500 + Math.floor(random() * 249500)),
  });
}

export interface BuildOptions {
  /** The SQLite file to create. */
  readonly path: string;
  readonly journals: number;
  /** Accounts in the chart (default 4, the bulk book's own). */
  readonly accounts?: number;
  /** Configuration revisions before the first journal (default 0). */
  readonly revisions?: number;
  /** Journals over the whole chart instead of cash against sales (default false). */
  readonly spread?: boolean;
  /** Seeds the journals when `spread` is on (default 1). */
  readonly seed?: number;
  readonly name?: string;
  readonly fiscalYear?: number;
  /** Told after each stage; for a bench that prints progress. */
  readonly progress?: (stage: "setup" | "revisions" | "journals", milliseconds: number) => void;
}

export interface BuiltBook {
  readonly journals: number;
  readonly accounts: number;
  readonly revisions: number;
  readonly milliseconds: number;
}

/** Build one book on disk and close it. The next process that opens it replays every outcome, which is
 * the cold path a pod takes for a book too big for a read snapshot. The service saves a snapshot of
 * what it has read when it closes (a chart with configuration revisions has read the first ones), so
 * the builder deletes it afterwards, unless `snapshot` asks for one: then the builder reads the whole
 * book once before it closes, and the snapshot is saved when the kernel's encoding of the book fits
 * under its 16 MiB cap (about 1,200 to 1,600 journals). */
export async function buildBook(
  options: BuildOptions & { readonly snapshot?: boolean },
): Promise<BuiltBook> {
  const started = performance.now();
  const accounts = options.accounts ?? BASE_ACCOUNTS.length;
  const revisions = options.revisions ?? 0;
  const fiscalYear = options.fiscalYear ?? BULK_BOOK.fiscalYear;
  const setup = chartSetup(accounts, {
    fiscalYear,
    ...(options.name ? { name: options.name } : {}),
  });
  const service = await LocalBookService.open(options.path, { safety: false });
  try {
    let stage = performance.now();
    await service.setup(setup);
    options.progress?.("setup", performance.now() - stage);
    stage = performance.now();
    await reconfigure(service, revisions);
    options.progress?.("revisions", performance.now() - stage);
    stage = performance.now();
    await postBulk(service, options.journals, {
      ...(options.spread
        ? { entry: spreadEntries(setup.accounts, fiscalYear, options.seed ?? 1) }
        : {}),
    });
    options.progress?.("journals", performance.now() - stage);
    if (options.snapshot) await service.readAggregate();
  } finally {
    service.close();
  }
  if (!options.snapshot) {
    const db = new Database(options.path);
    try {
      db.query("DELETE FROM app_read_snapshots WHERE id=1").run();
    } finally {
      db.close();
    }
  }
  return {
    journals: options.journals,
    accounts,
    revisions,
    milliseconds: performance.now() - started,
  };
}
