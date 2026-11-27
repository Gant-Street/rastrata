// biome-ignore-all lint/a11y/noRedundantRoles: a narrow list lays each row out as a grid or a flex line, and a table whose elements are not laid out as a table stops being read as one in Safari and older Chromium; the roles are said outright to keep it one
import {
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
import {
  columnFilteringFeature,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  createTable,
  filterFn_includesString,
  filterFn_equalsString,
  filterFn_arrIncludes,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
} from "@tanstack/solid-table";
import { ArrowDown, ArrowUp, Search } from "./icons";
import { Money } from "./money";
import { Button } from "./button";
import { Notice, Status } from "./notice";
import { EmptyState } from "./kit/empty-state";
import { FilterFold, FilterFoldButton, FilterFoldPanel } from "./kit/filter-fold";
import { ListSearch } from "./kit/list-search";
import { CalendarField, CheckField } from "./accounting-controls";
import { Pager } from "./pager";
import { EntryInspector } from "./entry-inspector";
import { accountFlow, correctionNote, plainNarration, sideText } from "./accounting-logic";
import { registerActionsId, RowMenu } from "./accounting/row-menu";
import { useUi } from "./locale";
import type {
  AccountChoice,
  DraftSaveResult,
  JournalContext,
  RegisterCorrection,
  RegisterEntry,
  RowAction,
} from "./accounting-types";
import { SelectField } from "./select-field";
import { DateValue } from "./date-value";
import { AccountPicker, type AccountOption } from "./kit/account-picker";
import { DateRangeField } from "./kit/date-range-field";
import {
  isUsableRange,
  presetOf,
  RANGE_PRESETS,
  type DateRangeValue,
  type FiscalCalendar,
} from "./kit/date-range";

// Entry numbers sort by their digits, so JRN-100 follows JRN-99 however the book is numbered.
const naturalOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// Only the behavior this register needs. Rendering stays native HTML + Ark.
const features = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
  rowSelectionFeature,
});

/** Something a person can do with the entries they ticked. */
export type SelectionAction = {
  id: string;
  label: string;
  onSelect: (ids: string[]) => void;
};

/** The id of the button of a selection action, so a host can return focus to it. */
export const selectionActionId = (id: string): string => `rt-register-selection-${id}`;

export type JournalRegisterProps = {
  state: "ready" | "loading" | "empty" | "error" | "refreshing";
  compact?: boolean;
  /** What stands at the start of the line of tools, before the search box: the page's views ("For review ·
   * All"). With it the list is a view of a page and carries no heavy rule of its own above its tools. */
  lead?: JSX.Element;
  entries: RegisterEntry[];
  accounts: readonly AccountChoice[];
  context: JournalContext;
  onRetry?: () => void;
  onSave?: (entry: RegisterEntry, reference: string) => Promise<DraftSaveResult>;
  newEntryHref?: string;
  /** Statuses offered in the status filter. Defaults to Draft and Posted. */
  statusOptions?: readonly { label: string; value: string }[];
  /** Called with the selected entry IDs. The button appears only when this is provided. */
  onReviewSelected?: (ids: string[]) => void;
  /** A checkbox on each row to pick entries for a bulk action. On by default; a register with no bulk
   * action turns it off, because a box that does nothing is noise. */
  selectable?: boolean;
  /** Which rows can be ticked. A row that cannot has no box, and "Select page" leaves it alone. Left out,
   * every row can. */
  rowSelectable?: (entry: RegisterEntry) => boolean;
  /** What can be done with the rows that are ticked: a button in the selection bar for each, given the
   * ids of the entries. */
  selectionActions?: readonly SelectionAction[];
  /** Changing this clears the selection. The host changes it when what was ticked has been dealt with. */
  selectionResetKey?: unknown;
  /**
   * A friendlier name for an entry than its raw ID. By default an entry with a posting sequence is
   * "No. 23" and anything else is its ID. The full ID stays available in the inspector and in search.
   */
  entryLabel?: (entry: RegisterEntry) => string;
  /** "/" focuses the search box. Turn off if the host page owns that key. */
  shortcuts?: boolean;
  /** The month the date filter opens on. Defaults to the month of the newest entry. */
  focusedDate?: string;
  /** The book's fiscal calendar and today. When it is given, the dates are chosen with the kit's range field (a
   * list of periods, "All dates" and Custom) and the account with the kit's picker ("All accounts"), as in every
   * other register and report; without it the register keeps its calendar popover and its list. */
  fiscal?: FiscalCalendar | undefined;
  /** While the book's calendar is being read, or when it could not be. */
  fiscalState?: "ready" | "loading" | "error" | undefined;
  entryHref?: (entry: RegisterEntry) => string | undefined;
  footnote?: string;
  /** Turns on the Type filter: the types to offer (`bank`, `stripe`, `manual`, `opening`). */
  typeOptions?: readonly string[];
  /** What can be done to one entry. An entry with at least one action gets a menu at the end of its
   * row, and the same actions are buttons in its side sheet. */
  rowActions?: (entry: RegisterEntry) => readonly RowAction[];
  /** The reversals of the book, so a row can say "Reversed by No. 29" or "Reverses No. 28" and a
   * reversal reads by number and not by the identifier the ledger wrote into it. */
  corrections?: readonly RegisterCorrection[];
  server?: {
    page: number;
    pageSize: number;
    count: number;
    text: string;
    from: string;
    to: string;
    accountId: string;
    status: string;
    type?: string;
    onChange: (
      change: Partial<{
        page: number;
        text: string;
        from: string;
        to: string;
        accountId: string;
        status: string;
        type: string;
      }>,
    ) => void;
  };
};

/** Client-side register or a server-owned filtered page. */
export function JournalRegister(props: JournalRegisterProps) {
  const ui = useUi();
  const m = () => ui.messages.register;
  const state = () => props.state;
  const [inspected, setInspected] = createSignal<RegisterEntry>();
  const [inspectorOpen, setInspectorOpen] = createSignal(false);
  const entryButtons = new Map<string, HTMLButtonElement>();
  let searchInput: HTMLInputElement | undefined;
  // In server mode each supplied page is already filtered and ordered by the backend.
  const table = createTable({
    features,
    get data() {
      return state() === "empty" ? [] : props.entries;
    },
    columns: [
      { accessorKey: "id", enableSorting: false },
      { accessorKey: "reference", enableSorting: false },
      {
        accessorKey: "status",
        enableSorting: false,
        enableGlobalFilter: false,
        filterFn: filterFn_equalsString,
      },
      {
        id: "accounts",
        accessorFn: (entry) => entry.lines.map((line) => line.accountId),
        enableSorting: false,
        enableGlobalFilter: false,
        filterFn: filterFn_arrIncludes,
      },
      {
        id: "type",
        accessorFn: (entry) => entry.type ?? "",
        enableSorting: false,
        enableGlobalFilter: false,
        filterFn: filterFn_equalsString,
      },
      {
        accessorKey: "isoDate",
        // By date, and within a day in the order the entries were made.
        sortFn: (rowA, rowB) =>
          rowA.original.isoDate.localeCompare(rowB.original.isoDate) ||
          naturalOrder.compare(rowA.original.id, rowB.original.id),
        enableGlobalFilter: false,
        filterFn: (row, _column, dates: string[]) =>
          dates.length < 2 ||
          (row.original.isoDate >= (dates[0] ?? "") && row.original.isoDate <= (dates[1] ?? "")),
      },
      // Display strings are never converted to Number or sorted lexically as money.
      { accessorKey: "amount", enableSorting: false, enableGlobalFilter: false },
    ],
    getRowId: (entry) => entry.id,
    // A row the host says cannot be ticked has no box, and ticking the page leaves it out.
    enableRowSelection: (row) => props.rowSelectable?.(row.original) ?? true,
    globalFilterFn: filterFn_includesString,
    enableSortingRemoval: false,
    enableMultiSort: false,
    autoResetPageIndex: false,
    initialState: {
      globalFilter: "",
      sorting: props.server ? [] : [{ id: "isoDate", desc: true }],
      pagination: { pageIndex: 0, pageSize: props.server?.pageSize ?? 4 },
    },
  });
  const query = () => props.server?.text ?? table.atoms.globalFilter.get() ?? "";
  const selected = () => table.getSelectedRowIds();
  // The host changes the key when what was ticked has been dealt with (moved to another account, say).
  createEffect(
    on(
      () => props.selectionResetKey,
      () => table.resetRowSelection(),
      { defer: true },
    ),
  );
  const filteredCount = () => props.server?.count ?? table.getFilteredRowModel().rows.length;
  const ascending = () => table.getColumn("isoDate")?.getIsSorted() === "asc";
  const columnFilters = () => table.atoms.columnFilters.get();
  const dates = () =>
    props.server
      ? [props.server.from, props.server.to].filter(Boolean)
      : ((table.getColumn("isoDate")?.getFilterValue() as string[] | undefined) ?? []);
  // The kit's range field holds what is being typed (a custom range with one end still empty) until it can be
  // applied, and remembers which period was chosen.
  const [rangeDraft, setRangeDraft] = createSignal<DateRangeValue | undefined>(undefined);
  const rangeValue = (): DateRangeValue => {
    const draft = rangeDraft();
    if (draft) return draft;
    const [from = "", to = ""] = dates();
    const calendar = props.fiscal;
    return from && to
      ? { preset: calendar ? presetOf({ from, to }, calendar) : "custom", from, to }
      : { preset: "all", from: "", to: "" };
  };
  const filterValue = (id: string) => {
    if (props.server)
      return id === "accounts"
        ? props.server.accountId || "all"
        : id === "type"
          ? props.server.type || "all"
          : props.server.status || "all";
    const value = table.getColumn(id)?.getFilterValue();
    return (
      (id === "accounts" ? (value as string[] | undefined)?.[0] : (value as string | undefined)) ??
      "all"
    );
  };
  const setFilter = (id: string, value: unknown) => {
    if (id === "isoDate" && value === undefined) setRangeDraft(undefined);
    if (props.server) {
      if (id === "accounts")
        props.server.onChange({ accountId: (value as string[] | undefined)?.[0] ?? "", page: 1 });
      else if (id === "status")
        props.server.onChange({ status: (value as string | undefined) ?? "", page: 1 });
      else if (id === "type")
        props.server.onChange({ type: (value as string | undefined) ?? "", page: 1 });
      else if (id === "isoDate") {
        const selected = value as string[] | undefined;
        props.server.onChange({ from: selected?.[0] ?? "", to: selected?.[1] ?? "", page: 1 });
      }
      return;
    }
    table.getColumn(id)?.setFilterValue(value);
    table.setPageIndex(0);
  };
  const setQuery = (value: string) => {
    if (props.server) {
      props.server.onChange({ text: value, page: 1 });
      return;
    }
    table.setGlobalFilter(value);
    table.setPageIndex(0);
  };
  /** A period chosen in the range field: "All dates" clears the filter, a usable range applies it, and a custom
   * range that is not complete yet is only held. */
  const chooseRange = (next: DateRangeValue) => {
    if (next.preset === "all") {
      setFilter("isoDate", undefined);
      return;
    }
    setRangeDraft(next);
    const calendar = props.fiscal;
    if (calendar && isUsableRange(next, calendar)) setFilter("isoDate", [next.from, next.to]);
  };
  /** The accounts as the kit's picker offers them: the name first, the code muted after it. */
  const pickerAccounts = (): AccountOption[] =>
    props.accounts.map((account) => ({
      value: account.value,
      label: account.name ?? account.label,
      ...(account.code ? { code: account.code } : {}),
      ...(account.path ? { path: account.path } : {}),
      group: ui.messages.account.headings[account.group] ?? account.group,
      ...(account.disabled ? { disabled: true, reason: account.reason ?? "" } : {}),
    }));
  const clearFilters = () => {
    setRangeDraft(undefined);
    if (props.server) {
      props.server.onChange({
        text: "",
        from: "",
        to: "",
        accountId: "",
        status: "",
        type: "",
        page: 1,
      });
      return;
    }
    table.resetColumnFilters();
    setQuery("");
  };
  const hasFilters = () =>
    props.server
      ? Boolean(
          props.server.text ||
            props.server.from ||
            props.server.to ||
            props.server.accountId ||
            props.server.status ||
            props.server.type,
        )
      : Boolean(query() || columnFilters().length);
  /** How many of the folded filters are on (the search is in the open, so it is not one of them). */
  const filtersOn = () =>
    props.server
      ? [
          props.server.from && props.server.to,
          props.server.accountId,
          props.server.status,
          props.server.type,
        ].filter(Boolean).length
      : columnFilters().length;
  const filterLabel = (id: string, value: unknown) =>
    id === "accounts"
      ? m().filterAccount(
          props.accounts.find((account) => account.value === (value as string[])[0])?.label ?? "",
        )
      : id === "isoDate"
        ? m().filterDates(...(value as [string, string]))
        : id === "type"
          ? m().filterType(m().types[String(value)] ?? String(value))
          : m().filterStatus(ui.messages.status[String(value)] ?? String(value));
  const returnFocus = () => {
    const trigger = entryButtons.get(inspected()?.id ?? "");
    return trigger?.isConnected ? trigger : (searchInput ?? null);
  };
  const closeInspector = () => {
    setInspectorOpen(false);
  };
  // "/" jumps to search, a long-standing convention. Never while typing or inside a dialog.
  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (props.shortcuts === false || event.key !== "/" || event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey || !searchInput) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        /^(input|textarea|select)$/i.test(target?.tagName ?? "") ||
        target?.closest('[role="dialog"],[role="alertdialog"]')
      )
        return;
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });
  const pageSize = () => props.server?.pageSize ?? table.atoms.pagination.get().pageSize;
  const pageIndex = () =>
    props.server ? props.server.page - 1 : table.atoms.pagination.get().pageIndex;
  // Tell screen-reader users what changed when a filter, sort or page turns the table over.
  const announcement = createMemo(() => {
    if (state() === "loading" || state() === "error") return "";
    const total = filteredCount();
    if (total === 0) return m().announceNone;
    const shown = table.getRowModel().rows.length;
    const from = pageIndex() * pageSize() + 1;
    const text = m().announceResults(
      from,
      from + Math.max(shown, 1) - 1,
      total,
      pageIndex() + 1,
      Math.max(1, Math.ceil(total / pageSize())),
    );
    return props.server ? text : `${text} ${m().announceSort(ascending())}`;
  });
  const labelOf = (entry: RegisterEntry) =>
    props.entryLabel?.(entry) ??
    (entry.postingSequence ? m().entryNumber(entry.postingSequence) : entry.id);
  /** The column of boxes: wanted by the host, and with a row on this page that can be ticked (or something
   * already ticked on another page, which can still be let go of). */
  const selectable = () =>
    props.selectable !== false &&
    (selected().length > 0 || table.getRowModel().rows.some((row) => row.getCanSelect()));
  /** What a person reads in the Description column: what the entry says, and not the short name they
   * gave it unless that adds something. */
  const spokenOf = (entry: RegisterEntry) => entry.description?.trim() || entry.reference;
  const descriptionOf = (entry: RegisterEntry) =>
    plainNarration(spokenOf(entry), entry.id, props.corrections, m().entryNumber);
  /** What the row's link says: the description, or the entry's number when it was given none. */
  const nameOf = (entry: RegisterEntry) => descriptionOf(entry).trim() || labelOf(entry);
  /** The state a row says, and only when it is not simply posted: a draft, or an entry that was reversed
   * (the reversal itself says what it reverses in its own description). */
  const stateOf = (entry: RegisterEntry): string | undefined =>
    entry.status !== "Posted"
      ? (ui.messages.status[entry.status] ?? entry.status)
      : correctionNote(entry.id, props.corrections)?.kind === "reversedBy"
        ? m().reversed
        : undefined;
  const referenceNote = (entry: RegisterEntry) => {
    const reference = entry.reference.trim();
    return reference && reference !== spokenOf(entry).trim() ? reference : "";
  };
  const calendarFocus = () =>
    props.focusedDate ??
    props.entries.map((entry) => entry.isoDate).reduce((a, b) => (b > a ? b : a), "") ??
    undefined;
  const statusOptions = () =>
    props.statusOptions ?? [
      { label: ui.messages.status.Draft ?? "Draft", value: "Draft" },
      { label: ui.messages.status.Posted ?? "Posted", value: "Posted" },
    ];
  return (
    <>
      <div
        class="rt-register-sheet"
        data-view={props.lead ? "" : undefined}
        style={{ "--rt-row-padding": props.compact ? "0.5rem 0.875rem" : "0.875rem 1rem" }}
      >
        {/* Announces results to screen readers when a filter, sort or page changes them. */}
        <div class="rt-sr-only" aria-live="polite" aria-atomic="true">
          {announcement()}
        </div>

        {/* At rest the list shows its search box and nothing else: the dates, the account, the type and
            the status are behind the one quiet button at the end of the box, and open under it. */}
        <FilterFold class="rt-register-filtering" defaultOpen={filtersOn() > 0}>
          <div class="rt-list-toolbar">
            {props.lead}
            <search class="rt-list-tools" aria-label={m().filtersLabel}>
              <ListSearch
                label={m().searchLabel}
                placeholder={m().searchPlaceholder}
                hint={m().searchHint}
                value={query()}
                onInput={setQuery}
                inputRef={(element) => {
                  searchInput = element;
                }}
                keyshortcuts={props.shortcuts === false ? undefined : "/"}
              >
                <FilterFoldButton count={filtersOn()} />
              </ListSearch>
            </search>
          </div>
          <FilterFoldPanel class="rt-register-toolbar">
            <Show
              when={props.fiscal}
              fallback={
                <CalendarField
                  range
                  hideHint
                  label={m().dates}
                  {...(calendarFocus() ? { focusedDate: calendarFocus() } : {})}
                  dateValues={dates()}
                  onDatesChange={(values) =>
                    setFilter("isoDate", values.length ? values : undefined)
                  }
                />
              }
            >
              {(fiscal) => (
                <DateRangeField
                  compact
                  presets={["all", ...RANGE_PRESETS]}
                  label={m().dates}
                  value={rangeValue()}
                  calendar={fiscal()}
                  {...(props.fiscalState ? { state: props.fiscalState } : {})}
                  onChange={chooseRange}
                />
              )}
            </Show>
            <Show
              when={props.fiscal}
              fallback={
                <SelectField
                  label={m().accountFilter}
                  value={filterValue("accounts")}
                  onChange={(value) => setFilter("accounts", value === "all" ? undefined : [value])}
                  items={[
                    { label: m().allAccounts, value: "all" },
                    ...props.accounts
                      .filter((account) => !account.disabled)
                      .map((account) => ({
                        value: account.value,
                        label: account.name
                          ? `${account.name} · ${account.code ?? account.value}`
                          : `${account.label} · ${account.path}`,
                      })),
                  ]}
                />
              }
            >
              <AccountPicker
                compact
                label={m().accountFilter}
                allLabel={m().allAccounts}
                accounts={pickerAccounts()}
                value={filterValue("accounts") === "all" ? "" : filterValue("accounts")}
                onChange={(id) => setFilter("accounts", id === "" ? undefined : [id])}
              />
            </Show>
            <Show when={props.typeOptions}>
              {(types) => (
                <SelectField
                  label={m().typeFilter}
                  value={filterValue("type")}
                  onChange={(value) => setFilter("type", value === "all" ? undefined : value)}
                  items={[
                    { label: m().allTypes, value: "all" },
                    ...types().map((type) => ({ value: type, label: m().types[type] ?? type })),
                  ]}
                />
              )}
            </Show>
            <SelectField
              label={m().statusFilter}
              value={filterValue("status")}
              onChange={(value) => setFilter("status", value === "all" ? undefined : value)}
              items={[{ label: m().allStatuses, value: "all" }, ...statusOptions()]}
            />
          </FilterFoldPanel>
        </FilterFold>

        <Show when={dates().length === 1}>
          <div class="rt-register-status-strip">
            <p class="rt-hint">{m().endDatePrompt}</p>
          </div>
        </Show>

        {/* Active Filter Chips */}
        <Show when={hasFilters()}>
          <section class="rt-applied-filters" aria-label={m().appliedFilters}>
            <span class="rt-register-applied-label" aria-hidden="true">
              {m().activeFilters}
            </span>
            <div class="rt-register-applied-chips">
              <Show when={query()}>
                <Button
                  variant="secondary"
                  size="sm"
                  label={m().removeSearch(query())}
                  onClick={() => setQuery("")}
                />
              </Show>
              <For each={columnFilters()}>
                {(filter) => (
                  <Button
                    variant="secondary"
                    size="sm"
                    label={m().removeFilter(filterLabel(filter.id, filter.value))}
                    onClick={() => setFilter(filter.id, undefined)}
                  />
                )}
              </For>
            </div>
            <Button variant="quiet" label={m().clearAll} onClick={clearFilters} />
          </section>
        </Show>

        <Show when={state() === "refreshing"}>
          <div class="rt-register-status-strip">
            <p role="status" class="rt-hint">
              {m().refreshing}
            </p>
          </div>
        </Show>

        {/* Batch Selection Bar */}
        <Show when={selected().length > 0}>
          <div class="rt-register-selection-bar">
            <div class="rt-register-selection-info">
              <strong dir="auto">{m().selectedAcross(selected().length)}</strong>
              <span class="rt-register-selection-outside" dir="auto">
                {m().outsideFilters(
                  selected().filter(
                    (id) => !table.getFilteredRowModel().rows.some((row) => row.id === id),
                  ).length,
                )}
              </span>
            </div>
            <div class="rt-row">
              <Show when={props.onReviewSelected}>
                <Button
                  variant="secondary"
                  label={m().reviewSelected}
                  onClick={() => props.onReviewSelected?.([...selected()])}
                />
              </Show>
              <For each={props.selectionActions}>
                {(action) => (
                  <Button
                    id={selectionActionId(action.id)}
                    variant="secondary"
                    label={action.label}
                    onClick={() => action.onSelect([...selected()])}
                  />
                )}
              </For>
              <Button
                variant="quiet"
                label={m().clearSelection}
                onClick={() => table.resetRowSelection()}
              />
            </div>
          </div>
        </Show>

        <Show when={state() === "error"}>
          <div class="rt-register-state-box">
            <Notice title={m().loadFailedTitle} tone="error">
              <p>{m().loadFailedBody}</p>
              <Show when={props.onRetry}>
                <Button label={m().retry} variant="secondary" onClick={() => props.onRetry?.()} />
              </Show>
            </Notice>
          </div>
        </Show>

        <Show when={state() === "loading"}>
          <div class="rt-register-state-box rt-stack" role="status" aria-label={m().loadingLabel}>
            <span class="rt-sr-only">{m().loadingText}</span>
            <For each={[1, 2, 3, 4]}>
              {() => <div class="rt-skeleton" style={{ height: "2.75rem" }} aria-hidden="true" />}
            </For>
          </div>
        </Show>

        <Show when={state() !== "loading" && state() !== "error"}>
          <Show
            when={filteredCount() > 0}
            fallback={
              <div class="rt-register-state-box">
                {/* A book with nothing in it says what is true and offers the one thing to do; a filter that
                    finds nothing says so politely, because rows were there a moment ago. */}
                <Show
                  when={hasFilters()}
                  fallback={
                    <EmptyState
                      title={m().noEntriesTitle}
                      action={
                        props.newEntryHref ? (
                          <a href={props.newEntryHref} class="rt-button" data-variant="primary">
                            {m().createFirst}
                          </a>
                        ) : undefined
                      }
                    >
                      {m().noEntriesBody}
                    </EmptyState>
                  }
                >
                  <EmptyState
                    live
                    title={m().noMatchesTitle}
                    action={
                      <Button
                        label={columnFilters().length ? m().resetFilters : m().clearSearch}
                        variant="secondary"
                        onClick={clearFilters}
                      />
                    }
                  >
                    {m().noMatchesBody}
                  </EmptyState>
                </Show>
              </div>
            }
          >
            <section
              class="rt-table-scroll rt-register-table-scroll"
              tabindex={0}
              aria-label={m().scrollLabel}
            >
              <table class="rt-table rt-register-table" role="table">
                <caption class="rt-sr-only">{m().caption}</caption>
                <thead role="rowgroup">
                  <tr role="row">
                    <Show when={selectable()}>
                      <th scope="col" role="columnheader" class="rt-register-col-check">
                        <CheckField
                          hideLabel
                          label={m().selectPage}
                          checked={
                            table.getIsAllPageRowsSelected()
                              ? true
                              : table.getIsSomePageRowsSelected()
                                ? "indeterminate"
                                : false
                          }
                          onChange={(checked) => table.toggleAllPageRowsSelected(checked)}
                        />
                      </th>
                    </Show>
                    <th
                      scope="col"
                      role="columnheader"
                      class="rt-register-col-date"
                      aria-sort={
                        props.server ? undefined : ascending() ? "ascending" : "descending"
                      }
                    >
                      {props.server ? (
                        m().columnDate
                      ) : (
                        // A list that is all here is in the order its entries were made, and the
                        // heading turns it over.
                        <button
                          type="button"
                          class="rt-sort-button"
                          onClick={() => {
                            table.getColumn("isoDate")?.toggleSorting();
                            table.setPageIndex(0);
                          }}
                        >
                          {m().columnDate}{" "}
                          {ascending() ? (
                            <ArrowUp aria-hidden="true" />
                          ) : (
                            <ArrowDown aria-hidden="true" />
                          )}
                        </button>
                      )}
                    </th>
                    <th scope="col" role="columnheader" class="rt-register-col-description">
                      {m().columnDescription}
                    </th>
                    <th scope="col" role="columnheader" class="rt-register-col-accounts">
                      {m().columnCategory}
                    </th>
                    <th scope="col" role="columnheader" class="rt-number rt-register-col-amount">
                      {m().columnAmount}
                    </th>
                    <Show when={props.rowActions}>
                      <th scope="col" role="columnheader" class="rt-register-col-actions">
                        <span class="rt-sr-only">{m().columnActions}</span>
                      </th>
                    </Show>
                  </tr>
                </thead>
                <tbody role="rowgroup">
                  <For each={table.getRowModel().rows}>
                    {(row) => (
                      <tr
                        role="row"
                        class={row.getIsSelected() ? "rt-register-row-selected" : undefined}
                      >
                        <Show when={selectable()}>
                          <td role="cell" class="rt-register-col-check">
                            <Show when={row.getCanSelect()}>
                              <CheckField
                                hideLabel
                                label={m().selectRow(labelOf(row.original))}
                                checked={row.getIsSelected()}
                                onChange={(checked) => row.toggleSelected(checked)}
                              />
                            </Show>
                          </td>
                        </Show>
                        <td role="cell" class="rt-register-cell-date">
                          <DateValue value={row.original.isoDate} />
                        </td>
                        {/* The description is the way into the entry: a link to its own page (where its
                            number is), or, in a list whose entries have no page, the button that
                            opens it beside the list. A state is said only when it is not the normal
                            one: a draft, or an entry that was reversed. */}
                        <th scope="row" role="rowheader" class="rt-register-cell-description">
                          <Show
                            when={props.entryHref?.(row.original)}
                            fallback={
                              <button
                                ref={(element) => entryButtons.set(row.id, element)}
                                type="button"
                                class="rt-register-entry-button"
                                onClick={() => {
                                  setInspected({ ...row.original });
                                  setInspectorOpen(true);
                                }}
                              >
                                <bdi>{nameOf(row.original)}</bdi>
                              </button>
                            }
                          >
                            {(href) => (
                              <a class="rt-register-entry-link" href={href()}>
                                <bdi>{nameOf(row.original)}</bdi>
                              </a>
                            )}
                          </Show>
                          <Show when={stateOf(row.original)}>
                            {(state) => (
                              <>
                                {" "}
                                <Status>{state()}</Status>
                              </>
                            )}
                          </Show>
                          <Show when={referenceNote(row.original)}>
                            {(note) => (
                              <small class="rt-register-reference">
                                <bdi>{m().referenceNote(note())}</bdi>
                              </small>
                            )}
                          </Show>
                        </th>
                        <td role="cell" class="rt-register-cell-accounts">
                          <AccountsCell entry={row.original} accounts={props.accounts} />
                        </td>
                        <td role="cell" class="rt-number rt-register-cell-amount">
                          <Money value={row.original.amount} />
                        </td>
                        <Show when={props.rowActions}>
                          {(actionsOf) => (
                            <td role="cell" class="rt-register-cell-actions">
                              <Show when={actionsOf()(row.original).length > 0}>
                                <RowMenu
                                  id={registerActionsId(row.original.id)}
                                  label={m().actionsFor(labelOf(row.original))}
                                  actions={actionsOf()(row.original)}
                                />
                              </Show>
                            </td>
                          )}
                        </Show>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </section>
            <div class="rt-register-footer-bar">
              <span class="rt-description" dir="auto">
                {m().summary(filteredCount(), props.context.currency)}
              </span>
              <Pager
                count={filteredCount()}
                pageSize={pageSize()}
                page={props.server?.page ?? table.atoms.pagination.get().pageIndex + 1}
                onPageChange={(page) =>
                  props.server ? props.server.onChange({ page }) : table.setPageIndex(page - 1)
                }
              />
            </div>
          </Show>
        </Show>
      </div>

      <Show when={props.footnote}>
        <p class="rt-description rt-register-footnote">
          <Search aria-hidden="true" /> {props.footnote}
        </p>
      </Show>
      <Show when={inspected()} keyed>
        {(entry) => (
          <EntryInspector
            entry={entry}
            open={inspectorOpen()}
            returnFocus={returnFocus}
            entryLabel={labelOf}
            onClose={closeInspector}
            accounts={props.accounts}
            context={props.context}
            detailHref={props.entryHref?.(entry)}
            actions={(props.rowActions?.(entry) ?? []).map((action) => ({
              ...action,
              // The side sheet gets out of the way of what the action opens.
              onSelect: () => {
                closeInspector();
                action.onSelect();
              },
            }))}
            {...(props.shortcuts !== undefined ? { shortcuts: props.shortcuts } : {})}
            onSave={
              props.onSave
                ? async (entry, reference) => {
                    const save = props.onSave;
                    if (!save) return { status: "rejected" };
                    const result = await save(entry, reference);
                    if (result.status === "saved")
                      table.setPageIndex(
                        Math.min(
                          table.atoms.pagination.get().pageIndex,
                          Math.max(0, table.getPageCount() - 1),
                        ),
                      );
                    return result;
                  }
                : undefined
            }
          />
        )}
      </Show>
    </>
  );
}

/** The accounts of an entry as money moving, "Business checking → Software": where it came from, then
 * where it went. An entry still being filled in lists its accounts and says nothing about direction. */
function AccountsCell(props: { entry: RegisterEntry; accounts: readonly AccountChoice[] }) {
  const ui = useUi();
  const m = () => ui.messages.register;
  const flow = () => accountFlow(props.entry, props.accounts);
  const side = (names: readonly string[]) => sideText(names, 3, m().moreAccounts);
  const complete = () => flow().open.length === 0 && flow().from.length + flow().to.length > 0;
  return (
    <Show
      when={complete()}
      fallback={
        <bdi class="rt-register-account-line">
          {side([...new Set([...flow().from, ...flow().to, ...flow().open])])}
        </bdi>
      }
    >
      <bdi class="rt-register-account-line">{side(flow().from)}</bdi>
      <Show when={flow().from.length > 0 && flow().to.length > 0}>
        <span class="rt-register-account-sep" aria-hidden="true">
          {" "}
          →{" "}
        </span>
        <span class="rt-sr-only"> {m().accountsTo} </span>
      </Show>
      <bdi class="rt-register-account-line">{side(flow().to)}</bdi>
    </Show>
  );
}
