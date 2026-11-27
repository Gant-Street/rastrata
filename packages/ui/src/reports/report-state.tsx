import { For, type JSX, Show } from "solid-js";
import { PageSkeleton } from "../skeleton";
import { Button, buttonAttrs } from "../button";
import { EmptyState } from "../kit";
import { useUi } from "../locale";
import { Notice } from "../notice";
import { formatFiguresInText } from "../format";

/** A report that is not on screen yet, or cannot be: compiling, failed, outside the calendar, older
 * than the book, or of uncertain age. Each says what is true and what to do, and none shows a figure
 * it does not have, so a stale number is never mistaken for the current one. A book that does not
 * exist yet is not a failure: it is the empty state, with the one place to go. */
export function ReportState(props: {
  state: "loading" | "failed" | "calendar" | "stale" | "uncertain" | "noBook";
  /** What is being compiled, for the loading line: "profit and loss". */
  what?: string | undefined;
  /** The service's own words, when it said why. */
  detail?: string | undefined;
  onRetry?: (() => void) | undefined;
}) {
  const ui = useUi();
  const t = () => ui.messages.reports.states;
  return (
    <Show
      when={props.state !== "loading"}
      fallback={<PageSkeleton shape="statement" label={t().loading(props.what ?? "")} />}
    >
      <Show
        when={props.state !== "noBook"}
        fallback={
          <EmptyState
            title={t().noBookTitle}
            live
            action={
              <a {...buttonAttrs({ variant: "secondary" })} href="/">
                {t().noBookAction}
              </a>
            }
          >
            {props.detail ?? t().noBookBody}
          </EmptyState>
        }
      >
        <Notice
          title={
            props.state === "failed"
              ? t().failedTitle
              : props.state === "calendar"
                ? t().calendarTitle
                : props.state === "stale"
                  ? t().staleTitle
                  : t().uncertainTitle
          }
          tone={props.state === "calendar" ? "attention" : "problem"}
          role={props.state === "failed" || props.state === "uncertain" ? "alert" : "status"}
        >
          <p>
            {props.detail ??
              (props.state === "failed"
                ? t().failedBody
                : props.state === "stale"
                  ? t().staleBody
                  : "")}
          </p>
          <Show when={props.onRetry}>
            <Button
              variant="secondary"
              label={props.state === "stale" ? t().reread : t().retry}
              onClick={props.onRetry as () => void}
            />
          </Show>
        </Notice>
      </Show>
    </Show>
  );
}

/** Figures that are being read again. They stay exactly where they are, so the controls around them,
 * the scroll position and the focus a person had do not move, and they are marked busy until the new
 * figures arrive. A quick read shows nothing at all; a slow one runs the accent colour along the
 * statement's heavy top rule, so a figure on its way out is not mistaken for the new one. */
export function ReportBusy(props: { busy: boolean; children: JSX.Element }) {
  return (
    <div class="rt-report-busy" aria-busy={props.busy}>
      {props.children}
    </div>
  );
}

/** The warnings that ask a person to act, because acting would change the figures on the page: an
 * account with no cash-flow tag has its change shown under "Not classified", and tagging it moves the
 * figure. Every other warning states a fact (there is nothing to compare with) and is a plain note. */
const ATTENTION = new Set(["unclassified_accounts"]);

/** Warnings the service attached to a report (an account that needs a tag, a comparison that is not
 * possible), each as a plain sentence under the heading it belongs to. Orange is for the ones that
 * would change the figures if acted on; the rest are notes. */
export function ReportWarnings(props: {
  warnings: readonly { code: string; message: string }[];
  /** A place to fix the problem, when there is one ("Tag accounts"). */
  action?: JSX.Element;
}) {
  const ui = useUi();
  const titles = () => ui.messages.reports.warningTitles;
  return (
    <Show when={props.warnings.length > 0}>
      <div class="rt-report-warnings">
        <For each={props.warnings}>
          {(warning) => (
            <Notice
              title={titles()[warning.code] ?? titles().fallback ?? ""}
              tone={ATTENTION.has(warning.code) ? "attention" : "info"}
              role="status"
            >
              <p>{formatFiguresInText(warning.message)}</p>
              <Show when={props.action && warning.code === "unclassified_accounts"}>
                {props.action}
              </Show>
            </Notice>
          )}
        </For>
      </div>
    </Show>
  );
}
