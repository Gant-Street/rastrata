import { For, Show } from "solid-js";
import type { SourceView } from "./types";
import { words } from "./words";
import { DateValue } from "../date-value";

/** What a source's row says will happen: the action in words, then what it does to lines. */
function effect(source: SourceView): string[] {
  const parts: string[] = [words.actions[source.action]];
  if (source.wouldExclude > 0) parts.push(words.wouldExclude(source.wouldExclude));
  if (source.wouldRestore > 0) parts.push(words.wouldRestore(source.wouldRestore));
  if (source.excluded > 0 && source.action === "unchanged")
    parts.push(words.alreadyExcluded(source.excluded));
  return parts;
}

/** Where each statement source of the Inbox starts, and where it would start with the cutover date
 * given. Every figure comes from the service; a source the lane never touches (Stripe) says so.
 * `current` is for a date that can no longer move: it shows where each source starts and how many
 * lines are set aside, with nothing about what a change would do. With no source there is nothing
 * to show, and the section is not rendered at all: the step's own sentence covers that case. */
export function SourceEffects(props: {
  sources: readonly SourceView[];
  busy?: boolean;
  current?: boolean | undefined;
}) {
  return (
    <Show when={props.sources.length > 0}>
      <section class="rt-shadow-sources" aria-labelledby="rt-shadow-sources-title">
        <h3 id="rt-shadow-sources-title">{words.sourcesCaption}</h3>
        <Show when={props.busy}>
          <p role="status" class="rt-hint">
            {words.previewing}
          </p>
        </Show>
        <section class="rt-table-scroll" tabindex="0" aria-label={words.sourcesCaption}>
          <table class="rt-table">
            <caption class="rt-sr-only">{words.sourcesCaption}</caption>
            <thead>
              <tr>
                <th scope="col">{words.source}</th>
                <th scope="col">{props.current ? words.startsAfter : words.startsNow}</th>
                <Show when={!props.current} fallback={<th scope="col">{words.setAside}</th>}>
                  <th scope="col">{words.startsAfter}</th>
                  <th scope="col">{words.whatHappens}</th>
                </Show>
              </tr>
            </thead>
            <tbody>
              <For each={props.sources}>
                {(source) => (
                  <tr>
                    <th scope="row">
                      <bdi title={source.accountKey}>{source.account ?? source.accountKey}</bdi>
                    </th>
                    <td class="rt-shadow-nowrap">
                      <Show when={source.startOn} fallback={words.notSet}>
                        {(on) => <DateValue value={on()} />}
                      </Show>
                    </td>
                    <Show
                      when={!props.current}
                      fallback={
                        <td>
                          {source.excluded > 0
                            ? words.alreadyExcluded(source.excluded)
                            : words.noneSetAside}
                        </td>
                      }
                    >
                      <td class="rt-shadow-nowrap">
                        <Show when={source.after} fallback="—">
                          {(on) => <DateValue value={on()} />}
                        </Show>
                      </td>
                      <td>
                        <For each={effect(source)}>
                          {(part) => <p class="rt-shadow-effect">{part}</p>}
                        </For>
                        <Show when={source.note}>
                          <p class="rt-hint">
                            <bdi>{source.note}</bdi>
                          </p>
                        </Show>
                      </td>
                    </Show>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </section>
      </section>
    </Show>
  );
}
