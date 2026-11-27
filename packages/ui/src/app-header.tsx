import { type JSX, Show } from "solid-js";

/**
 * The application's header: the wordmark and, beside it, the name of the book (so you always know which
 * one this is), then the navigation, all above one heavy rule. The application passes its own wordmark
 * link (the router's) and the navigation; before a book exists it passes only the wordmark.
 */
export function AppHeader(props: {
  /** The wordmark as a link home, drawn by the application's router. It carries the `wordmark` class. */
  wordmark: JSX.Element;
  /** The name of the book. Long names are cut with an ellipsis and keep their full text in a tooltip. */
  name?: string | undefined;
  /** The navigation (`AppNav`). */
  children?: JSX.Element;
}): JSX.Element {
  return (
    <header class="app-header">
      <div class="app-brand">
        {props.wordmark}
        <Show when={props.name}>
          {(name) => (
            <span class="app-book-name" title={name()}>
              {name()}
            </span>
          )}
        </Show>
      </div>
      {props.children}
    </header>
  );
}
