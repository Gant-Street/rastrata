/** Money by payee: for a range, what each person or business was paid and paid the book, and a report
 * that adds up to the profit and loss to the cent.
 *
 * What is counted. Every posting, in every journal the profit and loss reads (the same journals the
 * statements read: a superseded original is out, a reversal nets), on an income or expense account.
 * Money received is the credit side of income, money spent the debit side of expense; a refund takes
 * from its own side, so a payee can have a negative side. Moves between the owner's own accounts, loan
 * principal, assets bought and the owner's draws are not on those accounts and are not here.
 *
 * Who it went to. A journal made from an Inbox line takes the line's counterparty and then its
 * description as the text to match; a journal a connector made from its own source (a Stripe payout and
 * its fees) takes the provider's name; an entry written by hand has no bank text, so its own narration
 * is matched, and when that names nobody it is listed as "entered by hand" and is never offered as a
 * payee to name. A reversal belongs to the payee of the journal it reverses, so an undone line nets to
 * zero where it was and does not leave a mirror image under another name.
 *
 * Every journal ends in exactly one place: a payee's row, a group of bank texts that match no payee
 * ("unnamed"), a group whose text matches two payees equally ("ambiguous"), or "no payee" (entered by
 * hand, or a bank line that came with no text). The places add up to the profit and loss, and a report
 * that does not is an error, never a figure.
 *
 * The text is hostile. It is matched by whole words and shown as text; it is never a pattern, never a
 * query and never an instruction. Pure and portable. */
import { type BookedJournal, type BookState, hashCanonical } from "@rastrata/kernel";

import { ApplicationError } from "../errors.ts";
import { formatMoney } from "../money.ts";
import { merchantPhrase } from "../rules/normalize.ts";
import {
  type ChartAccount,
  compareCodes,
  isIncomeRole,
  isProfitLossRole,
} from "../reports/chart.ts";
import { compileColumn, reportContext, resolveRange } from "../reports/columns.ts";
import { addDays, parseDate } from "../reports/dates.ts";
import { postingCents } from "../reports/ledger.ts";
import { profitLossFigures } from "../reports/statements.ts";
import {
  PAYEE_KEY_MIN,
  type PayeeMatcher,
  compileMatcher,
  groupKey,
  payeeKey,
  payeeText,
  payeeWords,
} from "./match.ts";

export const PAYEE_TOTALS_VERSION = "rastrata-payee-totals-v1";

/** A payee as the report needs it. */
export interface PayeeRecord {
  readonly id: string;
  readonly name: string;
  /** Plain words, lower case, single-spaced: what a bank line's text is matched against. */
  readonly words: readonly string[];
  readonly retired: boolean;
}

/** What is known of the text behind a journal: the Inbox line that booked it, or the provider that made it. */
export interface JournalText {
  readonly counterparty: string;
  readonly description: string;
  /** Set for a journal made from a connector's own source: the provider's name ("Stripe"). */
  readonly connector?: string;
}

export interface PayeeTotalsInput {
  readonly state: BookState;
  readonly from: string;
  readonly to: string;
  readonly payees: readonly PayeeRecord[];
  /** The Inbox line behind a journal, by journal id. A journal with none was written by hand. */
  readonly texts: ReadonlyMap<string, JournalText>;
  /** Split every figure by calendar month. */
  readonly byMonth?: boolean;
  /** Only the postings on these income and expense accounts: the report then adds up to the profit and
   * loss of those accounts. Absent: every income and expense account. */
  readonly accounts?: ReadonlySet<string>;
}

/** Where a journal ended up. */
export type Outcome =
  | { readonly kind: "payee"; readonly payeeId: string; readonly key: string }
  | { readonly kind: "ambiguous"; readonly payeeIds: readonly string[] }
  | { readonly kind: "unnamed" }
  | { readonly kind: "none"; readonly why: NoPayeeReason };

export type NoPayeeReason = "by_hand" | "no_bank_text";

export type TextFrom = "counterparty" | "description" | "connector" | "narration";

/** One journal's part in the report: what it did to the profit and loss, and whose it is. */
export interface JournalEffect {
  readonly journalId: string;
  readonly date: string;
  readonly narration: string;
  /** Money received: credits to income less debits (cents). */
  readonly received: bigint;
  /** Money spent: debits to expense less credits (cents). */
  readonly spent: bigint;
  /** The income and expense accounts it is on. */
  readonly accounts: readonly ChartAccount[];
  /** The text that was matched, made safe and short; empty when there was none. */
  readonly text: string;
  readonly textFrom: TextFrom | null;
  /** The first journal of the chain this one reverses, when it is a reversal: its payee is that one's. */
  readonly reverses: string | null;
  readonly outcome: Outcome;
}

export interface Tally {
  readonly received: bigint;
  readonly spent: bigint;
  readonly transactions: number;
}

export interface Dated extends Tally {
  readonly firstOn: string;
  readonly lastOn: string;
}

export interface PayeeRow extends Dated {
  readonly payeeId: string;
  readonly name: string;
  readonly retired: boolean;
  readonly months?: readonly Tally[];
}

/** Bank texts that match no payee, with the digits made one, so "COFFEE 1234" and "COFFEE 5678" are one. */
export interface UnnamedGroup extends Dated {
  /** The group's key (`groupKey` of its text). */
  readonly key: string;
  /** The text of the group's largest transaction, made safe and short. */
  readonly text: string;
  readonly months?: readonly Tally[];
}

/** Bank texts that match two payees equally, so they are given to neither. */
export interface AmbiguousGroup extends Dated {
  readonly key: string;
  readonly text: string;
  readonly payeeIds: readonly string[];
  readonly months?: readonly Tally[];
}

export interface NoPayee {
  readonly byHand: Tally;
  readonly noBankText: Tally;
}

export interface MonthTie {
  readonly month: string;
  readonly from: string;
  readonly to: string;
  readonly profitLossIncome: bigint;
  readonly profitLossExpenses: bigint;
}

export interface PayeeTotals {
  readonly from: string;
  readonly to: string;
  readonly basis: string;
  /** The population of the profit and loss of the same range: the ledger half of this report's own. */
  readonly ledgerPopulationHash: string;
  /** Every journal that moved the profit and loss in the range, oldest first. */
  readonly journals: readonly JournalEffect[];
  /** Named payees with activity in the range, largest first. */
  readonly rows: readonly PayeeRow[];
  readonly unnamed: readonly UnnamedGroup[];
  readonly ambiguous: readonly AmbiguousGroup[];
  readonly noPayee: NoPayee;
  readonly totals: Tally;
  /** The months of the range, when asked for. */
  readonly months?: readonly MonthTie[];
  readonly profitLoss: { readonly income: bigint; readonly expenses: bigint };
}

// ------------------------------------------------------------------------------------------------
// Small things
// ------------------------------------------------------------------------------------------------

const MAX_PAYEE_MONTHS = 36;

const absolute = (value: bigint): bigint => (value < 0n ? -value : value);
const compareDescending = (a: bigint, b: bigint) => (b > a ? 1 : b < a ? -1 : 0);
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** How much money a place moved, for putting the largest first. */
export const gross = (tally: { readonly received: bigint; readonly spent: bigint }): bigint =>
  absolute(tally.received) + absolute(tally.spent);

/** The months a range touches, as `YYYY-MM`, each with the first and last day inside the range. */
export function monthsOf(from: string, to: string): { month: string; from: string; to: string }[] {
  const result: { month: string; from: string; to: string }[] = [];
  let cursor = from;
  while (cursor <= to) {
    const parts = parseDate(cursor);
    if (!parts) break;
    const month = cursor.slice(0, 7);
    const next =
      parts.month === 12
        ? `${parts.year + 1}-01-01`
        : `${month.slice(0, 5)}${String(parts.month + 1).padStart(2, "0")}-01`;
    const last = addDays(next, -1);
    result.push({ month, from: cursor, to: last < to ? last : to });
    cursor = next;
  }
  return result;
}

// ------------------------------------------------------------------------------------------------
// Reading the journals
// ------------------------------------------------------------------------------------------------

/** A journal that moved the profit and loss, with the text it will be matched on and not yet decided. */
interface Pending extends Omit<JournalEffect, "outcome"> {
  readonly candidates: readonly { readonly text: string; readonly from: TextFrom }[];
  /** Typed by hand: no bank, no provider and no source behind it. */
  readonly handmade: boolean;
}

/** What the profit and loss says for a range, in the two sides the report adds up to: all of it, or
 * the part that is on the accounts asked for. */
interface ProfitLoss {
  readonly income: bigint;
  readonly expenses: bigint;
}

function profitLossOf(
  accounts: readonly ChartAccount[],
  figures: ReturnType<typeof profitLossFigures>,
  only: ReadonlySet<string> | undefined,
): ProfitLoss {
  if (!only) return { income: figures.revenue, expenses: figures.expenses };
  let income = 0n;
  let expenses = 0n;
  for (const account of accounts) {
    if (!only.has(account.id) || !isProfitLossRole(account.role)) continue;
    const shown = figures.rows.get(account.id) ?? 0n;
    if (isIncomeRole(account.role)) income += shown;
    else expenses += shown;
  }
  return { income, expenses };
}

interface Read {
  readonly context: ReturnType<typeof reportContext>;
  readonly column: ReturnType<typeof compileColumn>;
  readonly profit: ProfitLoss;
  readonly pending: readonly Pending[];
}

function read(
  state: BookState,
  from: string,
  to: string,
  texts: ReadonlyMap<string, JournalText>,
  only?: ReadonlySet<string>,
): Read {
  const context = reportContext(state, to);
  resolveRange(context, to, from);
  const column = compileColumn(context, from, to);
  const profit = profitLossOf(context.accounts, profitLossFigures(context.accounts, column), only);
  const accounts = new Map(context.accounts.map((account) => [account.id, account]));

  // A reversal belongs to the payee of the journal it reverses (and a reversal of a reversal, of the
  // first of the chain).
  const reverses = new Map<string, string>();
  for (const link of state.corrections)
    if (link.kind === "reversal") reverses.set(link.correctionJournalId, link.originalJournalId);
  let byId: Map<string, BookedJournal> | undefined;
  const original = (journalId: string): BookedJournal | undefined => {
    let id = journalId;
    for (let hops = 0; hops < 8; hops++) {
      const next = reverses.get(id);
      if (next === undefined) break;
      id = next;
    }
    if (id === journalId) return undefined;
    byId ??= new Map(
      context.view.journalsByDate().map((booked) => [booked.journal.id as string, booked]),
    );
    return byId.get(id);
  };

  const pending: Pending[] = [];
  for (const booked of context.view.included(to).journals) {
    const date = booked.journal.accountingDate as string;
    if (date < from) continue;
    let received = 0n;
    let spent = 0n;
    const touched: ChartAccount[] = [];
    for (const posting of booked.journal.postings) {
      const account = accounts.get(posting.accountId as string);
      if (!account) throw new Error("Journal references an unknown account");
      if (!isProfitLossRole(account.role)) continue;
      if (only && !only.has(account.id)) continue;
      const cents = postingCents(posting);
      if (isIncomeRole(account.role)) received -= cents;
      else spent += cents;
      if (!touched.includes(account)) touched.push(account);
    }
    if (received === 0n && spent === 0n) continue;

    // The text to match: the first journal of a reversal chain speaks for the whole chain.
    const root = original(booked.journal.id as string);
    const head = root ?? booked;
    const source = texts.get(head.journal.id as string);
    const candidates: { text: string; from: TextFrom }[] = [];
    if (source?.connector !== undefined)
      candidates.push({ text: source.connector, from: "connector" });
    else if (source) {
      if (payeeKey(source.counterparty) !== "")
        candidates.push({ text: source.counterparty, from: "counterparty" });
      if (payeeKey(source.description) !== "")
        candidates.push({ text: source.description, from: "description" });
    } else candidates.push({ text: head.journal.narration, from: "narration" });
    const first = candidates[0];
    pending.push({
      journalId: booked.journal.id as string,
      date,
      narration: booked.journal.narration,
      received,
      spent,
      accounts: touched.sort((a, b) => compareCodes(a.code, b.code)),
      text: first ? payeeText(first.text) : "",
      textFrom: first?.from ?? null,
      reverses: root ? (root.journal.id as string) : null,
      candidates,
      handmade: !source && head.derivations.length === 0,
    });
  }
  return { context, column, profit, pending };
}

/** Where a journal goes, given the payees the matcher knows. */
function decide(pending: Pending, matcher: PayeeMatcher): Outcome {
  if (pending.candidates.length === 0) return { kind: "none", why: "no_bank_text" };
  const found = matcher.match(pending.candidates.map((candidate) => candidate.text));
  if (found.kind === "vendor") return { kind: "payee", payeeId: found.vendorId, key: found.key };
  if (found.kind === "ambiguous") return { kind: "ambiguous", payeeIds: found.vendorIds };
  // Typed by hand, its narration is the person's own words and not a payee to offer for naming.
  return pending.handmade ? { kind: "none", why: "by_hand" } : { kind: "unnamed" };
}

const matcherFor = (payees: readonly PayeeRecord[]): PayeeMatcher =>
  compileMatcher(payees.map((payee) => ({ id: payee.id, keys: payee.words })));

// ------------------------------------------------------------------------------------------------
// The report
// ------------------------------------------------------------------------------------------------

interface Bucket {
  received: bigint;
  spent: bigint;
  transactions: number;
  firstOn: string;
  lastOn: string;
  months: { received: bigint; spent: bigint; transactions: number }[] | undefined;
}

export function compilePayeeTotals(input: PayeeTotalsInput): PayeeTotals {
  const { state, from, to } = input;
  const { context, column, profit, pending } = read(state, from, to, input.texts, input.accounts);
  const windows = input.byMonth ? monthsOf(from, to) : [];
  if (windows.length > MAX_PAYEE_MONTHS)
    throw new ApplicationError(
      "too_many_months",
      `A report by month holds at most ${MAX_PAYEE_MONTHS} months; this range has ${windows.length}. Choose a shorter range.`,
      400,
    );
  const monthIndex = new Map(windows.map((window, index) => [window.month, index]));
  const matcher = matcherFor(input.payees);
  const payees = new Map(input.payees.map((payee) => [payee.id, payee]));

  const journals: JournalEffect[] = pending.map((one) => {
    const { candidates: _candidates, handmade: _handmade, ...effect } = one;
    return { ...effect, outcome: decide(one, matcher) };
  });

  // ---- aggregate -----------------------------------------------------------------------------
  const bucket = (date: string): Bucket => ({
    received: 0n,
    spent: 0n,
    transactions: 0,
    firstOn: date,
    lastOn: date,
    months: input.byMonth
      ? windows.map(() => ({ received: 0n, spent: 0n, transactions: 0 }))
      : undefined,
  });
  const add = (target: Bucket, effect: JournalEffect) => {
    target.received += effect.received;
    target.spent += effect.spent;
    target.transactions += 1;
    if (effect.date < target.firstOn) target.firstOn = effect.date;
    if (effect.date > target.lastOn) target.lastOn = effect.date;
    const slot = target.months?.[monthIndex.get(effect.date.slice(0, 7)) ?? -1];
    if (slot) {
      slot.received += effect.received;
      slot.spent += effect.spent;
      slot.transactions += 1;
    }
  };
  const named = new Map<string, Bucket>();
  const unnamed = new Map<string, Bucket & { biggest: JournalEffect }>();
  const ambiguous = new Map<
    string,
    Bucket & { biggest: JournalEffect; payeeIds: readonly string[]; key: string }
  >();
  const byHand = bucket(from);
  const noBankText = bucket(from);
  const all = bucket(from);
  const biggestOf = (current: JournalEffect, next: JournalEffect): JournalEffect => {
    const a = gross(current);
    const b = gross(next);
    return b > a ||
      (b === a &&
        (next.date < current.date ||
          (next.date === current.date && next.journalId < current.journalId)))
      ? next
      : current;
  };
  for (const effect of journals) {
    add(all, effect);
    const outcome = effect.outcome;
    if (outcome.kind === "payee") {
      let target = named.get(outcome.payeeId);
      if (!target) {
        target = bucket(effect.date);
        named.set(outcome.payeeId, target);
      }
      add(target, effect);
    } else if (outcome.kind === "ambiguous") {
      const key = groupKey(effect.text) || effect.text;
      const composite = `${key}\u0000${outcome.payeeIds.join(",")}`;
      let target = ambiguous.get(composite);
      if (!target) {
        target = { ...bucket(effect.date), biggest: effect, payeeIds: outcome.payeeIds, key };
        ambiguous.set(composite, target);
      }
      add(target, effect);
      target.biggest = biggestOf(target.biggest, effect);
    } else if (outcome.kind === "unnamed") {
      const key = groupKey(effect.text) || effect.text;
      let target = unnamed.get(key);
      if (!target) {
        target = { ...bucket(effect.date), biggest: effect };
        unnamed.set(key, target);
      }
      add(target, effect);
      target.biggest = biggestOf(target.biggest, effect);
    } else add(outcome.why === "by_hand" ? byHand : noBankText, effect);
  }
  const tally = (target: Bucket): Tally => ({
    received: target.received,
    spent: target.spent,
    transactions: target.transactions,
  });
  const monthsOfBucket = (target: Bucket): readonly Tally[] | undefined =>
    target.months?.map((slot) => ({ ...slot }));

  const rows: PayeeRow[] = [...named.entries()]
    .map(([payeeId, target]): PayeeRow => {
      const payee = payees.get(payeeId) as PayeeRecord;
      const months = monthsOfBucket(target);
      return {
        payeeId,
        name: payee.name,
        retired: payee.retired,
        received: target.received,
        spent: target.spent,
        transactions: target.transactions,
        firstOn: target.firstOn,
        lastOn: target.lastOn,
        ...(months ? { months } : {}),
      };
    })
    .sort(
      (a, b) =>
        compareDescending(gross(a), gross(b)) ||
        compareText(a.name.toLowerCase(), b.name.toLowerCase()) ||
        compareText(a.payeeId, b.payeeId),
    );
  const unnamedGroups: UnnamedGroup[] = [...unnamed.entries()]
    .map(([key, target]): UnnamedGroup => {
      const months = monthsOfBucket(target);
      return {
        key,
        text: target.biggest.text,
        received: target.received,
        spent: target.spent,
        transactions: target.transactions,
        firstOn: target.firstOn,
        lastOn: target.lastOn,
        ...(months ? { months } : {}),
      };
    })
    .sort((a, b) => compareDescending(gross(a), gross(b)) || compareText(a.key, b.key));
  const ambiguousGroups: AmbiguousGroup[] = [...ambiguous.values()]
    .map((target): AmbiguousGroup => {
      const months = monthsOfBucket(target);
      return {
        key: target.key,
        text: target.biggest.text,
        payeeIds: target.payeeIds,
        received: target.received,
        spent: target.spent,
        transactions: target.transactions,
        firstOn: target.firstOn,
        lastOn: target.lastOn,
        ...(months ? { months } : {}),
      };
    })
    .sort(
      (a, b) =>
        compareDescending(gross(a), gross(b)) ||
        compareText(a.key, b.key) ||
        compareText(a.payeeIds.join(","), b.payeeIds.join(",")),
    );

  // ---- the tie-out: the places add up to the profit and loss, or there is no report ----------
  const places: Bucket[] = [
    ...named.values(),
    ...unnamed.values(),
    ...ambiguous.values(),
    byHand,
    noBankText,
  ];
  const income = places.reduce((sum, place) => sum + place.received, 0n);
  const expenses = places.reduce((sum, place) => sum + place.spent, 0n);
  const differ = (what: string, got: bigint, want: bigint) =>
    got === want ? [] : [`${what} differs by ${formatMoney(got - want)}`];
  const problems = [
    ...differ("income", income, profit.income),
    ...differ("expenses", expenses, profit.expenses),
  ];
  const months: MonthTie[] = [];
  if (input.byMonth)
    for (const [index, window] of windows.entries()) {
      const figures = profitLossOf(
        context.accounts,
        profitLossFigures(context.accounts, compileColumn(context, window.from, window.to)),
        input.accounts,
      );
      months.push({
        month: window.month,
        from: window.from,
        to: window.to,
        profitLossIncome: figures.income,
        profitLossExpenses: figures.expenses,
      });
      let monthIncome = 0n;
      let monthExpenses = 0n;
      for (const place of places) {
        const slot = place.months?.[index];
        monthIncome += slot?.received ?? 0n;
        monthExpenses += slot?.spent ?? 0n;
      }
      problems.push(
        ...differ(`income in ${window.month}`, monthIncome, figures.income),
        ...differ(`expenses in ${window.month}`, monthExpenses, figures.expenses),
      );
    }
  if (problems.length > 0)
    throw new ApplicationError(
      "report_does_not_tie",
      `The report by payee does not add up to the profit and loss, so it is not shown: ${problems.join("; ")}.`,
      500,
    );

  return {
    from,
    to,
    basis: context.basis,
    ledgerPopulationHash: column.populationHash,
    journals,
    rows,
    unnamed: unnamedGroups,
    ambiguous: ambiguousGroups,
    noPayee: { byHand: tally(byHand), noBankText: tally(noBankText) },
    totals: tally(all),
    ...(input.byMonth ? { months } : {}),
    profitLoss: { income: profit.income, expenses: profit.expenses },
  };
}

/** A hash of what the report was read from besides the ledger, so a population changes when a payee's
 * words or the text behind a journal does. */
export function attributionHash(
  payees: readonly PayeeRecord[],
  texts: ReadonlyMap<string, JournalText>,
): string {
  return hashCanonical({
    type: "PayeeAttribution",
    version: PAYEE_TOTALS_VERSION,
    payees: [...payees]
      .sort((a, b) => compareText(a.id, b.id))
      .map((payee) => ({ id: payee.id, name: payee.name, words: [...payee.words] })),
    texts: [...texts.entries()]
      .sort(([a], [b]) => compareText(a, b))
      .map(([id, text]) => [id, text.counterparty, text.description, text.connector ?? null]),
  }).digest;
}

// ------------------------------------------------------------------------------------------------
// Trying words before they are saved
// ------------------------------------------------------------------------------------------------

export interface WordsTest {
  /** The keys that would be saved: the words of what was typed, one key to a line. */
  readonly keys: readonly string[];
  /** The transactions that would be this payee's once saved. */
  readonly matches: Tally;
  /** Of those, the ones that are already this payee's. */
  readonly stays: Tally;
  readonly fromUnnamed: Tally;
  readonly fromAmbiguous: Tally;
  /** Of those, entries that have no bank text to be told apart by (typed by hand, or a line with no text). */
  readonly fromNowhere: Tally;
  /** Of those, the ones that now belong to another payee and would move. */
  readonly taken: readonly { readonly payeeId: string; readonly tally: Tally }[];
  /** Transactions this payee has now and would not have: its words changed. */
  readonly lost: Tally;
  /** Transactions the words match as well as another payee's, so they would be given to neither. */
  readonly tied: Tally & { readonly payeeIds: readonly string[] };
  /** Transactions that contain the words but stay with another payee, whose key is longer. */
  readonly beaten: readonly { readonly payeeId: string; readonly tally: Tally }[];
  /** A few of the transactions that would be this payee's, the largest first. */
  readonly sample: readonly JournalEffect[];
}

export interface WordsTestInput {
  readonly state: BookState;
  readonly from: string;
  readonly to: string;
  readonly payees: readonly PayeeRecord[];
  readonly texts: ReadonlyMap<string, JournalText>;
  /** The words as typed, one phrase to an entry; they are reduced to keys here. */
  readonly words: readonly string[];
  /** The payee being changed: its present words are replaced by these. Absent for a new payee. */
  readonly payeeId?: string;
  /** Only the postings on these accounts, as in the report. */
  readonly accounts?: ReadonlySet<string>;
}

const SAMPLE = 5;

export function testPayeeWords(
  input: WordsTestInput,
): WordsTest & { readonly ledgerPopulationHash: string } {
  const { pending, column } = read(input.state, input.from, input.to, input.texts, input.accounts);
  const keys = [...new Set(input.words.map(payeeKey).filter((key) => key !== ""))];
  const self = input.payeeId ?? "\u0000new";
  const others = input.payees.filter((payee) => payee.id !== input.payeeId);
  const current = matcherFor(input.payees);
  const next = matcherFor([...others, { id: self, name: "", words: keys, retired: false }]);
  const mine = compileMatcher([{ id: self, keys }]);
  const sum = (): { received: bigint; spent: bigint; transactions: number } => ({
    received: 0n,
    spent: 0n,
    transactions: 0,
  });
  const put = (target: { received: bigint; spent: bigint; transactions: number }, one: Pending) => {
    target.received += one.received;
    target.spent += one.spent;
    target.transactions += 1;
  };
  const matches = sum();
  const stays = sum();
  const fromUnnamed = sum();
  const fromAmbiguous = sum();
  const fromNowhere = sum();
  const lost = sum();
  const tied = { ...sum(), payeeIds: new Set<string>() };
  const taken = new Map<string, ReturnType<typeof sum>>();
  const beaten = new Map<string, ReturnType<typeof sum>>();
  const slot = (map: Map<string, ReturnType<typeof sum>>, id: string) => {
    let found = map.get(id);
    if (!found) {
      found = sum();
      map.set(id, found);
    }
    return found;
  };
  const gained: Pending[] = [];
  for (const one of pending) {
    const was = decide(one, current);
    const will = decide(one, next);
    const wasMine = was.kind === "payee" && was.payeeId === self;
    const willBeMine = will.kind === "payee" && will.payeeId === self;
    if (willBeMine) {
      put(matches, one);
      gained.push(one);
      if (wasMine) put(stays, one);
      else if (was.kind === "payee") put(slot(taken, was.payeeId), one);
      else if (was.kind === "unnamed") put(fromUnnamed, one);
      else if (was.kind === "ambiguous") put(fromAmbiguous, one);
      else put(fromNowhere, one);
    } else if (wasMine) put(lost, one);
    if (will.kind === "ambiguous" && will.payeeIds.includes(self)) {
      put(tied, one);
      for (const id of will.payeeIds) if (id !== self) tied.payeeIds.add(id);
    } else if (
      !willBeMine &&
      will.kind === "payee" &&
      keys.length > 0 &&
      mine.match(one.candidates.map((candidate) => candidate.text)).kind === "vendor"
    )
      put(slot(beaten, will.payeeId), one);
  }
  const entries = (map: Map<string, ReturnType<typeof sum>>) =>
    [...map.entries()]
      .map(([payeeId, tally]) => ({ payeeId, tally }))
      .sort(
        (a, b) =>
          compareDescending(gross(a.tally), gross(b.tally)) || compareText(a.payeeId, b.payeeId),
      );
  const sample = gained
    .sort((a, b) => compareDescending(gross(a), gross(b)) || compareText(a.journalId, b.journalId))
    .slice(0, SAMPLE)
    .map((one) => {
      const { candidates: _candidates, handmade: _handmade, ...effect } = one;
      return {
        ...effect,
        outcome: { kind: "payee", payeeId: self, key: keys[0] ?? "" } as Outcome,
      };
    });
  return {
    keys,
    matches,
    stays,
    fromUnnamed,
    fromAmbiguous,
    fromNowhere,
    taken: entries(taken),
    lost,
    tied: { ...tied, payeeIds: [...tied.payeeIds].sort() },
    beaten: entries(beaten),
    sample,
    ledgerPopulationHash: column.populationHash,
  };
}

// ------------------------------------------------------------------------------------------------
// Words to offer when a text is named
// ------------------------------------------------------------------------------------------------

/** Words that say how money travelled or what kind of line it was, not who it went to. They are
 * skipped at the start of a text when words are suggested: "ZELLE PAYMENT FROM ACME DESIGN LLC" is
 * Acme Design. */
const CHANNEL: ReadonlySet<string> = new Set(
  (
    "zelle quickpay venmo cashapp paypal wire ach pos pmt pymt payment payments online transfer " +
    "from to credit debit deposit withdrawal purchase recurring checkcard card check web ppd ccd " +
    "incoming outgoing epayment autopay bill pay sq tst pp"
  ).split(" "),
);

/** The words to start from when naming a payee out of a bank's text: the leading name of the text, with
 * payment-channel words, numbers and a trailing place left out. Always words that are in the text,
 * whole and in order, so the payee being named matches the line it was named from; empty when the text
 * says nothing that names anyone. It is a suggestion for a person to shorten or extend, never a
 * decision. */
export function suggestWords(text: string): string {
  const words = payeeWords(text);
  let start = 0;
  while (start < words.length && CHANNEL.has(words[start] as string)) start++;
  const rest = words.slice(start);
  const suggested = payeeKey(merchantPhrase(rest.join(" ")).phrase);
  if (suggested.length >= PAYEE_KEY_MIN) {
    const probe = compileMatcher([{ id: "probe", keys: [suggested] }]);
    if (probe.match([text]).kind === "vendor") return suggested;
  }
  // Failing that, the leading words up to the first number.
  const lead: string[] = [];
  for (const word of rest) {
    if (/\p{N}/u.test(word)) break;
    lead.push(word);
    if (lead.length === 3) break;
  }
  const fallback = lead.join(" ");
  return fallback.length >= PAYEE_KEY_MIN ? fallback : "";
}
