import { createMemo, createUniqueId, type JSX, Show } from "solid-js";
import { useUi } from "../locale";
import { Notice } from "../notice";
import { Pager } from "../pager";
import type {
  CashFlowData,
  CoreReportsData,
  GeneralLedgerData,
  MonthlyReports,
  ReportHrefs,
  ScopeData,
} from "./data";
import { amountDifference } from "./format";
import { LedgerAccounts, LedgerLines } from "./ledger-table";
import { describeRange } from "./period";
import { ReportContext } from "./report-context";
import { ReportDetails } from "./report-details";
import { ReportWarnings } from "./report-state";
import { StatementTable, type StatementLine } from "./statement-table";
import { TieOut } from "./tie-out";
import {
  balanceSheetLines,
  balanceSheetMonthlyLines,
  cashFlowLines,
  monthsAddUp,
  profitLossLines,
  profitLossMonthlyLines,
  trialBalanceLines,
} from "./view-model";

/** What every statement view needs besides its data. */
interface ViewProps {
  hrefs: ReportHrefs;
  bookName?: string | undefined;
}

interface TableViewProps extends ViewProps {
  /** Show accounts that have no activity too; otherwise they are left out. The choice is in View. */
  showZero: boolean;
}

/** The line above a statement's table: its name, the book, the dates and the basis. */
function Context(props: {
  scope: ScopeData;
  title: string;
  period: string;
  bookName?: string | undefined;
  id: string;
}) {
  return (
    <ReportContext
      title={props.title}
      period={props.period}
      basis={props.scope.basis}
      bookName={props.bookName}
      headingId={props.id}
    />
  );
}

/** The proof a statement carries, at its foot and closed: the book revision and the fingerprint. */
function Proof(props: {
  scope: ScopeData;
  columns?: readonly { readonly label: string; readonly hash: string }[] | undefined;
}) {
  return (
    <ReportDetails
      revision={props.scope.bookRevision}
      populationHash={props.scope.populationHash}
      basis={props.scope.basis}
      currency={props.scope.currency}
      fiscalYear={props.scope.fiscalYear}
      columns={props.columns}
    />
  );
}

function ComparedWith(props: { data: CoreReportsData | CashFlowData }) {
  const ui = useUi();
  return (
    <Show when={props.data.comparison}>
      {(comparison) => (
        <p class="rt-hint">
          {ui.messages.reports.views.comparedWith(
            describeRange({ from: comparison().periodStart, to: comparison().asOf }),
          )}
        </p>
      )}
    </Show>
  );
}

export function ProfitLossView(props: TableViewProps & { data: CoreReportsData }) {
  const ui = useUi();
  const m = () => ui.messages.reports;
  const id = createUniqueId();
  const result = createMemo(() =>
    profitLossLines(props.data, props.hrefs, m(), { showZero: props.showZero }),
  );
  const period = () => describeRange({ from: props.data.periodStart, to: props.data.asOf });
  return (
    <div class="rt-report">
      <Context
        scope={props.data}
        title={m().statements.profitLoss}
        period={period()}
        bookName={props.bookName}
        id={id}
      />
      <ReportWarnings warnings={props.data.warnings} />
      <ComparedWith data={props.data} />
      <StatementTable
        caption={`${m().statements.profitLoss} · ${period()}`}
        captionHidden
        lines={result().lines}
        columns={result().columns}
        columnHints={result().hints}
      />
      <Show when={result().shares}>
        <p class="rt-hint rt-report-share-note">{m().share.note}</p>
      </Show>
      <Proof scope={props.data} />
    </div>
  );
}

export function BalanceSheetView(props: TableViewProps & { data: CoreReportsData }) {
  const ui = useUi();
  const m = () => ui.messages.reports;
  const id = createUniqueId();
  const result = createMemo(() =>
    balanceSheetLines(props.data, props.hrefs, m(), { showZero: props.showZero }),
  );
  const period = () => m().views.asOfPeriod(props.data.asOf);
  const sheet = () => props.data.balanceSheet;
  const difference = () => amountDifference(sheet().assets, [sheet().liabilities, sheet().equity]);
  const tie = () => (
    <TieOut
      title={m().views.equation}
      total={{ label: m().groups.asset, amount: sheet().assets }}
      parts={[
        { label: m().groups.liability, amount: sheet().liabilities },
        { label: m().groups.equity, amount: sheet().equity },
      ]}
      difference={difference()}
    />
  );
  return (
    <div class="rt-report">
      <Context
        scope={props.data}
        title={m().statements.balanceSheet}
        period={period()}
        bookName={props.bookName}
        id={id}
      />
      <ReportWarnings warnings={props.data.warnings} />
      <Show when={difference() !== "0.00"}>{tie()}</Show>
      <ComparedWith data={props.data} />
      <StatementTable
        caption={`${m().statements.balanceSheet} · ${period()}`}
        captionHidden
        lines={result().lines}
        columns={result().columns}
      />
      <Proof scope={props.data} />
    </div>
  );
}

export function TrialBalanceView(props: TableViewProps & { data: CoreReportsData }) {
  const ui = useUi();
  const m = () => ui.messages.reports;
  const id = createUniqueId();
  const result = createMemo(() =>
    trialBalanceLines(props.data, props.hrefs, m(), { showZero: props.showZero }),
  );
  const period = () => m().views.asOfPeriod(props.data.asOf);
  const trial = () => props.data.trialBalance;
  const difference = () => amountDifference(trial().debit, [trial().credit]);
  const tie = () => (
    <TieOut
      title={m().views.debitsEqualCredits}
      total={{ label: m().columns.debit, amount: trial().debit }}
      parts={[{ label: m().columns.credit, amount: trial().credit }]}
      difference={difference()}
    />
  );
  return (
    <div class="rt-report">
      <Context
        scope={props.data}
        title={m().statements.trialBalance}
        period={period()}
        bookName={props.bookName}
        id={id}
      />
      <ReportWarnings warnings={props.data.warnings} />
      <Show when={difference() !== "0.00"}>{tie()}</Show>
      <StatementTable
        caption={`${m().statements.trialBalance} · ${period()}`}
        captionHidden
        lines={result().lines}
        columns={result().columns}
      />
      <Proof scope={props.data} />
    </div>
  );
}

export function CashFlowView(props: ViewProps & { data: CashFlowData }) {
  const ui = useUi();
  const m = () => ui.messages.reports;
  const id = createUniqueId();
  const period = () => describeRange({ from: props.data.periodStart, to: props.data.asOf });
  const tagAction = (): JSX.Element =>
    props.hrefs.tagAccounts ? (
      <a href={props.hrefs.tagAccounts}>{m().cashFlow.tagAccounts}</a>
    ) : undefined;
  const result = createMemo(() => cashFlowLines(props.data, props.hrefs, m()));
  const accounts = (): StatementLine[] =>
    props.data.cashAccounts.map((account) => ({
      key: account.accountId,
      kind: "account",
      label: account.name,
      code: account.code,
      figures: [
        { value: account.opening },
        {
          value: account.closing,
          href: props.hrefs.account(account.accountId, "range", "current"),
        },
        { value: account.change },
      ],
    }));
  const difference = () =>
    amountDifference(props.data.closingCash ?? "0.00", [
      props.data.openingCash ?? "0.00",
      props.data.netChange ?? "0.00",
    ]);
  const tie = () => (
    <TieOut
      title={m().views.cashTie}
      total={{ label: m().cashFlow.endOfPeriod, amount: props.data.closingCash ?? "0.00" }}
      parts={[
        { label: m().cashFlow.startOfPeriod, amount: props.data.openingCash ?? "0.00" },
        { label: m().cashFlow.netChange, amount: props.data.netChange ?? "0.00" },
      ]}
      difference={difference()}
      note={m().views.cashAccountsNote(
        props.data.cashAccounts.map((account) => account.name).join(", "),
      )}
    />
  );
  return (
    <div class="rt-report">
      <Context
        scope={props.data}
        title={m().statements.cashFlow}
        period={period()}
        bookName={props.bookName}
        id={id}
      />
      <Show
        when={props.data.available}
        fallback={
          <>
            <Notice title={m().cashFlow.unavailableTitle} tone="attention" role="status">
              <p>{props.data.reason}</p>
              {tagAction()}
            </Notice>
            <ReportWarnings warnings={props.data.warnings} />
            <Proof scope={props.data} />
          </>
        }
      >
        <ReportWarnings warnings={props.data.warnings} action={tagAction()} />
        <Show when={difference() !== "0.00"}>{tie()}</Show>
        <ComparedWith data={props.data} />
        <StatementTable
          caption={`${m().statements.cashFlow} · ${period()}`}
          captionHidden
          lines={result().lines}
          columns={result().columns}
        />
        <StatementTable
          caption={m().cashFlow.cashAccounts}
          lines={accounts()}
          columns={[m().cashFlow.opening, m().cashFlow.closing, m().cashFlow.change]}
        />
        <Proof scope={props.data} />
      </Show>
    </div>
  );
}

export function GeneralLedgerView(
  props: ViewProps & { data: GeneralLedgerData; onPage: (page: number) => void },
) {
  const ui = useUi();
  const m = () => ui.messages.reports;
  const id = createUniqueId();
  const period = () => describeRange({ from: props.data.periodStart, to: props.data.asOf });
  const names = createMemo(
    () =>
      new Map(
        props.data.accounts.map((account) => [
          account.accountId,
          `${account.code} · ${account.name}`,
        ]),
      ),
  );
  const first = () => (props.data.page - 1) * props.data.pageSize + 1;
  const last = () => Math.min(props.data.count, props.data.page * props.data.pageSize);
  return (
    <div class="rt-report">
      <Context
        scope={props.data}
        title={m().statements.generalLedger}
        period={period()}
        bookName={props.bookName}
        id={id}
      />
      <h3 class="rt-report-subtitle">{m().ledger.accounts}</h3>
      <LedgerAccounts
        caption={`${m().ledger.accounts} · ${period()}`}
        captionHidden
        currency={props.data.currency}
        accounts={props.data.accounts.map((account) => ({
          key: account.accountId,
          code: account.code,
          name: account.name,
          opening: account.openingBalance,
          debit: account.totalDebit,
          credit: account.totalCredit,
          closing: account.closingBalance,
          lines: account.lineCount,
          href: props.hrefs.account(account.accountId, "range", "current"),
          balanceKind: account.balanceKind,
        }))}
      />
      <h3 class="rt-report-subtitle">{m().ledger.lines}</h3>
      <Show when={props.data.count > 0}>
        <p class="rt-hint" role="status">
          {m().ledger.position(first(), last(), props.data.count)}
        </p>
      </Show>
      <LedgerLines
        caption={`${m().ledger.lines} · ${period()}`}
        captionHidden
        lines={props.data.lines.map((line) => ({
          key: line.postingId,
          accountKey: line.accountId,
          account: names().get(line.accountId) ?? line.accountId,
          date: line.date,
          sequence: line.postingSequence,
          entryHref: props.hrefs.entry?.(line.journalId),
          description: line.narration,
          debit: line.debit,
          credit: line.credit,
          balance: line.runningBalance,
        }))}
      />
      <Show when={props.data.count > props.data.pageSize}>
        <div class="rt-report-no-print">
          <Pager
            count={props.data.count}
            page={props.data.page}
            pageSize={props.data.pageSize}
            onPageChange={props.onPage}
          />
        </div>
      </Show>
      <Proof scope={props.data} />
    </div>
  );
}

/** What a by-month view needs: the reads for each month and the total, and where a figure leads (each
 * column's own population, so a click lands on exactly the transactions behind that column). */
interface MonthlyViewProps extends Omit<TableViewProps, "hrefs"> {
  reports: MonthlyReports<CoreReportsData>;
  /** Where the amounts of one read lead. */
  hrefsFor: (data: CoreReportsData) => ReportHrefs;
}

/** The fingerprint of each column, for the report's details: the proof that each month can be made
 * again. */
function columnProofs(
  reports: MonthlyReports<CoreReportsData>,
  label: (column: MonthlyReports<CoreReportsData>["months"][number]) => string,
  totalLabel: string | undefined,
): { label: string; hash: string }[] {
  return [
    ...reports.months.map((column) => ({ label: label(column), hash: column.data.populationHash })),
    ...(totalLabel ? [{ label: totalLabel, hash: reports.total.populationHash }] : []),
  ];
}

/** The profit and loss with a column for each month and one for the whole range. */
export function ProfitLossMonthlyView(props: MonthlyViewProps) {
  const ui = useUi();
  const m = () => ui.messages.reports;
  const id = createUniqueId();
  const result = createMemo(() =>
    profitLossMonthlyLines(props.reports, props.hrefsFor, m(), { showZero: props.showZero }),
  );
  const total = () => props.reports.total;
  const period = () => describeRange({ from: total().periodStart, to: total().asOf });
  const disagrees = () => monthsAddUp(props.reports) !== null;
  return (
    <div class="rt-report">
      <Context
        scope={total()}
        title={m().statements.profitLoss}
        period={period()}
        bookName={props.bookName}
        id={id}
      />
      <ReportWarnings warnings={total().warnings} />
      <Show when={disagrees()}>
        <Notice title={m().monthly.doNotAddTitle} tone="problem" role="alert">
          <p>{m().monthly.doNotAdd}</p>
        </Notice>
      </Show>
      <StatementTable
        caption={`${m().statements.profitLoss} · ${period()}`}
        captionHidden
        lines={result().lines}
        columns={result().columns}
        wide
      />
      <Proof
        scope={total()}
        columns={columnProofs(
          props.reports,
          (column) => result().columns[props.reports.months.indexOf(column)] ?? column.month,
          m().table.total,
        )}
      />
    </div>
  );
}

/** The balance sheet with a column for the end of each month. */
export function BalanceSheetMonthlyView(props: MonthlyViewProps) {
  const ui = useUi();
  const m = () => ui.messages.reports;
  const id = createUniqueId();
  const result = createMemo(() =>
    balanceSheetMonthlyLines(props.reports, props.hrefsFor, m(), { showZero: props.showZero }),
  );
  const total = () => props.reports.total;
  const period = () => describeRange({ from: total().periodStart, to: total().asOf });
  const unbalanced = () =>
    props.reports.months.some((column) => !column.data.balanceSheet.balanced);
  return (
    <div class="rt-report">
      <Context
        scope={total()}
        title={m().statements.balanceSheet}
        period={period()}
        bookName={props.bookName}
        id={id}
      />
      <ReportWarnings warnings={total().warnings} />
      <Show when={unbalanced()}>
        <Notice title={m().monthly.notBalancedTitle} tone="problem" role="alert">
          <p>{m().tie.notBalancedBody}</p>
        </Notice>
      </Show>
      <StatementTable
        caption={`${m().statements.balanceSheet} · ${period()}`}
        captionHidden
        lines={result().lines}
        columns={result().columns}
        wide
      />
      <Proof
        scope={total()}
        columns={columnProofs(
          props.reports,
          (column) => result().columns[props.reports.months.indexOf(column)] ?? column.month,
          undefined,
        )}
      />
    </div>
  );
}
