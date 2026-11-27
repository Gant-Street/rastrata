import { createUniqueId, For, type JSX, Show } from "solid-js";
import { PageSkeleton } from "./skeleton";
import { Button, buttonAttrs } from "./button";
import { EmptyState } from "./kit/empty-state";
import { ToneMarker } from "./kit/tone-marker";
import type { NeedRowView } from "./home-types";
import { homeWords } from "./home-words";

const words = homeWords.needs;

/** "Needs you": the few things a person has to do, each one sentence and one verb. The first is the next
 * thing to do, and its verb is the page's one main button; the others are links. It says it is checking
 * while the facts are read, says what it could not check, and says "nothing needs you" only when every
 * check was read and none found anything. A new book has nothing to check, so it is not a list of
 * warnings. */
export function NeedsYou(props: {
  rows: readonly NeedRowView[];
  /** How many things need a person, shown or not. */
  total: number;
  /** How many of them are not shown. */
  hidden: number;
  state: "loading" | "ready";
  /** What could not be checked, in a sentence, or null. */
  unread?: string | null | undefined;
  onRetry?: () => void;
  /** The book has nothing in it yet. */
  isNew?: boolean;
  /** Where the empty sentence is said: a heading level for the section's own title. */
  headingLevel?: 2 | 3;
}): JSX.Element {
  const headingId = createUniqueId();
  const empty = () => props.rows.length === 0 && !props.unread;
  return (
    <section class="rt-needs" aria-labelledby={headingId} aria-busy={props.state === "loading"}>
      <div class="rt-needs-head">
        <Heading level={props.headingLevel ?? 2} id={headingId}>
          {words.heading}
          <Show when={props.state === "ready" && props.total > 0}>
            <span class="rt-sr-only">, {props.total}</span>
          </Show>
        </Heading>
        <Show when={props.state === "ready" && props.total > 0}>
          <p class="rt-needs-count" aria-hidden="true">
            {props.total}
          </p>
        </Show>
      </div>
      <Show
        when={props.state === "ready"}
        fallback={<PageSkeleton shape="statement" label={words.checking} />}
      >
        <Show when={props.unread}>
          {(text) => (
            <div class="rt-need rt-need-unread" data-tone="problem" role="alert">
              <ToneMarker tone="problem" />
              <p class="rt-need-text">{text()}</p>
              <Show when={props.onRetry}>
                <Button
                  variant="secondary"
                  size="sm"
                  label={words.unreadVerb}
                  onClick={() => props.onRetry?.()}
                />
              </Show>
            </div>
          )}
        </Show>
        <Show
          when={!empty()}
          fallback={<EmptyState live>{props.isNew ? words.noneYet : words.none}</EmptyState>}
        >
          <Show when={props.rows.length > 0}>
            <ul class="rt-needs-list" aria-label={words.listLabel}>
              <For each={props.rows}>
                {(row, index) => <NeedRow row={row} main={index() === 0} />}
              </For>
            </ul>
          </Show>
        </Show>
        <Show when={props.hidden > 0}>
          <p class="rt-needs-more">{words.more(props.hidden)}</p>
        </Show>
      </Show>
    </section>
  );
}

function NeedRow(props: { row: NeedRowView; main: boolean }): JSX.Element {
  const textId = createUniqueId();
  return (
    <li class="rt-need" data-tone={props.row.tone} data-need={props.row.id}>
      <ToneMarker tone={props.row.tone} />
      <p class="rt-need-text" id={textId}>
        {props.row.text}
      </p>
      <Show
        when={props.main}
        fallback={
          <a
            {...buttonAttrs({ variant: "secondary", size: "sm" })}
            href={props.row.href}
            aria-describedby={textId}
          >
            {props.row.verb}
          </a>
        }
      >
        <a
          {...buttonAttrs({ variant: "primary", size: "sm" })}
          href={props.row.href}
          aria-describedby={textId}
        >
          {props.row.verb}
        </a>
      </Show>
    </li>
  );
}

function Heading(props: { level: 2 | 3; id: string; children: JSX.Element }): JSX.Element {
  return props.level === 2 ? (
    <h2 id={props.id} class="rt-home-heading">
      {props.children}
    </h2>
  ) : (
    <h3 id={props.id} class="rt-home-heading">
      {props.children}
    </h3>
  );
}
