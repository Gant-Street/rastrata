import { For, Show } from "solid-js";
import { Button } from "../button";
import { changesInWindow, makerName } from "./logic";
import type { ChangeListView } from "./types";
import { words } from "./words";

/** How many changes there are and since when, who made them, and when the list was read. The list is a
 * snapshot: it says the moment it was read, and offers to read it again, so a number on the screen is
 * never mistaken for the book as it is now. The count is also said to a screen reader whenever it changes,
 * so a choice that narrows the list is heard to have done so. */
export function ChangesSummary(props: {
  list: ChangeListView;
  timeZone?: string | undefined;
  /** A newer list is being read. */
  busy?: boolean | undefined;
  onReload: () => void;
}) {
  const all = () => changesInWindow(props.list);
  const since = () => {
    const window = props.list.window;
    const start = words.sinceSentence(window.since);
    return window.until === null ? start : `${start}, ${words.untilSentence(window.until)}`;
  };
  return (
    <div class="rt-changes-summary" data-facts>
      <div class="rt-changes-headline" aria-live="polite" aria-atomic="true">
        <h2 class="rt-changes-count">{words.changesShown(props.list.count, all())}</h2>
        <p class="rt-changes-since">{since()}</p>
      </div>
      <Show when={props.list.actors.length > 0}>
        <ul class="rt-changes-makers" aria-label={words.makersLabel}>
          <For each={props.list.actors}>
            {(maker) => (
              <li class="rt-changes-maker" data-maker={maker.by.kind}>
                <bdi>{makerName(maker.by, props.list.caller)}</bdi>
                <span class="rt-changes-maker-count">{maker.count}</span>
                <span class="rt-sr-only"> {words.changesNoun(maker.count)}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <p class="rt-changes-read">
        <Show when={props.busy}>
          <span role="status">{words.updating}</span>
        </Show>
        <Button
          type="button"
          label={words.readAgain}
          variant="quiet"
          size="sm"
          pending={props.busy === true}
          onClick={() => props.onReload()}
        />
      </p>
    </div>
  );
}
