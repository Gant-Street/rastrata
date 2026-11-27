import { createUniqueId, For, Show } from "solid-js";
import { useUi } from "../locale";
import { Pager } from "../pager";
import { Amount } from "./amount";
import type { AccountActivityData } from "./data";
import { describeRange } from "./period";
import { ReportContext } from "./report-context";
import { ReportDetails } from "./report-details";
import { ReportHero } from "./report-hero";
import { DateValue } from "../date-value";

/** One account's postings for a range, with the balance before it, a running balance and the balance
 * after: the place every amount on a statement leads to. The balance is carried from the start of
 * the book for an asset, liability or equity account, and starts each fiscal year at zero for an
 * income or expense account, because the earnings of earlier years are rolled into retained
 * earnings; the page says which. Each line leads on to its journal entry. What it was built from (the
 * book revision and the fingerprint) is under "Report details" at the foot, as it is on a statement. */
export function AccountActivityView(props: {
  data: AccountActivityData;
  /** Where a posting's journal entry is. */
  entryHref: (journalId: string) => string;
  onPage: (page: number) => void;
  /** Back to the statement this was opened from. */
  backHref?: string | undefined;
  bookName?: string | undefined;
}) {
  const ui = useUi();
  const m = () => ui.messages.reports;
  const id = createUniqueId();
  const period = () => describeRange({ from: props.data.from, to: props.data.to });
  const first = () => (props.data.page - 1) * props.data.pageSize + 1;
  const last = () => Math.min(props.data.count, props.data.page * props.data.pageSize);
  return (
    <div class="rt-report">
      <ReportContext
        title={`${props.data.account.code} · ${props.data.account.name}`}
        period={period()}
        basis={props.data.basis}
        bookName={props.bookName}
        headingId={id}
      />
      <ReportHero label={m().activity.closing} amount={props.data.closingBalance} />
      <p class="rt-hint">
        {props.data.balanceKind === "cumulative"
          ? m().ledger.cumulative
          : m().ledger.fiscalYearToDate}
      </p>
      <Show when={props.backHref}>
        <p class="rt-report-no-print">
          <a href={props.backHref}>{m().activity.back}</a>
        </p>
      </Show>
      <section
        class="rt-table-scroll"
        tabindex={0}
        aria-label={m().table.scroll(m().activity.tableCaption)}
      >
        <table class="rt-table rt-ledger rt-ledger-lines">
          <caption data-hidden="">{m().activity.tableCaption}</caption>
          <thead>
            <tr>
              <th scope="col">{m().ledger.date}</th>
              <th scope="col">{m().ledger.description}</th>
              <th scope="col" class="rt-number">
                {m().ledger.debit}
              </th>
              <th scope="col" class="rt-number">
                {m().ledger.credit}
              </th>
              <th scope="col" class="rt-number">
                {m().ledger.balance}
              </th>
            </tr>
          </thead>
          <tbody>
            <Show when={props.data.page === 1}>
              <tr class="rt-statement-calculated">
                <td>
                  <DateValue value={props.data.from} />
                </td>
                <th scope="row">{m().activity.opening}</th>
                <td class="rt-number" />
                <td class="rt-number" />
                <td class="rt-number">
                  <Amount value={props.data.openingBalance} />
                </td>
              </tr>
            </Show>
            <For each={props.data.rows}>
              {(line) => (
                <tr>
                  <td>
                    <DateValue value={line.date} />
                  </td>
                  <th scope="row">
                    <a href={props.entryHref(line.journalId)}>{line.narration}</a>
                  </th>
                  <td class="rt-number">
                    <Amount value={line.debit} />
                  </td>
                  <td class="rt-number">
                    <Amount value={line.credit} />
                  </td>
                  <td class="rt-number">
                    <Amount value={line.runningBalance} />
                  </td>
                </tr>
              )}
            </For>
            <Show when={props.data.rows.length === 0}>
              <tr>
                <td colspan={5}>{m().ledger.none}</td>
              </tr>
            </Show>
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colspan={2}>
                {m().activity.totals} · {m().activity.postings(props.data.count)}
              </th>
              <td class="rt-number">
                <Amount value={props.data.totalDebit} />
              </td>
              <td class="rt-number">
                <Amount value={props.data.totalCredit} />
              </td>
              <td class="rt-number">
                <Amount value={props.data.closingBalance} />
              </td>
            </tr>
          </tfoot>
        </table>
      </section>
      <Show when={props.data.count > 0}>
        <p class="rt-hint" role="status">
          {m().ledger.position(first(), last(), props.data.count)}
        </p>
      </Show>
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
      <ReportDetails
        revision={props.data.revision}
        populationHash={props.data.populationHash}
        basis={props.data.basis}
        currency={props.data.currency}
      />
    </div>
  );
}
