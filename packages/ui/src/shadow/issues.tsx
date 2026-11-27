import { For, Show } from "solid-js";
import { Notice } from "../notice";
import { balanceInputId } from "./labels";
import type { IssueView } from "./types";
import { words } from "./words";

const focusInput = (event: MouseEvent, accountId: string) => {
  event.preventDefault();
  const target = document.getElementById(balanceInputId(accountId));
  target?.focus();
  target?.scrollIntoView({ block: "center" });
};

function Items(props: { issues: readonly IssueView[] }) {
  return (
    <ul class="rt-shadow-issues">
      <For each={props.issues}>
        {(issue) => (
          <li>
            <Show when={issue.row !== undefined}>
              <span class="rt-shadow-row">Row {issue.row}</span>{" "}
            </Show>
            <Show when={issue.accountId} fallback={issue.message}>
              {(accountId) => (
                <a
                  href={`#${balanceInputId(accountId())}`}
                  onClick={(event) => focusInput(event, accountId())}
                >
                  {issue.message}
                </a>
              )}
            </Show>
          </li>
        )}
      </For>
    </ul>
  );
}

/** What a review found, grouped by how much it matters: errors stop the entry, warnings ask a
 * person to look, notes only explain. An error that names an account links to its field, so the
 * fix is one keystroke away. All text is data from the service or from a file, shown as text. */
export function IssueList(props: { issues: readonly IssueView[] }) {
  const of = (severity: IssueView["severity"]) =>
    props.issues.filter((issue) => issue.severity === severity);
  return (
    <div class="rt-shadow-issue-groups">
      <Show when={of("error").length > 0}>
        <Notice title={words.errorsTitle} tone="error" role="alert">
          <Items issues={of("error")} />
        </Notice>
      </Show>
      <Show when={of("warning").length > 0}>
        <Notice title={words.warningsTitle} tone="review">
          <Items issues={of("warning")} />
        </Notice>
      </Show>
      <Show when={of("info").length > 0}>
        <section class="rt-shadow-notes" aria-label={words.notesTitle}>
          <h3>{words.notesTitle}</h3>
          <Items issues={of("info")} />
        </section>
      </Show>
    </div>
  );
}
