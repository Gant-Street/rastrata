import { Show } from "solid-js";
import { HelpTip } from "../help-tip";
import { useUi } from "../locale";

/** What a report is, in one line above its table: which statement, for which book, which dates and
 * on which basis ("Profit and loss  Willow Lane Studio · Jan 1 to Oct 4, 2026 · Cash basis"). It prints
 * with the statement, so a page torn from a binder still says what it is. The statement's name is the
 * heading of the region; the facts are a plain line, and the basis has its explanation one click
 * away. The machine detail (the book revision, the fingerprint) is not here: it is under "Report
 * details" at the foot. */
export function ReportContext(props: {
  title: string;
  /** The dates in words: "Jan 1 to Oct 4, 2026", or "As of Oct 4, 2026". */
  period: string;
  basis: "cash" | "accrual";
  bookName?: string | undefined;
  /** Names the heading so the statement's region can point at it. */
  headingId: string;
}) {
  const ui = useUi();
  const t = () => ui.messages.reports.header;
  return (
    <header class="rt-report-context" data-facts>
      <h2 id={props.headingId}>{props.title}</h2>
      <p class="rt-report-line">
        <Show when={props.bookName}>
          <span class="rt-report-book">{props.bookName}</span>
          <span class="rt-report-dot" aria-hidden="true">
            ·
          </span>
        </Show>
        <span class="rt-report-period">{props.period}</span>
        <span class="rt-report-dot" aria-hidden="true">
          ·
        </span>
        <span class="rt-report-basis">
          {props.basis === "cash" ? t().basisCash : t().basisAccrual}
          <HelpTip topic={t().basisHelpTopic}>
            {props.basis === "cash" ? t().basisCashHelp : t().basisAccrualHelp}
          </HelpTip>
        </span>
      </p>
    </header>
  );
}
