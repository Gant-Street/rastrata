import { createEffect, createUniqueId, For, on, onMount } from "solid-js";
import { useUi } from "./locale";

export type FormError = { id: string; message: string };

/**
 * Form-level recovery: one place that lists every problem, with a link that moves focus to the
 * field that needs attention. Show it after a failed submit; it takes focus so a screen reader
 * hears it first. Every valid answer stays in the form.
 *
 * `attempt` increases on each failed submit so the summary refocuses even if it is already
 * visible; it does not steal focus while the person types.
 */
export function ErrorSummary(props: {
  errors: readonly FormError[];
  title?: string;
  attempt?: number;
}) {
  const ui = useUi();
  const titleId = createUniqueId();
  let root: HTMLElement | undefined;
  const focus = () => queueMicrotask(() => root?.focus());
  onMount(focus);
  createEffect(on(() => props.attempt, focus, { defer: true }));
  return (
    <section class="rt-error-summary" ref={root} tabindex={-1} aria-labelledby={titleId}>
      <h2 id={titleId}>{props.title ?? ui.messages.summary.title}</h2>
      <ul>
        <For each={props.errors}>
          {(error) => (
            <li>
              <a
                href={`#${error.id}`}
                onClick={(event) => {
                  event.preventDefault();
                  const target = document.getElementById(error.id);
                  target?.focus();
                  target?.scrollIntoView({ block: "center" });
                }}
              >
                {error.message}
              </a>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}
