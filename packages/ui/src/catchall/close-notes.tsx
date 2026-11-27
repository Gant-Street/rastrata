import { For, type JSX, Show } from "solid-js";
import { Money } from "../money";
import { placeDetail } from "./logic";
import type { CloseNote } from "./types";
import { catchallWords } from "./words";

/** What a month says besides what stands in its way: money collecting in an account for what fits nowhere
 * else, or that the account could not be checked. A note is not a step. It never keeps a month from
 * closing, and it says so. What a bank wrote, and the names of payees, are text: shown as it is, never read
 * as anything else. */
export function CloseNotes(props: { notes: readonly CloseNote[] }): JSX.Element {
  const w = catchallWords.notes;
  return (
    <Show when={props.notes.length > 0}>
      <section class="rt-close-notes" aria-label={w.region}>
        <For each={props.notes}>
          {(note) => (
            <article class="rt-close-note" data-state={note.state}>
              <h3>
                <bdi dir="auto">{note.title}</bdi>
              </h3>
              <p>
                <bdi dir="auto">{note.text}</bdi>
              </p>
              <Show when={note.largest.length > 0}>
                <p class="rt-close-note-heading">{w.largestHeading}</p>
                <ul class="rt-close-note-places">
                  <For each={note.largest}>
                    {(place) => (
                      <li>
                        <span class="rt-close-note-name">
                          <bdi dir="auto">{place.name}</bdi>
                          <Show when={placeDetail(place.kind)}>
                            {(detail) => <small>{detail()}</small>}
                          </Show>
                        </span>
                        <span class="rt-number">
                          <Money value={place.amount} />
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <Show when={note.state === "found"}>
                <p class="rt-hint">{w.reassure}</p>
              </Show>
              <Show when={note.href}>
                {(href) => (
                  <p class="rt-close-note-actions">
                    <a
                      class="rt-button"
                      data-variant="secondary"
                      data-size="sm"
                      href={href()}
                      aria-label={w.seeIn(note.accountName)}
                    >
                      {w.see}
                    </a>
                  </p>
                )}
              </Show>
            </article>
          )}
        </For>
      </section>
    </Show>
  );
}
