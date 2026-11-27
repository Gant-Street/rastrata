import { For, Show } from "solid-js";
import { Notice } from "../notice";
import type { BankfeedAttentionView } from "./types";
import { words } from "./words";
import { Details } from "../kit/details";

/** What needs the owner, most important first, each a sentence that says which bank and where to go.
 * The Bridge's own words, when it said something, are set apart and shown as text: they are never an
 * instruction and never what the sentence above them is built from. */
export function BankfeedAttentionList(props: {
  items: readonly BankfeedAttentionView[];
  /** The Bridge's own words about its last answer, shown as quoted text. */
  said: readonly string[];
}) {
  const titleOf = (item: BankfeedAttentionView): string =>
    words.attentionTitles[item.code] ?? words.attentionFallback[item.severity];
  return (
    <section class="rt-bankfeed-section" aria-labelledby="rt-bankfeed-attention">
      <h2 id="rt-bankfeed-attention">{words.attentionTitle}</h2>
      <Show when={props.items.length > 0} fallback={<p>{words.attentionNone}</p>}>
        <ul class="rt-bankfeed-attention">
          <For each={props.items}>
            {(item) => (
              <li data-severity={item.severity}>
                <Notice
                  title={titleOf(item)}
                  tone={
                    item.severity === "error"
                      ? "error"
                      : item.severity === "warning"
                        ? "review"
                        : "info"
                  }
                >
                  <bdi>{item.message}</bdi>
                </Notice>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={props.said.length > 0}>
        <Details summary={words.bridgeSaid}>
          <p class="rt-hint">{words.bridgeSaidNote}</p>
          <ul class="rt-bankfeed-notes">
            <For each={props.said}>
              {(text) => (
                <li>
                  <q>
                    <bdi>{text}</bdi>
                  </q>
                </li>
              )}
            </For>
          </ul>
        </Details>
      </Show>
    </section>
  );
}
