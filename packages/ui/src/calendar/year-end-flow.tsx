import { createEffect, For, on, Show, type JSX } from "solid-js";
import { Button } from "../button";
import { StepIndicator } from "../chart/step-indicator";
import { ErrorSummary } from "../error-summary";
import { Notice } from "../notice";
import { TextField } from "../text-field";
import { YearEndChecklist, YearStatements } from "./year-end-checklist";
import type {
  ChecklistItem,
  StatementsView,
  YearEndPlanView,
  YearEndReceiptView,
  YearEndStage,
  YearEndStepView,
} from "./types";
import { words } from "./words";
import { formatDateRange } from "../format";
import { Details } from "../kit/details";

const REASON_ID = "rt-cal-year-end-reason";

const commandWord = (step: YearEndStepView): string =>
  step.commands.length === 0
    ? words.stepKeep
    : step.commands.length > 1
      ? words.stepReopenClose
      : words.stepClose;

/** What the books or another part of Rastrata wants said about a step, each said once. */
const stepNotes = (step: YearEndStepView): string[] => [
  ...new Set(step.commands.flatMap((command) => command.warnings)),
];

const notedSteps = (plan: YearEndPlanView): number =>
  plan.steps.filter((step) => stepNotes(step).length > 0).length;

/** The prepared year-end, in order: for each period what will happen to it, and a count of the notes
 * that go with it. The notes are advisories (a reconciliation not done, a period not over): a year
 * of twelve periods can have twelve long ones, so each row folds its own away, and the line above the
 * table says that they exist. */
export function YearEndPlanTable(props: { plan: YearEndPlanView }) {
  return (
    <section
      class="rt-table-scroll rt-cal-scroll"
      tabindex="0"
      aria-label={`${words.planTitle}, scroll horizontally on narrow screens`}
    >
      <table class="rt-table rt-cal-table rt-cal-plan">
        <caption class="rt-sr-only">{words.planTitle}</caption>
        <thead>
          <tr>
            <th scope="col">{words.stepColumn}</th>
            <th scope="col">{words.commandColumn}</th>
            <th scope="col">{words.warningsColumn}</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.plan.steps}>
            {(step) => (
              <tr data-keep={step.commands.length === 0 || undefined}>
                <th scope="row">
                  <bdi>{step.label}</bdi>
                  <small>
                    <bdi>{formatDateRange(step.startsOn, step.endsOn)}</bdi>
                  </small>
                </th>
                <td>{commandWord(step)}</td>
                <td>
                  <Show
                    when={stepNotes(step).length > 0}
                    fallback={<span class="rt-cal-note">{words.noNotes}</span>}
                  >
                    <Details
                      plain
                      flush
                      summary={
                        <>
                          <span class="rt-sr-only">{step.label}: </span>
                          {words.noteCount(stepNotes(step).length)}
                        </>
                      }
                    >
                      <ul class="rt-cal-notes">
                        <For each={stepNotes(step)}>{(note) => <li>{note}</li>}</For>
                      </ul>
                    </Details>
                  </Show>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </section>
  );
}

/** Closing a fiscal year, as three steps on one page: check the books, say why, review the
 * prepared year-end and close. Nothing here changes the books until the last button, and that one
 * names the year. A write that was sent and not answered is shown first, with the only thing that can
 * safely be done about it: resume it. Once the year-end has run, the page says what happened and
 * nothing else, so it never shows a checklist or a plan as if they were still to come. */
export function YearEndFlow(props: {
  fiscalYear: number;
  startsOn: string;
  endsOn: string;
  stage: YearEndStage;
  checklist: readonly ChecklistItem[];
  statements: StatementsView | null;
  reason: string;
  onReason: (value: string) => void;
  reasonError?: string | undefined;
  /** Counts failed attempts, so the summary takes focus again each time. */
  attempt?: number;
  /** A request failed in a way the person can act on. */
  error?: string | undefined;
  plan: YearEndPlanView | null;
  /** The plan on screen was prepared for the reason as typed now. */
  planCurrent: boolean;
  receipt: YearEndReceiptView | null;
  /** A write was sent and not answered. */
  uncertain: boolean;
  /** A request is in flight. */
  busy?: boolean;
  /** The periods the year-end would close, before a plan exists; null until the year is read. */
  periodsToClose: number | null;
  onPrepare: () => void;
  onCommit: () => void;
  onResume: () => void;
  onBack: () => void;
  onReviewAgain: () => void;
}): JSX.Element {
  let heading: HTMLHeadingElement | undefined;
  let planHeading: HTMLHeadingElement | undefined;
  createEffect(() => queueMicrotask(() => heading?.focus()));
  createEffect(
    on(
      () => props.plan,
      (plan) => {
        if (plan) queueMicrotask(() => planHeading?.focus());
      },
      { defer: true },
    ),
  );
  const step = () => (props.plan ? 2 : props.stage === "checking" ? 0 : 1);
  const closes = () => props.plan?.closes ?? props.periodsToClose;
  const finished = () => props.stage === "done" && props.receipt !== null;
  /** The year has been read and every period already has a current close. */
  const nothing = () => props.plan === null && props.periodsToClose === 0;
  return (
    <section class="rt-cal-flow" aria-labelledby="rt-cal-flow-title">
      <div>
        <Button label={words.back} variant="quiet" onClick={props.onBack} />
      </div>
      <h2 id="rt-cal-flow-title" tabindex="-1" ref={heading}>
        {words.yearEndTitle(props.fiscalYear)}
      </h2>
      <p class="rt-cal-lead">
        <bdi>{formatDateRange(props.startsOn, props.endsOn)}</bdi>
        <Show when={!nothing()}>
          {" · "}
          {words.yearEndLead(closes())}
        </Show>
      </p>
      <Show when={!nothing()}>
        <StepIndicator
          label={words.stepsLabel}
          steps={words.steps}
          current={finished() ? 3 : step()}
          doneLabel={words.stepDone}
        />
      </Show>

      <Show when={props.error}>
        {(message) => (
          <Notice title={words.requestFailedTitle} tone="error" role="alert">
            <p>{message()}</p>
          </Notice>
        )}
      </Show>

      <Show when={props.uncertain}>
        <Notice title={words.uncertainTitle} tone="review" role="status">
          <p>{words.uncertainBody}</p>
          <p>{words.retained}</p>
          <Button
            label={words.resume}
            variant="secondary"
            disabled={props.busy ?? false}
            onClick={props.onResume}
          />
        </Notice>
      </Show>

      <Show when={!finished()}>
        <section class="rt-cal-step" aria-labelledby="rt-cal-checklist-title">
          <h3 id="rt-cal-checklist-title">{words.checklist}</h3>
          <p class="rt-cal-note">{words.checklistLead}</p>
          <YearEndChecklist items={props.checklist} />
          <Show when={props.statements}>
            {(statements) => <YearStatements statements={statements()} />}
          </Show>
        </section>

        <Show when={nothing()}>
          <Notice title={words.nothingToCloseTitle} role="status">
            <p>{words.yearEndNothing}</p>
          </Notice>
        </Show>

        <form
          class="rt-cal-step"
          hidden={nothing()}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            props.onPrepare();
          }}
        >
          <h3>{words.steps[1]}</h3>
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
            label={words.yearEndReason}
            hint={words.yearEndReasonHint}
            required
            maxLength={400}
            value={props.reason}
            disabled={props.stage === "preparing" || props.stage === "committing"}
            onInput={(event) => props.onReason(event.currentTarget.value)}
            {...(props.reasonError ? { error: props.reasonError } : {})}
          />
          <div class="rt-cal-actions">
            <Button
              type="submit"
              label={words.reviewYearEnd}
              variant={props.plan && props.planCurrent ? "secondary" : "primary"}
              pending={props.stage === "preparing"}
              pendingLabel={words.preparing}
              disabled={props.uncertain || props.stage === "committing"}
            />
          </div>
        </form>

        <Show when={props.plan}>
          {(plan) => (
            <section class="rt-cal-step rt-cal-review" aria-label={words.planTitle}>
              <h3 tabindex="-1" ref={planHeading}>
                {words.planTitle}
              </h3>
              <p>{words.planLead(plan().closes)}</p>
              <Show when={plan().superseded > 0}>
                <p class="rt-cal-note">{words.planReopen(plan().superseded)}</p>
              </Show>
              <Show when={!plan().valid}>
                <Notice title={words.planInvalid} tone="error" role="alert">
                  <ul>
                    <For each={plan().problems}>{(problem) => <li>{problem}</li>}</For>
                  </ul>
                </Notice>
              </Show>
              <Show when={notedSteps(plan()) > 0}>
                <p class="rt-cal-note">{words.planNotes(notedSteps(plan()))}</p>
              </Show>
              <YearEndPlanTable plan={plan()} />
              <Show when={!props.planCurrent}>
                <p role="status">{words.inputsChanged}</p>
              </Show>
              <div class="rt-cal-actions">
                <Button
                  label={words.confirmClose(props.fiscalYear)}
                  variant="primary"
                  pending={props.stage === "committing"}
                  pendingLabel={words.committing}
                  disabled={
                    !plan().valid ||
                    !props.planCurrent ||
                    props.uncertain ||
                    props.stage === "committing" ||
                    (props.busy ?? false)
                  }
                  onClick={props.onCommit}
                />
              </div>
            </section>
          )}
        </Show>
      </Show>

      <Show when={props.receipt}>
        {(receipt) => (
          <Show
            when={receipt().disposition === "committed"}
            fallback={
              <Notice title={words.partialTitle} tone="error" role="alert">
                <Show when={receipt().message}>
                  <p>
                    <bdi>{receipt().message}</bdi>
                  </p>
                </Show>
                <p>{words.partialBody(receipt().closed, receipt().total)}</p>
                <Button
                  label={words.reviewAgain}
                  variant="secondary"
                  onClick={props.onReviewAgain}
                />
              </Notice>
            }
          >
            <Notice title={words.doneTitle(props.fiscalYear)} role="status">
              <p>{words.doneBody(receipt().closed)}</p>
              <Show when={props.statements}>
                {(statements) => (
                  <p>
                    <a href={statements().reportHref}>{words.reviewStatements}</a>
                  </p>
                )}
              </Show>
              <Button label={words.back} variant="secondary" onClick={props.onBack} />
            </Notice>
          </Show>
        )}
      </Show>
    </section>
  );
}
