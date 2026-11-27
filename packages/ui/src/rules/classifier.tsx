import { createEffect, createSignal, For, on, Show } from "solid-js";
import { CheckField } from "../accounting-controls";
import { Button } from "../button";
import { Details } from "../kit/details";
import { Notice } from "../notice";
import { NumberField } from "../number-field";
import { basisText } from "./format";
import type {
  ClassifierConfigView,
  ClassifierEvaluationView,
  ClassifierRatioView,
  ClassifierView,
  RulesLoadState,
} from "./types";
import { words } from "./words";
import { formatCount } from "../format";

/** The limits the service enforces on each threshold, so a value outside them is caught where it is
 * typed. The service checks again. */
export const CLASSIFIER_LIMITS = {
  minAgreement: { min: 50, max: 100 },
  minMargin: { min: 0, max: 99 },
  minExamples: { min: 1, max: 100 },
  minKnownWords: { min: 1, max: 5 },
} as const;
type Threshold = keyof typeof CLASSIFIER_LIMITS;
const THRESHOLDS: readonly Threshold[] = [
  "minAgreement",
  "minMargin",
  "minExamples",
  "minKnownWords",
];

const ratio = (value: ClassifierRatioView) => basisText(value.basisPoints);

function Figures(props: { evaluation: ClassifierEvaluationView }) {
  return (
    <dl class="rt-rules-quality">
      <div>
        <dt>{words.classifierPrecision}</dt>
        <dd class="rt-rules-quality-figure">{ratio(props.evaluation.precision)}</dd>
        <dd class="rt-rules-quality-note">
          {words.classifierPrecisionBody(props.evaluation.correct, props.evaluation.proposed)}
        </dd>
      </div>
      <div>
        <dt>{words.classifierRecall}</dt>
        <dd class="rt-rules-quality-figure">{ratio(props.evaluation.recall)}</dd>
        <dd class="rt-rules-quality-note">
          {words.classifierRecallBody(props.evaluation.correct, props.evaluation.scored)}
        </dd>
      </div>
      <div>
        <dt>{words.classifierCoverage}</dt>
        <dd class="rt-rules-quality-figure">{ratio(props.evaluation.coverage)}</dd>
        <dd class="rt-rules-quality-note">
          {words.classifierCoverageBody(props.evaluation.proposed, props.evaluation.scored)}
        </dd>
      </div>
    </dl>
  );
}

function Tables(props: { evaluation: ClassifierEvaluationView }) {
  return (
    <>
      <Details class="rt-rules-details" flush summary={words.classifierSweepTitle}>
        <p class="rt-hint">{words.classifierSweepBody}</p>
        <div class="rt-table-scroll">
          <table class="rt-table">
            <caption class="rt-sr-only">{words.classifierSweepTitle}</caption>
            <thead>
              <tr>
                <th scope="col">{words.classifierSweepConfidence}</th>
                <th scope="col" class="amount">
                  {words.classifierSweepSuggested}
                </th>
                <th scope="col" class="amount">
                  {words.classifierSweepRight}
                </th>
                <th scope="col" class="amount">
                  {words.classifierSweepPrecision}
                </th>
                <th scope="col" class="amount">
                  {words.classifierSweepRecall}
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={props.evaluation.thresholds}>
                {(row) => (
                  <tr>
                    <th scope="row">{row.minConfidence}%</th>
                    <td class="amount">{formatCount(row.proposed)}</td>
                    <td class="amount">{formatCount(row.correct)}</td>
                    <td class="amount">{ratio(row.precision)}</td>
                    <td class="amount">{ratio(row.recall)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Details>
      <Show when={props.evaluation.accounts.length > 0}>
        <Details class="rt-rules-details" flush summary={words.classifierAccountsTitle}>
          <div class="rt-table-scroll">
            <table class="rt-table">
              <caption class="rt-sr-only">{words.classifierAccountsTitle}</caption>
              <thead>
                <tr>
                  <th scope="col">{words.classifierAccountsAccount}</th>
                  <th scope="col" class="amount">
                    {words.classifierAccountsScored}
                  </th>
                  <th scope="col" class="amount">
                    {words.classifierAccountsSuggested}
                  </th>
                  <th scope="col" class="amount">
                    {words.classifierAccountsRight}
                  </th>
                  <th scope="col" class="amount">
                    {words.classifierAccountsPrecision}
                  </th>
                  <th scope="col" class="amount">
                    {words.classifierAccountsRecall}
                  </th>
                </tr>
              </thead>
              <tbody>
                <For each={props.evaluation.accounts}>
                  {(row) => (
                    <tr>
                      <th scope="row">
                        <bdi>{row.account}</bdi>
                      </th>
                      <td class="amount">{formatCount(row.scored)}</td>
                      <td class="amount">{formatCount(row.proposed)}</td>
                      <td class="amount">{formatCount(row.correct)}</td>
                      <td class="amount">{ratio(row.precision)}</td>
                      <td class="amount">{ratio(row.recall)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Details>
      </Show>
      <Show when={props.evaluation.confusions.length > 0}>
        <Details class="rt-rules-details" flush summary={words.classifierConfusionTitle}>
          <ul>
            <For each={props.evaluation.confusions}>
              {(row) => (
                <li>
                  <bdi>{words.classifierConfusion(row.count, row.actual, row.predicted)}</bdi>
                </li>
              )}
            </For>
          </ul>
        </Details>
      </Show>
    </>
  );
}

function Thresholds(props: {
  config: ClassifierConfigView;
  saving?: boolean | undefined;
  onSave: (config: ClassifierConfigView) => void;
}) {
  const [enabled, setEnabled] = createSignal(props.config.enabled);
  const [values, setValues] = createSignal<Record<Threshold, string>>(read(props.config));
  const [errors, setErrors] = createSignal<Partial<Record<Threshold, string>>>({});
  const idOf = (name: Threshold) => `rt-rules-threshold-${name}`;
  function read(config: ClassifierConfigView): Record<Threshold, string> {
    return {
      minAgreement: String(config.minAgreement),
      minMargin: String(config.minMargin),
      minExamples: String(config.minExamples),
      minKnownWords: String(config.minKnownWords),
    };
  }
  // What the service has is what the form shows, after a save, a training or a reload.
  createEffect(
    on(
      () => props.config,
      (config) => {
        setEnabled(config.enabled);
        setValues(read(config));
        setErrors({});
      },
      { defer: true },
    ),
  );
  const labels: Record<Threshold, { label: string; hint: string }> = {
    minAgreement: { label: words.classifierAgreement, hint: words.classifierAgreementHint },
    minMargin: { label: words.classifierMargin, hint: words.classifierMarginHint },
    minExamples: { label: words.classifierExamples, hint: words.classifierExamplesHint },
    minKnownWords: { label: words.classifierKnownWords, hint: words.classifierKnownWordsHint },
  };

  function submit() {
    const problems: Partial<Record<Threshold, string>> = {};
    const parsed: Partial<Record<Threshold, number>> = {};
    for (const name of THRESHOLDS) {
      const text = values()[name].trim();
      const limit = CLASSIFIER_LIMITS[name];
      const number = Number(text);
      if (text === "" || !Number.isInteger(number) || number < limit.min || number > limit.max)
        problems[name] = words.classifierRange(limit.min, limit.max);
      else parsed[name] = number;
    }
    setErrors(problems);
    const first = THRESHOLDS.find((name) => problems[name]);
    if (first) {
      document.getElementById(idOf(first))?.focus();
      return;
    }
    props.onSave({
      enabled: enabled(),
      minAgreement: parsed.minAgreement ?? props.config.minAgreement,
      minMargin: parsed.minMargin ?? props.config.minMargin,
      minExamples: parsed.minExamples ?? props.config.minExamples,
      minKnownWords: parsed.minKnownWords ?? props.config.minKnownWords,
    });
  }

  return (
    <form
      class="rt-rules-thresholds"
      novalidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h3>{words.classifierThresholds}</h3>
      <CheckField
        label={words.classifierEnabled}
        checked={enabled()}
        disabled={props.saving ?? false}
        onChange={setEnabled}
      />
      <div class="rt-rules-threshold-fields">
        <For each={THRESHOLDS}>
          {(name) => (
            <NumberField
              class="rt-rules-field"
              id={idOf(name)}
              label={labels[name].label}
              hint={labels[name].hint}
              min={CLASSIFIER_LIMITS[name].min}
              max={CLASSIFIER_LIMITS[name].max}
              value={values()[name]}
              disabled={props.saving}
              error={errors()[name]}
              onChange={(value) => setValues({ ...values(), [name]: value })}
            />
          )}
        </For>
      </div>
      <Button
        type="submit"
        variant="secondary"
        label={words.classifierSave}
        pendingLabel={words.classifierSaving}
        pending={props.saving ?? false}
      />
    </form>
  );
}

/** Whether the classifier has anything to say yet: something learned, a training on record, or a
 * history too long to learn from on its own. On a book with none of these (nothing posted yet) the
 * card is not shown: every sentence it could say would be about an absence. */
export const classifierHasSomethingToSay = (view: ClassifierView): boolean =>
  view.examples > 0 || view.trainedAt !== null || view.heldBack > 0;

/** The local classifier: what it has learned from and how well it does on this book's own history
 * (exact counts, replayed in date order, never a claim from elsewhere). It learns by itself as
 * transactions are posted and reviewed, so there is nothing to press; the one exception is a
 * history too long to learn from on the side, when the service says so and a button learns from all
 * of it. The thresholds that decide when it may suggest are a click away, under Advanced. The card
 * waits while it is read and is not shown at all on a book it has nothing to say about; a read that
 * failed says so. It suggests categories for lines no rule decides; it runs on this computer, calls
 * no model and never posts. Every figure is read from the service. */
export function ClassifierCard(props: {
  state: RulesLoadState;
  view?: ClassifierView | null | undefined;
  training?: boolean | undefined;
  saving?: boolean | undefined;
  /** A message after a train or a save: what happened, or what went wrong. */
  message?: { tone: "ok" | "error"; text: string } | undefined;
  onTrain: () => void;
  onSave: (config: ClassifierConfigView) => void;
  onRetry?: (() => void) | undefined;
}) {
  // Switched off is the one state worth a mark beside the title: what it has learned, and whether
  // that is enough to say anything, is said in the sentences below.
  const off = () => props.state === "ready" && props.view?.config.enabled === false;
  const shown = () =>
    props.state === "error" ||
    (props.state === "ready" && !!props.view && classifierHasSomethingToSay(props.view));
  return (
    <Show when={shown()}>
      {/* One click away: the page is the list of rules, and this is how the suggestions for everything else
          are doing. It opens by itself only when it could not be read. */}
      <Details
        summary={words.classifierTitle}
        preview={off() ? words.classifierOff : undefined}
        defaultOpen={props.state === "error"}
      >
        <Show when={props.state === "error"}>
          <Notice title={words.classifierFailed} tone="error" role="alert">
            <Show when={props.onRetry}>
              <Button variant="secondary" label={words.retry} onClick={() => props.onRetry?.()} />
            </Show>
          </Notice>
        </Show>
        <Show when={props.state === "ready" && props.view}>
          {(view) => (
            <>
              <div class="rt-rules-classifier-status">
                <Show when={view().examples > 0 || view().trainedAt}>
                  <p>
                    {view().examples > 0
                      ? words.classifierLearned(view().examples, view().accounts)
                      : words.classifierLearnedNothing}
                  </p>
                </Show>
                <Show when={view().examples > 0}>
                  <p class="rt-hint">
                    {words.classifierLearnedSources(view().posted, view().decisions)}
                  </p>
                </Show>
                <Show when={view().trainedAt}>
                  {(when) => <p class="rt-hint">{words.classifierTrained(when())}</p>}
                </Show>
                <For each={view().notes}>{(note) => <p class="rt-hint">{note}</p>}</For>
                <Show when={view().heldBack > 0}>
                  <Button
                    variant="secondary"
                    label={words.classifierTrain}
                    pendingLabel={words.classifierTraining}
                    pending={props.training ?? false}
                    onClick={() => props.onTrain()}
                  />
                </Show>
              </div>
              <Show when={props.message}>
                {(message) => (
                  <p
                    class={message().tone === "error" ? "rt-error" : "rt-hint"}
                    role={message().tone === "error" ? "alert" : "status"}
                  >
                    {message().text}
                  </p>
                )}
              </Show>
              <Show when={view().evaluation?.scored}>
                <div class="rt-rules-evaluation">
                  <h3>{words.classifierEvaluationTitle}</h3>
                  <p class="rt-hint">
                    {words.classifierEvaluationBody(view().evaluation?.scored ?? 0)}
                  </p>
                  <Show when={view().evaluation}>
                    {(evaluation) => (
                      <>
                        <Figures evaluation={evaluation()} />
                        <Tables evaluation={evaluation()} />
                      </>
                    )}
                  </Show>
                </div>
              </Show>
              <Details summary={words.classifierAdvanced}>
                <Thresholds config={view().config} saving={props.saving} onSave={props.onSave} />
              </Details>
            </>
          )}
        </Show>
      </Details>
    </Show>
  );
}
