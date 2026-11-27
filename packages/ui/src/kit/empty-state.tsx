import { Show, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";

export interface EmptyStateProps {
  /** A few words that name what is missing, in bold: "Nothing imported yet". Optional: the sentence can
   * stand alone. */
  title?: string | undefined;
  /** The one sentence. It says what is true and what happens next, and never claims a success that has
   * not happened: "Nothing imported yet", not "Caught up". */
  children: JSX.Element;
  /** The one action, usually a `Button` or a link made to look like one. Two only where the plan says so
   * (a new book's Inbox offers to import a statement or to connect a bank). */
  action?: JSX.Element | undefined;
  /** Make the title a heading of this level, when the empty state is a section of its own. */
  headingLevel?: 2 | 3 | 4 | undefined;
  /** Announce it politely. Set it where the empty state replaces rows that were there a moment ago (a
   * filter found nothing), so a screen reader hears that the list is now empty. */
  live?: boolean | undefined;
}

/** What a list, a table or a page says when there is nothing in it: one sentence and one action. It is
 * not an illustration, a celebration or a warning. A loading list is not empty and a failed read is not
 * empty either: those say so in their own words (a status line, a `Notice` with Try again), and only a
 * list that was read and had nothing in it uses this. */
export function EmptyState(props: EmptyStateProps): JSX.Element {
  return (
    <div class="rt-empty" role={props.live ? "status" : undefined}>
      <Show when={props.title}>
        <Dynamic
          component={props.headingLevel ? `h${props.headingLevel}` : "p"}
          class="rt-empty-title"
        >
          {props.title}
        </Dynamic>
      </Show>
      <p class="rt-empty-text">{props.children}</p>
      <Show when={props.action}>
        <div class="rt-empty-action">{props.action}</div>
      </Show>
    </div>
  );
}
