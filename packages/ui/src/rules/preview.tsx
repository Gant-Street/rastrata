import { createUniqueId, For, Show, type JSX } from "solid-js";
import { Button } from "../button";
import { Notice, Status } from "../notice";
import { RuleSelect } from "./fields";
import type { RulePreviewState, RulePreviewData, RuleSampleRow, RuleSection } from "./types";
import { words } from "./words";
import { formatMoney } from "../format";
import { DateValue } from "../date-value";

function Sample(props: { sample: RuleSampleRow }) {
  return (
    <li class="rt-rules-sample">
      <div class="rt-rules-sample-head">
        <span class="rt-rules-sample-date">
          <DateValue value={props.sample.date} />
        </span>
        <span class="rt-rules-sample-amount">{formatMoney(props.sample.amount)}</span>
      </div>
      <p class="rt-rules-sample-text">
        <bdi>{props.sample.description}</bdi>
        <Show when={props.sample.counterparty}>
          {(counterparty) => (
            <small>
              <bdi>{counterparty()}</bdi>
            </small>
          )}
        </Show>
      </p>
      <p class="rt-rules-sample-result">
        <Status tone={props.sample.outcome === "unusable" ? "review" : "neutral"}>
          {words.outcomeWord[props.sample.outcome]}
        </Status>
        <Show when={props.sample.detail}>
          {(detail) => (
            <span>
              <bdi>{detail()}</bdi>
            </span>
          )}
        </Show>
      </p>
      <Show when={props.sample.wouldBook.length > 0}>
        <p class="rt-rules-sample-legs">
          <span class="rt-rules-label">{words.sampleWould}</span>
          <For each={props.sample.wouldBook}>
            {(leg) => (
              <span class="rt-rules-leg">
                <bdi>{leg.account}</bdi>{" "}
                <span class="rt-rules-amount">{formatMoney(leg.amount)}</span>
              </span>
            )}
          </For>
        </p>
      </Show>
      <Show when={props.sample.bookedTo}>
        {(booked) => (
          <p class="rt-rules-sample-booked">
            <span class="rt-rules-label">{words.sampleBooked}</span> <bdi>{booked()}</bdi>
            <Show when={props.sample.differs}>
              {" "}
              <Status tone="review">{words.sampleDiffers}</Status>
            </Show>
          </p>
        )}
      </Show>
    </li>
  );
}

function Samples(props: { title: string; section: RuleSection }) {
  const headingId = createUniqueId();
  return (
    <Show when={props.section.samples.length > 0}>
      <section class="rt-rules-samples" aria-labelledby={headingId}>
        <h4 id={headingId}>{props.title}</h4>
        <p class="rt-hint">
          {words.samplesShown(props.section.samples.length, props.section.matched)}
        </p>
        <ul>
          <For each={props.section.samples}>{(sample) => <Sample sample={sample} />}</For>
        </ul>
      </section>
    </Show>
  );
}

/** What a rule would do to the lines already in the book: how many it matches, whether past
 * bookings agree with where it would book them, which lines an earlier rule would decide first,
 * and samples that show the entry it would suggest. It checks a draft as it is typed and changes
 * nothing. While it is checking it says so (and keeps the last answer, marked as updating); when
 * it cannot check it says why; it never shows a figure for a rule it has not checked. */
export function RulePreview(props: {
  state: RulePreviewState;
  data?: RulePreviewData | null | undefined;
  days: number;
  dayChoices: readonly number[];
  onDays: (days: number) => void;
  onRetry?: (() => void) | undefined;
  /** The test-a-line panel, or anything else that belongs with the check. */
  children?: JSX.Element;
}) {
  const headingId = createUniqueId();
  const data = () => (props.state === "ready" || props.state === "loading" ? props.data : null);
  return (
    <section
      class="rt-rules-preview"
      aria-labelledby={headingId}
      aria-busy={props.state === "loading"}
    >
      <h2 id={headingId}>{words.previewTitle}</h2>
      <RuleSelect
        label={words.windowLabel}
        value={String(props.days)}
        options={props.dayChoices.map((days) => ({
          value: String(days),
          label: words.windowDays(days),
        }))}
        onChange={(value) => props.onDays(Number(value))}
      />
      <div class="rt-rules-preview-body" role="status" aria-live="polite">
        <Show when={props.state === "idle"}>
          <p class="rt-hint">{words.previewIdle}</p>
        </Show>
        <Show when={props.state === "incomplete"}>
          <p class="rt-hint">{words.previewIncomplete}</p>
        </Show>
        <Show when={props.state === "loading"}>
          <p class="rt-hint">{data() ? words.previewUpdating : words.previewLoading}</p>
        </Show>
      </div>
      <Show when={props.state === "error"}>
        <Notice title={words.previewFailedTitle} tone="error" role="alert">
          <p>{words.previewFailed}</p>
          <Show when={props.onRetry}>
            <Button
              variant="secondary"
              size="sm"
              label={words.retry}
              onClick={() => props.onRetry?.()}
            />
          </Show>
        </Notice>
      </Show>
      <Show when={data()}>
        {(current) => {
          const considered = () => current().inbox.considered + current().history.considered;
          const matched = () => current().inbox.matched + current().history.matched;
          const shadowed = () => current().inbox.shadowed + current().history.shadowed;
          const unusable = () => current().inbox.unusable + current().history.unusable;
          return (
            <div class="rt-rules-preview-result">
              <p class="rt-rules-preview-headline">
                {words.previewMatches(matched(), considered(), current().days)}
              </p>
              <ul class="rt-rules-facts">
                <li>{words.previewInbox(current().inbox.matched, current().inbox.considered)}</li>
                <li>
                  {words.previewPosted(
                    current().history.matched,
                    current().history.considered,
                    current().days,
                  )}
                </li>
                <Show when={current().agreement.agreed + current().agreement.differed > 0}>
                  <li>
                    {words.previewAgreement(
                      current().agreement.agreed,
                      current().agreement.differed,
                    )}
                    <Show when={current().agreement.differed > 0}>
                      {" "}
                      <strong>{words.previewAgreementDiffers(current().agreement.differed)}</strong>
                    </Show>
                  </li>
                </Show>
                <Show when={shadowed() > 0}>
                  <li>{words.previewShadowed(shadowed())}</li>
                </Show>
                <Show when={unusable() > 0}>
                  <li>{words.previewUnusable(unusable())}</li>
                </Show>
                <Show when={matched() === 0 && considered() > 0}>
                  <li>{words.previewNone}</li>
                </Show>
                <li>{words.previewPosition(current().position)}</li>
              </ul>
              <Show when={current().inbox.truncated || current().history.truncated}>
                <p class="rt-hint">{words.samplesTruncated}</p>
              </Show>
              <For each={current().notes}>{(note) => <p class="rt-hint">{note}</p>}</For>
            </div>
          );
        }}
      </Show>
      {props.children}
      <Show when={data()}>
        {(current) => (
          <div class="rt-rules-preview-result">
            <Samples title={words.samplesInbox} section={current().inbox} />
            <Samples title={words.samplesHistory(current().days)} section={current().history} />
            <p class="rt-hint">{words.previewChangesNothing}</p>
          </div>
        )}
      </Show>
    </section>
  );
}
