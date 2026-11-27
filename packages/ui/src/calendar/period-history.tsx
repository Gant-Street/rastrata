import { createSignal, For, Show } from "solid-js";
import { Button } from "../button";
import { formatInstant } from "../format";
import { Details } from "../kit";
import type { HistoryEntry } from "./types";

const PAGE = 25;

/** Every close and reopening the book has recorded, newest first: which period, when, at which
 * revision, and why. A reopening says which later closes it superseded. It is a record to look
 * something up in, not something to read each visit, so it is one shut line with its count
 * ("Change history (10)"): closing a run of months in one step would otherwise leave a line a month
 * on the page. Long histories show a page at a time, so a book with years of closes stays quick. */
export function PeriodHistory(props: { entries: readonly HistoryEntry[] }) {
  return (
    <Show when={props.entries.length > 0}>
      <section aria-label={history.label} class="rt-cal-history">
        <Details summary={history.title(props.entries.length)}>
          <PeriodHistoryList entries={props.entries} />
        </Details>
      </section>
    </Show>
  );
}

/** The list itself, for a page that keeps it inside a fold of its own. */
export function PeriodHistoryList(props: { entries: readonly HistoryEntry[] }) {
  const [shown, setShown] = createSignal(PAGE);
  return (
    <Show when={props.entries.length > 0}>
      <div class="rt-cal-history-list">
        <ol aria-label={history.label}>
          <For each={props.entries.slice(0, shown())}>
            {(entry) => (
              <li>
                <bdi>{entry.periodLabel}</bdi>{" "}
                {entry.kind === "close" ? history.closed : history.reopened}
                {" · "}
                <bdi>{formatInstant(entry.recordedAt)}</bdi>
                {" · "}
                <bdi>{entry.reason}</bdi>
                <Show when={entry.superseded.length > 0}>
                  <small>
                    {history.superseded(entry.superseded.length)}{" "}
                    <bdi>{entry.superseded.join(", ")}</bdi>
                  </small>
                </Show>
              </li>
            )}
          </For>
        </ol>
        <Show when={props.entries.length > shown()}>
          <Button
            label={history.more(props.entries.length - shown())}
            variant="quiet"
            onClick={() => setShown((count) => count + PAGE)}
          />
        </Show>
      </div>
    </Show>
  );
}

const history = {
  label: "Period change history",
  title: (count: number) => `Change history (${count})`,
  closed: "closed",
  reopened: "reopened",
  superseded: (count: number) =>
    `Superseded ${count === 1 ? "the close of" : `the closes of ${count} periods:`}`,
  more: (count: number) =>
    `Show ${Math.min(count, PAGE)} older ${count === 1 ? "change" : "changes"}`,
} as const;
