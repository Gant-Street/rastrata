import { MAX_FISCAL_YEAR, fiscalYearOf } from "../calendar/fiscal-calendar.ts";
import type { HistoryEntry, HistoryLine, ParsedHistory } from "./parse.ts";
import { MAX_PROBLEMS } from "./parse.ts";
import { codeFor, type NewRole, suggestRole } from "./roles.ts";

/** Turning what a journal file says into what can be posted, and saying what stands in the way.
 *
 * Nothing here reads or writes the book: the book arrives as a small summary (its accounts, its calendar,
 * what it already holds) and the answer is a plan, which the preview shows and the import follows. An
 * import that cannot be done in full is not done in part: a problem, an account that is not mapped or a
 * conflict with what the book already holds stops it, with the reason. */

export interface BookAccount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface BookFiscalYear {
  readonly fiscalYear: number;
  readonly startsOn: string;
  readonly endsOn: string;
}

/** What the book already holds that a history must not meet. One row per journal, as small as can be. */
export interface ExistingJournal {
  readonly date: string;
  /** The source the journal was posted from (`rastrata-source-v1` evidence), or null for an entry typed in. */
  readonly sourceId: string | null;
}

export interface PlanBook {
  readonly accounts: readonly BookAccount[];
  readonly fiscalYears: readonly BookFiscalYear[];
  readonly existing: readonly ExistingJournal[];
  /** Periods that are locked: nothing can be posted into them. */
  readonly closed: readonly { readonly startsOn: string; readonly endsOn: string }[];
  /** What the move from Xero kept, when the book has it: the id of the book's account each Xero code is mapped to
   * (null when the owner left it out) and the kind of each Xero account by its type, both by lower-case code. A file
   * that writes Xero's codes is then read the way the owner already decided. */
  readonly xero?: {
    readonly mapping: ReadonlyMap<string, string | null>;
    readonly roles: ReadonlyMap<string, NewRole | null>;
  };
}

export interface PlannedLine {
  readonly accountId: string;
  readonly debit: bigint;
  readonly credit: bigint;
}

export interface PlannedEntry {
  readonly key: string;
  readonly date: string;
  readonly reference: string;
  readonly narration: string;
  /** The identity the entry is posted under, from the file and its number: the same file always gives
   * the same ids, so posting it again changes nothing. */
  readonly sourceId: string;
  readonly lines: readonly PlannedLine[];
}

export interface AccountMapRow {
  /** How the file names the account: its code and name as written. */
  readonly label: string;
  readonly code: string;
  readonly name: string;
  readonly lines: number;
  /** The book's account it is posted to, or null when none is. */
  readonly account: string | null;
  readonly accountName: string | null;
  /** The kind it will be added as, when the account is not the book's yet and the person chose to add it. */
  readonly add: NewRole | null;
  /** The kind the file's number or name suggests, for an account the book does not have. */
  readonly suggestedRole: NewRole | null;
  /** The code of the book's account this is probably the same as (its name says so), for an account that
   * did not resolve: shown as the choice, for the person to keep or change. */
  readonly suggestedAccount: string | null;
}

/** An account the import adds to the book before it posts anything, because the file has it and the book does not. */
export interface NewAccount {
  readonly label: string;
  readonly code: string;
  readonly name: string;
  readonly role: NewRole;
}

export interface YearRow {
  readonly fiscalYear: number;
  readonly from: string;
  readonly to: string;
  readonly entries: number;
  readonly lines: number;
  /** Total debits, which equal total credits. */
  readonly total: string;
}

export interface HistoryPlan {
  /** The entries whose accounts all resolve: what an import posts. */
  readonly entries: readonly PlannedEntry[];
  /** How many entries the file holds that were read without a problem, whether or not they can be posted yet. */
  readonly entryCount: number;
  /** What is wrong with the file, the first `MAX_PROBLEMS` kept, and how many there are. */
  readonly problems: readonly {
    readonly row: number;
    readonly code: string;
    readonly message: string;
  }[];
  readonly problemCount: number;
  readonly lines: number;
  readonly firstDate: string | null;
  readonly lastDate: string | null;
  readonly years: readonly YearRow[];
  readonly accounts: readonly AccountMapRow[];
  readonly unmapped: number;
  /** The accounts an import adds first. */
  readonly newAccounts: readonly NewAccount[];
  /** The day the added accounts are open from: the calendar's first day for a book with no entry, else the file's
   * first day (every entry already in the book is earlier). Null when nothing is added. */
  readonly addAccountsOn: string | null;
  readonly conflicts: readonly string[];
  readonly alreadyImported: number;
  readonly ready: boolean;
}

/** The identity prefix of every entry a file posts: the start of its SHA-256. */
export const sourcePrefix = (sha256: string): string => `history-${sha256.slice(0, 12)}`;

const safeKey = (key: string): string => key.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
const tidy = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

function cents(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

/** The words of an account's name that tell accounts apart: not the ones every name has. */
const COMMON_WORDS = new Set([
  "account",
  "accounts",
  "and",
  "the",
  "of",
  "a",
  "business",
  "general",
]);
export function nameWords(name: string): Set<string> {
  return new Set(
    tidy(name)
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(" ")
      .filter((word) => word !== "" && !COMMON_WORDS.has(word)),
  );
}

/** Whether two accounts' names say the same thing: the same words, or one's words all in the other's. */
function sameMeaning(a: string, b: string): boolean {
  const left = nameWords(a);
  const right = nameWords(b);
  if (left.size === 0 || right.size === 0) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return (
    shared === left.size || shared === right.size || shared * 2 >= Math.max(left.size, right.size)
  );
}

/** Which of the book's accounts an account of a file is: by the mapping the person gave; by name; by code when
 * the book's account with that code has a name that means the same, or the file names nothing (codes mean
 * different things in different charts, so a code alone never decides); when the file's Account column holds
 * codes, by that; or by the mapping saved for Xero's codes. Null when it is none. */
export function accountResolver(
  accounts: readonly BookAccount[],
  mapping: Readonly<Record<string, string>> = {},
  xero?: ReadonlyMap<string, string | null>,
): (code: string, name: string) => BookAccount | null {
  const byCode = new Map(accounts.map((account) => [account.code.toLowerCase(), account]));
  const byName = new Map(accounts.map((account) => [tidy(account.name), account]));
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const given = new Map(Object.entries(mapping).map(([label, code]) => [tidy(label), code]));
  return (code, name) => {
    for (const label of [`${code} ${name}`.trim(), code, name]) {
      const mapped = label === "" ? undefined : given.get(tidy(label));
      if (mapped !== undefined) return byCode.get(mapped.toLowerCase()) ?? null;
    }
    if (name !== "" && byName.has(tidy(name))) return byName.get(tidy(name)) ?? null;
    if (code !== "" && byCode.has(code.toLowerCase())) {
      const coded = byCode.get(code.toLowerCase()) as BookAccount;
      if (name === "" || sameMeaning(name, coded.name)) return coded;
    }
    if (name !== "" && byCode.has(name.toLowerCase()))
      return byCode.get(name.toLowerCase()) ?? null;
    if (name === "" && code !== "" && byName.has(tidy(code))) return byName.get(tidy(code)) ?? null;
    for (const label of [code, name]) {
      const id = label === "" ? undefined : xero?.get(label.toLowerCase());
      if (id) {
        const account = byId.get(id);
        if (account) return account;
      }
    }
    return null;
  };
}

/** Plan a parsed file against a book. `mapping` names the book account (by code) for an account of the file
 * the book does not have under the same code or name. */
export function planHistory(input: {
  readonly parsed: ParsedHistory;
  readonly book: PlanBook;
  readonly sha256: string;
  readonly mapping?: Readonly<Record<string, string>>;
  /** Accounts of the file to add to the book, by how the file writes them, and the kind each is added as. */
  readonly adds?: Readonly<Record<string, NewRole>>;
  readonly calendar: { readonly firstDate: string; readonly lastDate: string };
}): HistoryPlan {
  const { parsed, book, sha256, calendar } = input;
  const given = input.mapping ?? {};
  const adds = new Map(
    Object.entries(input.adds ?? {}).map(([label, role]) => [tidy(label), role]),
  );
  const prefix = sourcePrefix(sha256);
  const conflicts: string[] = [];
  const problems = [...parsed.problems];
  let extraProblems = 0;
  const problem = (row: number, code: string, message: string) => {
    extraProblems += 1;
    if (problems.length < MAX_PROBLEMS) problems.push({ row, code, message });
  };

  // Every account of the file, and the book's account it goes to.
  const byCode = new Map(book.accounts.map((account) => [account.code.toLowerCase(), account]));
  const plain = accountResolver(book.accounts, given, book.xero?.mapping);
  // The kind an account of the file probably is: what Xero's chart says of its code when the book has that chart,
  // else what the number or the name says.
  const suggestedKind = (code: string, name: string): NewRole | null =>
    book.xero?.roles.get(code.toLowerCase()) ??
    book.xero?.roles.get(name.toLowerCase()) ??
    suggestRole(code, name);
  const rows = new Map<string, { code: string; name: string; lines: number }>();
  for (const entry of parsed.entries)
    for (const line of entry.lines) {
      const key = tidy(`${line.code} ${line.name}`);
      const seen = rows.get(key);
      if (seen) seen.lines += 1;
      else rows.set(key, { code: line.code, name: line.name, lines: 1 });
    }
  // An account the book lacks and the person chose to add gets a code now, so that the preview, the entries
  // and the import all speak of the same account. They are taken in the order of their labels.
  const used = new Set(book.accounts.map((account) => account.code.toLowerCase()));
  const newAccounts: NewAccount[] = [];
  const mapping: Record<string, string> = { ...given };
  const kinds = new Map<string, NewRole>();
  const ordered = [...rows.values()].sort((a, b) =>
    `${a.code} ${a.name}`.localeCompare(`${b.code} ${b.name}`, "en", { numeric: true }),
  );
  for (const row of ordered) {
    const label = `${row.code} ${row.name}`.trim();
    if (plain(row.code, row.name) !== null) continue;
    const role = [label, row.code, row.name]
      .map((text) => (text === "" ? undefined : adds.get(tidy(text))))
      .find((found) => found !== undefined);
    if (role === undefined) continue;
    const name = (row.name === "" ? row.code : row.name).slice(0, 120);
    const code = codeFor(role, row.code, used);
    newAccounts.push({ label, code, name, role });
    mapping[label] = code;
    kinds.set(label, role);
  }
  const everyAccount: BookAccount[] = [
    ...book.accounts,
    ...newAccounts.map((account) => ({
      id: account.code.toLowerCase(),
      code: account.code,
      name: account.name,
    })),
  ];
  for (const account of newAccounts)
    byCode.set(account.code.toLowerCase(), everyAccount.at(-1) as BookAccount);
  const resolveAccount = accountResolver(everyAccount, mapping, book.xero?.mapping);
  const resolve = (line: HistoryLine): BookAccount | null => resolveAccount(line.code, line.name);
  for (const label of Object.keys(given))
    if (!byCode.has((given[label] ?? "").toLowerCase()))
      conflicts.push(
        `"${label}" is mapped to ${given[label]}, which is not an account of the book.`,
      );
  // An account that did not resolve may still be one of the book's under another name ("Cash (Checking)" and
  // "Business checking"): the one whose name means the same is suggested, and the person keeps or changes it.
  const likely = (code: string, name: string): BookAccount | null => {
    const text = name === "" ? code : name;
    const found = book.accounts.filter((account) => sameMeaning(text, account.name));
    return found.length === 1 ? (found[0] as BookAccount) : null;
  };
  const accounts: AccountMapRow[] = ordered.map((row) => {
    const label = `${row.code} ${row.name}`.trim();
    const account = resolveAccount(row.code, row.name);
    const suggested = account === null ? likely(row.code, row.name) : null;
    return {
      label,
      code: row.code,
      name: row.name,
      lines: row.lines,
      account: account?.code ?? null,
      accountName: account?.name ?? null,
      add: kinds.get(label) ?? null,
      suggestedRole:
        account === null && suggested === null ? suggestedKind(row.code, row.name) : null,
      suggestedAccount: suggested?.code ?? null,
    };
  });
  const unmapped = accounts.filter((row) => row.account === null).length;
  // An account cannot take an entry dated before it was added, and the book takes a change to its accounts only
  // after its latest entry: so accounts are added for a book with no entry (open from the calendar's first day),
  // or for a part of a history that begins after every entry the book holds (open from the part's first day).
  const dates = parsed.entries.map((entry) => entry.date).sort();
  const firstDate = dates[0] ?? null;
  const lastDate = dates.at(-1) ?? null;
  const latestHeld = book.existing.reduce<string | null>(
    (latest, held) => (latest === null || held.date > latest ? held.date : latest),
    null,
  );
  const canAdd = latestHeld === null || (firstDate !== null && latestHeld < firstDate);
  if (newAccounts.length > 0 && !canAdd)
    conflicts.push(
      `${newAccounts.length === 1 ? "An account" : `${newAccounts.length} accounts`} of the file ${newAccounts.length === 1 ? "is" : "are"} not in the book, and accounts can be added only when every entry already in the book is dated before the file begins (the book holds an entry dated ${latestHeld}; the file begins on ${firstDate}), because an account cannot take an entry dated before it was added. Choose one of the book's accounts for ${newAccounts
        .slice(0, 3)
        .map((account) => `"${account.label}"`)
        .join(", ")}${newAccounts.length > 3 ? " and the others" : ""}.`,
    );
  const addAccountsOn =
    newAccounts.length === 0 ? null : latestHeld === null ? calendar.firstDate : firstDate;

  // The entries, with the account each line goes to.
  const planned: PlannedEntry[] = [];
  const keys = new Set<string>();
  const sourceIds = new Set<string>();
  for (const entry of parsed.entries) {
    const key = safeKey(entry.key);
    if (keys.has(key)) {
      problem(
        entry.lines[0]?.row ?? 0,
        "duplicate_key",
        `Entry ${entry.key} has the same number as another once the number is made safe to store.`,
      );
      continue;
    }
    keys.add(key);
    sourceIds.add(`${prefix}-${key}`);
    const lines: PlannedLine[] = [];
    for (const line of entry.lines) {
      const account = resolve(line);
      if (account) lines.push({ accountId: account.id, debit: line.debit, credit: line.credit });
    }
    if (lines.length === entry.lines.length)
      planned.push({
        key: entry.key,
        date: entry.date,
        reference: entry.reference,
        narration: entry.narration,
        sourceId: `${prefix}-${key}`,
        lines,
      });
  }

  // Years the entries fall in. A date after the calendar's end belongs to the fiscal year the import grows
  // the calendar through as it posts; only a date before the first day, or past the last fiscal year the
  // calendar can reach, is outside.
  const last = book.fiscalYears.at(-1);
  const startMonth = last === undefined ? 1 : Number(last.startsOn.slice(5, 7));
  const yearOf = (date: string): number | undefined => {
    const found = book.fiscalYears.find((year) => date >= year.startsOn && date <= year.endsOn);
    if (found) return found.fiscalYear;
    if (last === undefined || date <= last.endsOn) return undefined;
    const fiscalYear = fiscalYearOf(date, startMonth);
    return fiscalYear <= MAX_FISCAL_YEAR ? fiscalYear : undefined;
  };
  const byYear = new Map<
    number,
    { from: string; to: string; entries: number; lines: number; total: bigint }
  >();
  let outside = 0;
  let before = null as string | null;
  let after = null as string | null;
  for (const entry of parsed.entries) {
    const year = yearOf(entry.date);
    if (year === undefined) {
      outside += 1;
      if (entry.date < calendar.firstDate)
        before = before === null || entry.date < before ? entry.date : before;
      else after = after === null || entry.date > after ? entry.date : after;
      continue;
    }
    const row = byYear.get(year) ?? {
      from: entry.date,
      to: entry.date,
      entries: 0,
      lines: 0,
      total: 0n,
    };
    row.entries += 1;
    row.lines += entry.lines.length;
    row.total += entry.lines.reduce((sum, line) => sum + line.debit, 0n);
    if (entry.date < row.from) row.from = entry.date;
    if (entry.date > row.to) row.to = entry.date;
    byYear.set(year, row);
  }
  const years: YearRow[] = [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([fiscalYear, row]) => ({
      fiscalYear,
      from: row.from,
      to: row.to,
      entries: row.entries,
      lines: row.lines,
      total: cents(row.total),
    }));
  if (outside > 0) {
    if (before !== null)
      conflicts.push(
        `${outside === 1 ? "An entry is" : "Entries are"} dated ${before}, before the calendar begins on ${calendar.firstDate}, and nothing can be dated before it.`,
      );
    if (after !== null)
      conflicts.push(
        `${outside === 1 ? "An entry is" : "Entries are"} dated ${after}, past fiscal year ${MAX_FISCAL_YEAR}, the last the calendar can reach.`,
      );
  }

  // What the book already holds.
  const ours = sourceIds;
  let alreadyImported = 0;
  let meeting = 0;
  let openingOn = null as string | null;
  for (const held of book.existing) {
    if (held.sourceId !== null && ours.has(held.sourceId)) {
      alreadyImported += 1;
      continue;
    }
    if (held.sourceId?.startsWith("opening-") && (openingOn === null || held.date > openingOn))
      openingOn = held.date;
    if (firstDate !== null && lastDate !== null && held.date >= firstDate && held.date <= lastDate)
      meeting += 1;
  }
  if (meeting > 0)
    conflicts.push(
      `The book already holds ${meeting} ${meeting === 1 ? "entry" : "entries"} dated between ${firstDate} and ${lastDate} that ${meeting === 1 ? "is" : "are"} not from this file. History goes into dates the book has no entries in, or those would be counted twice.`,
    );
  if (openingOn !== null && firstDate !== null && openingOn >= firstDate)
    conflicts.push(
      `An opening entry dated ${openingOn} already stands for everything before it, so history from ${firstDate} would be counted twice. Reverse the opening entry first, or bring in only history from after ${openingOn}.`,
    );
  const locked = book.closed.find(
    (period) =>
      firstDate !== null &&
      lastDate !== null &&
      period.startsOn <= lastDate &&
      period.endsOn >= firstDate,
  );
  if (locked)
    conflicts.push(
      `A period from ${locked.startsOn} to ${locked.endsOn} is closed, and nothing can be posted into it. Reopen it first.`,
    );

  const problemCount = parsed.problemCount + extraProblems;
  const ready =
    !parsed.unreadable &&
    problemCount === 0 &&
    unmapped === 0 &&
    conflicts.length === 0 &&
    planned.length === parsed.entries.length &&
    planned.length > 0;
  return {
    entries: planned,
    entryCount: parsed.entries.length,
    problemCount,
    lines: parsed.linesRead,
    firstDate,
    lastDate,
    years,
    accounts,
    unmapped,
    newAccounts,
    addAccountsOn,
    conflicts,
    alreadyImported,
    ready,
    problems,
  };
}

/** The same entry as the lines of a journal an import posts, debits first. */
export const debitTotal = (entry: PlannedEntry): bigint =>
  entry.lines.reduce((sum, line) => sum + line.debit, 0n);

export type { HistoryEntry };
