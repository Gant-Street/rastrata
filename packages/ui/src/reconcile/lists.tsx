import { For, Show } from "solid-js";
import { PageSkeleton } from "../skeleton";
import { Check } from "../icons";
import { EmptyState } from "../kit";
import { Button, buttonAttrs } from "../button";
import { Notice, Status } from "../notice";
import { Pager } from "../pager";
import type { AccountStatusRow, ReconciliationRow } from "./types";
import { words } from "./words";
import { formatDate, formatMoney } from "../format";
import { DateValue } from "../date-value";

type ListState = "ready" | "loading" | "error";

/** When the account was last reconciled, in a few words. A phone does not have room for that column, so the
 * account's name cell says it under the name (the column is hidden there, and this is what it showed). */
/** Nothing has reached the account: no posting off a statement, no reconciliation, no draft. Its row
 * says so and offers no Reconcile, since there would be nothing to reconcile against. */
const bare = (row: AccountStatusRow): boolean =>
  row.unclearedCount === 0 && row.lastReconciledDate === null && row.draftHref === null;

const lastLine = (row: AccountStatusRow) =>
  row.lastReconciledDate
    ? `${words.lastReconciled}: ${formatDate(row.lastReconciledDate)}`
    : `${words.lastReconciled}: ${words.never}`;

/** Which accounts to check, first on the page: when each was last reconciled, what is not yet on a
 * statement, and one button that opens the small form for that account. A transaction is "not on a
 * statement" until a completed reconciliation includes it. Nothing here is calculated: every figure comes
 * from the service. A book with no account to check says so, and says what to do. */
export function ReconcileStatusTable(props: {
  rows: readonly AccountStatusRow[];
  state?: ListState;
  /** The rows are being read again: they stay where they are, marked as busy, until the new ones arrive. */
  busy?: boolean;
  /** Where a book with nothing to reconcile goes first. */
  importHref?: string;
  onStart: (accountId: string) => void;
  onRetry?: () => void;
}) {
  return (
    <section
      class="rt-recon-list"
      data-lead
      aria-label={words.statusCaption}
      aria-busy={props.busy ? "true" : undefined}
    >
      <Show
        when={props.state !== "loading" && props.state !== "error"}
        fallback={
          props.state === "error" ? (
            <Notice title={words.unavailableTitle} tone="error" role="alert">
              <p>{words.unavailableBody}</p>
              <Show when={props.onRetry}>
                <Button variant="secondary" label="Try again" onClick={() => props.onRetry?.()} />
              </Show>
            </Notice>
          ) : (
            <PageSkeleton shape="table" label={words.columnLoading} />
          )
        }
      >
        <Show
          when={props.rows.length > 0}
          fallback={
            <EmptyState
              title={words.noAccountsTitle}
              action={
                <a
                  {...buttonAttrs({ variant: "secondary", size: "md" })}
                  href={props.importHref ?? "/import"}
                >
                  {words.importStatement}
                </a>
              }
            >
              {words.noAccountsBody}
            </EmptyState>
          }
        >
          <div class="rt-table-scroll">
            <table class="rt-table">
              <caption class="rt-sr-only">{words.statusCaption}</caption>
              <thead>
                <tr>
                  <th scope="col">{words.account2}</th>
                  <th scope="col" class="rt-recon-last">
                    {words.lastReconciled}
                  </th>
                  <th scope="col">{words.notOnStatement}</th>
                  <th scope="col">
                    <span class="rt-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <For each={props.rows}>
                  {(row) => (
                    <tr>
                      <th scope="row" class="rt-recon-account" data-last={lastLine(row)}>
                        <bdi>{row.account}</bdi>
                      </th>
                      <td class="rt-recon-last">
                        <Show when={row.lastReconciledDate} fallback={words.never}>
                          {(date) => (
                            <>
                              <DateValue value={date()} />
                              <Show when={row.lastReconciledBalance}>
                                {" · "}
                                <span class="rt-recon-amount">
                                  {formatMoney(row.lastReconciledBalance as string)}
                                </span>
                              </Show>
                            </>
                          )}
                        </Show>
                      </td>
                      <td>
                        <Show
                          when={row.unclearedCount > 0}
                          fallback={
                            <Show
                              when={!bare(row)}
                              fallback={<span class="rt-hint">{words.nothingYet}</span>}
                            >
                              <span class="rt-recon-done">
                                <Check aria-hidden="true" /> {words.allOnStatements}
                              </span>
                            </Show>
                          }
                        >
                          {words.unclearedSummary(
                            row.unclearedCount,
                            formatMoney(row.unclearedTotal),
                            row.oldestUnclearedDate,
                          )}
                        </Show>
                      </td>
                      <td class="rt-recon-row-action">
                        <Show
                          when={row.draftHref}
                          fallback={
                            <Show when={!bare(row)}>
                              <Button
                                variant="secondary"
                                size="sm"
                                label={words.reconcile}
                                aria-label={`${words.reconcile} ${row.account}`}
                                onClick={() => props.onStart(row.id)}
                              />
                            </Show>
                          }
                        >
                          {(href) => (
                            <a
                              class="rt-button"
                              data-variant="secondary"
                              data-size="sm"
                              href={href()}
                            >
                              {words.continueDraft}
                              <span class="rt-sr-only"> {row.account}</span>
                            </a>
                          )}
                        </Show>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Show>
    </section>
  );
}

const statusWords = {
  draft: words.inProgress,
  completed: words.completed,
  voided: words.voided,
} as const;

/** Every reconciliation, newest first: drafts in progress, completed records and voided ones. A
 * voided record stays in the list with its status; nothing is ever removed. */
export function ReconcileHistory(props: {
  rows: readonly ReconciliationRow[];
  count: number;
  page: number;
  pageSize: number;
  state?: ListState;
  /** The page is being read again: the rows and the pager stay where they are, marked as busy. */
  busy?: boolean;
  onPageChange: (page: number) => void;
  onRetry?: () => void;
  /** The list sits under a heading of its host's (a fold named "Reconciliations"): it draws none of its
   * own, and is named for assistive technology instead. */
  untitled?: boolean | undefined;
}) {
  return (
    <section
      class="rt-recon-list"
      aria-labelledby={props.untitled ? undefined : "rt-recon-history-heading"}
      aria-label={props.untitled ? words.historyCaption : undefined}
      aria-busy={props.busy ? "true" : undefined}
    >
      <Show when={!props.untitled}>
        <h2 id="rt-recon-history-heading">{words.historyCaption}</h2>
      </Show>
      <Show
        when={props.state !== "loading" && props.state !== "error"}
        fallback={
          props.state === "error" ? (
            <Notice title={words.historyFailed} tone="error" role="alert">
              <Show when={props.onRetry}>
                <Button variant="secondary" label="Try again" onClick={() => props.onRetry?.()} />
              </Show>
            </Notice>
          ) : (
            <PageSkeleton shape="table" label={words.columnLoading} />
          )
        }
      >
        <Show when={props.rows.length > 0} fallback={<p>{words.noHistory}</p>}>
          <div class="rt-table-scroll">
            <table class="rt-table">
              <caption class="rt-sr-only">{words.historyCaption}</caption>
              <thead>
                <tr>
                  <th scope="col">{words.statementCol}</th>
                  <th scope="col">{words.account2}</th>
                  <th scope="col" class="amount">
                    {words.statementBalance}
                  </th>
                  <th scope="col" class="amount">
                    {words.linesCol}
                  </th>
                  <th scope="col">{words.statusCol}</th>
                </tr>
              </thead>
              <tbody>
                <For each={props.rows}>
                  {(row) => (
                    <tr>
                      <th scope="row">
                        <a href={row.href}>
                          <DateValue value={row.statementDate} />
                          <span class="rt-sr-only">
                            {" "}
                            {row.account}, {statusWords[row.status]}
                          </span>
                        </a>
                      </th>
                      <td>
                        <bdi>{row.account}</bdi>
                      </td>
                      <td class="amount rt-recon-amount">{formatMoney(row.statementBalance)}</td>
                      <td class="amount">{row.lineCount}</td>
                      <td>
                        <Status tone={row.status === "draft" ? "review" : "neutral"}>
                          {row.status === "completed" ? (
                            <>
                              <Check aria-hidden="true" /> {words.completed}
                            </>
                          ) : (
                            statusWords[row.status]
                          )}
                        </Status>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
          <Show when={props.count > props.pageSize}>
            <Pager
              count={props.count}
              page={props.page}
              pageSize={props.pageSize}
              onPageChange={props.onPageChange}
            />
          </Show>
        </Show>
      </Show>
    </section>
  );
}
