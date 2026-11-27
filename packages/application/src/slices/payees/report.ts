/** The reads of the payees as the wire carries them: the report, one row of it opened, words tried
 * before they are saved, and the report as files. Each is made from one reading of the book, the
 * payees and the Inbox's text (`load`), so every part of one answer is from the same moment. */
import type {
  PayeeAmbiguousRow,
  PayeeDetail,
  PayeeExport,
  PayeeRest,
  PayeeTest,
  PayeeTotals as PayeeTotalsWire,
  PayeeTotalsRow,
  PayeeUnnamedRow,
} from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { formatMoney } from "../../money.ts";
import { summaryCsv, transactionsCsv, type PayeeFileHeader } from "../../payees/csv.ts";
import { groupKey } from "../../payees/match.ts";
import {
  PAYEE_TOTALS_VERSION,
  type JournalEffect,
  type PayeeTotals,
  type Tally,
  compilePayeeTotals,
  gross,
  suggestWords,
  testPayeeWords,
} from "../../payees/totals.ts";
import { reportContext } from "../../reports/columns.ts";
import type { SliceContext } from "../types.ts";
import {
  type Loaded,
  net,
  populationOf,
  payeeWire,
  refOf,
  refsByName,
  tallyWire,
  transactionWire,
} from "./read.ts";
import { cleanWords, holderOfKey } from "./save.ts";
import { MAX_WORDS } from "./save.ts";

const ROWS_PAGE = 100;
const UNNAMED_LIMIT = 100;
const AMBIGUOUS_LIMIT = 50;
const TRANSACTIONS_PAGE = 50;
const MAX_FILE_CHARACTERS = 16_000_000;

const abs = (value: bigint): bigint => (value < 0n ? -value : value);
const sideOf =
  (direction: string) =>
  (tally: { readonly received: bigint; readonly spent: bigint }): bigint =>
    direction === "spent"
      ? abs(tally.spent)
      : direction === "received"
        ? abs(tally.received)
        : gross(tally);
const keeps =
  (direction: string) =>
  (tally: { readonly received: bigint; readonly spent: bigint }): boolean =>
    direction === "both" || (direction === "spent" ? tally.spent !== 0n : tally.received !== 0n);

const warningsOf = (loaded: Loaded) =>
  loaded.textsRead
    ? []
    : [
        {
          code: "inbox_unreadable",
          message:
            "The Inbox could not be read, so every entry was matched on its own narration. Names found in bank lines may be missing.",
        },
      ];

const pageOf = (input: Record<string, unknown>, fallback: number) => ({
  page: typeof input.page === "number" ? input.page : 1,
  size: typeof input.pageSize === "number" ? input.pageSize : fallback,
});

export function compileFor(loaded: Loaded, byMonth = false): PayeeTotals {
  return compilePayeeTotals({
    state: loaded.state,
    from: loaded.from,
    to: loaded.to,
    payees: loaded.records,
    texts: loaded.texts,
    byMonth,
    ...(loaded.only ? { accounts: loaded.only } : {}),
  });
}

/** Tallies added up. */
function sum(tallies: readonly Tally[]): Tally {
  let received = 0n;
  let spent = 0n;
  let transactions = 0;
  for (const tally of tallies) {
    received += tally.received;
    spent += tally.spent;
    transactions += tally.transactions;
  }
  return { received, spent, transactions };
}

/** What a bounded list left out, added up. */
function rest(left: readonly Tally[]): PayeeRest {
  const total = sum(left);
  return {
    groups: left.length,
    received: formatMoney(total.received),
    spent: formatMoney(total.spent),
    transactions: total.transactions,
  };
}

export function totalsWire(
  loaded: Loaded,
  input: Record<string, unknown>,
  report: PayeeTotals,
): PayeeTotalsWire {
  const direction = typeof input.direction === "string" ? input.direction : "both";
  const keep = keeps(direction);
  const size = sideOf(direction);
  const bigger = <T extends { received: bigint; spent: bigint }>(a: T, b: T) =>
    size(b) > size(a) ? 1 : size(b) < size(a) ? -1 : 0;
  const { page, size: pageSize } = pageOf(input, ROWS_PAGE);
  const rows = report.rows.filter(keep).sort(direction === "both" ? () => 0 : bigger);
  const shownRows: PayeeTotalsRow[] = rows
    .slice((page - 1) * pageSize, page * pageSize)
    .map((row) => ({
      payeeId: row.payeeId,
      name: row.name,
      retired: row.retired,
      received: formatMoney(row.received),
      spent: formatMoney(row.spent),
      net: net(row),
      transactions: row.transactions,
      firstOn: row.firstOn,
      lastOn: row.lastOn,
      ...(row.months ? { months: row.months.map(tallyWire) } : {}),
    }));
  const unnamed = report.unnamed.filter(keep).sort(direction === "both" ? () => 0 : bigger);
  const shownUnnamed: PayeeUnnamedRow[] = unnamed.slice(0, UNNAMED_LIMIT).map((group) => ({
    key: group.key,
    text: group.text,
    suggestedWords: suggestWords(group.text),
    received: formatMoney(group.received),
    spent: formatMoney(group.spent),
    net: net(group),
    transactions: group.transactions,
    firstOn: group.firstOn,
    lastOn: group.lastOn,
    ...(group.months ? { months: group.months.map(tallyWire) } : {}),
  }));
  const ambiguous = report.ambiguous.filter(keep).sort(direction === "both" ? () => 0 : bigger);
  const shownAmbiguous: PayeeAmbiguousRow[] = ambiguous.slice(0, AMBIGUOUS_LIMIT).map((group) => ({
    key: group.key,
    text: group.text,
    payees: refsByName(loaded.names, group.payeeIds),
    received: formatMoney(group.received),
    spent: formatMoney(group.spent),
    net: net(group),
    transactions: group.transactions,
    firstOn: group.firstOn,
    lastOn: group.lastOn,
    ...(group.months ? { months: group.months.map(tallyWire) } : {}),
  }));
  const context = reportContext(loaded.state, loaded.to);
  return {
    from: loaded.from,
    to: loaded.to,
    currency: loaded.state.identity.functionalCommodityId,
    basis: context.basis,
    bookRevision: loaded.state.bookRevision.toString(),
    payeesRevision: String(loaded.payeeState.revision),
    payeesHash: loaded.payeeState.hash,
    ledgerPopulationHash: report.ledgerPopulationHash,
    populationHash: populationOf(report.ledgerPopulationHash, loaded),
    direction: direction as PayeeTotalsWire["direction"],
    ...(loaded.accountIds ? { accountIds: [...loaded.accountIds] } : {}),
    ...(report.months
      ? {
          months: report.months.map((month) => ({
            month: month.month,
            from: month.from,
            to: month.to,
            profitLossIncome: formatMoney(month.profitLossIncome),
            profitLossExpenses: formatMoney(month.profitLossExpenses),
          })),
        }
      : {}),
    rows: shownRows,
    rowCount: rows.length,
    page,
    pageSize,
    unnamed: shownUnnamed,
    unnamedCount: unnamed.length,
    unnamedRest: rest(unnamed.slice(UNNAMED_LIMIT)),
    ambiguous: shownAmbiguous,
    ambiguousCount: ambiguous.length,
    ambiguousRest: rest(ambiguous.slice(AMBIGUOUS_LIMIT)),
    noPayee: {
      byHand: tallyWire(report.noPayee.byHand),
      noBankText: tallyWire(report.noPayee.noBankText),
    },
    totals: tallyWire(report.totals),
    tieOut: {
      profitLossIncome: formatMoney(report.profitLoss.income),
      profitLossExpenses: formatMoney(report.profitLoss.expenses),
      income: formatMoney(report.totals.received),
      expenses: formatMoney(report.totals.spent),
      // The whole range, whatever side or page the lists above show.
      places: {
        payees: tallyWire(sum(report.rows)),
        unnamed: tallyWire(sum(report.unnamed)),
        ambiguous: tallyWire(sum(report.ambiguous)),
        noPayee: tallyWire(sum([report.noPayee.byHand, report.noPayee.noBankText])),
      },
      matches: true,
    },
    inboxRead: loaded.textsRead,
    warnings: warningsOf(loaded),
  };
}

// ------------------------------------------------------------------------------------------------

type Subject =
  | { readonly kind: "payee"; readonly payeeId: string }
  | { readonly kind: "unnamed"; readonly key: string }
  | { readonly kind: "ambiguous"; readonly key: string }
  | { readonly kind: "no_payee"; readonly why: "by_hand" | "no_bank_text" };

function subjectOf(input: Record<string, unknown>): Subject {
  const chosen: Subject[] = [];
  if (typeof input.payeeId === "string") chosen.push({ kind: "payee", payeeId: input.payeeId });
  if (typeof input.unnamed === "string") chosen.push({ kind: "unnamed", key: input.unnamed });
  if (typeof input.ambiguous === "string") chosen.push({ kind: "ambiguous", key: input.ambiguous });
  if (input.noPayee === "by_hand" || input.noPayee === "no_bank_text")
    chosen.push({ kind: "no_payee", why: input.noPayee });
  const only = chosen[0];
  if (chosen.length !== 1 || !only)
    throw new ApplicationError(
      "invalid_input",
      "Name exactly one thing to read: payeeId, unnamed, ambiguous or noPayee.",
      400,
    );
  return only;
}

const isIn = (subject: Subject, effect: JournalEffect): boolean => {
  const outcome = effect.outcome;
  switch (subject.kind) {
    case "payee":
      return outcome.kind === "payee" && outcome.payeeId === subject.payeeId;
    case "unnamed":
      return outcome.kind === "unnamed" && (groupKey(effect.text) || effect.text) === subject.key;
    case "ambiguous":
      return outcome.kind === "ambiguous" && (groupKey(effect.text) || effect.text) === subject.key;
    case "no_payee":
      return outcome.kind === "none" && outcome.why === subject.why;
  }
};

export function detailWire(
  loaded: Loaded,
  input: Record<string, unknown>,
  report: PayeeTotals,
): PayeeDetail {
  const subject = subjectOf(input);
  const payee =
    subject.kind === "payee"
      ? loaded.payeeState.payees.find((entry) => entry.id === subject.payeeId)
      : undefined;
  if (subject.kind === "payee" && !payee)
    throw new ApplicationError(
      "payee_not_found",
      "No payee has that id. List them with payees.list.",
      404,
    );
  const inside = report.journals
    .filter((effect) => isIn(subject, effect))
    .sort(
      (a, b) =>
        (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) ||
        (a.journalId < b.journalId ? -1 : a.journalId > b.journalId ? 1 : 0),
    );
  let received = 0n;
  let spent = 0n;
  for (const effect of inside) {
    received += effect.received;
    spent += effect.spent;
  }
  const { page, size } = pageOf(input, TRANSACTIONS_PAGE);
  const ambiguousPayees = new Set<string>();
  if (subject.kind === "ambiguous")
    for (const effect of inside)
      if (effect.outcome.kind === "ambiguous")
        for (const id of effect.outcome.payeeIds) ambiguousPayees.add(id);
  const example = inside[0];
  const context = reportContext(loaded.state, loaded.to);
  return {
    subject: {
      kind: subject.kind,
      ...(subject.kind === "payee" ? { payeeId: subject.payeeId } : {}),
      ...(subject.kind === "unnamed" || subject.kind === "ambiguous" ? { key: subject.key } : {}),
      ...(subject.kind === "unnamed" || subject.kind === "ambiguous"
        ? { text: example?.text ?? "" }
        : {}),
      ...(subject.kind === "no_payee" ? { why: subject.why } : {}),
      ...(subject.kind === "ambiguous"
        ? { payees: refsByName(loaded.names, ambiguousPayees) }
        : {}),
    },
    payee: payee ? payeeWire(payee, loaded.vendors) : null,
    history: payee
      ? (loaded.payeeState.history.get(payee.id) ?? []).slice(-200).map((entry) => ({
          version: entry.version,
          name: entry.name,
          words: [...entry.words],
          defaultAccountId: entry.defaultAccountId,
          note: entry.note,
          retired: entry.retired,
          recordedAt: entry.recordedAt,
          principal: entry.principal,
          via: entry.via,
        }))
      : [],
    transactions: inside
      .slice((page - 1) * size, page * size)
      .map((effect) => transactionWire(effect, loaded.names)),
    count: inside.length,
    page,
    pageSize: size,
    totals: tallyWire({ received, spent, transactions: inside.length }),
    from: loaded.from,
    to: loaded.to,
    currency: loaded.state.identity.functionalCommodityId,
    basis: context.basis,
    bookRevision: loaded.state.bookRevision.toString(),
    payeesRevision: String(loaded.payeeState.revision),
    ledgerPopulationHash: report.ledgerPopulationHash,
    populationHash: populationOf(report.ledgerPopulationHash, loaded),
    ...(loaded.accountIds ? { accountIds: [...loaded.accountIds] } : {}),
    inboxRead: loaded.textsRead,
    warnings: warningsOf(loaded),
  };
}

// ------------------------------------------------------------------------------------------------

export function testWire(loaded: Loaded, input: Record<string, unknown>): PayeeTest {
  const words = Array.isArray(input.words) ? (input.words as string[]) : [];
  const payeeId = typeof input.payeeId === "string" ? input.payeeId : undefined;
  if (payeeId !== undefined && !loaded.payeeState.payees.some((payee) => payee.id === payeeId))
    throw new ApplicationError(
      "payee_not_found",
      "No payee has that id. List them with payees.list.",
      404,
    );
  const problems: { code: string; message: string }[] = [];
  let usable = words;
  try {
    cleanWords(words);
  } catch (error) {
    if (!(error instanceof ApplicationError)) throw error;
    problems.push({ code: error.code, message: error.message });
    // Try what can be tried: the words that are long enough.
    usable = words.filter((entry) => {
      try {
        cleanWords([entry]);
        return true;
      } catch {
        return false;
      }
    });
  }
  const tested = testPayeeWords({
    state: loaded.state,
    from: loaded.from,
    to: loaded.to,
    payees: loaded.records,
    texts: loaded.texts,
    words: usable.slice(0, MAX_WORDS),
    ...(payeeId !== undefined ? { payeeId } : {}),
    ...(loaded.only ? { accounts: loaded.only } : {}),
  });
  for (const key of tested.keys) {
    const holder = holderOfKey(loaded.payeeState, key, payeeId ?? null);
    if (holder)
      problems.push({
        code: "payee_key_in_use",
        message: `"${key}" already belongs to ${holder.name}. A set of words names one payee.`,
      });
  }
  return {
    keys: [...tested.keys],
    problems,
    matches: tallyWire(tested.matches),
    stays: tallyWire(tested.stays),
    fromUnnamed: tallyWire(tested.fromUnnamed),
    fromAmbiguous: tallyWire(tested.fromAmbiguous),
    fromNowhere: tallyWire(tested.fromNowhere),
    taken: tested.taken.map((entry) => ({
      payee: refOf(loaded.names, entry.payeeId),
      tally: tallyWire(entry.tally),
    })),
    lost: tallyWire(tested.lost),
    tied: {
      received: formatMoney(tested.tied.received),
      spent: formatMoney(tested.tied.spent),
      transactions: tested.tied.transactions,
      payees: refsByName(loaded.names, tested.tied.payeeIds),
    },
    beaten: tested.beaten.map((entry) => ({
      payee: refOf(loaded.names, entry.payeeId),
      tally: tallyWire(entry.tally),
    })),
    // A payee that is not saved yet has no id to name: the transaction shows the words that found it.
    sample: tested.sample.map((effect) => ({
      ...transactionWire(effect, loaded.names),
      ...(payeeId === undefined ? { payee: null } : {}),
    })),
    from: loaded.from,
    to: loaded.to,
    bookRevision: loaded.state.bookRevision.toString(),
    payeesRevision: String(loaded.payeeState.revision),
    ledgerPopulationHash: tested.ledgerPopulationHash,
    inboxRead: loaded.textsRead,
  };
}

// ------------------------------------------------------------------------------------------------

export function exportFile(
  context: SliceContext,
  loaded: Loaded,
  input: Record<string, unknown>,
  report: PayeeTotals,
): PayeeExport {
  const reports = reportContext(loaded.state, loaded.to);
  const header: PayeeFileHeader = {
    title: "Money by payee",
    book: context.service.setupState()?.name ?? "",
    currency: loaded.state.identity.functionalCommodityId,
    basis: reports.basis,
    periodStart: loaded.from,
    periodEnd: loaded.to,
    bookRevision: loaded.state.bookRevision.toString(),
    payeesRevision: String(loaded.payeeState.revision),
    populationHash: populationOf(report.ledgerPopulationHash, loaded),
    ledgerPopulationHash: report.ledgerPopulationHash,
    compilerVersion: PAYEE_TOTALS_VERSION,
    accounts: (loaded.accountIds ?? []).map((id) => {
      const account = reports.accounts.find((entry) => entry.id === id);
      return account ? `${account.code} ${account.name}` : id;
    }),
  };
  const names = {
    name: (id: string) => loaded.names.get(id) ?? id,
    words: (id: string) => loaded.payeeState.payees.find((payee) => payee.id === id)?.words ?? [],
  };
  const stem = `${loaded.from}-to-${loaded.to}`;
  let filename: string;
  let content: string;
  if (input.file === "transactions") {
    const only = typeof input.payeeId === "string" ? input.payeeId : null;
    if (only !== null && !loaded.payeeState.payees.some((payee) => payee.id === only))
      throw new ApplicationError(
        "payee_not_found",
        "No payee has that id. List them with payees.list.",
        404,
      );
    const journals = report.journals.filter(
      (effect) =>
        only === null || (effect.outcome.kind === "payee" && effect.outcome.payeeId === only),
    );
    content = transactionsCsv(
      { ...header, title: "Money by payee: transactions" },
      journals,
      names,
    );
    filename = `payee-transactions-${stem}.csv`;
  } else {
    content = summaryCsv(header, report, names, suggestWords);
    filename = `money-by-payee-${stem}.csv`;
  }
  if (content.length > MAX_FILE_CHARACTERS)
    throw new ApplicationError(
      "export_too_large",
      "This file is too large to return in one piece. Choose a shorter date range.",
      413,
    );
  return {
    filename,
    mediaType: "text/csv; charset=utf-8",
    bookRevision: header.bookRevision,
    populationHash: header.populationHash,
    content,
  };
}
