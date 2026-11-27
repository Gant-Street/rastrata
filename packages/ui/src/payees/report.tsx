import { createMemo, createUniqueId, For, type JSX, Show } from "solid-js";
import { formatCount, formatFiguresInText, moneyDifference } from "../format";
import { EmptyState } from "../kit";
import { Money } from "../money";
import { Notice } from "../notice";
import { Pager } from "../pager";
import { describeRange } from "../reports/period";
import { ReportContext } from "../reports/report-context";
import { ReportDetails } from "../reports/report-details";
import { ReportBusy } from "../reports/report-state";
import { TieOut } from "../reports/tie-out";
import { AmbiguousTable, NoPayeeTable, Part, PayeeTable, UnnamedTable } from "./tables";
import type { PayeeReportData, PayeeSubject, PayeeUnnamedView, PayeeWarningView } from "./types";
import { words } from "./words";

/** The warnings the service attached. The one about the bank's text is said in the words of the screen;
 * any other is shown as the service wrote it. */
function Warnings(props: { warnings: readonly PayeeWarningView[] }): JSX.Element {
  return (
    <Show when={props.warnings.length > 0}>
      <div class="rt-report-warnings">
        <For each={props.warnings}>
          {(warning) => (
            <Show
              when={warning.code === "inbox_unreadable"}
              fallback={
                <Notice title={words.warningFallback} tone="info" role="status">
                  <p>{formatFiguresInText(warning.message)}</p>
                </Notice>
              }
            >
              <Notice title={words.warningInboxTitle} tone="attention" role="status">
                <p>{words.warningInboxBody}</p>
              </Notice>
            </Show>
          )}
        </For>
      </div>
    </Show>
  );
}

/** The proof, worked out from the figures the service gave: what the profit and loss says is income and
 * expenses, the money received and spent in each of the four places of this page, and what is left over
 * when the places are taken from the total. The service says the report ties; the page does not take its
 * word for it, so a disagreement between the two cannot be hidden. */
function proofOf(data: PayeeReportData) {
  const places = data.tieOut.places;
  const parts = (side: "received" | "spent") => [
    { label: words.tiePayees, amount: places.payees[side] },
    { label: words.tieUnnamed, amount: places.unnamed[side] },
    { label: words.tieAmbiguous, amount: places.ambiguous[side] },
    { label: words.tieNoPayee, amount: places.noPayee[side] },
  ];
  const received = parts("received");
  const spent = parts("spent");
  const incomeDifference = moneyDifference(
    data.tieOut.profitLossIncome,
    received.map((part) => part.amount),
  );
  const expensesDifference = moneyDifference(
    data.tieOut.profitLossExpenses,
    spent.map((part) => part.amount),
  );
  return {
    received,
    spent,
    incomeDifference,
    expensesDifference,
    holds: data.tieOut.matches && incomeDifference === "0.00" && expensesDifference === "0.00",
  };
}

/** The four numbers every other part of the page is read against, and the one line that says they are
 * the profit and loss's. */
function Summary(props: { data: PayeeReportData; holds: boolean }): JSX.Element {
  const net = () => moneyDifference(props.data.totals.received, [props.data.totals.spent]);
  return (
    <div class="rt-payees-figures">
      <dl class="rt-payees-summary">
        <div>
          <dt>{words.summaryReceived}</dt>
          <dd>
            <Money value={props.data.totals.received} />
          </dd>
        </div>
        <div>
          <dt>{words.summarySpent}</dt>
          <dd>
            <Money value={props.data.totals.spent} />
          </dd>
        </div>
        <div>
          <dt>{words.summaryNet}</dt>
          <dd>
            <Money value={net()} />
          </dd>
        </div>
        <div>
          <dt>{words.summaryTransactions}</dt>
          <dd>{formatCount(props.data.totals.transactions)}</dd>
        </div>
      </dl>
    </div>
  );
}

/** The proof of the report, as the statements show theirs: the profit and loss's total income is the money
 * received in the four places of this page, and its total expenses is the money spent in them. It sits
 * at the foot while it holds, where it proves the figures above it, and at the head the moment it does not,
 * where nobody can miss it. */
function Proof(props: {
  data: PayeeReportData;
  proof: ReturnType<typeof proofOf>;
  where: "head" | "foot";
}): JSX.Element {
  const result = {
    holds: words.tieHolds,
    broken: words.tieBroken,
    brokenBody: words.tieBrokenBody,
  };
  return (
    <Show when={!props.proof.holds === (props.where === "head")}>
      <div class="rt-payees-proof" data-facts>
        <TieOut
          title={words.tieIncomeTitle}
          total={{ label: words.tieIncome, amount: props.data.tieOut.profitLossIncome }}
          parts={props.proof.received}
          difference={props.proof.incomeDifference}
          result={result}
        />
        <TieOut
          title={words.tieExpensesTitle}
          total={{ label: words.tieExpenses, amount: props.data.tieOut.profitLossExpenses }}
          parts={props.proof.spent}
          difference={props.proof.expensesDifference}
          result={result}
        />
      </div>
    </Show>
  );
}

/** The report "Money by payee": the income and expenses of some dates, each in one place, with one row
 * for every payee and a way to name one out of the texts nobody has named. It carries its own proof: the
 * places add up to the profit and loss to the cent. */
export function PayeesReportView(props: {
  data: PayeeReportData;
  bookName?: string | undefined;
  /** Open the transactions of a row. */
  onOpen: (subject: PayeeSubject) => void;
  /** Start naming a payee out of a text nobody has named. */
  onName: (row: PayeeUnnamedView) => void;
  /** Start changing the name or words of a payee, by its id. */
  onChange: (payeeId: string) => void;
  onPage: (page: number) => void;
  /** The report is being read again; what is shown stays until the new figures arrive. */
  busy?: boolean | undefined;
}): JSX.Element {
  const headingId = createUniqueId();
  const period = () => describeRange({ from: props.data.from, to: props.data.to });
  const empty = () => props.data.totals.transactions === 0;
  const proof = createMemo(() => proofOf(props.data));
  const noPayee = () =>
    props.data.noPayee.byHand.transactions + props.data.noPayee.noBankText.transactions;
  const paged = () => props.data.rowCount > props.data.pageSize;
  return (
    <ReportBusy busy={props.busy ?? false}>
      <div class="rt-report rt-payees">
        <ReportContext
          title={words.reportTitle}
          period={period()}
          basis={props.data.basis}
          bookName={props.bookName}
          headingId={headingId}
        />
        <Warnings warnings={props.data.warnings} />
        <Show
          when={!empty()}
          fallback={
            <EmptyState title={words.emptyTitle} live>
              {words.emptyBody}
            </EmptyState>
          }
        >
          <Summary data={props.data} holds={proof().holds} />
          <Proof data={props.data} proof={proof()} where="head" />

          <Part title={words.payeesTitle} marker="payees">
            <Show
              when={props.data.rows.length > 0}
              fallback={
                <p class="rt-hint">
                  {props.data.unnamedCount > 0 ? words.payeesNoneName : words.payeesNone}
                </p>
              }
            >
              <PayeeTable rows={props.data.rows} onOpen={props.onOpen} />
            </Show>
            <Show when={paged()}>
              <div class="rt-payees-pager rt-report-no-print">
                <Pager
                  count={props.data.rowCount}
                  page={props.data.page}
                  pageSize={props.data.pageSize}
                  onPageChange={props.onPage}
                />
                <span class="rt-hint">
                  {words.payeesShown(props.data.rows.length, props.data.rowCount)}
                </span>
              </div>
            </Show>
          </Part>

          {/* A part is on the page when something is in it: a book whose every transaction has a payee
              has no "Not named yet". */}
          <Show when={props.data.unnamed.length > 0 || props.data.unnamedRest.groups > 0}>
            <Part title={words.unnamedTitle} intro={words.unnamedIntro} marker="unnamed">
              <Show when={props.data.unnamed.length > 0}>
                <UnnamedTable
                  rows={props.data.unnamed}
                  onName={props.onName}
                  onOpen={props.onOpen}
                />
              </Show>
              <Show when={props.data.unnamedRest.groups > 0}>
                <p class="rt-hint" role="status" data-facts>
                  {words.unnamedRest(
                    props.data.unnamedRest.groups,
                    props.data.unnamedRest.received,
                    props.data.unnamedRest.spent,
                    props.data.unnamedRest.transactions,
                  )}
                </p>
              </Show>
            </Part>
          </Show>

          <Show when={props.data.ambiguous.length > 0}>
            <Part title={words.ambiguousTitle} intro={words.ambiguousIntro} marker="ambiguous">
              <AmbiguousTable
                rows={props.data.ambiguous}
                onChange={props.onChange}
                onOpen={props.onOpen}
              />
              <Show when={props.data.ambiguousRest.groups > 0}>
                <p class="rt-hint" role="status">
                  {words.ambiguousRest(
                    props.data.ambiguousRest.groups,
                    props.data.ambiguousRest.transactions,
                  )}
                </p>
              </Show>
            </Part>
          </Show>

          <Show when={noPayee() > 0}>
            <Part title={words.noPayeeTitle} intro={words.noPayeeIntro} marker="no-payee">
              <NoPayeeTable
                byHand={props.data.noPayee.byHand}
                noBankText={props.data.noPayee.noBankText}
                onOpen={props.onOpen}
              />
            </Part>
          </Show>

          <Proof data={props.data} proof={proof()} where="foot" />
        </Show>
        <ReportDetails
          revision={props.data.bookRevision}
          populationHash={props.data.populationHash}
          basis={props.data.basis}
          currency={props.data.currency}
          extra={[{ label: words.detailsPayees, value: props.data.payeesRevision }]}
        />
      </div>
    </ReportBusy>
  );
}
