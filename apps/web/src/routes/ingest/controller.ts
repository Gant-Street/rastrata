import type { InboxActionReport, InboxListInput } from "@rastrata/application/client-contracts";
import type {
  AcceptMode,
  AccountOption as InboxAccountOption,
  InboxActionNote,
  InboxActions,
  InboxCountsView,
  InboxDetailView,
  InboxFilterState,
  InboxItemView,
  InboxProgress,
  InboxSourceView,
  InboxTab,
  InboxTarget,
} from "@rastrata/ui/ingest/types";
import { accountOptions } from "@rastrata/ui";
import { words } from "@rastrata/ui/ingest/words";
import { batch, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { ApplicationRequestError, BrowserApplicationClient } from "../../application-client";
import { restoreDrafts, undoLines, type UndoSummary } from "../entries/undo";
import { addressFor, addressForTab, scopedCounts, serverFilter, viewFromAddress } from "./view";

/** The workflow key every For review write is retained under. One write is pending at a time: a lost
 * reply is resumed under its original identity, never replaced. */
const WORKFLOW = "inbox:action";
const PAGE_SIZE = 50;
/** Transactions per call: drafting is quick, posting goes through the ledger and is not. A call is one entry of the log, which the hosted tail holds to a megabyte as stored: accepting a payout
 * of Stripe's comes to about three kilobytes of it, so a hundred leave room to spare. */
const STEP = { accept: 100, categorize: 100, exclude: 500, restore: 200, post: 25 } as const;
const zero: InboxCountsView = {
  total: 0,
  new: 0,
  proposed: 0,
  drafted: 0,
  posted: 0,
  excluded: 0,
  toReview: 0,
  covered: 0,
  postable: 0,
  beforeCutover: 0,
};

type Verb = "accept" | "categorize" | "exclude" | "restore" | "post";
type Choice = {
  accountId?: string;
  splits?: readonly { accountId: string; amount: string }[];
  narration?: string;
  allowDuplicate?: boolean;
};

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
};

/** What an action that recorded transactions needs to be told: whether they were posted to the books or only
 * saved as drafts, which ones, and how many. Both can be taken back (a draft returns to For review; a posted
 * entry is reversed, with a linked entry). */
export interface RecordedResult {
  readonly kind: "posted" | "saved";
  readonly ids: readonly string[];
  readonly count: number;
}

export interface InboxOptions {
  /** What accepting does. Read before every action: the setting is the book's. */
  acceptMode?: () => AcceptMode;
  /** Resolves once the book's settings have been read, so a click before the first read is not decided
   * by the default. */
  settingsReady?: () => Promise<void>;
  /** What the owner chose, as the service says it now: asked of it beside the first call of an Accept, so that the choice that decides what is done with what is accepted is not one the
   * page held. Used in place of `settingsReady` where it is given. */
  settingsNow?: () => Promise<void>;
  /** Told when an action recorded transactions cleanly, so the page can say so (with Undo). Without it
   * the controller says it itself, as a note. */
  onDone?: (result: RecordedResult) => void;
}

/** Everything the For review view of Transactions needs, kept apart from how it looks. It loads a page at a time (the
 * service filters, sorts and counts, so 2,000 transactions cost the same as 50), keeps what is ticked,
 * and does every piece of work through retained writes: a bulk action is a series of bounded calls with
 * visible progress that can be stopped between steps, and a reply that is lost is resumed, never
 * repeated under a new identity. Accepting records the transaction (the same accept and post the
 * terminal has, one after the other, for exactly the same ids) unless the book is set to keep drafts.
 * Nothing it shows is a guess: while a change is being confirmed the figures say so. */
export function createInbox(options: InboxOptions = {}) {
  const client = new BrowserApplicationClient(window.localStorage);
  const view = viewFromAddress(window.location.search);
  const [tab, setTabSignal] = createSignal<InboxTab>(view.tab);
  const [filters, setFiltersSignal] = createSignal<InboxFilterState>(view.filters);
  const [page, setPageSignal] = createSignal(1);
  const [state, setState] = createSignal<"loading" | "ready" | "error">("loading");
  const [refreshing, setRefreshing] = createSignal(false);
  const [items, setItems] = createSignal<readonly InboxItemView[]>([]);
  const [matching, setMatching] = createSignal(0);
  const [suggestions, setSuggestions] = createSignal(0);
  const [counts, setCounts] = createSignal<InboxCountsView>(zero);
  const [sources, setSources] = createSignal<readonly InboxSourceView[]>([]);
  const [accounts, setAccounts] = createSignal<readonly InboxAccountOption[]>([]);
  // A transaction named in the address is open from the first paint, not after the first read.
  const wanted = new URLSearchParams(window.location.search).get("item");
  const [activeId, setActiveId] = createSignal<string | null>(wanted);
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [allMatching, setAllMatching] = createSignal(false);
  const [detail, setDetail] = createSignal<{
    state: "none" | "loading" | "error" | "ready";
    value?: InboxDetailView;
  }>({ state: "none" });
  const [busy, setBusy] = createSignal(false);
  const [progress, setProgress] = createSignal<InboxProgress | null>(null);
  const [note, setNote] = createSignal<InboxActionNote | null>(null);
  const [uncertain, setUncertain] = createSignal(false);

  let generation = 0;
  let detailGeneration = 0;
  /** A transaction named in the address stays open until the person chooses another one. */
  let pinned: string | null = wanted;
  let stopped = false;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let detailTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    clearTimeout(searchTimer);
    clearTimeout(detailTimer);
  });

  const input = (): InboxListInput => ({
    filter: serverFilter(tab(), filters()),
    sort: filters().sort,
    page: page(),
    pageSize: PAGE_SIZE,
  });

  /** How many suggestions are ready in what the list shows: the number on "Accept N suggested". Asked
   * of the service with the same filter, so it is exactly what accepting would act on. */
  async function loadSuggestions(mine: number) {
    if (tab() !== "review" || filters().coveredBy !== "") {
      setSuggestions(0);
      return;
    }
    try {
      const result = await client.read("inbox.list", {
        filter: { ...serverFilter("review", filters()), hasProposal: true },
        pageSize: 1,
      });
      if (mine === generation) setSuggestions(result.count);
    } catch {
      if (mine === generation) setSuggestions(0);
    }
  }

  async function load() {
    const mine = ++generation;
    setRefreshing(true);
    try {
      const [result] = await Promise.all([
        client.read("inbox.list", input()),
        loadSuggestions(mine),
      ]);
      if (mine !== generation) return;
      const last = Math.max(1, Math.ceil(result.count / PAGE_SIZE));
      if (page() > last) {
        setPageSignal(last);
        return load();
      }
      setItems(result.items as readonly InboxItemView[]);
      setMatching(result.count);
      setCounts({ ...zero, ...result.counts });
      setState("ready");
      const current = activeId();
      if (!current || (pinned === null && !result.items.some((item) => item.id === current)))
        setActiveId(result.items[0]?.id ?? null);
    } catch (cause) {
      if (mine !== generation) return;
      if (cause instanceof ApplicationRequestError && cause.code === "book_not_configured") {
        setItems([]);
        setMatching(0);
        setCounts(zero);
        setState("ready");
        setNote({
          tone: "attention",
          title: words.results.setupTitle,
          lines: [words.results.setupBody],
        });
        return;
      }
      if (items().length === 0) setState("error");
      else
        setNote({
          tone: "problem",
          title: words.results.refreshFailedTitle,
          lines: [words.results.refreshFailedBody],
        });
    } finally {
      if (mine === generation) setRefreshing(false);
    }
  }

  async function loadSides() {
    try {
      const [summary, chart] = await Promise.all([
        client.read("inbox.summary", {}, { fresh: true }),
        client.read("accounts.list", {}, { fresh: true }),
      ]);
      setSources(summary.sources as readonly InboxSourceView[]);
      // The names first and the numbers muted, a group account never offered: the kit builds them from
      // the chart. The role stays beside each, because what an entry does to a balance depends on it.
      setAccounts(
        accountOptions(chart.accounts).map((option, index) => ({
          ...option,
          role: chart.accounts[index]?.role,
        })),
      );
    } catch {
      // The list itself reports failures; without accounts the pickers are simply empty.
    }
  }

  async function loadDetail(id: string | null) {
    const mine = ++detailGeneration;
    if (!id) {
      setDetail({ state: "none" });
      return;
    }
    setDetail((current) => (current.value?.item.id === id ? current : { state: "loading" }));
    try {
      const value = (await client.read("inbox.get", { itemId: id })) as unknown as InboxDetailView;
      if (mine === detailGeneration) setDetail({ state: "ready", value });
    } catch {
      if (mine === detailGeneration) setDetail({ state: "error" });
    }
  }

  const reload = async () => {
    await Promise.all([load(), loadSides()]);
    await loadDetail(activeId());
  };

  /** What changes the list on the server. */
  const serverKey = (value: InboxFilterState) =>
    JSON.stringify(serverFilter(tab(), value)) + value.sort;

  const clearSelection = () => {
    setSelected(new Set<string>());
    setAllMatching(false);
  };

  // Changing what is listed starts again from the first page with nothing ticked.
  createEffect(
    on(
      [tab, () => serverKey(filters())],
      () => {
        clearSelection();
        setPageSignal(1);
        void load();
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      page,
      () => {
        clearSelection();
        void load();
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      activeId,
      (id) => {
        clearTimeout(detailTimer);
        detailTimer = setTimeout(() => void loadDetail(id), 90);
      },
      { defer: true },
    ),
  );

  onMount(() => {
    try {
      if (client.pending(WORKFLOW)) setUncertain(true);
    } catch {
      setUncertain(true);
    }
    void Promise.all([load(), loadSides()]).then(() => {
      if (wanted) void loadDetail(wanted);
    });
  });

  const setFilters = (patch: Partial<InboxFilterState>) => {
    const next = { ...filters(), ...patch };
    if ("text" in patch && Object.keys(patch).length === 1) {
      // Typing: show the text at once, ask the service after a pause.
      setTyped(next);
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => setFiltersSignal(next), 250);
    } else {
      clearTimeout(searchTimer);
      setTyped(null);
      setFiltersSignal(next);
      if ("account" in patch) rememberAccount(next.account);
    }
  };
  const [typed, setTyped] = createSignal<InboxFilterState | null>(null);
  createEffect(on(filters, () => setTyped(null), { defer: true }));

  /** The chosen account is in the address, so a reload or a link keeps it. */
  function rememberAccount(account: string) {
    const url = new URL(window.location.href);
    window.history.replaceState(null, "", `${url.pathname}${addressFor(url.search, account)}`);
  }

  /** So is the view: what is ready to post and what was set aside each have an address of their own. */
  function rememberTab(value: InboxTab) {
    const url = new URL(window.location.href);
    window.history.replaceState(null, "", `${url.pathname}${addressForTab(url.search, value)}`);
  }

  // ---- Actions ----------------------------------------------------------------------------------

  const selectionOf = (target: InboxTarget, suggestionsOnly: boolean) =>
    target.kind === "items"
      ? { itemIds: [...target.ids] }
      : {
          filter: {
            ...serverFilter(tab(), filters()),
            ...(suggestionsOnly ? { hasProposal: true } : {}),
          },
          expectedCount: target.count,
        };

  /** Post the transactions an action has just drafted, a step at a time. What it returns is exactly what
   * the service confirmed: the ones posted, and the ones the ledger refused with its reason. */
  async function postDrafted(ids: readonly string[]) {
    const posted: string[] = [];
    const refused: { id: string; text: string; code?: string }[] = [];
    for (const group of chunks(ids, STEP.post)) {
      const report = (await client.write(
        "inbox.post",
        { itemIds: group },
        WORKFLOW,
      )) as InboxActionReport;
      for (const result of report.results) {
        if (result.outcome === "applied") posted.push(result.itemId);
        else {
          const text = result.message ?? result.code ?? "Not done";
          refused.push({
            id: result.itemId,
            text,
            ...(result.code ? { code: result.code } : {}),
          });
        }
      }
    }
    return { posted, refused };
  }

  /** Take these rows out of the list the person is looking at, and out of the number that says how many it holds. What a click shows must not wait for the network (docs/reference/program/
   * performance.md): the rows an action is for leave at once and the service is told behind it. What it does not do comes back, with the reason, when the list is read again at the end. */
  function leave(ids: readonly string[]): void {
    const gone = new Set(ids);
    const here = items().filter((item) => gone.has(item.id)).length;
    if (here === 0) return;
    setItems((previous) => previous.filter((item) => !gone.has(item.id)));
    setMatching((count) => Math.max(0, count - here));
    setSelected((previous) => new Set([...previous].filter((id) => !gone.has(id))));
  }

  /** `chosen` is the category a person chose on a transaction's own row, by the transaction's id (accept
   * only): those are categorized first, a call for each category, and the rest of the target is then
   * accepted, so every row is booked as it reads and the whole is one action with one result. Each of them
   * belongs to the target. */
  async function run(
    verb: Verb,
    target: InboxTarget,
    extra: Record<string, unknown>,
    suggestionsOnly = false,
    chosen: ReadonlyMap<string, string> = new Map(),
  ) {
    if (busy()) return;
    setBusy(true);
    setNote(null);
    stopped = false;
    if (target.kind === "items") leave(target.ids);
    // Accepting and categorizing record the transaction, unless the book is set to keep drafts. The same
    // two calls the terminal has (accept, then post), for exactly the ids the first one drafted. What the owner chose is asked of the service now, beside the first call and not before it (the
    // click already costs that round trip), and is what decides: not what the page held when it opened.
    const choice = Promise.resolve(
      verb === "accept" || verb === "categorize"
        ? (options.settingsNow ?? options.settingsReady)?.()
        : options.settingsReady?.(),
    ).catch(() => undefined);
    const posts = async (): Promise<boolean> => {
      if (verb !== "accept" && verb !== "categorize") return false;
      await choice;
      return (options.acceptMode?.() ?? "post") === "post";
    };
    const name = `inbox.${verb}` as const;
    const total = target.kind === "items" ? target.ids.length : target.count;
    const messages = new Map<string, { tone: "skipped" | "failed"; count: number }>();
    let applied = 0;
    let skipped = 0;
    let failed = 0;
    let first = true;
    const postedIds: string[] = [];
    const savedIds: string[] = [];
    let notPosted = 0;
    const verbLabel = words.doing[verb];
    const remember = (text: string, tone: "skipped" | "failed") => {
      const known = messages.get(text);
      if (known) known.count += 1;
      else messages.set(text, { tone, count: 1 });
    };
    /** Take in what one call did: the counts, the reason for each transaction it could not do, and (for
     * an accept or a categorize) the drafts it made, posted at once unless the book keeps drafts. */
    const absorb = async (report: InboxActionReport) => {
      const thenPost = await posts();
      applied += report.applied;
      skipped += report.skipped;
      failed += report.failed;
      for (const result of report.results)
        if (result.outcome !== "applied") {
          const text = result.message ?? result.code ?? "Not done";
          remember(text, result.outcome);
        } else if (verb === "post") postedIds.push(result.itemId);
      const drafted = report.results
        .filter((result) => result.outcome === "applied" && result.status === "drafted")
        .map((result) => result.itemId);
      if (!thenPost && (verb === "accept" || verb === "categorize")) savedIds.push(...drafted);
      if (thenPost) {
        const done = await postDrafted(drafted);
        postedIds.push(...done.posted);
        notPosted += done.refused.length;
        for (const refusal of done.refused) remember(refusal.text, "failed");
      }
      setProgress({
        label: verbLabel,
        done: Math.min(total, applied + skipped + failed),
        total,
      });
    };
    try {
      // The categories chosen on the rows first: one call for each category.
      let appliedChosen = 0;
      const byCategory = new Map<string, string[]>();
      for (const [itemId, accountId] of chosen)
        byCategory.set(accountId, [...(byCategory.get(accountId) ?? []), itemId]);
      for (const [accountId, ids] of byCategory)
        for (const group of chunks(ids, STEP.categorize)) {
          if (stopped) break;
          const report = (await client.write(
            "inbox.categorize",
            { itemIds: group, accountId },
            WORKFLOW,
          )) as InboxActionReport;
          appliedChosen += report.applied;
          await absorb(report);
        }
      // Then the rest of the target, as the action names it. The ones just recorded have left it.
      const rest: InboxTarget =
        target.kind === "items"
          ? { kind: "items", ids: target.ids.filter((id) => !chosen.has(id)) }
          : { kind: "matching", count: target.count - appliedChosen };
      const left = rest.kind === "items" ? rest.ids.length : rest.count;
      while (left > 0 && !stopped) {
        const body = {
          ...(first || rest.kind === "items"
            ? selectionOf(rest, suggestionsOnly)
            : { filter: selectionOf(rest, suggestionsOnly).filter }),
          ...extra,
          ...(rest.kind === "matching" ? { limit: STEP[verb] } : {}),
        };
        first = false;
        const report = (await client.write(name, body as never, WORKFLOW)) as InboxActionReport;
        await absorb(report);
        // A selection by filter works through the list in steps. It stops when asked, when nothing
        // more can be done to what is left (those stay in the list with their reason), and never
        // loops on transactions the service keeps refusing.
        if (rest.kind === "items" || report.remaining === 0 || stopped || report.applied === 0)
          break;
      }
      setUncertain(false);
    } catch (cause) {
      if (cause instanceof ApplicationRequestError && cause.uncertain) setUncertain(true);
      else if (cause instanceof ApplicationRequestError && cause.code === "selection_changed")
        setNote({ tone: "attention", title: words.results.changedTitle, lines: [cause.message] });
      else
        setNote({
          tone: "problem",
          title: words.results.failedTitle,
          lines: [cause instanceof Error ? cause.message : words.results.failedBody],
        });
    } finally {
      setProgress(null);
      clearSelection();
      setBusy(false);
    }
    if (!uncertain() && !note()) {
      const thenPost = await posts();
      const problems = skipped + failed + notPosted;
      const lines = [...messages]
        .slice(0, 4)
        .map(([text, entry]) => words.results.reason(entry.count, text));
      // A selection by filter only acts on the transactions the action can apply to. The rest are left
      // as they are, and the person should hear that rather than wonder.
      const untouched = target.kind === "matching" ? total - applied - skipped - failed : 0;
      if (untouched > 0 && !stopped)
        lines.push(
          verb === "accept"
            ? words.results.noSuggestion(untouched)
            : words.results.untouched(untouched),
        );
      const count = thenPost || verb === "post" ? postedIds.length : applied;
      const summary =
        thenPost || verb === "post"
          ? words.results.posted(count)
          : verb === "accept" || verb === "categorize"
            ? words.results.saved(count)
            : verb === "exclude"
              ? words.results.excluded(count)
              : words.results.returned(count);
      const title =
        summary +
        (notPosted > 0 ? words.results.notPosted(notPosted) : "") +
        (skipped + failed > 0 ? words.results.couldNot(skipped + failed) : "") +
        (stopped ? words.results.stopped : "");
      const clean = problems === 0 && lines.length === 0 && !stopped && count > 0;
      if (clean && (thenPost || verb === "post") && options.onDone)
        options.onDone({ kind: "posted", ids: postedIds, count });
      else if (clean && savedIds.length > 0 && options.onDone)
        options.onDone({ kind: "saved", ids: savedIds, count: savedIds.length });
      else
        setNote({
          tone: failed > 0 || notPosted > 0 ? "problem" : problems > 0 ? "attention" : "info",
          title,
          lines,
        });
    }
    await reload();
  }

  const actions: InboxActions = {
    accept: (target, proposalId, accepting) =>
      void run(
        "accept",
        target,
        {
          ...(proposalId ? { proposalId } : {}),
          ...(accepting?.allowDuplicate ? { allowDuplicate: true } : {}),
        },
        accepting?.suggestionsOnly ?? false,
        accepting?.chosen,
      ),
    categorize: (target, choice: Choice) =>
      void run("categorize", target, {
        ...(choice.accountId ? { accountId: choice.accountId } : {}),
        ...(choice.splits ? { splits: choice.splits } : {}),
        ...(choice.narration ? { narration: choice.narration } : {}),
        ...(choice.allowDuplicate ? { allowDuplicate: true } : {}),
      }),
    exclude: (target, reason) => void run("exclude", target, { reason }),
    restore: (target, reason) => void run("restore", target, { reason }),
    post: (target) => void run("post", target, {}),
    stop: () => {
      stopped = true;
    },
  };

  async function resume() {
    if (busy()) return;
    setBusy(true);
    try {
      await client.resume(WORKFLOW);
      setUncertain(false);
      setNote({
        tone: "info",
        title: words.results.finishedTitle,
        lines: [words.results.finishedBody],
      });
    } catch (cause) {
      if (!(cause instanceof ApplicationRequestError && cause.uncertain)) setUncertain(false);
      setNote({
        tone: "problem",
        title: words.results.unconfirmedTitle,
        lines: [cause instanceof Error ? cause.message : words.results.tryAgain],
      });
    } finally {
      setBusy(false);
    }
    await reload();
  }

  /** Take transactions back: a posted one has its entry reversed (a linked entry, so the books keep the
   * whole story) and returns to For review; one that was only saved as a draft goes straight back. Every
   * call is a retained write under the same key as the other actions, so two never overlap and a lost reply
   * is resumed, never repeated. Says nothing itself: the caller tells the person what came of it. */
  async function undo(ids: readonly string[], saved = false): Promise<UndoSummary | null> {
    if (busy() || ids.length === 0) return null;
    setBusy(true);
    setNote(null);
    try {
      const summary = await (saved ? restoreDrafts : undoLines)(client, ids, WORKFLOW);
      setUncertain(false);
      return summary;
    } catch (cause) {
      if (cause instanceof ApplicationRequestError && cause.uncertain) setUncertain(true);
      else
        setNote({
          tone: "problem",
          title: words.results.failedTitle,
          lines: [cause instanceof Error ? cause.message : words.results.failedBody],
        });
      return null;
    } finally {
      setBusy(false);
      await reload();
    }
  }

  async function saveSource(
    source: InboxSourceView,
    change: { ledgerAccountId?: string; startOn?: string },
  ): Promise<string | null> {
    try {
      await client.write(
        "inbox.configureSource",
        { provider: source.provider, accountKey: source.accountKey, ...change },
        "inbox:source",
      );
      await reload();
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : words.results.saveFailed;
    }
  }

  return {
    state,
    // While the list is being reloaded, or a typed filter is waiting to be applied, what is shown
    // may be about to change, so nothing is offered that would act on it.
    refreshing: () => refreshing() || typed() !== null,
    /** What the tabs count: the whole book's, or the chosen account's. */
    counts: () => scopedCounts(counts(), sources(), filters().account),
    /** The whole book's counts, whichever account is chosen. */
    allCounts: counts,
    tab,
    setTab: (value: InboxTab) => {
      if (value === tab()) return;
      // A view is a list of its own: the transactions one payout books, shown from the view before,
      // are let go with it.
      batch(() => {
        if (filters().coveredBy !== "") setFilters({ coveredBy: "" });
        setTabSignal(value);
      });
      rememberTab(value);
    },
    filters: () => typed() ?? filters(),
    setFilters,
    sources,
    accounts,
    items,
    matching,
    suggestions,
    mode: (): AcceptMode => options.acceptMode?.() ?? "post",
    page,
    pageSize: PAGE_SIZE,
    setPage: (value: number) => setPageSignal(value),
    activeId,
    setActive: (id: string) => {
      pinned = null;
      setActiveId(id);
    },
    /** The address named a transaction, so its pane opens at once. */
    pinned: () => pinned !== null,
    selected,
    allMatching,
    toggle: (ids: readonly string[], on: boolean) => {
      setAllMatching(false);
      setSelected((current) => {
        const next = new Set(current);
        for (const id of ids) on ? next.add(id) : next.delete(id);
        return next;
      });
    },
    selectMatching: () => setAllMatching(true),
    clearSelection,
    detail,
    retryDetail: () => void loadDetail(activeId()),
    actions,
    busy,
    progress,
    note,
    dismissNote: () => setNote(null),
    client,
    uncertain,
    resume: () => void resume(),
    saveSource,
    undo,
    retry: () => void reload(),
  };
}
