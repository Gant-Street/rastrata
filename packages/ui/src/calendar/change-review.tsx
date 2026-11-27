import { createEffect, For, on, Show, type JSX } from "solid-js";
import { Button } from "../button";
import { ErrorSummary } from "../error-summary";
import { formatDateRange, formatFiguresInText } from "../format";
import { Notice } from "../notice";
import { TextField } from "../text-field";
import type { ChangePlanView, ChangeStage, PeriodView } from "./types";
import { words } from "./words";

const REASON_ID = "rt-cal-change-reason";

/** Closing or reopening one period, in two steps: say why, then review exactly what the service
 * prepared and commit it. Reopening names every later close it supersedes before anything is
 * committed. The heading takes focus when the panel opens, and the commit is disabled until the plan
 * on screen is the plan for the reason typed. */
export function PeriodChangePanel(props: {
  operation: "close" | "reopen";
  period: PeriodView;
  reason: string;
  onReason: (value: string) => void;
  /** The reason is missing: shown in a summary that links to the field, and beside it. */
  reasonError?: string | undefined;
  /** Counts failed attempts, so the summary takes focus again each time. */
  attempt?: number;
  stage: ChangeStage;
  plan: ChangePlanView | null;
  /** The plan on screen was prepared for the reason as typed now. */
  current: boolean;
  busy?: boolean;
  /** A write is retained: it must be resumed before anything else. */
  blocked?: boolean;
  onPrepare: () => void;
  onCommit: () => void;
  onCancel: () => void;
  /** What the commit button says when the screen can name it better than "Commit change" ("Close March 2026"). */
  submitLabel?: string | undefined;
}): JSX.Element {
  let heading: HTMLHeadingElement | undefined;
  createEffect(
    on(
      () => props.stage,
      () => queueMicrotask(() => heading?.focus()),
    ),
  );
  const title = () =>
    props.operation === "close"
      ? words.changeClose(props.period.label)
      : words.changeReopen(props.period.label);
  /** The later closes a reopening supersedes: what the prepared plan says once there is one (it is
   * what will be committed), what the periods list says until then. */
  const consequences = () =>
    props.stage === "review" && props.plan ? props.plan.supersedes : props.period.supersedes;
  return (
    <section
      class="rt-cal-review"
      aria-label={props.stage === "review" ? words.changeReview : title()}
    >
      <h2 tabindex="-1" ref={heading}>
        {props.stage === "review" ? words.reviewTitle : title()}
      </h2>
      <p>
        <bdi>
          {props.period.label} · {formatDateRange(props.period.startsOn, props.period.endsOn)}
        </bdi>
      </p>
      <p class="rt-cal-note">
        {props.operation === "close" ? words.closeEffect : words.reopenEffect}
      </p>
      <Show when={props.operation === "reopen" && consequences().length > 0}>
        <Notice title={words.supersedesTitle(consequences().length)} tone="review">
          <p>
            <bdi>{consequences().join(", ")}.</bdi>
          </p>
          <p>{words.supersedesBody(consequences().length)}</p>
        </Notice>
      </Show>
      {/* Enter in the field reviews the change, like the button does. The browser's own
          validation bubble is off: a missing reason is said by the summary and by the field. */}
      <form
        class="rt-cal-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (props.stage === "preparing" || (props.stage === "review" && props.current)) return;
          props.onPrepare();
        }}
      >
        <Show when={props.reasonError}>
          {(message) => (
            <ErrorSummary
              errors={[{ id: REASON_ID, message: message() }]}
              attempt={props.attempt ?? 0}
            />
          )}
        </Show>
        <TextField
          id={REASON_ID}
          label={words.reasonForChange}
          hint={words.reasonHint}
          required
          maxLength={500}
          value={props.reason}
          disabled={props.stage === "preparing"}
          onInput={(event) => props.onReason(event.currentTarget.value)}
          {...(props.reasonError ? { error: props.reasonError } : {})}
        />
      </form>
      <Show when={props.stage === "review" && props.plan}>
        {(plan) => (
          <div class="rt-stack">
            <Show when={plan().warnings.length > 0}>
              <Notice title={words.warningsTitle} tone="review">
                <ul>
                  <For each={plan().warnings}>
                    {(warning) => <li>{formatFiguresInText(warning)}</li>}
                  </For>
                </ul>
              </Notice>
            </Show>
            <Show when={!plan().valid}>
              <Notice title={words.invalidTitle} tone="error" role="alert">
                <ul>
                  <For each={plan().problems}>{(problem) => <li>{problem}</li>}</For>
                </ul>
              </Notice>
            </Show>
            <Show when={plan().reportHref}>
              {(href) => (
                <p>
                  <a href={href()}>{words.closingReport}</a>
                </p>
              )}
            </Show>
            <Show when={!props.current}>
              <p role="status">{words.inputsChanged}</p>
            </Show>
          </div>
        )}
      </Show>
      <div class="rt-cal-actions">
        <Show
          when={props.stage === "review"}
          fallback={
            <Button
              label={words.reviewTitle}
              variant="primary"
              disabled={props.blocked ?? false}
              pending={props.stage === "preparing"}
              pendingLabel={words.preparingReview}
              onClick={props.onPrepare}
            />
          }
        >
          <Button
            label={props.submitLabel ?? words.commitChange}
            variant="primary"
            disabled={
              !props.plan?.valid ||
              !props.current ||
              (props.blocked ?? false) ||
              (props.busy ?? false)
            }
            pending={props.busy ?? false}
            onClick={props.onCommit}
          />
          <Show when={!props.current}>
            <Button
              label={words.reviewTitle}
              variant="secondary"
              disabled={props.blocked ?? false}
              onClick={props.onPrepare}
            />
          </Show>
        </Show>
        <Button label={words.cancel} variant="quiet" onClick={props.onCancel} />
      </div>
    </section>
  );
}
