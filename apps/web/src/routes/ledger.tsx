import type { ApplicationInputs } from "@rastrata/application/client-contracts";
import {
  AccountRegister,
  Button,
  buttonAttrs,
  catchallWords,
  chartMessages,
  chartWords,
  DateRangeField,
  type DateRangeValue,
  defaultRange,
  Details,
  DetailsList,
  formatCount,
  formatDate,
  formatDateRange,
  formatMoney,
  isUsableRange,
  kindOfAccount,
  listAccountLabel,
  Notice,
  PageHeader,
  PageSkeleton,
  ReconcileHistory,
  type ReconciliationRow,
  ReportBusy,
  ReportDetails,
  Status,
  useToast,
} from "@rastrata/ui";
import { createMemo, createSignal, onMount, Show } from "solid-js";
import { AppLink } from "../app-link";
import { ApplicationRequestError, BrowserApplicationClient } from "../application-client";
import { createKeyedLoader, createLoader } from "../loader";
import { openedForDisplay } from "./account-opened";
import { createAccountEditing } from "./accounting/account-editing";
import { loadTaxLines, taxLineNames } from "./accounting/tax-lines";
import { watchOffered } from "./accounting/watch";
import { bankingSummary } from "./ingest/summary";
import { StartReconciliation } from "./reconcile/start";
import { Failure } from "./reports/failure";

const RECONCILE_ID = "account-reconcile";
const EDIT_ID = "account-edit";
const WATCH_ID = "account-watch";
const TAGS_ID = "account-tags";

/** Where "back to the report" may lead: only the Reports screen, as a path with a query. An address is
 * data, so anything else (another site, another path) is ignored. */
const safeBack = (value: string | null): string | undefined =>
  value !== null && /^\/reports(\?[^#\s]*)?$/.test(value) ? value : undefined;

/** Save text as a file through the browser, as UTF-8 with a byte order mark so a spreadsheet reads
 * accented names correctly. The service's file has none; this is only for the download. */
function saveFile(filename: string, mediaType: string, content: string): void {
  const blob = new Blob(["﻿", content], { type: mediaType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** One account's page: its transactions with a running balance. It opens from two places. An account's name
 * on Accounts (or its tile on Home) leads here for the book as it stands, in a range the person chooses (this
 * fiscal year to date to start with): a bank or card account says what the books hold, what the bank says and
 * how many transactions wait, has Import a statement and Reconcile in its head, and reads its amounts as
 * Spent and Received; under the transactions are two folds, the account's reconciliations and its details
 * (code, type, tax line, the same lines as a file, and what changes the account: Edit account, watching it
 * at month end, Edit tags). An amount on a report leads here with the report's own
 * dates and population, so the lines add up to the figure that was clicked: the range is fixed to the
 * report's, the way back is the report, and what the lines were read from is under Report details at the
 * foot. If the book moved since the report was read, the service says so and the page offers the report
 * again. */
export function LedgerPage() {
  const w = chartWords.register;
  const toast = useToast();
  const source = new URLSearchParams(window.location.search);
  const accountId = source.get("accountId") ?? "";
  const pinnedPopulation = source.get("population") ?? "";
  const pinnedAsOf = source.get("asOf") ?? "";
  const reportFrom = source.get("reportFrom") ?? "";
  const revision = source.get("revision") ?? "";
  const back = safeBack(source.get("back"));
  const client = new BrowserApplicationClient(window.localStorage);
  const pinned = pinnedPopulation !== "" && pinnedAsOf !== "";

  // Without an account there is nothing to read: the page only says where to choose one.
  const calendar = createLoader(async () =>
    accountId ? client.read("periods.list", {}) : undefined,
  );
  const chart = createLoader(async () =>
    accountId ? client.read("accounts.list", {}) : undefined,
  );
  const fiscal = () => {
    const list = calendar.value();
    return list
      ? {
          years: list.calendar.fiscalYears.map(({ startsOn, endsOn }) => ({ startsOn, endsOn })),
          today: list.calendar.today,
        }
      : undefined;
  };
  const [chosen, setChosen] = createSignal<DateRangeValue | undefined>(
    pinned
      ? {
          preset: "custom",
          from: source.get("from") ?? "",
          to: source.get("to") ?? pinnedAsOf,
        }
      : undefined,
  );
  const range = (): DateRangeValue | undefined => {
    const own = chosen();
    if (own) return own;
    const book = fiscal();
    return book ? defaultRange(book) : undefined;
  };
  const usable = () => {
    const value = range();
    const book = fiscal();
    if (!value) return false;
    return pinned || (book !== undefined && isUsableRange(value, book));
  };
  const [page, setPage] = createSignal(1);
  // The population the first page was read under, so the next pages are the same book.
  const [held, setHeld] = createSignal("");
  const key = createMemo(() => {
    const value = range();
    if (!accountId || !value || !usable()) return undefined;
    return `${value.from}|${value.to}|${page()}`;
  });
  // A loader, not a resource: turning the page keeps the table, the pager and the focus in place while the
  // next page is read.
  const activity = createKeyedLoader(key, async () => {
    const value = range() as DateRangeValue;
    const hash = pinned ? pinnedPopulation : page() > 1 ? held() : "";
    const input: ApplicationInputs["activity.get"] = {
      accountId,
      asOf: pinned ? pinnedAsOf : value.to,
      from: value.from,
      to: value.to,
      page: page(),
      ...(hash ? { populationHash: hash } : {}),
      ...(pinned && reportFrom ? { reportFrom } : {}),
      ...(pinned && revision ? { revision } : {}),
    };
    const read = await client.read("activity.get", input);
    if (!pinned && page() === 1) setHeld(read.populationHash);
    return read;
  });
  const changeRange = (next: DateRangeValue) => {
    setHeld("");
    setPage(1);
    setChosen(next);
  };
  const entryHref = (journalId: string) => {
    if (!pinned) return `/journal/${encodeURIComponent(journalId)}`;
    const query = new URLSearchParams({ asOf: pinnedAsOf, population: pinnedPopulation });
    if (reportFrom) query.set("reportFrom", reportFrom);
    if (revision) query.set("revision", revision);
    return `/journal/${encodeURIComponent(journalId)}?${query.toString()}`;
  };
  const account = () => chart.value()?.accounts.find((item) => item.id === accountId);
  const title = () => activity.value()?.account.name ?? account()?.name ?? w.back;
  /** What the account is, in the chart's words: a bank account, a card, or its type. */
  const kind = () => {
    const found = account();
    return found
      ? kindOfAccount({
          role: found.role,
          tags: { cashFlowClass: found.tags?.cashFlowClass, kind: found.tags?.kind },
        })
      : undefined;
  };
  const kindName = () => {
    const named = kind();
    return named ? (chartMessages.accounts.types[named] ?? named) : "";
  };
  /** A bank or card account: its amounts are money out and money in, and it is reconciled and imported into. */
  const isMoney = () => kind() === "bank" || kind() === "card";
  /** Any account that holds or owes money has reconciliations to show. */
  const balanceSheet = () => account()?.role === "asset" || account()?.role === "liability";
  // What the bank says and what waits come from the summary the whole application shares.
  const banking = bankingSummary();
  onMount(() => {
    if (accountId && !pinned) void banking.reload(2_000);
  });
  const tile = () =>
    banking.tiles().find((item) => item.kind !== "stripe" && item.accountId === accountId);
  /** The line under a bank or card account's name: what the books hold, what the bank says when that is
   * another figure, and how many transactions wait. Any other account's page has no line: what it is, is
   * under Account details. */
  const description = () => {
    const found = account();
    if (pinned || !found || !isMoney()) return undefined;
    const parts = [w.inBooks(formatMoney(found.balance))];
    const said = tile()?.statementBalance;
    if (said !== undefined && said !== found.balance) {
      const when = tile()?.statementAsOf;
      parts.push(w.bankSays(formatMoney(said), when ? formatDate(when) : null));
    }
    const waiting = tile()?.toReview ?? 0;
    if (waiting > 0) parts.push(w.toReview(formatCount(waiting)));
    return parts.join(" · ");
  };

  // Reconcile opens its small form over the page.
  const [reconciling, setReconciling] = createSignal(false);
  const [historyPage, setHistoryPage] = createSignal(1);
  const reconciliations = createKeyedLoader(
    () => (accountId && !pinned && balanceSheet() ? historyPage() : undefined),
    (current) => client.read("reconcile.list", { accountId, page: current }),
  );
  const historyRows = createMemo((): ReconciliationRow[] =>
    (reconciliations.value()?.items ?? []).map((item) => ({
      id: item.id,
      href: `/reconcile/${item.id}`,
      account: listAccountLabel(item.account.name, item.account.code),
      statementDate: item.statementDate,
      statementBalance: item.statementBalance,
      lineCount: item.lineCount,
      status: item.status,
      on: item.completedAt ?? item.createdAt,
    })),
  );
  /** The newest finished reconciliation, for the fold's line while it is shut. */
  const reconciledThrough = () =>
    reconciliations.value()?.items.find((item) => item.status === "completed")?.statementDate;

  const taxLines = createLoader(async () =>
    accountId && !pinned ? loadTaxLines(client) : undefined,
  );
  // Renaming or closing the account, watching it and editing its tags are done here, on its own page.
  const editing = createAccountEditing({
    client,
    chart: () => chart.value() ?? (chart.error() !== undefined ? null : undefined),
    reload: async () => {
      await chart.reload();
      await activity.reload();
    },
    taxLines: taxLines.value,
    periods: calendar.value,
  });
  /** The account as the editing dialogs take one. */
  const view = () => editing.views().find((item) => item.id === accountId);
  const details = () => {
    const found = account();
    if (!found) return [];
    const taxLine = found.tags?.taxLine;
    const cashFlow = found.tags?.cashFlowClass;
    return [
      { label: w.detailCode, value: found.code },
      { label: w.detailType, value: kindName() },
      ...(taxLine
        ? [
            {
              label: w.detailTaxLine,
              value: taxLineNames(taxLines.value()).get(taxLine) ?? taxLine,
            },
          ]
        : []),
      ...(cashFlow
        ? [
            {
              label: w.detailCashFlow,
              value: chartMessages.accounts.classes[cashFlow] ?? cashFlow,
            },
          ]
        : []),
      {
        label: w.detailOpened,
        value: formatDate(openedForDisplay(found.openedOn, calendar.value()?.calendar.booksBegan)),
      },
      ...(found.closedOn ? [{ label: w.detailClosed, value: formatDate(found.closedOn) }] : []),
    ];
  };

  const [exporting, setExporting] = createSignal(false);
  const exportFile = async () => {
    const value = range();
    if (!value || exporting()) return;
    setExporting(true);
    try {
      const file = await client.read("reports.export", {
        statement: "general-ledger",
        asOf: pinned ? pinnedAsOf : value.to,
        from: value.from,
        accountId,
        ...(pinned && revision ? { revision } : {}),
      });
      saveFile(file.filename, file.mediaType, file.content);
      toast.show({ message: w.exported(file.filename) });
    } catch (cause) {
      toast.show({
        message: `${w.exportFailed}${cause instanceof ApplicationRequestError ? ` ${cause.message}` : ""}`,
        tone: "problem",
      });
    } finally {
      setExporting(false);
    }
  };

  return (
    <section class="app-activity rt-acct-page" aria-labelledby="ledger-title">
      <PageHeader
        titleId="ledger-title"
        title={title()}
        description={description()}
        {...(back ? { back: { label: w.backToReport, href: back } } : {})}
        actions={
          <Show
            when={!pinned}
            fallback={
              // Opened from a report: the lines behind its figure, and the same lines as a file.
              <Show when={accountId && activity.value()}>
                <Button
                  variant="secondary"
                  label={exporting() ? w.exporting : w.export}
                  pending={exporting()}
                  onClick={() => void exportFile()}
                />
              </Show>
            }
          >
            <Show when={isMoney() && !account()?.closedOn}>
              <a
                {...buttonAttrs({ variant: "secondary" })}
                href={`/import?account=${encodeURIComponent(accountId)}`}
              >
                {w.importStatement}
              </a>
              <Button id={RECONCILE_ID} label={w.reconcile} onClick={() => setReconciling(true)} />
            </Show>
          </Show>
        }
      />
      <Show when={!pinned && accountId}>
        <editing.Notices />
      </Show>
      <Show
        when={accountId}
        fallback={
          <Notice title={w.chooseTitle}>
            <p>{w.chooseBody}</p>
            <AppLink href="/accounts">{w.chartLink}</AppLink>
          </Notice>
        }
      >
        <Show
          when={pinned}
          fallback={
            <Show when={fiscal()}>
              {(book) => (
                <div class="rt-register-range">
                  <DateRangeField
                    compact
                    label={w.range}
                    value={range() as DateRangeValue}
                    calendar={book()}
                    onChange={changeRange}
                  />
                </div>
              )}
            </Show>
          }
        >
          <p class="rt-hint">
            <Status>{formatDateRange(range()?.from ?? "", range()?.to ?? "")}</Status>
          </p>
        </Show>
        <Show
          when={activity.error() === undefined}
          fallback={
            <Failure
              error={activity.error()}
              retry={() => void activity.reload()}
              staleRetry={() => {
                // A report's lines are the report's: when the book has moved on, the report is read again.
                if (pinned) window.location.assign(back ?? "/reports");
                // A register's pages are one book: read it again from the first page.
                else {
                  setHeld("");
                  setPage(1);
                }
              }}
            />
          }
        >
          <Show when={activity.value()} fallback={<PageSkeleton shape="table" label={w.loading} />}>
            {(data) => (
              <ReportBusy busy={activity.loading()}>
                <AccountRegister
                  data={data()}
                  entryHref={entryHref}
                  onPage={setPage}
                  columns={isMoney() ? "money" : "ledger"}
                />
                <Show when={pinned}>
                  <ReportDetails
                    revision={data().revision}
                    populationHash={data().populationHash}
                    basis={data().basis}
                    currency={data().currency}
                  />
                </Show>
              </ReportBusy>
            )}
          </Show>
        </Show>
        <Show when={!pinned && account()}>
          <div class="rt-account-folds">
            <Show when={balanceSheet()}>
              <Details
                summary={w.reconciliations}
                preview={
                  reconciliations.value() === undefined
                    ? undefined
                    : reconciledThrough()
                      ? w.reconciledThrough(formatDate(reconciledThrough() as string))
                      : (reconciliations.value()?.count ?? 0) === 0
                        ? w.reconciliationsNone
                        : undefined
                }
              >
                <ReconcileHistory
                  untitled
                  rows={historyRows()}
                  count={reconciliations.value()?.count ?? 0}
                  page={historyPage()}
                  pageSize={reconciliations.value()?.pageSize ?? 25}
                  state={
                    reconciliations.error() !== undefined
                      ? "error"
                      : reconciliations.value() === undefined
                        ? "loading"
                        : "ready"
                  }
                  busy={reconciliations.loading() && reconciliations.value() !== undefined}
                  onPageChange={setHistoryPage}
                  onRetry={() => void reconciliations.reload()}
                />
                {/* A bank or card account has Reconcile in the page's head; any other account that holds
                    or owes money has it here. */}
                <Show when={!isMoney() && !account()?.closedOn}>
                  <p class="rt-account-folds-actions">
                    <Button
                      id={RECONCILE_ID}
                      variant="secondary"
                      size="sm"
                      label={w.reconcile}
                      onClick={() => setReconciling(true)}
                    />
                  </p>
                </Show>
              </Details>
            </Show>
            <Details
              summary={w.details}
              preview={w.detailsPreview(account()?.code ?? "", kindName())}
            >
              <DetailsList items={details()} />
              <p class="rt-account-folds-actions">
                <Show when={view()}>
                  {(current) => (
                    <>
                      <Show when={!current().closedOn}>
                        <Button
                          id={EDIT_ID}
                          variant="secondary"
                          size="sm"
                          label={chartWords.actions.edit}
                          onClick={() => editing.editAccount(current(), EDIT_ID)}
                        />
                      </Show>
                      <Show when={watchOffered(current())}>
                        {(offer) => (
                          <Button
                            id={WATCH_ID}
                            variant="secondary"
                            size="sm"
                            label={
                              offer() === "watch"
                                ? catchallWords.watch.action
                                : catchallWords.watch.stopAction
                            }
                            onClick={() => editing.watchAccount(current(), WATCH_ID)}
                          />
                        )}
                      </Show>
                      <Button
                        id={TAGS_ID}
                        variant="secondary"
                        size="sm"
                        label={chartWords.actions.tags}
                        onClick={() => editing.editTags(current(), TAGS_ID)}
                      />
                    </>
                  )}
                </Show>
                <Button
                  variant="secondary"
                  size="sm"
                  label={exporting() ? w.exporting : w.export}
                  pending={exporting()}
                  disabled={!activity.value()}
                  onClick={() => void exportFile()}
                />
              </p>
            </Details>
          </div>
        </Show>
      </Show>
      <Show when={!pinned}>
        <editing.Dialogs />
      </Show>
      <StartReconciliation
        open={reconciling()}
        account={accountId || undefined}
        onClose={() => {
          setReconciling(false);
          document.getElementById(RECONCILE_ID)?.focus();
        }}
      />
    </section>
  );
}
