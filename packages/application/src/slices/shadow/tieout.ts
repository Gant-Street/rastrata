/** The tie-out report: what the pure engine (`shadow/xero/tie-out.ts`) says, with Rastrata's side
 * gathered through the reports lane's operations (`reports.get`, `reports.generalLedger`,
 * `reports.calendar`, `periods.list`) and Xero's from what was imported. Nothing here reads another
 * lane's tables, and nothing here changes anything. */
import type {
  GeneralLedger,
  PeriodList,
  ReportCalendar,
  CoreReports,
  TieoutAccount,
  TieoutInput,
  TieoutLine,
  TieoutPeriod,
  TieoutReport,
} from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { parseMoney, formatMoney } from "../../money.ts";
import { addDays } from "../../reports/dates.ts";
import { sideOf } from "../../shadow/opening.ts";
import {
  type AccountInput,
  type Line,
  type LineDifference,
  type PeriodInput,
  tieOut,
} from "../../shadow/xero/tie-out.ts";
import type { SliceContext } from "../types.ts";
import { readChart } from "./chart.ts";
import { callOperation } from "./operations.ts";
import { openingStatus } from "./opening.ts";
import { shadowStore, xeroStore } from "./store.ts";

const lower = (code: string): string => code.trim().toLowerCase();
const normalName = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, " ");

/** The most pages of the general ledger read for one period: a hundred lines a page. */
const MAX_PAGES = 400;

interface Ledger {
  readonly movement: Map<string, bigint>;
  readonly lines: Map<string, Line[]>;
}

/** Rastrata's movement and lines for a period from the general ledger. The opening entry (and
 * anything that corrects it) is left out: it is what the book started from, so it is the book's
 * opening balance and not an event of the period, and Xero has no line for it. */
async function ledgerFor(
  context: SliceContext,
  from: string,
  to: string,
  exclude: ReadonlySet<string>,
): Promise<Ledger> {
  const movement = new Map<string, bigint>();
  const lines = new Map<string, Line[]>();
  let seen = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await callOperation<GeneralLedger>(context, "reports.generalLedger", {
      asOf: to,
      from,
      page,
    });
    if (page === 1)
      for (const account of data.accounts)
        movement.set(
          account.accountId,
          parseMoney(account.totalDebit) - parseMoney(account.totalCredit),
        );
    for (const line of data.lines) {
      const net = parseMoney(line.debit) - parseMoney(line.credit);
      if (exclude.has(line.journalId)) {
        movement.set(line.accountId, (movement.get(line.accountId) ?? 0n) - net);
        continue;
      }
      const list = lines.get(line.accountId) ?? [];
      list.push({
        id: line.postingId,
        date: line.date,
        description: line.narration,
        reference: line.journalId,
        source: "",
        net,
      });
      lines.set(line.accountId, list);
    }
    seen += data.lines.length;
    if (seen >= data.count || data.lines.length === 0) break;
  }
  return { movement, lines };
}

async function closingAt(
  context: SliceContext,
  date: string,
  calendar: ReportCalendar,
  cache: Map<string, Map<string, bigint>>,
): Promise<Map<string, bigint>> {
  const cached = cache.get(date);
  if (cached) return cached;
  const map = new Map<string, bigint>();
  if (date >= calendar.firstDate) {
    const data = await callOperation<CoreReports>(context, "reports.get", { asOf: date });
    for (const row of data.trialBalance.rows)
      map.set(row.accountId, parseMoney(row.debit) - parseMoney(row.credit));
  }
  cache.set(date, map);
  return map;
}

const fiscalYearOf = (calendar: ReportCalendar, date: string): number | null =>
  calendar.fiscalYears.find((year) => year.startsOn <= date && date <= year.endsOn)?.year ?? null;

/** A Xero account of a stored report line: by its code, else by its name in the chart. */
function codeResolver(chart: readonly { code: string; name: string }[]) {
  const byCode = new Map(chart.map((account) => [lower(account.code), account.code]));
  const byName = new Map(chart.map((account) => [normalName(account.name), account.code]));
  return (code: string | null, name: string): string | null =>
    (code !== null ? byCode.get(lower(code)) : undefined) ?? byName.get(normalName(name)) ?? code;
}

/** Turn a debit-positive amount into the account's normal orientation, as a money string. */
const natural = (role: AccountInput["role"], cents: bigint | null): string | null =>
  cents === null ? null : formatMoney(sideOf(role) === "debit" ? cents : -cents);

const lineView = (item: LineDifference): TieoutLine => ({
  side: item.side,
  date: item.line.date,
  description: item.line.description,
  reference: item.line.reference,
  source: item.line.source,
  debit: formatMoney(item.line.net > 0n ? item.line.net : 0n),
  credit: formatMoney(item.line.net < 0n ? -item.line.net : 0n),
});

export async function tieOutReport(
  context: SliceContext,
  input: TieoutInput,
): Promise<TieoutReport> {
  const store = xeroStore(context.service);
  const chart = store.accounts();
  if (chart.length === 0)
    throw new ApplicationError(
      "xero_chart_missing",
      "Import the Xero chart and map it before the tie-out.",
      409,
    );
  const book = await readChart(context);
  const calendar = await callOperation<ReportCalendar>(context, "reports.calendar");
  const periodList = await callOperation<PeriodList>(context, "periods.list");
  const cutover = shadowStore(context.service).cutover()?.cutoverOn ?? null;
  const { ownJournalIds } = await openingStatus(context.service);
  const saved = store.mapping();
  const resolve = codeResolver(chart);
  const xeroByCode = new Map(chart.map((account) => [lower(account.code), account]));

  // The accounts of the book and the Xero accounts the owner has mapped to each.
  const mapped = new Map<string, string[]>();
  for (const [code, choice] of saved)
    if (!choice.skip && choice.accountId) {
      const list = mapped.get(choice.accountId) ?? [];
      list.push(code);
      mapped.set(choice.accountId, list);
    }
  const accounts: AccountInput[] = book.accounts.map((account) => ({
    accountId: account.id,
    code: account.code,
    name: account.name,
    role: account.role,
    xero: (mapped.get(account.id) ?? []).flatMap((code) => {
      const xero = xeroByCode.get(code);
      return xero ? [{ code: xero.code, name: xero.name, bank: xero.bank }] : [];
    }),
  }));
  const unmappedChart = new Map<string, { name: string; bank: boolean }>();
  // Xero's retained earnings is not compared (the book's opening balances hold the earlier years'
  // earnings), so it is not an account that "nothing maps".
  for (const account of chart)
    if (
      !saved.has(lower(account.code)) &&
      !account.archived &&
      lower(account.typeLabel ?? "") !== "retained earnings"
    )
      unmappedChart.set(account.code, { name: account.name, bank: account.bank });

  // Xero's trial balances by date, as debit-positive year-to-date balances by Xero code.
  const trialBalances = new Map<string, Map<string, bigint>>();
  for (const date of store.trialBalanceDates()) {
    const map = new Map<string, bigint>();
    for (const row of store.trialBalance(date)) {
      const code = resolve(row.code, row.name);
      if (code === null) continue;
      map.set(code, (map.get(code) ?? 0n) + (row.ytdDebit - row.ytdCredit));
    }
    trialBalances.set(date, map);
  }
  const ranges = store.transactionRanges();

  // The periods to compare: the book's periods from the cutover on that Xero has something for.
  const wanted = periodList.periods
    .filter((period) => period.ended)
    .filter((period) => cutover === null || period.endsOn >= cutover)
    .filter((period) => input.from === undefined || period.endsOn >= input.from)
    .filter((period) => input.to === undefined || period.startsOn <= input.to)
    .filter((period) => {
      const covered = ranges.some(
        (range) => range.from <= period.startsOn && period.endsOn <= range.to,
      );
      return covered || trialBalances.has(period.endsOn);
    });

  const closingCache = new Map<string, Map<string, bigint>>();
  const inputs: PeriodInput[] = [];
  for (const period of wanted) {
    const covered = ranges.some(
      (range) => range.from <= period.startsOn && period.endsOn <= range.to,
    );
    const lines = new Map<string, Line[]>();
    if (covered)
      for (const stored of store.lines(period.startsOn, period.endsOn)) {
        const code = resolve(stored.code, stored.name);
        if (code === null) continue;
        const list = lines.get(code) ?? [];
        list.push({
          id: `${stored.fileSeq}:${stored.row}`,
          date: stored.date,
          description: stored.description,
          reference: stored.reference,
          source: stored.source,
          net: stored.debit - stored.credit,
        });
        lines.set(code, list);
      }
    const ledger = await ledgerFor(context, period.startsOn, period.endsOn, ownJournalIds);
    const dayBefore = addDays(period.startsOn, -1);
    inputs.push({
      from: period.startsOn,
      to: period.endsOn,
      rastrataClosing: await closingAt(context, period.endsOn, calendar, closingCache),
      rastrataMovement: ledger.movement,
      rastrataLines: ledger.lines,
      xeroClosing: trialBalances.get(period.endsOn) ?? null,
      xeroOpening: trialBalances.get(dayBefore) ?? null,
      sameFiscalYear: fiscalYearOf(calendar, dayBefore) === fiscalYearOf(calendar, period.endsOn),
      xeroLines: covered ? lines : null,
    });
  }

  const reconciledThrough = new Map(store.reconciled().map((row) => [row.code, row.through]));
  const results = tieOut({
    cutoverDate: cutover,
    accounts,
    xeroUnmapped: unmappedChart,
    reconciledThrough,
    periods: inputs,
    ...(input.toleranceDays !== undefined ? { toleranceDays: input.toleranceDays } : {}),
  });

  const byAccount = new Map(accounts.map((account) => [account.accountId, account]));
  const periods: TieoutPeriod[] = results.map((result) => {
    const rows: TieoutAccount[] = result.accounts.map((item) => {
      const role = byAccount.get(item.accountId)?.role ?? item.role;
      const explained =
        item.status === "differs" && item.residual === 0n && item.unmatched !== null;
      return {
        accountId: item.accountId,
        code: item.code,
        name: item.name,
        role,
        basis: item.basis,
        status: item.status,
        reason: item.reason ? { code: item.reason.code, message: item.reason.message } : null,
        xero: natural(role, item.xero),
        rastrata: natural(role, item.rastrata),
        difference: natural(role, item.difference),
        carried: natural(role, item.carried),
        matched: item.matched,
        unmatched: item.unmatched === null ? null : item.unmatched.slice(0, 200).map(lineView),
        unmatchedCount: item.unmatched === null ? null : item.unmatched.length,
        residual: natural(role, item.residual),
        explained,
      };
    });
    return {
      from: result.from,
      to: result.to,
      xeroReconciled: result.xeroReconciled,
      notReconciled: result.xeroNotReconciled.map((bank) => ({
        code: bank.code,
        name: bank.name,
        through: bank.through,
      })),
      accounts: rows,
      unmapped: result.unmapped.map((item) => ({
        code: item.code,
        name: item.name,
        net: formatMoney(item.net),
      })),
    };
  });

  const all = periods.flatMap((period) => period.accounts);
  const summary = {
    periods: periods.length,
    comparable: all.filter((row) => row.status !== "not_comparable").length,
    matches: all.filter((row) => row.status === "matches").length,
    differs: all.filter((row) => row.status === "differs").length,
    explained: all.filter((row) => row.explained).length,
    unexplained: all.filter((row) => row.status === "differs" && !row.explained).length,
    notComparable: all.filter((row) => row.status === "not_comparable").length,
    linesOnlyInXero: all.reduce(
      (n, row) => n + (row.unmatched ?? []).filter((line) => line.side === "xero").length,
      0,
    ),
    linesOnlyInRastrata: all.reduce(
      (n, row) => n + (row.unmatched ?? []).filter((line) => line.side === "rastrata").length,
      0,
    ),
  };
  const notes: string[] = [
    "Every figure is in the account's normal orientation. A difference is Rastrata less Xero.",
    "Xero is compared only where it was itself reconciled: a period whose Xero bank accounts were not all reconciled through its end is not comparable, and neither is a period that starts before the cutover date.",
    "Xero's retained earnings, and the earnings Rastrata calculates, are not compared: a book that starts at the cutover date has the earlier years' earnings in its opening balances.",
  ];
  if (calendar.basis === "cash")
    notes.push(
      "This book is kept on a cash basis and Xero's trial balance is on an accrual basis: unpaid invoices and bills explain differences in income, expenses, receivables and payables.",
    );
  if (periods.length === 0)
    notes.push(
      "No period has anything from Xero to compare yet: import a trial balance as at a period's last day, or account transactions that cover a whole period.",
    );
  const saveable = [...unmappedChart].length;
  if (saveable > 0)
    notes.push(
      `${saveable} Xero account${saveable === 1 ? " is" : "s are"} not mapped (or left out), so nothing in Xero is compared with ${saveable === 1 ? "it" : "them"}.`,
    );
  return {
    currency: book.currency,
    basis: calendar.basis,
    cutoverDate: cutover,
    toleranceDays: input.toleranceDays ?? 4,
    periods,
    summary,
    notes,
  };
}
