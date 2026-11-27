import { createUniqueId, Show } from "solid-js";
import { byWords, timeOf } from "./logic";
import type { ChangeView, MakerView, SubjectView } from "./types";
import { kindWords, openWords, words } from "./words";

/** One change: when, what happened in the service's one sentence, what it is about, who made it and how,
 * and a link to the thing itself. The sentence and everything inside it that came from outside (a bank's
 * description, the name of a rule or an agent) is plain text: it is never read as a command, a link or
 * markup. Who made it is said in words, and "not recorded" is said as it is: it never reads as a person. */
export function ChangeRow(props: {
  change: ChangeView;
  caller?: MakerView | undefined;
  timeZone?: string | undefined;
  hrefFor: (subject: SubjectView) => string | undefined;
}) {
  const id = createUniqueId();
  const by = () => byWords(props.change.by, props.caller);
  const href = () => props.hrefFor(props.change.subject);
  const open = () => openWords[props.change.subject.kind];
  const accounts = () => props.change.entry?.accounts ?? [];
  const moreAccounts = () =>
    Math.max(0, (props.change.entry?.accountCount ?? 0) - accounts().length);
  return (
    <li
      class="rt-change"
      data-kind={props.change.kind}
      data-maker={props.change.by.kind}
      data-change-id={props.change.id}
    >
      <time class="rt-change-time" datetime={props.change.at} title={props.change.at}>
        {timeOf(props.change.at, props.timeZone)}
      </time>
      <div class="rt-change-main">
        <p class="rt-change-summary" id={`${id}-summary`}>
          <bdi>{props.change.summary}</bdi>
        </p>
        <p class="rt-change-meta">
          <span class="rt-change-kind">{kindWords[props.change.kind]}</span>
          <span class="rt-sr-only">. </span>
          <span class="rt-change-by">
            {by().text}
            <Show when={by().name}>
              {(name) => (
                <>
                  {" "}
                  <bdi class="rt-change-name">{name()}</bdi>
                </>
              )}
            </Show>
          </span>
          <Show when={props.change.how !== ""}>
            <span class="rt-sr-only">. </span>
            <span class="rt-change-how">
              <bdi>{props.change.how}</bdi>
            </span>
          </Show>
        </p>
        <Show when={accounts().length > 0}>
          <p class="rt-change-meta rt-change-accounts">
            <span class="rt-sr-only">{words.accountsLabel}: </span>
            <bdi>{accounts().join(", ")}</bdi>
            <Show when={moreAccounts() > 0}> {words.moreAccounts(moreAccounts())}</Show>
          </p>
        </Show>
      </div>
      <Show when={href() !== undefined && open() !== null}>
        <a class="rt-change-link" href={href()} aria-describedby={`${id}-summary`}>
          {open()}
        </a>
      </Show>
    </li>
  );
}
