import {
  children,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Button, buttonAttrs } from "../button";
import { Dialog } from "../dialog";
import { FilterFold } from "../kit/filter-fold";
import { Notice } from "../notice";
import { Pager } from "../pager";
import { PageHeader } from "../page-header";
import type { AccountChoiceItem } from "./bank-tile-types";
import {
  AcceptBar,
  type BulkAbilities,
  InboxNote,
  InboxProgressBar,
  InboxSelectionBar,
  InboxUncertain,
} from "./bulk";
import { categoryOf, hasCategoryField, nameOfAccount, suggestedCategory } from "./category";
import { type CategorizeChoice, InboxDetail, type InboxLinks } from "./detail";
import { CategorizeDialog, PostDialog, ReasonDialog, SourceDialog } from "./dialogs";
import { AccountSelect, CoveredChip, InboxFilterPanel, InboxSearch, narrowed } from "./filters";
import { InboxList, type RowAction } from "./list";
import { InboxEmpty } from "./states";
import {
  emptyFilters,
  type AcceptMode,
  type AccountOption,
  type InboxActionNote,
  type InboxActions,
  type InboxCountsView,
  type InboxDetailView,
  type InboxFilterState,
  type InboxItemView,
  type InboxProgress,
  type InboxSourceView,
  type InboxTab,
  type InboxTarget,
} from "./types";
import {
  type TransactionView,
  type TransactionViewHrefs,
  TransactionViews,
  transactionViews,
  type ViewLinkExtras,
} from "./views";
import { words } from "./words";

type Dialogue =
  | { kind: "exclude"; target: InboxTarget }
  | { kind: "restore"; target: InboxTarget }
  | { kind: "categorize"; target: InboxTarget }
  | { kind: "post"; target: InboxTarget }
  | { kind: "source"; source: InboxSourceView | null };

const targetCount = (target: InboxTarget) =>
  target.kind === "items" ? target.ids.length : target.count;
const scopeNote = (target: InboxTarget) =>
  target.kind === "matching" ? words.allMatchingNote(target.count) : undefined;

/** A click the browser keeps for itself: a new tab or window, a download, a selection. */
const browserKeeps = (event: MouseEvent): boolean =>
  event.defaultPrevented ||
  event.button !== 0 ||
  event.metaKey ||
  event.ctrlKey ||
  event.shiftKey ||
  event.altKey;

/** Transactions, the view that waits for review: the title and the switch between the views, the
 * transactions with their category and Accept on each row, and the chosen transaction's detail beside
 * them. It holds only what is on the screen (which dialog is open, whether the pane is open, the category
 * chosen on a row that has not been accepted yet; what is ticked is the parent's) and does no work itself:
 * every decision goes out through `actions`, and what comes back is what it shows. */
export function InboxWorkspace(props: {
  state: "loading" | "ready" | "error";
  /** The list is being reloaded after a change; figures may be about to move. */
  refreshing?: boolean;
  counts: InboxCountsView;
  tab: InboxTab;
  onTab: (tab: InboxTab) => void;
  filters: InboxFilterState;
  onFilters: (patch: Partial<InboxFilterState>) => void;
  /** The accounts that have transactions, for the one select the list can be narrowed with. It shows
   * only when there is more than one (or when the list is already narrowed to an account). */
  accountChoices: readonly AccountChoiceItem[];
  sources: readonly InboxSourceView[];
  accounts: readonly AccountOption[];
  items: readonly InboxItemView[];
  /** Transactions matching the filter, across all pages. */
  matching: number;
  /** Suggestions ready to accept in what the list shows (in For review): the number on "Accept N suggested". */
  suggestions: number;
  /** Whether accepting records a transaction or saves a draft. */
  mode: AcceptMode;
  page: number;
  pageSize: number;
  onPage: (page: number) => void;
  activeId: string | null;
  onActive: (id: string) => void;
  /** The address named a transaction: open its pane at once. */
  pinned?: boolean;
  selected: ReadonlySet<string>;
  allMatching: boolean;
  onToggle: (ids: readonly string[], on: boolean) => void;
  onSelectMatching: () => void;
  onClearSelection: () => void;
  detail: { state: "none" | "loading" | "error" | "ready"; value?: InboxDetailView };
  onRetryDetail: () => void;
  actions: InboxActions;
  /** Take posted transactions back (the entry is reversed and each returns to review). */
  onUndo?: (ids: readonly string[]) => void;
  busy?: boolean;
  progress?: InboxProgress | null;
  note?: InboxActionNote | null;
  onDismissNote: () => void;
  /** Something the screen offers beside the note. The page supplies it; the workspace only places it. */
  noteExtra?: JSX.Element;
  uncertain?: boolean;
  onResume: () => void;
  /** Called when the person saves a provider account's settings. Resolves to an error message, or null. */
  onSaveSource: (
    source: InboxSourceView,
    change: { ledgerAccountId?: string; startOn?: string },
  ) => Promise<string | null>;
  links: InboxLinks & {
    importHref: string;
    rulesHref: string;
    connectHref?: string | undefined;
    /** The address of each view of the page. */
    views: TransactionViewHrefs;
  };
  /** Draws the link to the view that is another page ("All") the way the application navigates. */
  renderViewLink?: (view: TransactionView, extras: ViewLinkExtras) => JSX.Element;
  onRetry: () => void;
}) {
  const extra = children(() => props.noteExtra);
  const [dialogue, setDialogue] = createSignal<Dialogue | null>(null);
  const [sourceError, setSourceError] = createSignal("");
  const [detailOpen, setDetailOpen] = createSignal(false);
  const [paneOpen, setPaneOpen] = createSignal(props.pinned ?? false);
  const [foldOpen, setFoldOpen] = createSignal(false);
  const [shortcutsOpen, setShortcutsOpen] = createSignal(false);
  const [wantCategory, setWantCategory] = createSignal(false);
  const [narrow, setNarrow] = createSignal(false);
  /** The category chosen on a row and not accepted yet, by the transaction's id. */
  const [choices, setChoices] = createSignal<ReadonlyMap<string, string>>(new Map());
  let searchInput: HTMLInputElement | undefined;
  let heading: HTMLHeadingElement | undefined;
  let root: HTMLDivElement | undefined;

  onMount(() => {
    heading?.focus();
    // Shortcuts that belong to the whole screen (/ to search, ? for the shortcuts, Escape to clear or
    // close) listen on the window, so they work wherever focus is, and only when nothing is being typed
    // and no dialog is open.
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
    const query = window.matchMedia("(max-width: 62rem)");
    setNarrow(query.matches);
    const change = (event: MediaQueryListEvent) => setNarrow(event.matches);
    query.addEventListener("change", change);
    onCleanup(() => query.removeEventListener("change", change));
    if (props.pinned && query.matches) setDetailOpen(true);
  });

  // A choice belongs to a row that is on the page: one whose transaction has left (accepted, excluded,
  // another page) is let go.
  createEffect(
    on(
      () => props.items,
      (items) => {
        const held = choices();
        if (held.size === 0) return;
        const here = new Set(items.map((item) => item.id));
        if ([...held.keys()].every((id) => here.has(id))) return;
        setChoices(new Map([...held].filter(([id]) => here.has(id))));
      },
      { defer: true },
    ),
  );
  const choose = (id: string, accountId: string) =>
    setChoices((held) => {
      const next = new Map(held);
      if (accountId === "") next.delete(id);
      else next.set(id, accountId);
      return next;
    });
  /** The rows among these whose category was changed from what was suggested, or chosen where nothing
   * was: the ones that are booked with the row's own category. */
  const overridesOf = (items: readonly InboxItemView[]): Map<string, string> => {
    const out = new Map<string, string>();
    for (const item of items) {
      const chosen = choices().get(item.id);
      if (chosen !== undefined && hasCategoryField(item) && chosen !== suggestedCategory(item))
        out.set(item.id, chosen);
    }
    return out;
  };

  const accountName = (id: string | null): string | undefined =>
    id === null ? undefined : nameOfAccount(props.accounts, id);
  const sourceLabel = (source: InboxSourceView): string => {
    const name = accountName(source.ledgerAccountId);
    return name ? `${name} (${source.provider})` : `${source.accountKey} (${source.provider})`;
  };
  const accountLabel = (item: InboxItemView): string => {
    const name = accountName(item.ledgerAccountId);
    if (name && item.ledgerAccountId !== null) return name;
    const source = props.sources.find(
      (entry) => entry.provider === item.line.provider && entry.accountKey === item.line.accountKey,
    );
    return source ? sourceLabel(source) : item.line.accountKey;
  };
  const categoryFor = (item: InboxItemView) =>
    categoryOf(item, (id) => nameOfAccount(props.accounts, id));
  const filtered = createMemo(() => narrowed(props.filters));
  const unmapped = createMemo(() => props.sources.filter((source) => source.needsAccount ?? false));
  /** A row says its account only when the list holds more than one account's transactions. */
  const severalAccounts = createMemo(
    () => new Set(props.items.map((item) => item.ledgerAccountId ?? item.line.accountKey)).size > 1,
  );
  /** Only the transactions one payout books are showing, whatever has become of them. */
  const covered = () => props.filters.coveredBy !== "";
  /** The accounts the select offers: the ones with transactions, and the one the list is narrowed to
   * (an address can name an account nothing has been imported into yet). */
  const accountChoices = createMemo((): readonly AccountChoiceItem[] => {
    const chosen = props.filters.account;
    if (chosen === "" || props.accountChoices.some((account) => account.key === chosen))
      return props.accountChoices;
    return [...props.accountChoices, { key: chosen, label: accountName(chosen) ?? chosen }];
  });
  const views = createMemo(() =>
    transactionViews({
      current: props.tab,
      page: "review",
      toReview: props.counts.toReview,
      ready: props.counts.postable ?? props.counts.drafted,
      excluded: props.counts.excluded,
      hrefs: props.links.views,
    }),
  );

  const selectedItems = createMemo(() => props.items.filter((item) => props.selected.has(item.id)));
  const abilities = createMemo((): BulkAbilities => {
    if (props.allMatching) {
      return {
        accept: props.tab === "review",
        categorize: props.tab === "review",
        exclude: props.tab === "review",
        post: props.tab === "ready",
        restore: props.tab === "ready" || props.tab === "excluded",
      };
    }
    // A transaction booked together with a payout is decided with the payout, so it offers nothing itself.
    const own = selectedItems().filter((item) => !item.coveredBy);
    const statuses = new Set(own.map((item) => item.status));
    const open = statuses.has("new") || statuses.has("proposed");
    return {
      accept: own.some((item) => item.status === "proposed") || overridesOf(own).size > 0,
      categorize: open,
      exclude: open,
      post: statuses.has("drafted"),
      restore: statuses.has("drafted") || statuses.has("excluded"),
    };
  });
  const target = (ids?: readonly string[]): InboxTarget =>
    ids
      ? { kind: "items", ids }
      : props.allMatching
        ? { kind: "matching", count: props.matching }
        : { kind: "items", ids: [...props.selected] };

  /** Accept transactions as their rows read: each with the category chosen on its row, the rest with
   * what is suggested. `ids` names them; left out, they are the ticked ones (or everything matching). */
  const acceptRows = (ids?: readonly string[]) => {
    const what = target(ids);
    const mine =
      what.kind === "items"
        ? props.items.filter((item) => what.ids.includes(item.id))
        : props.items;
    const chosen = overridesOf(mine);
    props.actions.accept(what, undefined, chosen.size > 0 ? { chosen } : undefined);
  };
  /** "Accept N suggested": every suggestion in the list as it is filtered. One whose category was
   * changed on its row is booked with the row's. */
  const acceptSuggested = () => {
    const chosen = overridesOf(
      props.items.filter((item) => item.status === "proposed" && item.suggestion !== undefined),
    );
    props.actions.accept({ kind: "matching", count: props.suggestions }, undefined, {
      suggestionsOnly: true,
      ...(chosen.size > 0 ? { chosen } : {}),
    });
  };

  /** The pane is where one transaction is looked at: a column beside the list, or a sheet on a phone. */
  const openPane = () => {
    if (narrow()) setDetailOpen(true);
    else setPaneOpen(true);
  };

  const onRowAction = (action: RowAction, ids: readonly string[]) => {
    if (props.busy) return;
    if (action === "undo") props.onUndo?.(ids);
    else if (action === "accept") acceptRows(ids);
    else if (action === "exclude") setDialogue({ kind: "exclude", target: target(ids) });
    else if (action === "post") setDialogue({ kind: "post", target: target(ids) });
    else if (action === "restore") setDialogue({ kind: "restore", target: target(ids) });
    else if (ids.length > 1 || props.allMatching)
      setDialogue({ kind: "categorize", target: target(ids) });
    else {
      // One transaction whose category is not a field on its row (a split or a transfer is suggested):
      // the category field is in its pane. Open the pane and ask for the field.
      const only = ids[0];
      if (only) props.onActive(only);
      openPane();
      setWantCategory(true);
    }
  };
  const single = (): readonly string[] | undefined =>
    props.activeId ? [props.activeId] : undefined;
  /** The transaction the pane is about, when it is on the page and its category is a field on its row:
   * the pane's category field is then the row's. */
  const activeField = (): InboxItemView | undefined => {
    const item = props.items.find((entry) => entry.id === props.activeId);
    return item && hasCategoryField(item) ? item : undefined;
  };

  /** The pane shows the transaction the list has chosen, never the one before it: while the next one is
   * on its way the pane says it is loading, so its buttons are never about a transaction it is not showing. */
  const current = (): {
    state: "none" | "loading" | "error" | "ready";
    value?: InboxDetailView;
  } => {
    const value = props.detail.value;
    return value !== undefined && props.activeId !== null && value.item.id !== props.activeId
      ? { state: "loading" }
      : props.detail;
  };

  const detailPane = (showTitle = true, closable = true) => (
    <InboxDetail
      showTitle={showTitle}
      state={current().state}
      {...(current().value ? { detail: current().value as InboxDetailView } : {})}
      accounts={props.accounts}
      accountLabel={accountLabel}
      links={props.links}
      mode={props.mode}
      busy={props.busy ?? false}
      focusCategory={wantCategory()}
      onCategoryFocused={() => setWantCategory(false)}
      {...(activeField()
        ? {
            category: choices().get(activeField()?.id ?? "") ?? "",
            onCategory: (accountId: string) => {
              const item = activeField();
              if (item) choose(item.id, accountId);
            },
          }
        : {})}
      onAccept={(proposalId, allowDuplicate) => {
        const id = single();
        if (id)
          props.actions.accept(
            { kind: "items", ids: id },
            proposalId,
            allowDuplicate ? { allowDuplicate: true } : undefined,
          );
      }}
      onCategorize={(choice: CategorizeChoice) => {
        const id = single();
        if (!id) return;
        // The suggested category, chosen again with nothing added, is the suggestion accepted.
        const item = activeField();
        const same =
          item !== undefined &&
          choice.accountId !== undefined &&
          choice.accountId === suggestedCategory(item) &&
          choice.splits === undefined &&
          choice.narration === undefined &&
          choice.allowDuplicate !== true;
        if (same) props.actions.accept({ kind: "items", ids: id });
        else props.actions.categorize({ kind: "items", ids: id }, choice);
      }}
      onExclude={() => {
        const id = single();
        if (id) setDialogue({ kind: "exclude", target: { kind: "items", ids: id } });
      }}
      onRestore={() => {
        const id = single();
        if (id) setDialogue({ kind: "restore", target: { kind: "items", ids: id } });
      }}
      onPost={() => {
        const id = single();
        if (id) setDialogue({ kind: "post", target: { kind: "items", ids: id } });
      }}
      {...(props.onUndo
        ? {
            onUndo: () => {
              const id = single();
              if (id) props.onUndo?.(id);
            },
          }
        : {})}
      onRetry={props.onRetryDetail}
      onShowCovered={(providerId) => props.onFilters({ coveredBy: providerId })}
      {...(closable
        ? {
            onClose: () => {
              setPaneOpen(false);
              setDetailOpen(false);
              setWantCategory(false);
            },
          }
        : {})}
    />
  );

  const onKeyDown = (event: KeyboardEvent) => {
    const element = event.target as HTMLElement;
    // Typing is a field that takes text. A check box or a button is not: "/" and Escape still work from
    // a row's check box, which is where the keyboard is while the list is being worked.
    const takesText =
      element instanceof HTMLInputElement
        ? !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(
            element.type,
          )
        : element instanceof HTMLTextAreaElement;
    const typing = takesText || element instanceof HTMLSelectElement || element.isContentEditable;
    const free = !typing && !dialogue() && !shortcutsOpen();
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "/" && free) {
      event.preventDefault();
      searchInput?.focus();
    } else if (event.key === "?" && free) {
      event.preventDefault();
      setShortcutsOpen(true);
    } else if (event.key === "Escape" && !dialogue() && !shortcutsOpen()) {
      if (props.selected.size > 0 || props.allMatching) props.onClearSelection();
      else if (paneOpen() && !narrow() && !typing) setPaneOpen(false);
    }
  };

  /** The target of the dialog that is open, or an empty one while none is. */
  const dialogTarget = (): InboxTarget => {
    const current = dialogue();
    return current && "target" in current ? current.target : { kind: "items", ids: [] };
  };
  /** A view of this page, chosen from a link without leaving the page. */
  const showView = (event: MouseEvent, tab: InboxTab) => {
    if (browserKeeps(event)) return;
    event.preventDefault();
    props.onTab(tab);
  };

  return (
    <div class="rt-inbox" ref={root}>
      <PageHeader
        title={words.title}
        titleRef={(element) => {
          heading = element;
        }}
        actions={
          <>
            <a {...buttonAttrs({ variant: "quiet", size: "md" })} href={props.links.rulesHref}>
              {words.rules}
            </a>
            <a {...buttonAttrs({ variant: "secondary", size: "md" })} href={props.links.importHref}>
              {words.importStatement}
            </a>
          </>
        }
      />
      <p class="rt-sr-only" role="status">
        {props.state === "ready" && !props.refreshing
          ? words.countsLive({
              toReview: props.counts.toReview,
              ready: props.counts.postable ?? props.counts.drafted,
            })
          : ""}
      </p>

      <Show when={unmapped().length > 0}>
        <Notice title={words.unmappedTitle(unmapped().length)} tone="attention">
          <p>{words.unmappedBody}</p>
          <ul class="rt-inbox-unmapped">
            <For each={unmapped()}>
              {(source) => (
                <li>
                  <bdi>{sourceLabel(source)}</bdi>
                  <Button
                    size="sm"
                    variant="secondary"
                    label={words.chooseSource}
                    onClick={() => {
                      setSourceError("");
                      setDialogue({ kind: "source", source });
                    }}
                  />
                </li>
              )}
            </For>
          </ul>
        </Notice>
      </Show>

      <Show when={props.uncertain}>
        <InboxUncertain onResume={props.onResume} busy={props.busy ?? false} />
      </Show>
      <Show when={props.progress}>
        {(progress) => <InboxProgressBar progress={progress()} onStop={props.actions.stop} />}
      </Show>
      <Show when={props.note}>
        {(note) => <InboxNote note={note()} onDismiss={props.onDismissNote} />}
      </Show>
      <Show when={extra()}>
        <div class="rt-inbox-note-extra">{extra()}</div>
      </Show>

      <FilterFold class="rt-inbox-filtering" open={foldOpen()} onOpenChange={setFoldOpen}>
        <div class="rt-list-toolbar">
          <TransactionViews
            views={views()}
            stale={props.refreshing ?? false}
            onView={(id) => {
              if (id !== "all") props.onTab(id);
            }}
            {...(props.renderViewLink ? { renderLink: props.renderViewLink } : {})}
          />
          <div class="rt-list-tools">
            <Show when={accountChoices().length > 1 || props.filters.account !== ""}>
              <AccountSelect
                accounts={accountChoices()}
                value={props.filters.account}
                disabled={props.busy ?? false}
                onChange={(key) => props.onFilters({ account: key })}
              />
            </Show>
            <InboxSearch
              filters={props.filters}
              onChange={props.onFilters}
              searchRef={(element) => {
                searchInput = element;
              }}
            />
          </div>
        </div>
        <InboxFilterPanel
          filters={props.filters}
          sources={props.sources}
          sourceLabel={sourceLabel}
          onChange={props.onFilters}
          onSourceSettings={(source) => {
            setSourceError("");
            setDialogue({ kind: "source", source });
          }}
        />
      </FilterFold>
      <Show when={covered()}>
        <CoveredChip
          coveredBy={props.filters.coveredBy}
          onClear={() => props.onFilters({ coveredBy: "" })}
        />
      </Show>

      {/* One bar above the rows: what is ticked and what can be done with it, or, with nothing ticked,
          the suggestions and the one button that accepts them all. */}
      <Show
        when={props.selected.size > 0 || props.allMatching}
        fallback={
          <Show
            when={
              props.tab === "review" &&
              props.suggestions > 0 &&
              props.state === "ready" &&
              !props.uncertain &&
              !covered()
            }
          >
            <AcceptBar
              count={props.suggestions}
              busy={(props.busy ?? false) || (props.refreshing ?? false)}
              onAccept={acceptSuggested}
            />
          </Show>
        }
      >
        <InboxSelectionBar
          pageCount={props.selected.size}
          matchingCount={props.matching}
          allMatching={props.allMatching}
          postCount={
            selectedItems().filter((item) => item.status === "drafted" && !item.coveredBy).length
          }
          abilities={abilities()}
          busy={(props.busy ?? false) || (props.refreshing ?? false)}
          onSelectMatching={props.onSelectMatching}
          onClear={props.onClearSelection}
          onAccept={() => acceptRows()}
          onCategorize={() => setDialogue({ kind: "categorize", target: target() })}
          onExclude={() => setDialogue({ kind: "exclude", target: target() })}
          onPost={() => setDialogue({ kind: "post", target: target() })}
          onRestore={() => setDialogue({ kind: "restore", target: target() })}
        />
      </Show>

      <div class="rt-inbox-panes" data-open={!narrow() && paneOpen() ? "" : undefined}>
        <div class="rt-inbox-main">
          <InboxList
            items={props.items}
            totalCount={props.matching}
            activeId={props.activeId}
            selected={props.selected}
            state={props.state}
            stale={props.refreshing ?? false}
            disabled={props.busy ?? false}
            tab={props.tab}
            showStatus={covered()}
            showAccount={severalAccounts()}
            canUndo={props.onUndo !== undefined}
            accounts={props.accounts}
            choices={choices()}
            onChoose={choose}
            accountLabel={accountLabel}
            categoryOf={categoryFor}
            onActive={props.onActive}
            onOpen={openPane}
            onToggle={props.onToggle}
            onAction={onRowAction}
            onRetry={props.onRetry}
            empty={
              <InboxEmpty
                tab={props.tab}
                counts={props.counts}
                filtered={filtered()}
                connectHref={props.links.connectHref}
                onClearFilters={() =>
                  props.onFilters({
                    ...emptyFilters,
                    sort: props.filters.sort,
                    account: props.filters.account,
                  })
                }
              />
            }
          />
          <Show when={props.state === "ready" && props.matching > props.pageSize}>
            <Pager
              count={props.matching}
              page={props.page}
              pageSize={props.pageSize}
              onPageChange={props.onPage}
            />
          </Show>
          {/* What was set aside is one quiet line under the list. It is the door to those transactions,
              which are shown in place of the list, each with the way to bring it back. */}
          <Show
            when={
              props.tab === "review" &&
              props.state === "ready" &&
              props.counts.excluded > 0 &&
              !covered()
            }
          >
            <p class="rt-inbox-excluded">
              <a href={props.links.views.excluded} onClick={(event) => showView(event, "excluded")}>
                {words.excludedLine(props.counts.excluded)}
              </a>
            </p>
          </Show>
        </div>
        <Show
          when={!narrow()}
          fallback={
            <Dialog
              open={detailOpen()}
              onOpenChange={setDetailOpen}
              placement="end"
              title={words.detailTitle}
              closeLabel={words.close}
              class="rt-inbox-sheet"
            >
              {detailPane(false, false)}
            </Dialog>
          }
        >
          <Show when={paneOpen()}>
            <div class="rt-inbox-side">{detailPane()}</div>
          </Show>
        </Show>
      </div>

      {/* The keyboard shortcuts, for whoever asks for them with "?": they are not on the page. */}
      <Dialog
        open={shortcutsOpen()}
        onOpenChange={setShortcutsOpen}
        title={words.shortcuts}
        closeLabel={words.close}
        class="rt-inbox-shortcuts"
      >
        <dl class="rt-inbox-shortcut-list">
          <For each={words.shortcutList}>
            {([keys, what]) => (
              <div>
                <dt>
                  <kbd>{keys}</kbd>
                </dt>
                <dd>{what}</dd>
              </div>
            )}
          </For>
        </dl>
      </Dialog>

      <ReasonDialog
        open={dialogue()?.kind === "exclude"}
        title={words.excludeDialogTitle(targetCount(dialogTarget()))}
        body={words.excludeDialogBody}
        confirm={words.excludeConfirm(targetCount(dialogTarget()))}
        quick={words.reasonQuick}
        {...(scopeNote(dialogTarget()) ? { scope: scopeNote(dialogTarget()) as string } : {})}
        busy={props.busy ?? false}
        onClose={() => setDialogue(null)}
        onConfirm={(reason) => {
          const current = dialogue();
          setDialogue(null);
          if (current && current.kind === "exclude") props.actions.exclude(current.target, reason);
        }}
      />
      <ReasonDialog
        open={dialogue()?.kind === "restore"}
        title={words.restoreDialogTitle(targetCount(dialogTarget()))}
        body={words.restoreDialogBody}
        confirm={words.restoreConfirm(targetCount(dialogTarget()))}
        busy={props.busy ?? false}
        onClose={() => setDialogue(null)}
        onConfirm={(reason) => {
          const current = dialogue();
          setDialogue(null);
          if (current && current.kind === "restore") props.actions.restore(current.target, reason);
        }}
      />
      <CategorizeDialog
        open={dialogue()?.kind === "categorize"}
        count={targetCount(dialogTarget())}
        accounts={props.accounts}
        mode={props.mode}
        {...(scopeNote(dialogTarget()) ? { scope: scopeNote(dialogTarget()) as string } : {})}
        busy={props.busy ?? false}
        onClose={() => setDialogue(null)}
        onConfirm={(choice) => {
          const current = dialogue();
          setDialogue(null);
          if (current && current.kind === "categorize")
            props.actions.categorize(current.target, choice);
        }}
      />
      <PostDialog
        open={dialogue()?.kind === "post"}
        count={targetCount(dialogTarget())}
        {...(scopeNote(dialogTarget()) ? { scope: scopeNote(dialogTarget()) as string } : {})}
        busy={props.busy ?? false}
        onClose={() => setDialogue(null)}
        onConfirm={() => {
          const current = dialogue();
          setDialogue(null);
          if (current && current.kind === "post") props.actions.post(current.target);
        }}
      />
      <SourceDialog
        open={dialogue()?.kind === "source"}
        source={
          dialogue()?.kind === "source"
            ? (dialogue() as { source: InboxSourceView | null }).source
            : null
        }
        sourceLabel={sourceLabel}
        accounts={props.accounts}
        error={sourceError()}
        onClose={() => setDialogue(null)}
        onSave={async (change) => {
          const current = dialogue();
          if (current?.kind !== "source" || !current.source) return;
          const failure = await props.onSaveSource(current.source, change);
          if (failure) setSourceError(failure);
          else setDialogue(null);
        }}
      />
    </div>
  );
}
