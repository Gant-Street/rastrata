import type { BookContext, BookSetup } from "@rastrata/application/client-contracts";
import {
  Button,
  formatWeekdayDate,
  HomeStart,
  homeWords,
  localToday,
  MoneyInOut,
  NeedsYou,
  Notice,
  PageHeader,
  PageSkeleton,
} from "@rastrata/ui";
import { createEffect, createMemo, createSignal, Match, onMount, Show, Switch } from "solid-js";
import { BrowserApplicationClient } from "../application-client";
import { createLoader } from "../loader";
import { fromOpening } from "../opening";
import { noteSetupPending, openWorkspace, setupPending } from "../new-book";
import { announceBook, PendingSetup, prefetchSetupChoices, SetupFlow } from "./chart/setup-flow";
import { loadHomeFacts } from "./home-facts";
import { loadMoney } from "./home-money";
import { needsYou } from "./home-needs";
import { homeStart } from "./home-start";
import { currentRole } from "../role";
import { BankTiles } from "./ingest/bank-tiles";
import { bankingSummary } from "./ingest/summary";

const readBook = () => new BrowserApplicationClient(window.localStorage).read("book.get", {});
/** The book as Home takes it: one that is not enabled is a failure of the page. */
function enabledBook(status: Awaited<ReturnType<typeof readBook>>): BookContext {
  if (!status.enabled) throw new Error("Local book mode is not enabled.");
  return status;
}

const MONEY_KEY = "rastrata:home:money";

/** Whether this browser has seen money in and out drawn for the book: its place is then held while it
 * is read again. A per-viewer convenience, so it may be unavailable (a private window, blocked storage):
 * the chart then simply arrives when it is read. What is drawn never depends on it. */
function moneySeen(workspace: string | null): boolean {
  try {
    return window.localStorage.getItem(`${MONEY_KEY}:${workspace ?? "local"}`) === "1";
  } catch {
    return false;
  }
}

function noteMoneySeen(workspace: string | null, seen: boolean): void {
  try {
    const key = `${MONEY_KEY}:${workspace ?? "local"}`;
    if (seen) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    // The chart arrives when it is read.
  }
}

/** Today: what needs a person, the money in and out, and the accounts, in that order. A book with nothing
 * in it and no bank connected yet shows one thing instead: the way to add the bank. Nothing is shown that
 * has nothing to say (no empty section), and the page says nothing about the book it is not asked to
 * act on. Every read is held in plain signals (see loader.ts), and each part says when it is still
 * reading or could not read, so a slow one never holds the rest back, suspends the page or drops focus;
 * until it is known whether the book is new, one quiet skeleton stands in, so the wrong page is never
 * shown first. */
function Today(props: { setup: BookSetup; focusTitle: boolean }) {
  const client = new BrowserApplicationClient(window.localStorage);
  const today = localToday();
  const facts = createLoader(async () =>
    loadHomeFacts(client, props.setup, today, new Date(), await currentRole()),
  );
  const money = createLoader(() => loadMoney(client, props.setup, today));
  // The accounts come from the summary the whole application shares; arriving here reads it again, whether
  // or not there is an account to show yet.
  const banking = bankingSummary();
  onMount(() => void banking.reload(2_000));
  const needs = createMemo(() => {
    const read = facts.value();
    return read ? needsYou(read) : undefined;
  });
  // Money in and out is drawn when something was recorded in its months, and always says a failure. It
  // has no empty state: a book with nothing recorded yet has no such section. While it is read, its place
  // is held only where it was drawn before, so nothing appears that then goes away.
  const workspace = openWorkspace();
  const drawnBefore = moneySeen(workspace);
  const showMoney = () =>
    money.value()?.any === true ||
    money.error() !== undefined ||
    (drawnBefore && money.value() === undefined);
  createEffect(() => {
    const read = money.value();
    if (read) noteMoneySeen(workspace, read.any);
  });
  /** The start of a new book, null for a book that is under way, undefined while that is not known. */
  const start = createMemo(() => {
    const read = facts.value();
    return read ? homeStart(read) : undefined;
  });
  const settled = () => facts.value() !== undefined || facts.error() !== undefined;
  /** Nothing says yet which page this is: the facts are not read, and the book is not one whose money
   * was drawn here before (or has just been read). */
  const reading = () => !settled() && !drawnBefore && money.value()?.any !== true;
  // The accounts are shown when there is one to show, and while a book that is under way reads them. At
  // the start of a new book every account holds nothing, so they are shown only once something is
  // connected (Stripe, with its next step or its balance): what is not connected is not a thing to look at.
  const showTiles = () =>
    start()
      ? banking
          .tiles()
          .some(
            (tile) => tile.connection !== undefined && tile.connection.state !== "not_connected",
          )
      : banking.state() !== "ready" || banking.tiles().length > 0;
  // Under the start of a new book, "Needs you" is there only when it has something to say (a connection
  // that failed, a check that could not be read).
  const showNeeds = () => {
    if (!start()) return true;
    const read = needs();
    return read !== undefined && (read.rows.length > 0 || read.unread !== null);
  };
  // A person who has just made their books lands here, and a screen reader starts at the title.
  let title: HTMLHeadingElement | undefined;
  onMount(() => {
    if (props.focusTitle) title?.focus();
  });
  return (
    <div class="rt-today" data-read={settled() ? "" : undefined}>
      <PageHeader
        size="home"
        title={homeWords.title}
        actions={
          <p class="rt-home-date">
            <time datetime={today}>{formatWeekdayDate(today)}</time>
          </p>
        }
        titleRef={(element) => {
          title = element;
        }}
      />

      <Show when={!reading()} fallback={<PageSkeleton label={homeWords.book.opening} />}>
        <Show when={start()}>{(view) => <HomeStart start={view()} />}</Show>

        <Show when={showNeeds() || showMoney()}>
          <div class="rt-home-columns">
            <Show when={showNeeds()}>
              <NeedsYou
                state={needs() || facts.error() !== undefined ? "ready" : "loading"}
                rows={needs()?.rows ?? []}
                total={needs()?.total ?? 0}
                hidden={needs()?.hidden ?? 0}
                unread={
                  needs()?.unread ??
                  (facts.error() !== undefined && !facts.value()
                    ? homeWords.needs.unread([homeWords.needs.sources.all])
                    : null)
                }
                isNew={needs()?.isNew ?? false}
                onRetry={() => void facts.reload()}
              />
            </Show>
            <Show when={showMoney()}>
              <MoneyInOut
                state={money.value() ? "ready" : money.error() !== undefined ? "error" : "loading"}
                months={money.value()?.months ?? []}
                profit={money.value()?.profit ?? null}
                any={money.value()?.any ?? false}
                cash={(props.setup.basis ?? "accrual") === "cash"}
                currency={props.setup.currency}
                onRetry={() => void money.reload()}
              />
            </Show>
          </div>
        </Show>

        <Show when={showTiles()}>
          <div class="rt-tiles">
            <h2 class="rt-home-heading">{homeWords.tiles.heading}</h2>
            <BankTiles headingLevel={3} />
          </div>
        </Show>
      </Show>
    </div>
  );
}

export function Home() {
  // The book the page read before it drew itself (opening.ts), when this is the page it opened on: Home is then Home
  // from its first draw, with no placeholder standing where its title will be.
  const opening = fromOpening("book", readBook, "home");
  const book = createLoader(
    () => opening.fetcher().then(enabledBook),
    opening.initial?.enabled ? enabledBook(opening.initial) : undefined,
  );
  // A workspace whose books this browser last saw still to be set up (or that the sign-in card has just made) shows
  // the setup at once, and it stays (with whatever was typed) when the book arrives and says the same.
  const workspace = openWorkspace();
  const pending = setupPending(workspace);
  // Its choices are then read beside the book, not after it. A book that is set up never asks for them (the setup
  // reads them itself when it shows).
  if (pending) void prefetchSetupChoices().catch(() => undefined);
  const view = createMemo(() => {
    const context = book.value();
    if (context === undefined) {
      if (book.error() !== undefined) return "error";
      return pending ? "setup" : "opening";
    }
    if (context.setup) return "today";
    return context.permissions.includes("provision") ? "setup" : "notSetUp";
  });
  createEffect(() => {
    const context = book.value();
    if (workspace !== null && context !== undefined)
      noteSetupPending(workspace, view() === "setup");
  });
  // The books were made in this visit (the wizard, or a setup that was resumed): the page they land on
  // takes focus, because the wizard that held it has just gone.
  const [created, setCreated] = createSignal(false);
  const made = () => {
    setCreated(true);
    return book.reload();
  };
  return (
    <section class="app-home">
      <PendingSetup onResolved={made} />
      <Switch>
        {/* No heading while the book is read: the page is Home, or the setup, and which is not known yet. */}
        <Match when={view() === "opening"}>
          <PageSkeleton label={homeWords.book.opening} />
        </Match>
        <Match when={view() === "error"}>
          <PageHeader size="home" title={homeWords.title} />
          <Notice title={homeWords.book.unavailable} tone="error">
            <p>
              {book.error() instanceof Error
                ? (book.error() as Error).message
                : homeWords.book.unreadable}
            </p>
            {/* A bad moment of the service passes: the page can ask again without being reloaded. The header, which read the book at the same moment and failed with it, is told to read it again too. */}
            <Button
              variant="secondary"
              label={homeWords.book.retry}
              onClick={() => {
                announceBook();
                void book.reload();
              }}
            />
          </Notice>
        </Match>
        <Match when={view() === "setup"}>
          <SetupFlow onCreated={made} />
        </Match>
        {/* Setting the books up needs `provision`, which an owner has and an accountant or a member does not: they are told, and not given a form that would be refused at the end. */}
        <Match when={view() === "notSetUp"}>
          <PageHeader size="home" title={homeWords.title} />
          <Notice title={homeWords.book.notSetUp} tone="info">
            <p>{homeWords.book.notSetUpBody}</p>
          </Notice>
        </Match>
        <Match when={view() === "today" && book.value()?.setup}>
          {(setup) => <Today setup={setup()} focusTitle={created()} />}
        </Match>
      </Switch>
    </section>
  );
}
