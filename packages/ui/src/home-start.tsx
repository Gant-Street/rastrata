import { createUniqueId, For, type JSX, Show } from "solid-js";
import { buttonAttrs } from "./button";
import { ChevronRight } from "./icons";
import type { HomeStartView } from "./home-types";

/** The start of a new book: one thing to do, said as a title, a sentence and one button, with the second
 * way to do it as a second button beside it. Under a rule, a row for each person it might be for (moving
 * from another system, having an agent): the row is the link, and no sentence carries one
 * (docs/reference/design-language.md). Nothing else is on the page until something is in the books. */
export function HomeStart(props: { start: HomeStartView }): JSX.Element {
  const headingId = createUniqueId();
  return (
    <section class="rt-start" aria-labelledby={headingId}>
      <h2 id={headingId} class="rt-home-heading rt-start-title">
        {props.start.title}
      </h2>
      <p class="rt-start-text">{props.start.text}</p>
      <p class="rt-start-actions">
        <a {...buttonAttrs({ variant: "primary" })} href={props.start.action.href}>
          {props.start.action.label}
        </a>
        <Show when={props.start.alt}>
          {(alt) => (
            <a {...buttonAttrs({ variant: "secondary" })} href={alt().href}>
              {alt().label}
            </a>
          )}
        </Show>
      </p>
      <Show when={props.start.lines.length > 0}>
        <ul class="rt-start-lines">
          <For each={props.start.lines}>
            {(line) => (
              <li data-line={line.id}>
                <a
                  class="rt-start-row"
                  href={line.href}
                  aria-labelledby={`${headingId}-${line.id}`}
                  aria-describedby={`${headingId}-${line.id}-for`}
                >
                  <span class="rt-start-row-label" id={`${headingId}-${line.id}`}>
                    {line.action}
                  </span>
                  <span class="rt-start-row-note" id={`${headingId}-${line.id}-for`}>
                    {line.text}
                  </span>
                  <ChevronRight aria-hidden="true" />
                </a>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
