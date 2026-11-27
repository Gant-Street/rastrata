import { For, Show } from "solid-js";
import { Button } from "../button";
import { formatCount, formatFiguresInText, formatInstant, transactionsIn } from "../format";
import { ArrowRight, Check, TriangleAlert } from "../icons";
import { Notice } from "../notice";
import type {
  BankfeedPauseView,
  BankfeedRequestsView,
  BankfeedRunView,
  BankfeedSyncState,
} from "./types";
import { words } from "./words";
import { Details } from "../kit/details";

/** Run a sync and see what it did. A sync reads the posted transactions of the linked accounts and
 * queues them in the Inbox; it never posts. The result is always the service's own answer, and a lost
 * reply is shown as uncertain with a way to resume it, never as a failure or a silent retry. When the
 * Bridge's limit is reached the screen says so and when it may ask again. */
export function BankfeedSyncPanel(props: {
  state: BankfeedSyncState;
  /** Why syncing is not possible right now, in words; the button is disabled while this is set. */
  blocked?: string | null;
  progress?: { calls: number; lines: number } | null;
  /** Why a sync stopped without finishing, and when it may be asked again. */
  pause?: BankfeedPauseView | null;
  lastRun: BankfeedRunView | null;
  history: readonly BankfeedRunView[];
  requests: BankfeedRequestsView | null;
  /** The message of a failure that is not a run's own (the service could not be reached). */
  failure?: string | null;
  inboxHref: string;
  onSync: () => void;
  onResume: () => void;
}) {
  const running = () => props.state === "running";
  return (
    <section class="rt-bankfeed-section" aria-labelledby="rt-bankfeed-sync">
      <h2 id="rt-bankfeed-sync">{words.syncTitle}</h2>
      <p class="rt-hint">{words.syncIntro}</p>
      <div class="rt-bankfeed-actions">
        <Button
          label={words.syncNow}
          pendingLabel={words.syncing}
          pending={running()}
          disabled={!!props.blocked || props.state === "uncertain"}
          onClick={props.onSync}
        />
        <Show when={props.blocked}>
          <p class="rt-hint">{props.blocked}</p>
        </Show>
      </div>
      <Show when={running()}>
        <p role="status" class="rt-bankfeed-progress">
          {props.progress
            ? words.syncProgress(props.progress.calls, props.progress.lines)
            : words.syncing}
        </p>
      </Show>
      <Show when={props.state === "uncertain"}>
        <Notice title={words.syncUncertain} tone="review" role="status">
          <p>{words.syncUncertainBody}</p>
          <Button variant="secondary" label={words.resume} onClick={props.onResume} />
        </Notice>
      </Show>
      <Show when={props.state === "failed" && props.failure}>
        <Notice title={words.syncFailed} tone="error" role="alert">
          <bdi>{props.failure}</bdi>
        </Notice>
      </Show>
      <Show when={props.pause}>
        {(pause) => (
          <Notice title={words.syncPaused} tone="review" role="status">
            <p>{pause().message}</p>
            <Show when={pause().until}>
              <p>{words.pausedUntil(formatInstant(pause().until as string))}</p>
            </Show>
          </Notice>
        )}
      </Show>
      <Show when={props.lastRun && !running()}>
        {(_) => {
          const last = props.lastRun as BankfeedRunView;
          return (
            <div class="rt-bankfeed-result" aria-live="polite">
              <p
                class="rt-bankfeed-state"
                data-state={last.disposition === "complete" ? "ok" : "attention"}
              >
                <Show
                  when={last.disposition === "complete"}
                  fallback={<TriangleAlert aria-hidden="true" />}
                >
                  <Check aria-hidden="true" />
                </Show>{" "}
                <span>
                  {last.disposition === "complete"
                    ? words.syncDone
                    : last.disposition === "more"
                      ? words.syncMore
                      : last.disposition === "paused"
                        ? words.syncPaused
                        : words.syncFailed}
                </span>
              </p>
              <Show when={last.disposition === "failed" && last.errorMessage}>
                <p>
                  <bdi>{last.errorMessage}</bdi>
                </p>
              </Show>
              <dl class="rt-bankfeed-facts">
                <div>
                  <dt>{words.lastSync}</dt>
                  <dd>{formatInstant(last.finishedAt ?? last.startedAt)}</dd>
                </div>
                <div>
                  <dt>{words.trigger}</dt>
                  <dd>{words.triggers[last.trigger]}</dd>
                </div>
                <div>
                  <dt>{words.newLines}</dt>
                  <dd class="rt-bankfeed-number">{formatCount(last.newLines)}</dd>
                </div>
                <div>
                  <dt>{words.alreadyImported}</dt>
                  <dd class="rt-bankfeed-number">{formatCount(last.duplicateLines)}</dd>
                </div>
                <div>
                  <dt>{words.pendingLeft}</dt>
                  <dd class="rt-bankfeed-number">{formatCount(last.pendingSkipped)}</dd>
                </div>
                <div>
                  <dt>{words.held}</dt>
                  <dd class="rt-bankfeed-number">{formatCount(last.heldLines)}</dd>
                </div>
                <div>
                  <dt>{words.requestsRun}</dt>
                  <dd class="rt-bankfeed-number">{formatCount(last.requests)}</dd>
                </div>
              </dl>
              <Show when={last.notes.length > 0}>
                <div>
                  <h3 class="rt-bankfeed-subtitle">{words.notes}</h3>
                  <ul class="rt-bankfeed-notes">
                    <For each={last.notes}>
                      {(note) => (
                        <li>
                          <bdi>{formatFiguresInText(transactionsIn(note))}</bdi>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>
              <Show when={last.newLines > 0 || last.heldLines > 0}>
                <a class="rt-bankfeed-link-out" href={props.inboxHref}>
                  {words.reviewInbox} <ArrowRight aria-hidden="true" class="rt-dir-icon" />
                </a>
              </Show>
            </div>
          );
        }}
      </Show>
      <Show when={!props.lastRun && !running() && props.state === "idle"}>
        <p class="rt-hint">{words.never}</p>
      </Show>
      <Show when={props.requests}>
        {(requests) => (
          <p class="rt-hint">
            {words.requestsLine(requests().used, requests().limit, requests().budget)}
          </p>
        )}
      </Show>
      <Details flush summary={words.historyTitle}>
        <Show when={props.history.length > 0} fallback={<p>{words.historyEmpty}</p>}>
          <div class="rt-table-scroll">
            <table class="rt-table">
              <caption class="rt-sr-only">{words.historyTitle}</caption>
              <thead>
                <tr>
                  <th scope="col">{words.columns.when}</th>
                  <th scope="col">{words.columns.by}</th>
                  <th scope="col">{words.columns.result}</th>
                  <th scope="col" class="amount">
                    {words.columns.transactions}
                  </th>
                </tr>
              </thead>
              <tbody>
                <For each={props.history}>
                  {(item) => (
                    <tr>
                      <th scope="row">{formatInstant(item.startedAt)}</th>
                      <td>{words.triggers[item.trigger]}</td>
                      <td>{words.runResult(item)}</td>
                      <td class="amount">{formatCount(item.newLines)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Details>
    </section>
  );
}
