import type { PeriodList } from "@rastrata/application/client-contracts";
import {
  buttonAttrs,
  Button,
  CALENDAR_CLOSE_YEAR_ID,
  CALENDAR_YEAR_TITLE_ID,
  calendarActionId,
  type CalendarPeriod as PeriodView,
  CalendarRetainedWrite,
  calendarWords as words,
  CloseCalendar,
  CloseCard,
  ClosedMonths,
  closedMonths,
  closedThrough,
  CloseLead,
  closeLeft,
  type CloseLinks,
  closeLook,
  closeNotes,
  closeReady,
  closeTargets,
  closeThrough,
  closeWords,
  CloseYear,
  defaultCalendarYear,
  formatDate,
  monthRange,
  type NoteLinks,
  Notice,
  PageHeader,
  PageSkeleton,
  PeriodChangePanel,
  unitOf,
  useToast,
} from "@rastrata/ui";
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { ApplicationRequestError, BrowserApplicationClient } from "../application-client";
import { capabilities } from "../capabilities";
import { createLoader } from "../loader";
import { availableRoutes } from "../nav";
import { type ChecklistRead, createChecklists } from "./accounting/checklists";
import { closeRun } from "./accounting/close-run";
import { createChangeController } from "./calendar/change";
import { nameOf, toCalendar, toHistory, toPeriod, toYears } from "./calendar/convert";
import { locationSearch, parseLocation } from "./calendar/location";
import { retainedYearEnd } from "./calendar/year-end";
import { YearEndSection } from "./calendar/year-end-section";
import { lanes } from "./registry";

/** The line that says how far the books are closed: where the cursor goes after a close or a reopening. */
const CLOSE_THROUGH_ID = "rt-close-through";
/** The card's button. */
const CLOSE_BUTTON_ID = "rt-close-button";

const notConfigured = (cause: unknown): boolean =>
  cause instanceof ApplicationRequestError && cause.code === "book_not_configured";

/** Where each thing that is left is done, for the screens this version has. */
function leftLinks(): CloseLinks {
  const routes = availableRoutes(
    lanes.flatMap((lane) => lane.routes),
    capabilities(),
  ).map((route) => route.path);
  const first = (...paths: string[]) => paths.find((path) => routes.includes(path));
  return {
    reconcile: (accountId) => `/reconcile?account=${encodeURIComponent(accountId)}`,
    inbox: first("/inbox"),
    opening: first("/opening"),
    stripe: first("/settings/stripe", "/stripe"),
    backups: first("/settings/backups", "/settings/backup", "/backups"),
  };
}

/** Where the transactions behind a note are listed: Transactions, with the account and the month already
 * chosen. Transactions is one of the application's own screens, so it is always there. */
const noteLinks: NoteLinks = {
  transactions: (account, from, to) =>
    `/journal?${new URLSearchParams({ accountId: account.id, from, to }).toString()}`,
};

/** Whether a month's checklist was read and says the month can close. */
const passes = (read: ChecklistRead): boolean => read.state === "ready" && closeReady(read.view);

/** Close the books: how far they are closed, one card for the months that can be closed now (what is left,
 * each with its button, and "Close through October 2026"), and three folds under it: the year, the closed
 * months with Reopen, and the calendar with its history. Months before the books began, months still under
 * way and months nothing was recorded in are not listed: there is nothing to do about them. */
export function PeriodsPage() {
  const w = closeWords;
  const toast = useToast();
  const client = new BrowserApplicationClient(window.localStorage);
  const list = createLoader(() => client.read("periods.list", {}));
  // What the person may do: one who may not close sees how far the books are closed and what is left, and
  // is not offered a button that would be refused. Until it is read, nothing is held back.
  const book = createLoader(() => client.read("book.get", {}));
  const mayClose = () => book.value()?.permissions.includes("close") ?? true;
  const start = parseLocation(window.location.search);
  // A year-end write that was sent and never answered opens the guided flow, where it is resumed.
  const waiting = retainedYearEnd(client);
  const [chosen, setChosen] = createSignal<number | undefined>(waiting?.year ?? start.year);
  const [yearEnd, setYearEnd] = createSignal(start.yearEnd || waiting !== null);
  const [yearEndWaiting, setYearEndWaiting] = createSignal(false);
  /** The year's fold as the person left it; until they touch it, it is open when the year needs them. */
  const [yearFold, setYearFold] = createSignal<boolean | undefined>(
    start.year !== undefined ? true : undefined,
  );
  /** Where the cursor goes once the write that was just committed has finished. */
  const [focusAfter, setFocusAfter] = createSignal<string | undefined>(undefined);
  /** The months are being closed, one after the other; it reports once, at the end. */
  const [running, setRunning] = createSignal(false);
  /** How a close ended short: which month would not close, and that the ones before it stayed closed. */
  const [stopped, setStopped] = createSignal<string | null>(null);

  const changes = createChangeController({
    list: list.value,
    reload: async () => {
      await list.reload();
      checklists.forgetAll();
    },
    committed: (text, done) => {
      // A run says what it did once it is over, not once per month.
      if (running()) return;
      // Say what was done in the month's own name, and put the cursor on the line that now says how far the
      // books are closed.
      const current = list.value();
      const period =
        done?.kind === "period" && current ? toPeriod(current, done.periodId) : undefined;
      const message = period
        ? done?.kind === "period" && done.operation === "close"
          ? w.closing.done(nameOf(period))
          : w.closing.reopened(nameOf(period))
        : text;
      toast.show({ message });
      // The buttons are off while the write is being finished, so the cursor moves when it is.
      setFocusAfter(CLOSE_THROUGH_ID);
    },
  });
  createEffect(() => {
    const id = focusAfter();
    if (id === undefined || changes.blocked()) return;
    setFocusAfter(undefined);
    queueMicrotask(() => document.getElementById(id)?.focus());
  });
  const checklists = createChecklists(client);

  // A page the browser brings back from its memory (Back, after reconciling) shows what it read before:
  // read the books again, so what is left is what is left now.
  onMount(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (!event.persisted || changes.blocked() || running()) return;
      checklists.forgetAll();
      void list.reload();
    };
    window.addEventListener("pageshow", onShow);
    onCleanup(() => window.removeEventListener("pageshow", onShow));
  });

  /** Every period of the book, as the components show it. */
  const periods = createMemo((): PeriodView[] => {
    const current = list.value();
    return current
      ? current.periods
          .map((period) => toPeriod(current, period.id))
          .filter((period): period is PeriodView => period !== undefined)
      : [];
  });
  const today = () => list.value()?.calendar.today ?? "";
  const closed = createMemo(() => closedMonths(periods()));
  const through = createMemo(() => closedThrough(periods()));
  const links = leftLinks();
  const unit = () => unitOf(list.value()?.calendar.periodModel);

  // The card is about one month. When the latest ended month with something in it can be closed, it is
  // that one, and one press closes everything up to it. When it cannot, the card is about the earliest
  // (the month Home names), with what is left for it: months close in order, so that is the one to deal
  // with. The latest is read first; the earliest only when the latest is not ready.
  const targets = createMemo(() => closeTargets(periods(), today()));
  createEffect(() => {
    // While the months are being closed each one is read as it is closed; the card's own read waits.
    if (running()) return;
    const { first, last } = targets();
    if (!first || !last) return;
    checklists.ensure(last.id);
    const read = checklists.read(last.id);
    if (
      first.id !== last.id &&
      (read.state === "failed" || (read.state === "ready" && !passes(read)))
    )
      checklists.ensure(first.id);
  });
  type Card = { readonly period: PeriodView; readonly read: ChecklistRead };
  const card = createMemo((previous: Card | null): Card | null => {
    // While the months are being closed the card stays as it was pressed: each month is read and closed
    // behind it, and it is drawn again once, when the run is over.
    if (running() && previous) return previous;
    const { first, last } = targets();
    if (!first || !last) return null;
    const latest = checklists.read(last.id);
    if (first.id === last.id || passes(latest)) return { period: last, read: latest };
    if (latest.state === "idle" || latest.state === "checking")
      return { period: first, read: { state: "checking" } };
    return { period: first, read: checklists.read(first.id) };
  }, null);
  const cardState = () => {
    const state = card()?.read.state;
    return state === "ready" || state === "failed" ? state : "checking";
  };
  /** What the card says of its month, once the month's checklist has been read. */
  const cardFacts = createMemo(() => {
    const read = card()?.read;
    return read?.state === "ready"
      ? {
          left: closeLeft(read.view, links),
          look: closeLook(read.view),
          notes: closeNotes(read.view, noteLinks),
        }
      : { left: [], look: [], notes: [] };
  });
  /** Read again what the card is about, after a read that failed. */
  const retry = () => {
    const { first, last } = targets();
    if (first && first.id !== last?.id) checklists.forget(first.id);
    if (last) checklists.refresh(last.id);
  };

  /** Close through the card's month: each open month up to it is checked afresh and closed the way an agent
   * or the command line closes one, oldest first. It stops at the first month that cannot close and says
   * which; the months before it stay closed, and the card then shows what is left for that month. */
  const closeNow = async () => {
    const target = card()?.period;
    if (!target || changes.blocked() || running() || !mayClose()) return;
    const months = closeThrough(periods(), today(), target.id);
    if (months.length === 0) return;
    const names = new Map(months.map((period) => [period.id, nameOf(period)]));
    setStopped(null);
    setRunning(true);
    try {
      const result = await closeRun(
        months.map((period) => period.id),
        {
          ready: async (id) => passes(await checklists.load(id)),
          close: async (id) => {
            await changes.closeNow(id, w.closing.reasonPrefill(names.get(id) ?? id));
            // Committed: nothing is left in hand. A plan with something to read, a refusal or a lost request
            // leaves the change open or an error, and the run stops there.
            return changes.change() === null && !changes.error();
          },
        },
      );
      const closedNames = result.closed.map((id) => names.get(id) ?? id);
      const first = closedNames[0];
      const last = closedNames[closedNames.length - 1];
      const closedRange = first && last ? monthRange(first, last) : null;
      if (result.stoppedAt === null) {
        if (closedRange)
          toast.show({
            message:
              closedNames.length === 1
                ? w.closing.done(closedRange)
                : w.closing.doneRun(closedRange),
          });
        setFocusAfter(CLOSE_THROUGH_ID);
      } else if (changes.change() === null) {
        // A close that is waiting for its review says so itself, in the card; anything else is said here.
        setStopped(
          w.closing.stoppedAt(names.get(result.stoppedAt) ?? result.stoppedAt, closedRange),
        );
      }
    } finally {
      setRunning(false);
    }
  };

  // The address says which year is on show and whether the year-end is open, so a reload or a shared link
  // comes back to the same place.
  createEffect(
    on([chosen, yearEnd], ([wanted, open]) => {
      const next = `${window.location.pathname}${locationSearch({ year: wanted, yearEnd: open })}`;
      if (next !== `${window.location.pathname}${window.location.search}`)
        window.history.replaceState(window.history.state, "", next);
    }),
  );
  /** The fiscal year in the fold: the one asked for when the book has it, otherwise the one that most
   * needs attention. */
  const year = createMemo(() => {
    const current = list.value();
    if (!current) return undefined;
    const years = toYears(current);
    const wanted = chosen();
    return wanted !== undefined && years.some((item) => item.fiscalYear === wanted)
      ? wanted
      : defaultCalendarYear(years);
  });
  const yearView = createMemo(() => {
    const current = list.value();
    const shown = year();
    return current && shown !== undefined
      ? toYears(current).find((item) => item.fiscalYear === shown)
      : undefined;
  });
  /** The year has ended and something in it is left to close: its fold is open without being asked. */
  const yearNeeds = () => {
    const shown = yearView();
    if (!shown?.ended || shown.beforeBooks) return false;
    return shown.closedCount < shown.periodCount || shown.supersededCount > 0;
  };
  const openYearEnd = () => {
    setChosen(year());
    setYearEnd(true);
  };
  const closeYearEnd = () => {
    setYearEnd(false);
    setYearFold(true);
    setYearEndWaiting(retainedYearEnd(client) !== null);
    queueMicrotask(() => {
      const button = document.getElementById(CALENDAR_CLOSE_YEAR_ID);
      const target =
        button && !button.hasAttribute("disabled")
          ? button
          : document.getElementById(CALENDAR_YEAR_TITLE_ID);
      target?.focus();
    });
  };

  const focusLater = (id: string) => queueMicrotask(() => document.getElementById(id)?.focus());
  /** Leave a review, and put focus back on the button that opened it. */
  const cancelChange = () => {
    const open = changes.change();
    changes.cancel();
    focusLater(
      open?.operation === "close"
        ? CLOSE_BUTTON_ID
        : open
          ? calendarActionId(open.periodId)
          : CLOSE_THROUGH_ID,
    );
  };
  const periodChange = createMemo(() => {
    const open = changes.change();
    return open?.kind === "period" ? open : null;
  });
  /** The review of one change. A close is shown only when there is something to read (a warning or a
   * problem), since a clean one is committed from the same press. */
  const panel = (operation: "close" | "reopen") => (
    <Show
      when={
        periodChange()?.operation === operation &&
        (operation === "reopen" || changes.stage() === "review")
      }
    >
      <Show when={changes.period()}>
        {(period) => (
          <PeriodChangePanel
            operation={operation}
            period={period()}
            reason={changes.reason()}
            onReason={changes.setReason}
            reasonError={changes.reasonError()}
            attempt={changes.attempt()}
            stage={changes.stage()}
            plan={changes.plan()}
            current={changes.current()}
            busy={changes.busy()}
            blocked={changes.blocked()}
            onPrepare={() => void changes.prepare()}
            onCommit={() => void changes.commit()}
            onCancel={cancelChange}
            {...(operation === "close" ? { submitLabel: words.changeClose(nameOf(period())) } : {})}
          />
        )}
      </Show>
    </Show>
  );

  return (
    <section class="app-periods rt-acct-page" aria-labelledby="periods-title">
      <PageHeader titleId="periods-title" title={w.title} />
      <Show
        when={list.value()}
        fallback={
          <Show
            when={list.error() !== undefined}
            fallback={<PageSkeleton shape="table" label={w.loading()} />}
          >
            <Show
              when={!notConfigured(list.error())}
              fallback={
                <Notice title={w.noBookTitle}>
                  <p>{w.noBookBody}</p>
                  <p>
                    <a {...buttonAttrs({ variant: "secondary", size: "sm" })} href="/">
                      Go to Home
                    </a>
                  </p>
                </Notice>
              }
            >
              <Notice title={w.failedTitle} tone="problem" role="alert">
                <p>{w.failedBody()}</p>
                <Button label={w.retry} variant="secondary" onClick={() => void list.reload()} />
              </Notice>
            </Show>
          </Show>
        }
      >
        {(current) => (
          <Show
            when={yearEnd() && year() !== undefined ? year() : undefined}
            fallback={
              <div class="rt-close-page">
                <Show when={list.error() !== undefined}>
                  <Notice title={words.staleTitle} tone="attention" role="status">
                    <p>{words.staleBody}</p>
                    <Button
                      label={w.retry}
                      variant="secondary"
                      onClick={() => void list.reload()}
                    />
                  </Notice>
                </Show>
                <Show when={yearEndWaiting()}>
                  <Notice title={words.uncertainTitle} tone="attention" role="status">
                    <p>{words.yearEndWaiting}</p>
                    <Button
                      label={words.yearEndOpenRetained}
                      variant="secondary"
                      onClick={openYearEnd}
                    />
                  </Notice>
                </Show>
                <Show when={changes.retained()}>
                  <CalendarRetainedWrite
                    busy={changes.working()}
                    onResume={() => void changes.resume()}
                  />
                </Show>
                <Show when={changes.error()}>
                  {(message) => (
                    <Notice title={words.requestFailedTitle} tone="problem" role="alert">
                      <p>{message()}</p>
                    </Notice>
                  )}
                </Show>
                <CloseLead
                  id={CLOSE_THROUGH_ID}
                  through={through().through ? formatDate(through().through as string) : null}
                  hasWork={card() !== null}
                  unit={unit()}
                />
                <Show when={card()}>
                  {(shown) => (
                    <CloseCard
                      label={nameOf(shown().period)}
                      state={cardState()}
                      left={cardFacts().left}
                      look={cardFacts().look}
                      notes={cardFacts().notes}
                      closing={running()}
                      blocked={changes.blocked() || running()}
                      mayClose={mayClose()}
                      stopped={stopped()}
                      buttonId={CLOSE_BUTTON_ID}
                      onClose={() => void closeNow()}
                      onRetry={retry}
                      panel={panel("close")}
                      unit={unit()}
                    />
                  )}
                </Show>
                <div class="rt-close-folds">
                  <Show when={yearView()}>
                    {(shown) => (
                      <CloseYear
                        year={shown()}
                        years={toYears(current())}
                        onYear={setChosen}
                        booksBegan={current().calendar.booksBegan}
                        blocked={changes.blocked() || running()}
                        main={card() === null}
                        mayClose={mayClose()}
                        open={yearFold() ?? yearNeeds()}
                        onOpenChange={setYearFold}
                        onCloseYear={openYearEnd}
                      />
                    )}
                  </Show>
                  <ClosedMonths
                    months={closed().map((period) => ({
                      id: period.id,
                      label: nameOf(period),
                      superseded: period.closeSuperseded,
                      reportHref: period.closingReportHref,
                    }))}
                    blocked={changes.blocked() || running()}
                    mayReopen={mayClose()}
                    onReopen={(id) =>
                      changes.begin({ kind: "period", periodId: id, operation: "reopen" })
                    }
                    panel={panel("reopen")}
                    unit={unit()}
                  />
                  <CloseCalendar calendar={toCalendar(current())} history={toHistory(current())} />
                </div>
              </div>
            }
          >
            {(shown) => (
              <>
                <Show when={changes.retained()}>
                  <CalendarRetainedWrite
                    busy={changes.working()}
                    onResume={() => void changes.resume()}
                  />
                </Show>
                <YearEndSection
                  client={client}
                  list={current() as PeriodList}
                  fiscalYear={shown()}
                  onYear={setChosen}
                  onChanged={() => list.reload()}
                  onBack={closeYearEnd}
                />
              </>
            )}
          </Show>
        )}
      </Show>
    </section>
  );
}
