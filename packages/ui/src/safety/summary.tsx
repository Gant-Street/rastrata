import { createUniqueId, For, Show } from "solid-js";
import { PageSkeleton } from "../skeleton";
import { Button } from "../button";
import { TriangleAlert } from "../icons";
import { Notice, Status } from "../notice";
import { words } from "./words";
import type { SafetyStatusView, SafetyTone, WarningView } from "./types";

export type SummaryState = "loading" | "error" | "unavailable" | "no-book" | "ready";

/** The worst tone among the warnings: this decides the headline. */
export function overallTone(warnings: readonly WarningView[]): SafetyTone {
  if (warnings.some((warning) => warning.tone === "error")) return "error";
  if (warnings.some((warning) => warning.tone === "review")) return "review";
  return "info";
}

const toneLabel: Record<SafetyTone, string> = {
  error: "Problem",
  review: "Needs attention",
  info: "Good to know",
};

/** One sentence about how safe the books are, then every warning, most serious first, each saying
 * what to do. Never a stale answer: while loading it says it is checking, and a failed read says so
 * and offers to try again. */
export function BackupSummary(props: {
  state: SummaryState;
  status?: SafetyStatusView | undefined;
  onRetry?: () => void;
}) {
  const titleId = createUniqueId();
  return (
    <Show
      when={props.state === "ready" && props.status}
      fallback={
        <Show
          when={props.state === "loading"}
          fallback={
            <Show
              when={props.state === "error"}
              fallback={
                <Notice
                  title={props.state === "no-book" ? words.needsBook : words.unavailable}
                  role="status"
                >
                  {props.state === "no-book" ? words.needsBookBody : words.unavailableBody}
                </Notice>
              }
            >
              <Notice title={words.statusFailed} tone="error" role="alert">
                <p>{words.statusFailedBody}</p>
                <Button label={words.retry} variant="secondary" onClick={() => props.onRetry?.()} />
              </Notice>
            </Show>
          }
        >
          <PageSkeleton shape="statement" label={words.statusLoading} />
        </Show>
      }
    >
      {(status) => {
        // A problem and a note are different kinds of news and are not one banner: the headline and its bar
        // are the worst of what needs a person (a problem or something to look at), and what is only good
        // to know is its own quiet section under it. (F28: one red banner used to hold both.)
        const serious = () => status().warnings.filter((warning) => warning.tone !== "info");
        const notes = () => status().warnings.filter((warning) => warning.tone === "info");
        const tone = () => overallTone(serious());
        const notesId = createUniqueId();
        return (
          <>
            <section class="rt-safe-summary" data-tone={tone()} aria-labelledby={titleId}>
              <h2 id={titleId}>
                <Show when={tone() === "error"}>
                  <TriangleAlert class="rt-safe-summary-icon" aria-hidden="true" />
                </Show>
                {tone() === "error"
                  ? words.headlineError
                  : tone() === "review"
                    ? words.headlineReview
                    : words.headlineOk}
              </h2>
              <Show
                when={serious().length > 0}
                fallback={<p class="rt-hint">{words.noWarnings}</p>}
              >
                <ul class="rt-safe-warnings">
                  <For each={serious()}>
                    {(warning) => (
                      <li data-tone={warning.tone}>
                        <Status tone={warning.tone}>{toneLabel[warning.tone]}</Status>
                        <span>{warning.message}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>
            <Show when={notes().length > 0}>
              <section class="rt-safe-notes" aria-labelledby={notesId}>
                <h2 id={notesId}>{words.goodToKnow}</h2>
                <ul class="rt-safe-notelist">
                  <For each={notes()}>{(warning) => <li>{warning.message}</li>}</For>
                </ul>
              </section>
            </Show>
          </>
        );
      }}
    </Show>
  );
}
