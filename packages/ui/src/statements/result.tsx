import { DateValue } from "../date-value";
import { listAccountLabel } from "../entries/display";
import { For, type JSX, onMount, Show } from "solid-js";
import { Button } from "../button";
import { formatMoney } from "../format";
import { Notice } from "../notice";
import type { HistoryRow, ImportCommitData } from "./types";
import { words } from "./words";

/** What the import did, in the one sentence the person came for: how many transactions are waiting. The
 * For review link is a slot because the page owns the router. A result that is not known is said to be
 * unknown and offers to resume the original request: it is never shown as a success or a failure. */
export function ImportResult(props: {
  state: "done" | "uncertain";
  result?: ImportCommitData | undefined;
  /** The link to the Inbox, rendered by the page. */
  inboxLink?: JSX.Element;
  resuming?: boolean | undefined;
  onResume?: (() => void) | undefined;
  onAnother: () => void;
}) {
  const waiting = () => props.result?.waiting ?? 0;
  const difference = () => props.result?.balances[0]?.difference ?? null;
  let heading: HTMLHeadingElement | undefined;
  // The person pressed Import and the form they were in is gone: focus goes to what replaced it.
  onMount(() => heading?.focus());
  return (
    <Show
      when={props.state === "done" && props.result}
      fallback={
        <Notice title={words.uncertainTitle} tone="review" role="alert">
          <p>{words.uncertainBody}</p>
          <div class="rt-imp-commit-actions">
            <Button
              label={words.resume}
              pending={props.resuming === true}
              pendingLabel={words.importing}
              onClick={() => props.onResume?.()}
            />
          </div>
        </Notice>
      }
    >
      <section class="rt-imp-result" aria-labelledby="rt-imp-result-title">
        <h2 id="rt-imp-result-title" ref={heading} tabindex={-1}>
          {words.resultTitle(waiting())}
        </h2>
        <dl class="rt-imp-facts">
          <div>
            <dt>{words.newLines}</dt>
            <dd>{props.result?.counts.new ?? 0}</dd>
          </div>
          <div>
            <dt>{words.alreadyImported}</dt>
            <dd>{(props.result?.counts.duplicate ?? 0) + (props.result?.counts.overlap ?? 0)}</dd>
          </div>
          <Show when={(props.result?.counts.excluded ?? 0) > 0}>
            <div>
              <dt>{words.keptOut}</dt>
              <dd>{props.result?.counts.excluded}</dd>
            </div>
          </Show>
          <Show when={difference() !== null}>
            <div>
              <dt>{words.balanceDifference}</dt>
              <dd class="rt-imp-money">{formatMoney(difference() as string)}</dd>
            </div>
          </Show>
        </dl>
        <div class="rt-imp-commit-actions">
          {props.inboxLink}
          <Button label={words.importAnother} variant="secondary" onClick={props.onAnother} />
        </div>
      </section>
    </Show>
  );
}

/** Recent imports, newest first. The page shows it only when there is one. */
export function ImportHistoryList(props: {
  rows: readonly HistoryRow[];
  state?: "ready" | "loading" | "error";
}) {
  return (
    <section class="rt-imp-history" aria-labelledby="rt-imp-history-title">
      <h2 id="rt-imp-history-title">{words.historyTitle}</h2>
      <Show when={props.state === "error"}>
        <Notice title={words.historyFailed} tone="error" role="alert" />
      </Show>
      <Show when={props.state === "loading"}>
        <p class="rt-hint" role="status">
          Loading…
        </p>
      </Show>
      <Show when={props.rows.length > 0}>
        <section class="rt-table-scroll" tabindex={0} aria-label={words.historyScroll}>
          <table class="rt-table rt-imp-table">
            <caption class="rt-sr-only">{words.historyCaption}</caption>
            <thead>
              <tr>
                <th scope="col">{words.historyDate}</th>
                <th scope="col">{words.historyFile}</th>
                <th scope="col">{words.historyAccount}</th>
                <th scope="col" class="amount">
                  {words.historyNew}
                </th>
                <th scope="col" class="amount">
                  {words.historyAlready}
                </th>
                <th scope="col" class="amount">
                  {words.historyKept}
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={props.rows}>
                {(row) => (
                  <tr>
                    <td class="rt-imp-date">
                      <DateValue value={row.on} />
                    </td>
                    <td class="rt-imp-text">
                      <span class="rt-imp-description">{row.file.name ?? words.unnamedFile}</span>
                    </td>
                    <td>{listAccountLabel(row.account.name, row.account.code)}</td>
                    <td class="amount">{row.counts.new}</td>
                    <td class="amount">{row.counts.duplicate + row.counts.overlap}</td>
                    <td class="amount">{row.counts.excluded}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </section>
      </Show>
    </section>
  );
}
