import { For, Show } from "solid-js";
import { Button } from "../button";
import { Notice } from "../notice";
import { Progress } from "../progress";
import { words } from "./words";
import type { InboxActionNote, InboxProgress } from "./types";

/** What can be done to the transactions that are selected. The parent works it out from their statuses
 * (or from the tab, when "all matching" is selected), so a button is only offered when it can apply. */
export interface BulkAbilities {
  readonly accept: boolean;
  readonly categorize: boolean;
  readonly exclude: boolean;
  readonly post: boolean;
  readonly restore: boolean;
}

/** "14 have a suggested category. [Accept 14 suggested]": the quick way through a first import, above the
 * list where it is seen, and the page's one main button. It acts on every suggestion in the list as it is
 * filtered, not only on this page. */
export function AcceptBar(props: { count: number; busy?: boolean; onAccept: () => void }) {
  return (
    <section class="rt-inbox-accept" aria-label={words.acceptAll(props.count)}>
      <p>{words.suggestionsReady(props.count)}</p>
      <Button
        size="sm"
        label={words.acceptAll(props.count)}
        disabled={props.busy ?? false}
        onClick={props.onAccept}
      />
    </section>
  );
}

/** The bar that appears when transactions are ticked. It says exactly how many an action will touch, and
 * offers to extend a page's selection to everything that matches the filter: the way a first import of
 * a thousand transactions is worked through, in a few steps and not a thousand clicks. */
export function InboxSelectionBar(props: {
  /** Transactions ticked on this page. */
  pageCount: number;
  /** Every transaction matching the filter. */
  matchingCount: number;
  allMatching: boolean;
  /** How many transactions are ready to post among the selection, for the Post button. */
  postCount: number;
  abilities: BulkAbilities;
  busy?: boolean;
  onSelectMatching: () => void;
  onClear: () => void;
  onAccept: () => void;
  onCategorize: () => void;
  onExclude: () => void;
  onPost: () => void;
  onRestore: () => void;
}) {
  const count = () => (props.allMatching ? props.matchingCount : props.pageCount);
  return (
    <section class="rt-inbox-selection" aria-label={words.selectionLabel}>
      <p class="rt-inbox-selection-text" role="status">
        {props.allMatching
          ? words.allMatching(props.matchingCount)
          : words.selectedPage(props.pageCount)}
      </p>
      <div class="rt-inbox-selection-actions">
        <Show when={props.abilities.accept}>
          <Button
            size="sm"
            label={words.acceptSelected}
            disabled={props.busy ?? false}
            onClick={props.onAccept}
          />
        </Show>
        <Show when={props.abilities.categorize}>
          <Button
            size="sm"
            variant="secondary"
            label={words.categorizeMore}
            disabled={props.busy ?? false}
            onClick={props.onCategorize}
          />
        </Show>
        <Show when={props.abilities.post}>
          <Button
            size="sm"
            label={words.postReady(props.allMatching ? count() : props.postCount)}
            disabled={props.busy ?? false}
            onClick={props.onPost}
          />
        </Show>
        <Show when={props.abilities.exclude}>
          <Button
            size="sm"
            variant="secondary"
            label={words.excludeMore}
            disabled={props.busy ?? false}
            onClick={props.onExclude}
          />
        </Show>
        <Show when={props.abilities.restore}>
          <Button
            size="sm"
            variant="secondary"
            label={words.restore}
            disabled={props.busy ?? false}
            onClick={props.onRestore}
          />
        </Show>
        <Show when={!props.allMatching && props.matchingCount > props.pageCount}>
          <Button
            size="sm"
            variant="quiet"
            label={words.selectMatching(props.matchingCount)}
            disabled={props.busy ?? false}
            onClick={props.onSelectMatching}
          />
        </Show>
        <Button size="sm" variant="quiet" label={words.clearSelection} onClick={props.onClear} />
      </div>
    </section>
  );
}

/** What an action did, in words, with the reason for every transaction it could not do. It stays until it
 * is dismissed, so a person can read it, and it never says more than the service confirmed. */
export function InboxNote(props: { note: InboxActionNote; onDismiss: () => void }) {
  const problem = () => props.note.tone === "problem" || props.note.tone === "error";
  return (
    <div class="rt-inbox-note">
      <Notice title={props.note.title} tone={props.note.tone} role={problem() ? "alert" : "status"}>
        <Show when={props.note.lines.length > 0}>
          <ul class="rt-inbox-note-lines">
            <For each={props.note.lines}>
              {(line) => (
                <li>
                  <bdi>{line}</bdi>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Button size="sm" variant="quiet" label={words.close} onClick={props.onDismiss} />
      </Notice>
    </div>
  );
}

/** A long action in steps. It says how far it has got and can be stopped between steps. */
export function InboxProgressBar(props: { progress: InboxProgress; onStop: () => void }) {
  return (
    <div class="rt-inbox-progress" role="status">
      <Progress
        label={words.progress(props.progress.label, props.progress.done, props.progress.total)}
        value={
          props.progress.total > 0
            ? Math.min(100, Math.floor((props.progress.done * 100) / props.progress.total))
            : null
        }
      />
      <Button size="sm" variant="secondary" label={words.stop} onClick={props.onStop} />
    </div>
  );
}

/** A write whose reply was lost. The original request is resumed, never replaced. */
export function InboxUncertain(props: { onResume: () => void; busy?: boolean }) {
  return (
    <Notice title={words.uncertainTitle} tone="attention" role="alert">
      <p>{words.uncertainBody}</p>
      <Button
        label={words.resume}
        pending={props.busy ?? false}
        pendingLabel={words.working}
        onClick={props.onResume}
      />
    </Notice>
  );
}
