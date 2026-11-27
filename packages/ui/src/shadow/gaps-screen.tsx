import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import { PageSkeleton } from "../skeleton";
import { Button } from "../button";
import { formatInstant } from "../format";
import { Notice, Status } from "../notice";
import { TextArea, TextField } from "../text-field";
import { SelectField } from "../select-field";
import type { GapFilter, GapKind, GapView, GapsScreenProps } from "./xero-types";
import { NoBook } from "./no-book";
import { xeroWords as words } from "./xero-words";
import { PageHeader } from "../page-header";

const KINDS: readonly GapKind[] = ["difference", "unmapped", "feature", "data", "other"];
const FILTERS: readonly GapFilter[] = ["open", "closed", "all"];

/** One gap: what was found, who opened it, and, once closed, what was found out about it. An open
 * gap is closed only with a note. The note is asked for beside the gap, and nothing is closed until
 * it has been written. */
function GapCard(props: {
  gap: GapView;
  busy: boolean;
  error: string | undefined;
  held: boolean;
  onClose: (resolution: string) => void;
  onReopen: () => void;
  /** The card is gone after a write that was under way: the screen decides where focus goes. */
  onGone: () => void;
}): JSX.Element {
  const uid = createUniqueId();
  let heading: HTMLHeadingElement | undefined;
  let note: HTMLTextAreaElement | undefined;
  let opener: HTMLButtonElement | undefined;
  const [asking, setAsking] = createSignal(false);
  const [resolution, setResolution] = createSignal("");
  const [tried, setTried] = createSignal(false);
  const ready = () => resolution().trim().length >= 3;
  let wasBusy = false;
  createEffect(() => {
    if (props.busy) wasBusy = true;
  });
  // A write finished and the card is still here: its buttons changed, so the card takes the focus.
  createEffect(
    on(
      () => props.busy,
      (busy, was) => {
        if (was && !busy && !props.error) {
          setAsking(false);
          setResolution("");
          setTried(false);
          queueMicrotask(() => heading?.focus());
        }
      },
      { defer: true },
    ),
  );
  onCleanup(() => {
    if (wasBusy) props.onGone();
  });
  const open = () => props.gap.status === "open";
  return (
    <li class="rt-xero-gap" data-status={props.gap.status}>
      <article aria-labelledby={`${uid}-title`}>
        <header>
          <h3 id={`${uid}-title`} tabindex="-1" ref={heading}>
            <bdi>{props.gap.title}</bdi>
          </h3>
          <p class="rt-xero-tags">
            <Status tone={open() ? "review" : "neutral"}>{open() ? "Open" : "Closed"}</Status>
            <Status>{words.kind[props.gap.kind]}</Status>
            <span class="rt-hint">
              {props.gap.source === "tieout" ? words.sourceTieout : words.sourceManual}
            </span>
          </p>
        </header>
        <Show when={props.gap.detail}>
          <p class="rt-xero-detail">
            <bdi>{props.gap.detail}</bdi>
          </p>
        </Show>
        <p class="rt-hint">{words.opened(props.gap.openedBy, formatInstant(props.gap.openedAt))}</p>
        <Show when={!open() && props.gap.resolution}>
          {(resolutionText) => (
            <div class="rt-xero-resolution">
              <h4>{words.resolutionHeading}</h4>
              <p>
                <bdi>{resolutionText()}</bdi>
              </p>
              <p class="rt-hint">
                {words.closed(
                  props.gap.closedBy ?? "",
                  props.gap.closedAt ? formatInstant(props.gap.closedAt) : "",
                )}
              </p>
            </div>
          )}
        </Show>
        <Show when={!open()}>
          <div class="rt-shadow-actions">
            <Button
              variant="secondary"
              label={words.reopen}
              pendingLabel={words.reopening}
              pending={props.busy}
              disabled={props.held}
              onClick={() => props.onReopen()}
            />
          </div>
        </Show>
        <Show when={open()}>
          <Show
            when={asking()}
            fallback={
              <div class="rt-shadow-actions">
                <Button
                  variant="secondary"
                  label={words.closeGap}
                  disabled={props.held}
                  ref={opener}
                  onClick={() => {
                    setAsking(true);
                    queueMicrotask(() => note?.focus());
                  }}
                />
              </div>
            }
          >
            <form
              class="rt-xero-close"
              aria-label={words.closeFormTitle(props.gap.title)}
              onSubmit={(event) => {
                event.preventDefault();
                setTried(true);
                if (ready() && !props.busy && !props.held) props.onClose(resolution().trim());
              }}
              noValidate
            >
              <TextArea
                label={words.resolutionLabel}
                hint={words.resolutionHint}
                required
                value={resolution()}
                ref={note}
                onInput={(event) => setResolution(event.currentTarget.value)}
                {...(tried() && !ready() ? { error: words.resolutionNeeded } : {})}
              />
              <div class="rt-shadow-actions">
                <Button
                  type="submit"
                  label={words.confirmClose}
                  pendingLabel={words.closingGap}
                  pending={props.busy}
                  disabled={props.held}
                />
                <Button
                  variant="quiet"
                  label={words.cancel}
                  disabled={props.busy}
                  onClick={() => {
                    setAsking(false);
                    setTried(false);
                    queueMicrotask(() => opener?.focus());
                  }}
                />
              </div>
            </form>
          </Show>
        </Show>
        <Show when={props.error}>
          <Notice title={words.actionFailed} tone="error" role="alert">
            {props.error}
          </Notice>
        </Show>
      </article>
    </li>
  );
}

/** The gap log: what the move found that is not yet right. A controlled view; the application owns
 * every request. Text in a gap came from a comparison or a person and is shown as text. */
export function GapsScreen(props: GapsScreenProps): JSX.Element {
  const uid = createUniqueId();
  let heading: HTMLHeadingElement | undefined;
  let list: HTMLHeadingElement | undefined;
  onMount(() => {
    if (props.focusTitle) heading?.focus();
  });
  const held = () => props.uncertain !== null;
  const total = () => props.counts.open + props.counts.closed;
  const filterLabel = (filter: GapFilter): string =>
    filter === "open"
      ? words.filterOpen(props.counts.open)
      : filter === "closed"
        ? words.filterClosed(props.counts.closed)
        : words.filterAll;
  return (
    <section class="rt-shadow-screen" aria-labelledby={`${uid}-title`}>
      <PageHeader
        titleId={`${uid}-title`}
        titleRef={(element) => {
          heading = element;
        }}
        title={words.gapsTitle}
        description={words.gapsIntro}
      />

      <Show when={props.noBook}>
        <NoBook />
      </Show>
      <Show when={!props.noBook && props.state === "loading"}>
        <PageSkeleton shape="table" label={words.loading} />
      </Show>
      <Show when={!props.noBook && props.state === "error"}>
        <Notice title={words.gapsLoadFailed} tone="error" role="alert">
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

        <section class="rt-shadow-step" aria-labelledby={`${uid}-list`}>
          <h2 id={`${uid}-list`} tabindex="-1" ref={list}>
            {words.gapCount(total())}
          </h2>
          <fieldset class="rt-xero-filter">
            <legend class="rt-sr-only">{words.filterLegend}</legend>
            <For each={FILTERS}>
              {(filter) => (
                <button
                  type="button"
                  class="rt-xero-filter-button"
                  aria-pressed={props.filter === filter}
                  onClick={() => props.onFilter(filter)}
                >
                  {filterLabel(filter)}
                </button>
              )}
            </For>
          </fieldset>
          <Show
            when={props.gaps.length > 0}
            fallback={<p class="rt-hint">{words.gapsNone[props.filter]}</p>}
          >
            <ul class="rt-xero-gaps">
              <For each={props.gaps}>
                {(gap) => (
                  <GapCard
                    gap={gap}
                    busy={props.busyId === gap.id}
                    error={props.actionError?.id === gap.id ? props.actionError.message : undefined}
                    held={held()}
                    onClose={(resolution) => props.onClose(gap.id, resolution)}
                    onReopen={() => props.onReopen(gap.id)}
                    onGone={() => queueMicrotask(() => list?.focus())}
                  />
                )}
              </For>
            </ul>
          </Show>
        </section>

        <section class="rt-shadow-step" aria-labelledby={`${uid}-add`}>
          <h2 id={`${uid}-add`}>{words.addTitle}</h2>
          <form
            class="rt-xero-add"
            onSubmit={(event) => {
              event.preventDefault();
              if (!props.add.pending && !held()) props.add.onSubmit();
            }}
            noValidate
          >
            <TextField
              label={words.titleLabel}
              required
              value={props.add.title}
              onInput={(event) => props.add.onTitle(event.currentTarget.value)}
              {...(props.add.titleError ? { error: props.add.titleError } : {})}
            />
            <SelectField
              label={words.kindLabel}
              value={props.add.kind}
              items={KINDS.map((kind) => ({ value: kind, label: words.kind[kind] }))}
              onChange={(value) => props.add.onKind(value as GapKind)}
            />
            <TextArea
              label={words.detailLabel}
              hint={words.detailHint}
              value={props.add.detail}
              onInput={(event) => props.add.onDetail(event.currentTarget.value)}
            />
            <Show when={props.add.error}>
              <Notice title={words.requestFailed} tone="error" role="alert">
                {props.add.error}
              </Notice>
            </Show>
            <div class="rt-shadow-actions">
              <Button
                type="submit"
                label={words.addButton}
                pendingLabel={words.addingGap}
                pending={props.add.pending}
                disabled={held()}
              />
            </div>
            <p role="status" class="rt-hint">
              {props.add.done ? words.added : ""}
            </p>
          </form>
        </section>
      </Show>
    </section>
  );
}
