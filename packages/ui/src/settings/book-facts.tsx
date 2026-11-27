import { For, type JSX, Show } from "solid-js";

export interface BookFact {
  readonly label: string;
  readonly value: JSX.Element;
}

/** What is true of the book, as rows of a name and a value under one heavy rule. Read-only: a value that
 * can be changed is a form of its own, not a row here. With a `title` the block says what it is, and with
 * a `hint` why it cannot be changed, so it is not read as part of a form above it. */
export function BookFacts(props: {
  label: string;
  title?: string;
  hint?: string;
  facts: readonly BookFact[];
}): JSX.Element {
  return (
    <section class="rt-settings-block" aria-label={props.label}>
      <Show when={props.title}>{(title) => <h2>{title()}</h2>}</Show>
      <Show when={props.hint}>{(hint) => <p>{hint()}</p>}</Show>
      <dl class="rt-facts">
        <For each={props.facts}>
          {(fact) => (
            <div class="rt-fact">
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          )}
        </For>
      </dl>
    </section>
  );
}
