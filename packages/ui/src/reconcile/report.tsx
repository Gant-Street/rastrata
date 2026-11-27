import { createUniqueId, For, Show } from "solid-js";
import { Button } from "../button";
import { DateValue } from "../date-value";
import { Money } from "../money";
import { Notice } from "../notice";
import type { ReconcileOutstandingView, ReportFileState } from "./types";
import { words } from "./words";

type OutstandingState = "ready" | "loading" | "error";

/** What the statement did not show yet, on a finished reconciliation, and how the books get to it: the
 * statement balance, the transactions not yet on it, and the books' balance on that day. The list is worked
 * out by the application from the finished record and the books as they were when it was finished, and
 * checked there; this only shows it. A person reads three figures and a list, nothing is calculated here,
 * and descriptions are bank memos shown as text. */
export function ReconcileOutstanding(props: {
  view?: ReconcileOutstandingView | undefined;
  state?: OutstandingState;
  /** Why it could not be worked out, in the service's words, when it could not. */
  error?: string | undefined;
  onRetry?: () => void;
}) {
  const headingId = `${createUniqueId()}-heading`;
  return (
    <section class="rt-recon-outstanding" aria-labelledby={headingId}>
      <header class="rt-recon-column-head">
        <h2 id={headingId}>{words.outstandingTitle}</h2>
        <Show when={props.state !== "loading" && props.state !== "error" && props.view}>
          {(view) => (
            <span class="rt-recon-column-count">
              {words.recordCount(view().lines.length)}
              <Show when={view().lines.length > 0}>
                {" · "}
                <span class="rt-recon-amount">
                  <Money value={view().total} />
                </span>
              </Show>
            </span>
          )}
        </Show>
      </header>
      <Show
        when={props.state !== "loading" && props.state !== "error"}
        fallback={
          props.state === "error" ? (
            <Notice title={words.outstandingFailedTitle} tone="error" role="alert">
              <Show when={props.error}>
                <p>
                  <bdi>{props.error}</bdi>
                </p>
              </Show>
              <p>{words.outstandingFailedBody}</p>
              <Show when={props.onRetry}>
                <Button
                  variant="secondary"
                  label={words.tryAgain}
                  onClick={() => props.onRetry?.()}
                />
              </Show>
            </Notice>
          ) : (
            <p role="status" class="rt-recon-state">
              {words.outstandingLoading}
            </p>
          )
        }
      >
        <Show when={props.view}>
          {(view) => (
            <>
              <dl class="rt-recon-record rt-recon-tie">
                <div>
                  <dt>{words.tieStatement}</dt>
                  <dd class="rt-recon-amount">
                    <Money value={view().statementBalance} />
                  </dd>
                </div>
                <div>
                  <dt>{words.tieNotYet(view().lines.length)}</dt>
                  <dd class="rt-recon-amount">
                    <Money value={view().total} />
                  </dd>
                </div>
                <div>
                  <dt>{words.tieBooks(view().statementDate)}</dt>
                  <dd class="rt-recon-amount">
                    <Money value={view().bookBalance} />
                  </dd>
                </div>
              </dl>
              <p class="rt-hint">{words.tieSentence}</p>
              <p class="rt-hint">{words.outstandingExplain}</p>
              <Show
                when={view().lines.length > 0}
                fallback={
                  <p class="rt-recon-state">{words.outstandingNone(view().statementDate)}</p>
                }
              >
                <div class="rt-table-scroll rt-recon-scroll">
                  <table class="rt-table rt-recon-table">
                    <caption class="rt-sr-only">
                      {words.outstandingCaption(view().lines.length)}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">{words.date}</th>
                        <th scope="col">{words.description}</th>
                        <th scope="col" class="amount">
                          {words.amount}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={view().lines}>
                        {(line) => (
                          <tr>
                            <td class="rt-recon-date">
                              <DateValue value={line.date} />
                            </td>
                            <td class="rt-recon-description">
                              <bdi>{line.description}</bdi>
                              <Show when={line.href}>
                                {(href) => (
                                  <a class="rt-recon-entry-link" href={href()}>
                                    {words.viewEntry}
                                    <span class="rt-sr-only"> {line.description}</span>
                                  </a>
                                )}
                              </Show>
                            </td>
                            <td class="amount rt-recon-amount">
                              <Money value={line.amount} />
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
            </>
          )}
        </Show>
      </Show>
    </section>
  );
}

/** The page's button for the report: it saves the report as a spreadsheet. A press while the file is being
 * made does nothing, so one press is one file. */
export function ReconcileReportButton(props: { state: ReportFileState; onDownload: () => void }) {
  return (
    <Button
      variant="secondary"
      label={words.reportAction}
      pendingLabel={words.reportPreparing}
      pending={props.state === "preparing"}
      onClick={() => props.onDownload()}
    />
  );
}

/** What became of the press, said where a person looks and announced politely: the file is being made, the
 * file is saved (said only once the browser has it), or it could not be made, with the reason and the
 * assurance that nothing in the books changed. The live region is always there, so a change in it is
 * announced; the sentence a sighted person reads is not read out twice. */
export function ReconcileReportStatus(props: {
  state: ReportFileState;
  /** The file's name, once it is saved. */
  fileName?: string | undefined;
  /** Why the file could not be made, in words. */
  error?: string | undefined;
}) {
  const saved = () => (props.state === "saved" && props.fileName ? props.fileName : undefined);
  const announcement = () =>
    props.state === "preparing"
      ? words.reportPreparing
      : saved() !== undefined
        ? words.reportSaved(saved() ?? "")
        : "";
  return (
    <div class="rt-recon-report-status">
      <div class="rt-sr-only" role="status">
        {announcement()}
      </div>
      <Show when={saved()}>
        {(name) => (
          <p class="rt-recon-report-saved" aria-hidden="true">
            {words.reportSaved(name())}
          </p>
        )}
      </Show>
      <Show when={props.state === "failed"}>
        <Notice title={words.reportFailedTitle} tone="error" role="alert">
          <Show when={props.error}>
            <p>
              <bdi>{props.error}</bdi>
            </p>
          </Show>
          <p>{words.reportFailedBody}</p>
        </Notice>
      </Show>
    </div>
  );
}
