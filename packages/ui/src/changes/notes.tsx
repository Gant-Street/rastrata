import { For, Show } from "solid-js";
import { formatDate, formatInstant } from "../format";
import { Details, DetailsList, type DetailsItem } from "../kit/details";
import { Notice } from "../notice";
import type { ChangeListView, SourceView } from "./types";
import { words } from "./words";

/** The parts of the list that could not be read, with the reason for each, above the list: a short list
 * must never be mistaken for a quiet one. */
export function UnreadNotice(props: { sources: readonly SourceView[] }) {
  return (
    <Notice title={words.unreadTitle} tone="attention">
      <p>{words.unreadBody}</p>
      <ul class="rt-changes-unread">
        <For each={props.sources}>
          {(source) => (
            <li>
              <strong>{source.reason === null ? source.title : `${source.title}:`}</strong>{" "}
              <Show when={source.reason}>{(reason) => <bdi>{reason()}</bdi>}</Show>
            </li>
          )}
        </For>
      </ul>
    </Notice>
  );
}

const sourceItem = (source: SourceView): DetailsItem => ({
  label: source.title,
  value: source.read
    ? `${words.sourceRead}: ${words.sourceChanges(source.changes)}`
    : `${words.sourceUnread}${source.reason === null ? "" : `: ${source.reason}`}`,
});

/** What was left out for this sign-in (one quiet line each), how far back the books know who made a change
 * (said only when a listed change is from before then), and, one click away, where the list was read from,
 * when, and what it does not cover yet. */
export function ChangesNotes(props: { list: ChangeListView; timeZone?: string | undefined }) {
  const details = (): readonly DetailsItem[] => [
    ...props.list.sources.map(sourceItem),
    {
      label: words.readAtLabel,
      value: formatInstant(props.list.asOf, { timeZone: props.timeZone }),
    },
    { label: words.versionLabel, value: props.list.revision, mono: true },
  ];
  const withheld = () =>
    props.list.sources.flatMap((source) => (source.withheld ? [source.withheld] : []));
  // A change whose maker the books did not record is in the window: the sentence says why.
  const unrecorded = () => props.list.actors.some((actor) => actor.by.kind === "unknown");
  return (
    <div class="rt-changes-notes">
      <For each={withheld()}>{(line) => <p class="rt-description">{line}</p>}</For>
      <Show when={unrecorded()}>
        <p class="rt-description">
          <Show when={props.list.attribution} fallback={words.attribution.never}>
            {(from) =>
              words.attribution.from(formatDate(from().fromAt, { timeZone: props.timeZone }))
            }
          </Show>
        </p>
      </Show>
      <Details summary={words.sourcesTitle}>
        <DetailsList items={details()} />
        <Show when={props.list.notCovered.length > 0}>
          <p class="rt-description">{words.notCoveredIntro}</p>
          <ul class="rt-changes-notcovered">
            <For each={props.list.notCovered}>{(item) => <li>{item}</li>}</For>
          </ul>
        </Show>
      </Details>
    </div>
  );
}
