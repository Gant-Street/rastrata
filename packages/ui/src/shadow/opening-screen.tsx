import { createEffect, createUniqueId, For, type JSX, on, onMount, Show } from "solid-js";
import { FileField } from "../file-field";
import { SelectField } from "../select-field";
import { PageSkeleton } from "../skeleton";
import { Button, buttonAttrs } from "../button";
import { Check } from "../icons";
import { Details, DetailsList } from "../kit";
import { Notice } from "../notice";
import { BalanceTable } from "./balance-table";
import { CutoverStep } from "./cutover-step";
import { EntryReview } from "./entry-review";
import { IssueList } from "./issues";
import type {
  BalanceSection,
  EntryView,
  IssueView,
  OffsetView,
  OpeningStatus,
  SourceView,
  StatementAccountView,
  TotalsView,
} from "./types";
import { NoBook } from "./no-book";
import { words } from "./words";
import { introParts } from "../intro";
import { PageHeader } from "../page-header";

export interface NextStepView {
  readonly id: string;
  readonly href: string;
  readonly title: string;
}

type CutoverProps = Parameters<typeof CutoverStep>[0];

export interface OpeningScreenProps {
  /** `loading` while the accounts are read, `error` when they could not be. */
  state: "loading" | "error" | "ready";
  /** There is no book yet: the screen says so, in place of the rest. */
  noBook?: boolean | undefined;
  onRetry?: (() => void) | undefined;
  /** Move focus to the title when the screen opens, as every route does. */
  focusTitle?: boolean | undefined;
  /** A request failed in a way no field can show. Nothing was changed. */
  error?: string | undefined;
  /** An earlier write was not confirmed: resuming it is the only thing offered. */
  uncertain: { readonly resuming: boolean } | null;
  onResume?: (() => void) | undefined;
  opening: {
    readonly status: OpeningStatus;
    /** The date the opening entry is (or will be) posted on. */
    readonly date?: string | undefined;
    /** The balances were entered by hand as an ordinary journal, not through these tools. */
    readonly byHand?: boolean | undefined;
    readonly entryHref?: string | undefined;
  };
  cutover: Omit<CutoverProps, "held" | "accounts" | "sources"> & {
    accounts: readonly StatementAccountView[];
    sources: readonly SourceView[];
  };
  balances: {
    readonly sections: readonly BalanceSection[];
    readonly entered: TotalsView;
    readonly totals: TotalsView;
    readonly offset: OffsetView | null;
    /** The equity accounts that can carry the difference, and the one chosen ("" is automatic). */
    readonly offsetChoices: readonly { readonly value: string; readonly label: string }[];
    readonly offsetValue: string;
    /** No account is named for opening balances: the person must choose one. */
    readonly offsetRequired: boolean;
    readonly file: {
      readonly reading: boolean;
      readonly message?: string | undefined;
      readonly error?: string | undefined;
    };
    readonly problems: number;
    readonly anyEntered: boolean;
    readonly disabled?: boolean | undefined;
    readonly onInput: (accountId: string, value: string) => void;
    readonly onBlur: (accountId: string) => void;
    readonly onToggleSection: (sectionId: string) => void;
    readonly onOffset: (value: string) => void;
    readonly onFile: (file: File) => void;
    readonly onClear: () => void;
  };
  review: {
    readonly stage: "none" | "reviewing" | "reviewed";
    /** The balances changed after the review was made. */
    readonly stale: boolean;
    readonly entry: EntryView | null;
    readonly issues: readonly IssueView[];
    readonly valid: boolean;
    readonly onReview: () => void;
  };
  plan: {
    readonly stage: "none" | "preparing" | "prepared";
    readonly entry: EntryView | null;
    readonly valid: boolean;
    readonly revision: string;
    readonly hash: string;
    readonly warnings: readonly string[];
    readonly problems: readonly string[];
    readonly onPrepare: () => void;
  };
  post: {
    readonly pending: boolean;
    /** The entry was posted from this screen just now (not found already posted). */
    readonly done: boolean;
    readonly error?: string | undefined;
    readonly onPost: () => void;
  };
  nextSteps: readonly NextStepView[];
}

function NextSteps(props: { steps: readonly NextStepView[] }) {
  return (
    <section class="rt-shadow-next" aria-labelledby="rt-shadow-next-title">
      <h3 id="rt-shadow-next-title">{words.nextTitle}</h3>
      <ol>
        <For each={props.steps}>
          {(step) => (
            <li>
              <a href={step.href}>{step.title}</a>
            </li>
          )}
        </For>
      </ol>
    </section>
  );
}

/** Opening balances: the cutover date, the balances, and the entry they make, reviewed before it is
 * posted. The screen is a controlled view; the application owns every request and every figure.
 * Nothing posts until the person has seen the exact entry and chosen Post. */
export function OpeningScreen(props: OpeningScreenProps): JSX.Element {
  const uid = createUniqueId();
  const intro = introParts(words.openingIntro);
  let heading: HTMLHeadingElement | undefined;
  onMount(() => {
    if (props.focusTitle) heading?.focus();
  });
  // Posting removes the button that had the focus: the confirmation takes it. The heading may be
  // made before or after the screen learns the entry was posted from here, so both are covered.
  let confirmation: HTMLHeadingElement | undefined;
  const focusConfirmation = () => queueMicrotask(() => confirmation?.focus());
  createEffect(
    on(
      () => props.post.done,
      (done) => {
        if (done) focusConfirmation();
      },
      { defer: true },
    ),
  );
  const held = () => props.uncertain !== null;
  const posted = () => props.opening.status === "posted";
  const canReview = () =>
    props.cutover.recorded !== null &&
    !held() &&
    props.balances.problems === 0 &&
    props.balances.anyEntered &&
    props.review.stage !== "reviewing";
  const reviewHint = (): string | null =>
    props.cutover.recorded === null
      ? words.needCutover
      : props.balances.problems > 0
        ? words.fixAmounts(props.balances.problems)
        : !props.balances.anyEntered
          ? words.nothingEntered
          : null;
  const canPrepare = () =>
    props.review.stage === "reviewed" &&
    props.review.valid &&
    !props.review.stale &&
    props.plan.stage !== "preparing" &&
    !held();
  return (
    <section class="rt-shadow-screen" aria-labelledby={`${uid}-title`}>
      <PageHeader
        titleId={`${uid}-title`}
        titleRef={(element) => {
          heading = element;
        }}
        title={words.openingTitle}
        description={intro.line}
        actions={
          <Show when={posted() && props.opening.entryHref}>
            {(href) => (
              <a {...buttonAttrs({ variant: "secondary" })} href={href()}>
                {words.entryLink}
              </a>
            )}
          </Show>
        }
      />

      <Show when={props.noBook}>
        <NoBook />
      </Show>
      <Show when={!props.noBook && props.state === "loading"}>
        <PageSkeleton shape="table" label={words.loading} />
      </Show>
      <Show when={!props.noBook && props.state === "error"}>
        <Notice title={words.loadFailed} tone="error" role="alert">
          <Show when={props.onRetry}>
            <Button variant="secondary" label={words.retry} onClick={() => props.onRetry?.()} />
          </Show>
        </Notice>
      </Show>

      <Show when={!props.noBook && props.state === "ready"}>
        <Show when={props.error}>
          <Notice title={words.requestFailed} tone="error" role="alert">
            {props.error}
          </Notice>
        </Show>
        <Show when={props.uncertain}>
          {(uncertain) => (
            <Notice title={words.uncertainTitle} tone="review" role="alert">
              <p>{words.uncertainBody}</p>
              <Button
                label={words.resume}
                pendingLabel={words.resuming}
                pending={uncertain().resuming}
                onClick={() => props.onResume?.()}
              />
            </Notice>
          )}
        </Show>

        <Show when={posted()}>
          <section class="rt-shadow-posted" aria-labelledby={`${uid}-posted`}>
            <h2
              id={`${uid}-posted`}
              tabindex="-1"
              ref={(element) => {
                confirmation = element;
                if (props.post.done) focusConfirmation();
              }}
            >
              <Check aria-hidden="true" />{" "}
              {props.post.done
                ? words.posted
                : props.opening.byHand
                  ? words.alreadyByHand
                  : words.alreadyPosted}
            </h2>
            <p>
              {props.post.done
                ? `${words.postedDetail(props.opening.date ?? "")} ${words.postedNote}`
                : props.opening.byHand
                  ? words.alreadyByHandBody(props.opening.date ?? "")
                  : words.alreadyPostedBody(props.opening.date ?? "")}
            </p>
            <NextSteps steps={props.nextSteps} />
          </section>
        </Show>

        <Show when={props.opening.status === "reversed"}>
          <Notice title={words.reversedNote} tone="info" />
        </Show>
        <Show when={props.opening.status === "planned"}>
          <Notice title={words.plannedWaiting} tone="review" />
        </Show>

        <CutoverStep {...props.cutover} held={held()} />

        <Show when={!posted()}>
          <section class="rt-shadow-step" aria-labelledby={`${uid}-balances`}>
            <h2 id={`${uid}-balances`}>{words.stepBalances}</h2>
            <p class="rt-hint">{words.balancesIntro}</p>
            <div class="rt-shadow-tools">
              <FileField
                label={words.importCsv}
                hideLabel
                button={words.importCsv}
                accept=".csv,text/csv,text/plain"
                disabled={held() || props.balances.disabled === true}
                onFile={(file) => props.balances.onFile(file)}
              />
              <Button
                variant="quiet"
                label={words.clearAll}
                disabled={!props.balances.anyEntered || held()}
                onClick={() => props.balances.onClear()}
              />
            </div>
            <p class="rt-hint">{words.importHint}</p>
            <Show when={props.balances.file.reading}>
              <p role="status">{words.importReading}</p>
            </Show>
            <Show when={props.balances.file.message}>
              <p role="status">{props.balances.file.message}</p>
            </Show>
            <Show when={props.balances.file.error}>
              <Notice title={words.importFailed} tone="error" role="alert">
                {props.balances.file.error}
              </Notice>
            </Show>
            <Show when={props.balances.offsetRequired || props.balances.offsetChoices.length > 1}>
              <SelectField
                class="rt-shadow-offset-choice"
                label={words.offsetChoice}
                value={props.balances.offsetValue}
                disabled={held()}
                items={[{ value: "", label: words.offsetAuto }, ...props.balances.offsetChoices]}
                onChange={props.balances.onOffset}
              />
            </Show>
            <BalanceTable
              sections={props.balances.sections}
              offset={props.balances.offset}
              entered={props.balances.entered}
              totals={props.balances.totals}
              disabled={held() || props.balances.disabled === true}
              onInput={props.balances.onInput}
              onBlur={props.balances.onBlur}
              onToggle={props.balances.onToggleSection}
            />
          </section>

          <section class="rt-shadow-step" aria-labelledby={`${uid}-review`}>
            <h2 id={`${uid}-review`}>{words.stepReview}</h2>
            <div class="rt-shadow-actions">
              <Button
                variant="secondary"
                label={words.reviewButton}
                pendingLabel={words.reviewing}
                pending={props.review.stage === "reviewing"}
                disabled={!canReview()}
                onClick={() => props.review.onReview()}
              />
            </div>
            <Show when={reviewHint()}>{(hint) => <p class="rt-hint">{hint()}</p>}</Show>

            <Show when={props.review.stage === "reviewed"}>
              <Show when={props.review.stale}>
                <Notice title={words.stale} tone="review" role="status" />
              </Show>
              <IssueList issues={props.review.issues} />
              {/* Once the entry is prepared, the prepared entry below is the one to read. */}
              <Show when={props.plan.stage !== "prepared"}>
                <Show when={props.review.entry}>{(entry) => <EntryReview entry={entry()} />}</Show>
                <div class="rt-shadow-actions">
                  <Button
                    label={words.prepare}
                    pendingLabel={words.preparing}
                    pending={props.plan.stage === "preparing"}
                    disabled={!canPrepare()}
                    onClick={() => props.plan.onPrepare()}
                  />
                </div>
              </Show>
            </Show>

            <Show when={props.plan.stage === "prepared"}>
              <section class="rt-shadow-prepared" aria-labelledby={`${uid}-prepared`}>
                <h3 id={`${uid}-prepared`}>
                  <Show when={props.plan.valid} fallback={words.preparedInvalid}>
                    <Check aria-hidden="true" /> {words.prepared}
                  </Show>
                </h3>
                <Details summary={words.preparedDetails}>
                  <DetailsList
                    items={[
                      { label: words.preparedRevision, value: props.plan.revision },
                      { label: words.preparedPlan, value: props.plan.hash, mono: true, copy: true },
                    ]}
                  />
                </Details>
                <Show when={props.plan.problems.length > 0}>
                  <Notice title={words.errorsTitle} tone="error" role="alert">
                    <ul class="rt-shadow-issues">
                      <For each={props.plan.problems}>{(problem) => <li>{problem}</li>}</For>
                    </ul>
                  </Notice>
                </Show>
                <Show when={props.plan.warnings.length > 0}>
                  <Notice title={words.warningsTitle} tone="review">
                    <ul class="rt-shadow-issues">
                      <For each={props.plan.warnings}>{(warning) => <li>{warning}</li>}</For>
                    </ul>
                  </Notice>
                </Show>
                <Show when={props.plan.entry}>{(entry) => <EntryReview entry={entry()} />}</Show>
                <Show when={props.post.error}>
                  <Notice title={words.postRejected} tone="error" role="alert">
                    {props.post.error}
                  </Notice>
                </Show>
                <div class="rt-shadow-actions">
                  <Button
                    label={words.post}
                    pendingLabel={words.posting}
                    pending={props.post.pending}
                    disabled={!props.plan.valid || held()}
                    onClick={() => props.post.onPost()}
                  />
                </div>
                <p class="rt-hint">{words.postNote}</p>
              </section>
            </Show>
          </section>
        </Show>
      </Show>
    </section>
  );
}
