import { createMemo, createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  type AcceptMode,
  type AccountChoiceItem,
  emptyInboxFilters,
  type InboxActionNote,
  type InboxActions,
  type InboxCountsView,
  type InboxDetailView,
  type InboxFilterState,
  type InboxItemView,
  type InboxProgress,
  type InboxTab,
  InboxWorkspace,
  UiProvider,
} from "../../src";
import {
  accountChoices,
  accounts,
  counts,
  detailOf,
  emptyCounts,
  lines,
  manyLines,
  payoutRows,
  postedLines,
  sources,
  stripeAccountChoices,
} from "./fixtures";

type Scenario = {
  items?: InboxItemView[];
  counts?: InboxCountsView;
  matching?: number;
  /** The view of the page: what waits for review, what is ready to post, what was set aside. */
  tab?: InboxTab;
  /** What the list holds when it is not one of those: the posted transactions, or everything (the
   * transactions a payout books are listed with the payout, as the page does when it is asked for them). */
  listing?: "posted" | "everything";
  state?: "loading" | "ready" | "error";
  refreshing?: boolean;
  busy?: boolean;
  uncertain?: boolean;
  progress?: InboxProgress;
  note?: InboxActionNote;
  selected?: number[];
  allMatching?: boolean;
  active?: number;
  detail?: "none" | "loading" | "error" | "ready";
  filters?: Partial<InboxFilterState>;
  withSources?: boolean;
  locale?: string;
  pageSize?: number;
  /** Suggestions ready to accept in the list (the number on "Accept N suggested"). */
  suggestions?: number;
  mode?: AcceptMode;
  /** The accounts the select offers. */
  accountChoices?: AccountChoiceItem[];
  /** Open the pane at once, as an address that names a transaction does. A story that chooses a
   * transaction (`active`) opens it. */
  pinned?: boolean;
  /** Whether Undo is offered on posted transactions (the page always does; false shows the list without it). */
  undo?: boolean;
};

/** The real workspace over fictional lines. Ticking, filtering by tab, choosing a line and the
 * dialogs all work; the actions say what they would do and send nothing. */
function Harness(props: Scenario) {
  const all = () => props.items ?? lines;
  const [tab, setTab] = createSignal<InboxTab>(props.tab ?? "review");
  const [filters, setFilters] = createSignal<InboxFilterState>({
    ...emptyInboxFilters,
    ...props.filters,
  });
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(
    new Set((props.selected ?? []).map((index) => all()[index]?.id ?? "")),
  );
  const [allMatching, setAllMatching] = createSignal(props.allMatching ?? false);
  const [active, setActive] = createSignal<string | null>(all()[props.active ?? 0]?.id ?? null);
  const [message, setMessage] = createSignal<InboxActionNote | null>(props.note ?? null);
  const [page, setPage] = createSignal(1);
  const view = createMemo(() => {
    const status =
      props.listing === "everything"
        ? null
        : props.listing === "posted"
          ? ["posted"]
          : tab() === "review"
            ? ["new", "proposed"]
            : tab() === "ready"
              ? ["drafted"]
              : ["excluded"];
    const text = filters().text.trim().toLowerCase();
    const cover = filters().coveredBy;
    return all().filter(
      (row) =>
        (!status || status.includes(row.status)) &&
        // Showing a payout's lines is a filter of its own; otherwise covered lines sit on All.
        (cover
          ? row.coveredBy?.providerId === cover
          : props.listing !== undefined || !row.coveredBy) &&
        (!filters().account ||
          row.ledgerAccountId === filters().account ||
          (filters().account === "provider:stripe" && row.line.provider === "stripe")) &&
        (!text || `${row.line.description} ${row.line.amount}`.toLowerCase().includes(text)),
    );
  });
  const size = props.pageSize ?? 50;
  const pageItems = createMemo(() => view().slice((page() - 1) * size, page() * size));
  const matching = () => props.matching ?? view().length;
  const detail = createMemo(
    (): { state: "none" | "loading" | "error" | "ready"; value?: InboxDetailView } => {
      if (props.detail && props.detail !== "ready") return { state: props.detail };
      const row = all().find((entry) => entry.id === active());
      return row
        ? {
            state: "ready",
            value: detailOf(row, {
              coveredCount: row.line.kind === "event" && !row.coveredBy ? 4 : 0,
            }),
          }
        : { state: "none" };
    },
  );
  const say = (title: string) => () =>
    setMessage({ tone: "info", title: `${title} (preview: nothing was stored).`, lines: [] });
  const actions: InboxActions = {
    accept: say("Posted the transactions"),
    categorize: say("Recorded the transactions"),
    exclude: say("Excluded the transactions"),
    restore: say("Returned the transactions to review"),
    post: say("Posted the transactions"),
    stop: () => setMessage({ tone: "info", title: "Stopped.", lines: [] }),
  };
  const undo = (ids: readonly string[]) =>
    setMessage({
      tone: "info",
      title: `Undone: ${ids.length} waiting for review again (preview: nothing was stored).`,
      lines: [],
    });
  return (
    <UiProvider locale={props.locale ?? "en-US"}>
      <div class="rt-theme rt-inbox-story">
        <InboxWorkspace
          state={props.state ?? "ready"}
          refreshing={props.refreshing ?? false}
          counts={props.counts ?? counts()}
          tab={tab()}
          onTab={(next) => {
            setTab(next);
            setPage(1);
          }}
          filters={filters()}
          onFilters={(patch) => setFilters({ ...filters(), ...patch })}
          accountChoices={props.accountChoices ?? accountChoices}
          sources={props.withSources === false ? [] : sources}
          accounts={accounts}
          items={pageItems()}
          matching={matching()}
          suggestions={props.suggestions ?? view().filter((row) => row.suggestion).length}
          mode={props.mode ?? "post"}
          page={page()}
          pageSize={size}
          onPage={setPage}
          activeId={active()}
          onActive={setActive}
          pinned={props.pinned ?? props.active !== undefined}
          selected={selected()}
          allMatching={allMatching()}
          onToggle={(ids, on) => {
            setAllMatching(false);
            setSelected((current) => {
              const next = new Set(current);
              for (const id of ids) on ? next.add(id) : next.delete(id);
              return next;
            });
          }}
          onSelectMatching={() => setAllMatching(true)}
          onClearSelection={() => {
            setSelected(new Set<string>());
            setAllMatching(false);
          }}
          detail={detail()}
          onRetryDetail={() => undefined}
          actions={actions}
          {...(props.undo === false ? {} : { onUndo: undo })}
          busy={props.busy ?? false}
          progress={props.progress ?? null}
          note={message()}
          onDismissNote={() => setMessage(null)}
          uncertain={props.uncertain ?? false}
          onResume={say("Resumed the original request")}
          onSaveSource={async () => null}
          onRetry={() => undefined}
          links={{
            entry: (id) => `#entry-${id}`,
            item: (id) => `#item-${id}`,
            rule: (id) => `#rule-${id}`,
            newRule: (id) => `#new-rule-${id}`,
            reconciliation: (id) => `#reconciliation-${id}`,
            importHref: "#import",
            rulesHref: "#rules",
            connectHref: "#connect",
            views: { review: "#review", ready: "#ready", excluded: "#excluded", all: "#all" },
          }}
        />
      </div>
    </UiProvider>
  );
}

const meta = {
  title: "Lanes/Ingest/Inbox",
  component: Harness,
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Transactions waiting for a person, with the one thing to do on each row: the category is on the row (filled in
 * where one is suggested, a field that asks where none is) and so is Accept. The whole reason is in the pane.
 * Try it with the keyboard: Tab to the list, j and k to move, x to tick, a to accept, c to choose a category,
 * e to exclude, Enter to open the transaction beside the list, ? for the shortcuts. */
export const Default: Story = {};

/** Ticked transactions: the bar says exactly how many, and offers only what can apply to them. */
export const SelectedOnThePage: Story = { args: { selected: [0, 1, 3] } };

/** A thousand transactions at once, the way a first import goes: select everything that matches the filter. */
export const AllMatchingSelected: Story = {
  args: {
    items: manyLines(1800),
    counts: counts({ toReview: 1800, total: 1800 }),
    allMatching: true,
    selected: [0],
  },
};

/** The first import: thousands of transactions, fifty to a page, the counts and the pager doing the work. */
export const FirstImportBacklog: Story = {
  args: {
    items: manyLines(2000),
    counts: counts({
      toReview: 2000,
      total: 2000,
      drafted: 0,
      postable: 0,
      posted: 0,
      excluded: 0,
      covered: 0,
    }),
  },
};

export const ReadyToPost: Story = { args: { tab: "ready" } };
/** Posted transactions are listed with the payout that books them (and in All, the other view of the page).
 * Each says it is posted, and has Undo. */
export const Posted: Story = { args: { listing: "posted" } };

/** A posted transaction that is on a completed reconciliation says so with a check mark and the word,
 * in the list and in its detail, with a way to the reconciliation. The one dated after the statement
 * says nothing: it is on no statement yet. */
export const PostedAndReconciled: Story = {
  args: { items: postedLines, listing: "posted", counts: counts({ posted: 2 }), active: 0 },
};
export const PostedNotYetReconciled: Story = {
  args: { items: postedLines, listing: "posted", counts: counts({ posted: 2 }), active: 1 },
};
export const Excluded: Story = { args: { tab: "excluded", active: 0 } };

/** Every transaction is decided: a calm state, with what is left offered once. */
export const CaughtUp: Story = {
  args: {
    items: lines.filter((row) => row.status !== "new" && row.status !== "proposed"),
    counts: counts({ toReview: 0, new: 0, proposed: 0 }),
    detail: "none",
  },
};

/** Nothing imported yet: it says so, and offers the two ways in. No account has brought anything, so there is none
 * to choose between, as in the application (which offers the accounts something came in for). */
export const EmptyInbox: Story = {
  args: { items: [], counts: emptyCounts, withSources: false, detail: "none", accountChoices: [] },
};

export const Searching: Story = { args: { filters: { text: "github" } } };
export const NoMatches: Story = {
  args: { filters: { text: "nothing like this" }, detail: "none" },
};

export const Loading: Story = { args: { state: "loading", detail: "loading" } };
export const LoadFailed: Story = { args: { state: "error", detail: "error" } };
export const Refreshing: Story = { args: { refreshing: true } };

/** A long action in steps, with a plain count and a way to stop between steps. */
export const WorkingThroughABacklog: Story = {
  args: {
    busy: true,
    progress: { label: "Accepting", done: 800, total: 1621 },
    selected: [0, 1],
  },
};

/** What an action did, with the reason for each transaction it could not do. */
export const ResultWithSkippedLines: Story = {
  args: {
    note: {
      tone: "attention",
      title: "Posted 1,598 transactions. 23 could not be done.",
      lines: [
        "14 transactions: This transaction is in EUR and the book is in USD. Rastrata does not convert currencies. Exclude it, or book it by hand.",
        "9 transactions: Choose which chart account this provider account belongs to first.",
      ],
    },
  },
};

export const ResultFailed: Story = {
  args: {
    note: {
      tone: "problem",
      title: "Posted 12 transactions. 2 could not be posted and are still drafts.",
      lines: ["2 transactions: The ledger refused this entry: Posting date is in a closed period."],
    },
  },
};

/** A transaction dated past the last fiscal year the book can keep cannot post (the calendar grows by itself
 * up to then). The refusal says why; the transactions that did post stay posted. */
export const PostingRefusedForItsDate: Story = {
  args: {
    tab: "ready",
    note: {
      tone: "problem",
      title: "Posted 11 transactions. 2 could not be posted and are still drafts.",
      lines: [
        "2 transactions: 2101-02-03 is past the last fiscal year Rastrata supports. The book's fiscal calendar covers 2026-01-01 to 2100-12-31.",
      ],
    },
  },
};

/** The reply was lost: resume the original request, never replace it. */
export const UncertainWrite: Story = { args: { uncertain: true } };

/** A Stripe payout is one summary entry; the transactions it books are evidence and follow it. */
export const PayoutAndItsLines: Story = {
  args: {
    items: [...payoutRows, ...lines.slice(0, 3)],
    listing: "everything",
    counts: counts({ total: 9, covered: 4, toReview: 4 }),
    active: 0,
    withSources: false,
  },
};

/** A transaction that is booked together with its payout shows why it cannot be decided on its own. */
export const CoveredLine: Story = {
  args: {
    items: [...payoutRows, ...lines.slice(0, 3)],
    listing: "everything",
    active: 1,
    counts: counts({ total: 9, covered: 4, toReview: 4 }),
  },
};

/** Text from a bank is shown exactly as received: an instruction, hidden characters, a very long
 * memo, another currency, right-to-left text. None of it is ever acted on. */
export const HostileAndAwkwardText: Story = { args: { active: 8 } };
export const HiddenCharacters: Story = { args: { active: 9 } };
export const AnotherCurrency: Story = { args: { active: 10 } };
export const LongMemo: Story = { args: { active: 7 } };
export const RightToLeft: Story = { args: { active: 12 } };
export const TransferSuggestion: Story = { args: { active: 2 } };
export const MatchSuggestion: Story = { args: { active: 3 } };
/** Entered by hand before the bank's transaction arrived: the entry comes first, and recording another
 * has to be chosen as a second payment. */
export const AlreadyInTheBooks: Story = { args: { active: 17 } };
export const SuggestionWithProblems: Story = { args: { active: 1 } };

/** The detail of a transaction that has a draft, and of one that was posted. */
export const DraftedLine: Story = { args: { tab: "ready", active: 0 } };

/** A provider account with no chart account: its transactions wait until one is chosen. */
export const AccountsNeedChoosing: Story = { args: {} };

/** A right-to-left locale mirrors the layout; the figures stay left to right. */
export const RightToLeftLayout: Story = { args: { locale: "ar" } };

/** The book is set to keep drafts: Accept saves a draft in Ready to post, and the bar above the list says so
 * before anything is done. */
export const SavesDrafts: Story = { args: { mode: "draft" } };

/** One account chosen: the tabs, the counts and the list are that account's, and its name is not repeated on
 * every row. */
export const OneAccountChosen: Story = {
  args: { filters: { account: "1000" }, counts: counts({ toReview: 980 }) },
};

/** Stripe connected: it sits with the bank accounts, and choosing it lists what Stripe reported. */
export const StripeConnected: Story = {
  args: {
    accountChoices: stripeAccountChoices,
    filters: { account: "provider:stripe" },
    withSources: false,
  },
};

/** Posted transactions each have Undo, which reverses the entry and returns the transaction to For review. */
export const PostedWithUndo: Story = { args: { listing: "posted", active: 0 } };

/** Without Undo (a place that cannot take things back) the list shows no button for it. */
export const PostedWithoutUndo: Story = { args: { listing: "posted", undo: false } };
