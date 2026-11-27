import { createUniqueId, For, Show } from "solid-js";
import type { RuleRevisionRow } from "./types";
import { words } from "./words";

const who = (by: RuleRevisionRow["by"]) =>
  by.kind === "agent" ? words.madeByAgent(by.name) : words.madeByPerson;

function what(revision: RuleRevisionRow): string {
  if (revision.changed.includes("created")) return words.historyCreated;
  if (revision.changed.includes("deleted")) return words.historyDeleted;
  const parts = revision.changed.map((part) => words.changedParts[part] ?? part);
  return parts.length === 0 ? words.historyNothing : words.historyChanged(parts.join(", "));
}

/** Who changed a rule, when, and which parts, newest first. Earlier revisions are never edited or
 * removed: this is the record a reviewer reads to see whether a person or an agent made a change. */
export function RuleHistory(props: { revisions: readonly RuleRevisionRow[] }) {
  const headingId = createUniqueId();
  return (
    <section class="rt-rules-history" aria-labelledby={headingId}>
      <h2 id={headingId}>{words.historyTitle}</h2>
      <Show
        when={props.revisions.length > 0}
        fallback={<p class="rt-hint">{words.historyEmpty}</p>}
      >
        <ol>
          <For each={props.revisions}>
            {(revision) => (
              <li>
                <p class="rt-rules-history-head">
                  <strong>{words.historyRevision(revision.revision)}</strong>
                  <span>{words.historyBy(who(revision.by), revision.at)}</span>
                </p>
                <p>{what(revision)}</p>
                <Show when={revision.note}>
                  {(note) => (
                    <p class="rt-hint">
                      <bdi>{words.historyNote(note())}</bdi>
                    </p>
                  )}
                </Show>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </section>
  );
}
