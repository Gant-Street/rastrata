import type { ApplicationInputs, ApplicationOutputs } from "@rastrata/application/client-contracts";
import {
  BalanceSheetMonthlyView,
  BalanceSheetView,
  canBeByMonth,
  canBeCompared,
  canShare,
  canShowEmpty,
  CashFlowView,
  defaultState,
  describeRange,
  ExportMenu,
  GeneralLedgerView,
  isUsableRange,
  localToday,
  MAX_MONTH_COLUMNS,
  monthlyCsv,
  Notice,
  PageHeader,
  ProfitLossMonthlyView,
  ProfitLossView,
  parseState,
  ReportBusy,
  ReportControls,
  Loading,
  ReportState,
  IndexList,
  serializeState,
  TrialBalanceView,
  monthWindows,
  useUi,
  yearContaining,
  type CompareChoice,
  type DateRangeValue,
  type ReportCalendar,
  type ReportColumns,
  type ReportHrefs,
  type ReportScreenState,
  type ReportTab,
} from "@rastrata/ui";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  Show,
  Switch,
  type JSX,
} from "solid-js";
import { useLocation } from "@tanstack/solid-router";
import { AppLink } from "../app-link";
import { ApplicationRequestError, BrowserApplicationClient } from "../application-client";
import { createKeyedLoader, createLoader, type Loader } from "../loader";
import { Failure } from "./reports/failure";
import { keepChoices, lastChoices, STATEMENT_CHOICES, TAX_CHOICES } from "./reports/last-choices";
import { type MonthlyInput, readMonthly } from "./reports/monthly";

type Core = ApplicationOutputs["reports.get"];
type CashFlow = ApplicationOutputs["reports.cashFlow"];
type Ledger = ApplicationOutputs["reports.generalLedger"];

/** The Reports screen: it reads through the versioned `/v1` operations, keeps its whole state (the
 * statement, the period, the comparison, the page) in the address, and hands everything it shows to
 * the report components. It reads the current book with an as-of date and never pins an older
 * revision unless a link asked for one: pinning replays history, which is slow in a large book, and
 * a figure that has gone stale is better named than silently kept. */

const CORE_TABS: readonly ReportTab[] = ["profit-loss", "balance-sheet", "trial-balance"];

const sameContent = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A value that follows `value()` while `active()`, and holds its last value otherwise. Feeding a
 * loader from it means a statement that is not on screen is neither read nor thrown away, and a
 * request made twice reads nothing again: a tab left and returned to, or the three statements of one
 * population, share one read, because a new object with the same content is not a change. */
function whileActive<T>(active: () => boolean, value: () => T | undefined) {
  return createMemo<T | undefined>((previous) => (active() ? value() : previous), undefined, {
    equals: sameContent,
  });
}

/** One statement's honest states: its outline while it is read for the first time, failed, or the figures. Figures that
 * are being read again stay where they are, marked busy, so the controls around them and the focus a
 * person has keep their place (a read that suspended the page would drop both); a failed read shows
 * the failure, never the old figures. */
function Loaded<T>(props: {
  loader: Loader<T>;
  what: string;
  children: (data: Accessor<T>) => JSX.Element;
}) {
  const ui = useUi();
  return (
    <Show
      when={props.loader.error() === undefined}
      fallback={<Failure error={props.loader.error()} retry={() => void props.loader.reload()} />}
    >
      <Loading
        ready={props.loader.value() !== undefined}
        shape="statement"
        label={ui.messages.reports.states.loading(props.what)}
      >
        <Show when={props.loader.value()}>
          {(data) => <ReportBusy busy={props.loader.loading()}>{props.children(data)}</ReportBusy>}
        </Show>
      </Loading>
    </Show>
  );
}

/** The figures a loader is showing now: nothing while a read is under way or after one failed, so a
 * decision about "what is on screen" never rests on the figures a newer read is replacing. */
function onScreen<T>(loader: Loader<T>): T | undefined {
  return loader.loading() || loader.error() !== undefined ? undefined : loader.value();
}

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

/** Reports: the list of every report, in three groups, when the address names none; the report itself
 * when it does (`?tab=balance-sheet`, or any address a figure or a link wrote, which is the profit and
 * loss unless it says otherwise). */
export function ReportsPage() {
  const location = useLocation();
  // Which report the address asks for: none (the list), or a statement by name. An address a figure or a
  // link wrote may not name one, and is the profit and loss. A report changes the rest of its own address
  // as its dates change, so only the statement's name decides when the page is made again: a link from
  // one statement to another reads the new address, and a change of dates keeps the page and the focus.
  const asked = createMemo((): string[] => {
    const query = location().searchStr.replace(/^\?/, "");
    if (query === "") return [];
    return [new URLSearchParams(query).get("tab") ?? "profit-loss"];
  });
  return (
    <For each={asked()} fallback={<ReportsIndex />}>
      {() => <StatementPage />}
    </For>
  );
}

/** The list: Statements, Detail and Tax time. One link a row; nothing else is on the page. */
function ReportsIndex() {
  const ui = useUi();
  const t = () => ui.messages.reports;
  const carried = lastChoices(STATEMENT_CHOICES);
  const statement = (tab: ReportTab) => `/reports?tab=${tab}${carried ? `&${carried}` : ""}`;
  const carriedTax = lastChoices(TAX_CHOICES);
  const tax = (tab: string) => `/tax?tab=${tab}${carriedTax ? `&${carriedTax}` : ""}`;
  const groups = () => [
    {
      id: "statements",
      label: t().index.statements,
      entries: [
        { href: statement("profit-loss"), label: t().statements.profitLoss },
        { href: statement("balance-sheet"), label: t().statements.balanceSheet },
        { href: statement("cash-flow"), label: t().statements.cashFlow },
      ],
    },
    {
      id: "detail",
      label: t().index.detail,
      entries: [
        { href: statement("trial-balance"), label: t().statements.trialBalance },
        { href: statement("general-ledger"), label: t().statements.generalLedger },
        { href: "/reports/payees", label: t().index.byPayee },
      ],
    },
    {
      id: "tax",
      label: t().index.taxTime,
      entries: [
        { href: tax("worksheet"), label: t().index.taxWorksheet },
        { href: tax("pack"), label: t().index.yearEndPack },
        { href: tax("vendors"), label: t().index.vendors },
        { href: tax("sales"), label: t().index.salesTax },
        { href: tax("accountant"), label: t().index.accountantPack },
      ],
    },
  ];
  return (
    <section class="app-reports" aria-labelledby="reports-title">
      <PageHeader titleId="reports-title" title={t().page.title} />
      <div class="rt-report-index">
        <For each={groups()}>
          {(group) => (
            <section aria-labelledby={`reports-${group.id}`}>
              <h2 id={`reports-${group.id}`} class="rt-report-index-title">
                {group.label}
              </h2>
              <IndexList
                label={group.label}
                entries={group.entries}
                link={(props) => (
                  <AppLink class={props.class} href={props.href}>
                    {props.children}
                  </AppLink>
                )}
              />
            </section>
          )}
        </For>
      </div>
    </section>
  );
}

function StatementPage() {
  // What the address asked for is what the next statement opens with, from the moment the page opens:
  // going back to the list before the figures arrive must not lose the dates.
  keepChoices(STATEMENT_CHOICES, window.location.search.replace(/^\?/, ""), [
    "tab",
    "page",
    "revision",
    "zero",
  ]);
  const ui = useUi();
  const t = () => ui.messages.reports;
  const client = new BrowserApplicationClient(window.localStorage);
  const today = localToday();

  // Every read here is a loader, not a resource: see loader.ts for why a read may never suspend.
  const calendar = createLoader(() => client.read("reports.calendar", {}));
  const book = createLoader(() =>
    client.read("book.get", {}).then((context) => context.setup?.name ?? null),
  );
  const years = () => calendar.value()?.fiscalYears ?? [];
  /** The book's fiscal years and today: every period the date range offers is worked out from them. */
  const fiscal = createMemo((): ReportCalendar => ({ years: years(), today }));

  const [ready, setReady] = createSignal(false);
  const [state, setState] = createSignal<ReportScreenState>(defaultState());
  const [notice, setNotice] = createSignal<string | undefined>();
  const [stale, setStale] = createSignal(false);
  createEffect(() => {
    const loaded = calendar.value();
    if (!loaded || ready()) return;
    const parsed = parseState(window.location.search, { years: loaded.fiscalYears, today });
    setState(parsed.state);
    setNotice(parsed.notice);
    setReady(true);
  });
  // The address follows the screen, so a reload, a link and the back button agree with it.
  createEffect(() => {
    if (!ready()) return;
    const query = serializeState(state());
    // What the next statement opens with: the dates, the comparison, months in columns and the share of
    // income, written as the profit and loss writes them (it can show every one of them), whichever
    // statement is on screen.
    keepChoices(
      STATEMENT_CHOICES,
      serializeState({
        ...state(),
        tab: "profit-loss",
        page: 1,
        showZero: false,
        revision: undefined,
      }),
      ["tab"],
    );
    const next = `${window.location.pathname}${query ? `?${query}` : ""}`;
    if (next !== `${window.location.pathname}${window.location.search}`)
      window.history.replaceState(window.history.state, "", next);
  });
  const update = (patch: Partial<ReportScreenState>) => {
    setStale(false);
    setState((current) => ({ ...current, ...patch }));
  };
  /** Months in columns turn the comparison off: the columns already set the months side by side. They turn
   * the share of income off too: a share for each month would double the columns. */
  const onBy = (by: ReportColumns) =>
    update({
      by,
      page: 1,
      ...(by === "month" ? { compare: "none" as CompareChoice, share: "none" as const } : {}),
    });

  /** The share of income takes the months out of the columns, for the same reason. */
  const onShare = (on: boolean) =>
    update(on ? { share: "income", by: "total", page: 1 } : { share: "none" });

  /** The inputs every statement shares, or nothing while the dates are not usable: a half-typed date, a
   * range the wrong way round or one outside the book's calendar is named by the date range itself and
   * nothing is requested for it. */
  const base = createMemo(() => {
    if (!ready()) return undefined;
    const current = state();
    if (!isUsableRange(current.range, fiscal())) return undefined;
    return {
      asOf: current.range.to,
      from: current.range.from,
      ...(current.revision !== undefined ? { revision: current.revision } : {}),
    };
  });
  const withComparison = () => (state().compare === "none" ? {} : { compare: state().compare });
  /** The profit and loss with each amount's share of total income. The three statements of one population
   * share one read, so every statement of the page asks for it while it is chosen; only the profit and loss
   * has shares, and the others carry none. */
  const withShare = () => (state().share === "income" ? { share: "income" as const } : {});

  // A memo: the statement is drawn again only when it is another statement, never when its dates change.
  const tab = createMemo(() => state().tab);
  /** Months in columns: only the statements that have months, and never together with a comparison. */
  const byMonth = () => canBeByMonth(tab()) && state().by === "month";
  const monthCount = createMemo(() => {
    const shared = base();
    return shared ? monthWindows({ from: shared.from, to: shared.asOf }).length : 0;
  });
  const tooManyMonths = () => monthCount() > MAX_MONTH_COLUMNS;
  const coreInput = whileActive(
    () => CORE_TABS.includes(tab()) && !byMonth(),
    (): ApplicationInputs["reports.get"] | undefined => {
      const shared = base();
      return shared && { ...shared, ...withComparison(), ...withShare() };
    },
  );
  // By month is the whole range once and then each month, all at one book revision (see monthly.ts).
  const monthlyInput = whileActive(
    () => byMonth(),
    (): MonthlyInput | undefined => (monthCount() > 0 && !tooManyMonths() ? base() : undefined),
  );
  const monthly = createKeyedLoader(monthlyInput, (input) =>
    readMonthly((request) => client.read("reports.get", request), input),
  );
  const flowInput = whileActive(
    () => tab() === "cash-flow",
    (): ApplicationInputs["reports.cashFlow"] | undefined => {
      const shared = base();
      return shared && { ...shared, ...withComparison() };
    },
  );
  const ledgerInput = whileActive(
    () => tab() === "general-ledger",
    (): ApplicationInputs["reports.generalLedger"] | undefined => {
      const shared = base();
      return shared && { ...shared, page: state().page };
    },
  );
  const core = createKeyedLoader(coreInput, (input) => client.read("reports.get", input));
  const flow = createKeyedLoader(flowInput, (input) => client.read("reports.cashFlow", input));
  const ledger = createKeyedLoader(ledgerInput, (input) =>
    client.read("reports.generalLedger", input),
  );
  const reloadAll = () => {
    setStale(false);
    // A person asked to read the report again: from the service, not from what the page holds.
    void calendar.refresh();
    void core.refresh();
    void monthly.refresh();
    void flow.refresh();
    void ledger.refresh();
  };
  /** The button that offers this is gone once it is pressed, and a person at the keyboard must not be
   * left with no focus: it goes to the page's title, under which the statement is read again in place. */
  let heading: HTMLHeadingElement | undefined;
  const readAgain = () => {
    reloadAll();
    queueMicrotask(() => heading?.focus());
  };

  /** Where an amount leads: the activity behind it, in the population its own column was read from.
   * No revision is added; if the book moves before the click, the page says so and offers the report
   * again. `back` returns to this exact screen: it is worked out from the screen's state, so a choice
   * made after the figures arrived (accounts with no activity shown) is in it. */
  const back = () => {
    const query = serializeState(state());
    return `${window.location.pathname}${query ? `?${query}` : ""}`;
  };
  const hrefsFor = (scope: {
    asOf: string;
    periodStart: string;
    yearStart: string;
    populationHash: string;
    comparison: { asOf: string; periodStart: string; populationHash: string } | null;
  }): ReportHrefs => {
    const column = (which: "current" | "comparison") =>
      which === "comparison" && scope.comparison
        ? {
            asOf: scope.comparison.asOf,
            start: scope.comparison.periodStart,
            hash: scope.comparison.populationHash,
            yearStart:
              yearContaining(years(), scope.comparison.asOf)?.startsOn ??
              scope.comparison.periodStart,
          }
        : {
            asOf: scope.asOf,
            start: scope.periodStart,
            hash: scope.populationHash,
            yearStart: scope.yearStart,
          };
    const pin = state().revision;
    return {
      account: (accountId, span, which) => {
        const c = column(which);
        const query = new URLSearchParams({
          accountId,
          asOf: c.asOf,
          population: c.hash,
          reportFrom: c.start,
          from: span === "range" ? c.start : c.yearStart,
          to: c.asOf,
          back: back(),
        });
        if (pin !== undefined) query.set("revision", pin);
        return `/ledger?${query.toString()}`;
      },
      entry: (journalId) => {
        const c = column("current");
        const query = new URLSearchParams({
          asOf: c.asOf,
          population: c.hash,
          reportFrom: c.start,
        });
        if (pin !== undefined) query.set("revision", pin);
        return `/journal/${encodeURIComponent(journalId)}?${query.toString()}`;
      },
      tagAccounts: "/accounts",
    };
  };
  // What a link needs of a report is what every column of a by-month report has too.
  const coreHrefs = (
    data: Pick<Core, "asOf" | "periodStart" | "fiscalYear" | "populationHash" | "comparison">,
  ) =>
    hrefsFor({
      asOf: data.asOf,
      periodStart: data.periodStart,
      yearStart: data.fiscalYear.startsOn,
      populationHash: data.populationHash,
      comparison: data.comparison,
    });
  const flowHrefs = (data: CashFlow) =>
    hrefsFor({
      asOf: data.asOf,
      periodStart: data.periodStart,
      yearStart: data.fiscalYear.startsOn,
      populationHash: data.ledgerPopulationHash,
      comparison: data.comparison,
    });
  const ledgerHrefs = (data: Ledger) =>
    hrefsFor({
      asOf: data.asOf,
      periodStart: data.periodStart,
      yearStart: data.fiscalYear.startsOn,
      populationHash: data.populationHash,
      comparison: null,
    });

  const [exporting, setExporting] = createSignal(false);
  const [message, setMessage] = createSignal("");
  /** The population on screen for the statement being shown: what a downloaded file must match. */
  const shownPopulation = (): string | undefined =>
    tab() === "cash-flow"
      ? onScreen(flow)?.populationHash
      : tab() === "general-ledger"
        ? onScreen(ledger)?.populationHash
        : onScreen(core)?.populationHash;
  const downloadCsv = async () => {
    const shared = base();
    if (!shared || exporting()) return;
    if (byMonth()) {
      // The months are several reads laid side by side and no single service file says so: the file is
      // made from exactly the figures on screen, which are the service's own.
      const reports = onScreen(monthly);
      if (!reports) return;
      const file = monthlyCsv({
        statement: tab() === "balance-sheet" ? "balance-sheet" : "profit-loss",
        bookName: book.value() ?? "",
        reports,
      });
      saveFile(file.filename, file.mediaType, file.content);
      setMessage(t().actions.exported(file.filename));
      return;
    }
    setExporting(true);
    setMessage(t().actions.exporting);
    try {
      const compared =
        tab() === "trial-balance" || tab() === "general-ledger" ? {} : withComparison();
      const input: ApplicationInputs["reports.export"] = {
        statement: tab(),
        ...shared,
        ...compared,
        // Only the profit and loss has a share of income, and the service refuses it for any other file.
        ...(tab() === "profit-loss" ? withShare() : {}),
        // The cash flow reads account tags; naming the revision shown reproduces what is on screen.
        ...(tab() === "cash-flow" && onScreen(flow)
          ? { tagsRevision: (onScreen(flow) as CashFlow).tagsRevision }
          : {}),
      };
      const file = await client.read("reports.export", input);
      saveFile(file.filename, file.mediaType, file.content);
      const shown = shownPopulation();
      if (shown !== undefined && file.populationHash !== shown) {
        // The file is the book as it is now, and the screen is older: say so rather than let the two
        // be taken for one another.
        setStale(true);
        setMessage(
          `${t().actions.exported(file.filename)} The book has changed since this report was read, so the file is newer than the screen.`,
        );
      } else setMessage(t().actions.exported(file.filename));
    } catch (error) {
      setMessage(
        `${t().actions.exportFailed}${error instanceof ApplicationRequestError ? ` ${error.message}` : ""}`,
      );
    } finally {
      setExporting(false);
    }
  };

  // Each view is given the figures as a getter, so a new read updates it in place; the pager, the
  // tabs and whatever has focus are never rebuilt.
  const statement = (value: ReportTab): JSX.Element => (
    <Switch>
      <Match when={value === "cash-flow"}>
        <Loaded loader={flow} what={t().statements.cashFlow}>
          {(data) => (
            <CashFlowView
              data={data()}
              hrefs={flowHrefs(data())}
              bookName={book.value() ?? undefined}
            />
          )}
        </Loaded>
      </Match>
      <Match when={value === "general-ledger"}>
        <Loaded loader={ledger} what={t().statements.generalLedger}>
          {(data) => (
            <GeneralLedgerView
              data={data()}
              hrefs={ledgerHrefs(data())}
              bookName={book.value() ?? undefined}
              onPage={(page) => update({ page })}
            />
          )}
        </Loaded>
      </Match>
      <Match when={value === "profit-loss" && byMonth()}>
        <MonthlyStatement>
          <Loaded loader={monthly} what={t().monthly.loading}>
            {(data) => (
              <ProfitLossMonthlyView
                reports={data()}
                hrefsFor={coreHrefs}
                bookName={book.value() ?? undefined}
                showZero={state().showZero}
              />
            )}
          </Loaded>
        </MonthlyStatement>
      </Match>
      <Match when={value === "balance-sheet" && byMonth()}>
        <MonthlyStatement>
          <Loaded loader={monthly} what={t().monthly.loading}>
            {(data) => (
              <BalanceSheetMonthlyView
                reports={data()}
                hrefsFor={coreHrefs}
                bookName={book.value() ?? undefined}
                showZero={state().showZero}
              />
            )}
          </Loaded>
        </MonthlyStatement>
      </Match>
      <Match when={value === "profit-loss"}>
        <Loaded loader={core} what={t().statements.profitLoss}>
          {(data) => (
            <ProfitLossView
              data={data()}
              hrefs={coreHrefs(data())}
              bookName={book.value() ?? undefined}
              showZero={state().showZero}
            />
          )}
        </Loaded>
      </Match>
      <Match when={value === "balance-sheet"}>
        <Loaded loader={core} what={t().statements.balanceSheet}>
          {(data) => (
            <BalanceSheetView
              data={data()}
              hrefs={coreHrefs(data())}
              bookName={book.value() ?? undefined}
              showZero={state().showZero}
            />
          )}
        </Loaded>
      </Match>
      <Match when={value === "trial-balance"}>
        <Loaded loader={core} what={t().statements.trialBalance}>
          {(data) => (
            <TrialBalanceView
              data={data()}
              hrefs={coreHrefs(data())}
              bookName={book.value() ?? undefined}
              showZero={state().showZero}
            />
          )}
        </Loaded>
      </Match>
    </Switch>
  );

  /** A report by month: said plainly when the range has more months than a page can hold, and
   * otherwise the months, read at one book revision. */
  const MonthlyStatement = (props: { children: JSX.Element }) => (
    <Show
      when={!tooManyMonths()}
      fallback={
        <Notice title={t().monthly.tooManyTitle} tone="info" role="status">
          <p>{t().monthly.tooMany(MAX_MONTH_COLUMNS)}</p>
        </Notice>
      }
    >
      {props.children}
    </Show>
  );

  const tabLabel = (value: ReportTab): string =>
    t().statements[
      {
        "profit-loss": "profitLoss",
        "balance-sheet": "balanceSheet",
        "cash-flow": "cashFlow",
        "trial-balance": "trialBalance",
        "general-ledger": "generalLedger",
      }[value] as keyof ReturnType<typeof t>["statements"]
    ];
  const compareNote = () => {
    const shared = base();
    if (state().compare === "none" || !shared) return undefined;
    // The last figures read, not `shown`: the note sits in the picker, and a line that vanished for
    // every read would move the controls under a person's hand.
    const data = tab() === "cash-flow" ? flow.value() : core.value();
    return data?.comparison === null && (data?.warnings.length ?? 0) > 0
      ? t().compare.unavailable
      : undefined;
  };
  /** Said politely when a statement arrives, for people who cannot see it appear. */
  const announcement = () => {
    const shared = base();
    if (!shared || shownPopulation() === undefined) return "";
    // A person who cannot see a column appear is told that the statement now has it.
    const shares =
      tab() === "profit-loss" && state().share === "income" ? `, ${t().share.announce}` : "";
    return `${tabLabel(tab())}, ${describeRange({ from: shared.from, to: shared.asOf })}${shares}.`;
  };

  return (
    <section class="app-reports">
      <PageHeader
        titleId="reports-title"
        titleRef={(element) => {
          heading = element;
        }}
        title={tabLabel(tab())}
      />
      <Loading
        ready={calendar.value() !== undefined || calendar.error() !== undefined}
        shape="report"
        label={t().views.loadingBook}
      >
        <Show
          when={calendar.error() === undefined}
          fallback={<Failure error={calendar.error()} retry={reloadAll} />}
        >
          <Show when={ready()}>
            <Show when={notice()}>
              <p class="rt-hint" role="status">
                {notice()}
              </p>
            </Show>
            <Show when={state().revision}>
              <p class="rt-hint">{t().pinned}</p>
            </Show>
            <div class="rt-report-page">
              <ReportControls
                calendar={fiscal()}
                range={state().range}
                onRange={(range: DateRangeValue) => update({ range, page: 1 })}
                compare={state().compare}
                onCompare={(compare: CompareChoice) => update({ compare })}
                canCompare={canBeCompared(tab())}
                compareNote={compareNote()}
                by={state().by}
                onBy={onBy}
                canBeByMonth={canBeByMonth(tab())}
                share={state().share === "income"}
                onShare={onShare}
                canShare={canShare(tab())}
                canShowEmpty={canShowEmpty(tab())}
                showEmpty={state().showZero}
                onShowEmpty={(showZero: boolean) => update({ showZero })}
              >
                <Show when={message()}>
                  {/* Said to a screen reader by the live region below; this is for the eye. */}
                  <span class="rt-hint rt-report-message" aria-hidden="true">
                    {message()}
                  </span>
                </Show>
                <ExportMenu
                  label={t().toolbar.export}
                  disabled={!base()}
                  actions={[
                    {
                      id: "csv",
                      label: t().actions.exportCsv,
                      disabled: exporting() || (byMonth() && !monthly.value()),
                      onSelect: () => void downloadCsv(),
                    },
                    {
                      id: "print",
                      label: t().actions.print,
                      onSelect: () => window.print(),
                    },
                  ]}
                />
              </ReportControls>
              <Show when={stale()}>
                <ReportState state="stale" onRetry={readAgain} />
              </Show>
              <Show when={base()} fallback={<p class="rt-hint">{t().period.chooseDates}</p>}>
                {statement(tab())}
              </Show>
            </div>
            <p class="rt-sr-only" role="status" aria-live="polite">
              {announcement()}
            </p>
            <p class="rt-sr-only" role="status" aria-live="polite">
              {message()}
            </p>
          </Show>
        </Show>
      </Loading>
    </section>
  );
}
