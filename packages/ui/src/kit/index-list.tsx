import { For, type JSX, Show } from "solid-js";
import { ChevronRight } from "../icons";

/** One page a person can open from a list. */
export interface IndexEntry {
  readonly label: string;
  readonly href: string;
  /** One line under the name, where the name alone does not say what the page is for. */
  readonly note?: string | undefined;
}

/** What a row's link is drawn from: where it goes, its class and what goes inside it. */
export interface IndexLinkProps {
  readonly class: string;
  readonly href: string;
  readonly children: JSX.Element;
}

/**
 * Pages to open, one a row: the page's name, a line saying what it is for where the name needs one, and
 * a chevron. The whole row is the link, so the target is as wide as the list. It is a list of links and
 * nothing else: a row carries no state, no figure and no second control (a list that needs those is a
 * table).
 */
export function IndexList(props: {
  /** Names the list for assistive technology ("Ways to bring in your books"). */
  label: string;
  entries: readonly IndexEntry[];
  /** Draws the link the way the application navigates (through its router). */
  link?: (props: IndexLinkProps) => JSX.Element;
}): JSX.Element {
  const row = (entry: IndexEntry): JSX.Element => {
    const children = (
      <>
        <span class="rt-index-text">
          <span class="rt-index-name">{entry.label}</span>
          <Show when={entry.note}>
            <span class="rt-index-note">{entry.note}</span>
          </Show>
        </span>
        <ChevronRight aria-hidden="true" />
      </>
    );
    return props.link ? (
      props.link({ class: "rt-index-link", href: entry.href, children })
    ) : (
      <a class="rt-index-link" href={entry.href}>
        {children}
      </a>
    );
  };
  return (
    <ul class="rt-index" aria-label={props.label}>
      <For each={props.entries}>{(entry) => <li>{row(entry)}</li>}</For>
    </ul>
  );
}
