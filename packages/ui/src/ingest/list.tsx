// biome-ignore-all lint/a11y/noRedundantRoles: a narrow list lays each row out as a grid or a flex line, and a table whose elements are not laid out as a table stops being read as one in Safari and older Chromium; the roles are said outright to keep it one
import { createEffect, createMemo, createUniqueId, For, on, Show, type JSX } from "solid-js";
import { RowCheck } from "../row-check";
import { PageSkeleton } from "../skeleton";
import { Button } from "../button";
import { undoWords } from "../entries/words";
import { formatDate, formatMoneyAbsolute, isNegativeMoney } from "../format";
import { TriangleAlert } from "../icons";
import { AccountPicker } from "../kit/account-picker";
import { acceptable, type Category, hasCategoryField, suggestedCategory } from "./category";
import { Absolute, FlagList, ReconciledMark, StatusChip } from "./parts";
import type { AccountOption, InboxItemView, InboxTab } from "./types";
import { words } from "./words";
import { DateValue } from "../date-value";

export type RowAction = "accept" | "categorize" | "exclude" | "post" | "restore" | "undo";

const shortened = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

// (Constants, so the copy scan does not read a ternary of two class names as the singular and plural of a word.)
const QUIET_CLASS = "rt-inbox-muted";
const NAMED_CLASS = "rt-inbox-category-name";

/** The words a category cell shows for what a transaction is, or would be, booked to. */
export function categoryText(category: Category, item: InboxItemView): string {
  switch (category.kind) {
    case "account":
      return category.names[0] ?? "";
    case "split":
      return words.categorySplit(category.names);
    case "transfer":
      return category.direction === "from"
        ? words.categoryTransferFrom(category.names[0] ?? "")
        : words.categoryTransferTo(category.names[0] ?? "");
    case "match":
      return words.categoryMatch;
    case "exclude":
      return words.categoryExclude;
    case "event":
      return item.line.provider === "stripe" ? words.categoryPayout : words.categoryProviderEntry;
    default:
      return "";
  }
}

/** The Category column of a transaction that has no field: where the money went, or would go. A suggestion
 * that is not one category (a split, a transfer, an entry already in the books, a payout) is its sentence
 * here, and changing it means opening the transaction. One that was set aside says why. */
function CategoryText(props: { item: InboxItemView; category: Category }) {
  const item = () => props.item;
  const text = () => categoryText(props.category, item());
  const said = () =>
    item().status === "excluded"
      ? (item().exclusion?.reason ?? words.statusLabel.excluded)
      : item().coveredBy
        ? words.nothingToDecide
        : text();
  const quiet = () => item().status === "excluded" || Boolean(item().coveredBy);
  return (
    <Show when={said() !== ""}>
      <span class={quiet() ? QUIET_CLASS : NAMED_CLASS}>
        <bdi>{said()}</bdi>
      </span>
    </Show>
  );
}

/** The button at the end of a row: the one thing most likely to be done next. A transaction that waits
 * has Accept, which is off until its row has a category. */
function RowButton(props: {
  item: InboxItemView;
  /** The category chosen on the row, if one was. */
  chosen: string | undefined;
  /** A posted transaction can be taken back (the page offers it). */
  canUndo: boolean;
  disabled: boolean;
  tabIndex: number;
  onAction: (action: RowAction) => void;
}) {
  const item = () => props.item;
  const about = () => shortened(item().line.description, 60);
  const act = (): { action: RowAction; label: string; name: string; off?: boolean } | null => {
    if (item().coveredBy) return null;
    if (item().status === "new" || item().status === "proposed") {
      const suggested = item().status === "proposed" && item().suggestion !== undefined;
      // Nothing to accept and nowhere to choose (another currency, no account in the books yet): the
      // transaction is decided from its pane.
      if (!suggested && !hasCategoryField(item())) return null;
      return {
        action: "accept",
        label: words.accept,
        name: words.acceptRow(about()),
        off: !acceptable(item(), props.chosen),
      };
    }
    if (item().status === "drafted")
      return { action: "post", label: words.post, name: words.postRow(about()) };
    if (item().status === "posted" && props.canUndo)
      return { action: "undo", label: undoWords.rowAction, name: undoWords.rowLabel(about()) };
    if (item().status === "excluded")
      return { action: "restore", label: words.returnLabel, name: words.restoreRow(about()) };
    return null;
  };
  return (
    <Show when={act()}>
      {(current) => (
        <Button
          size="sm"
          variant="secondary"
          label={current().label}
          aria-label={current().name}
          tabindex={props.tabIndex}
          disabled={props.disabled || current().off === true}
          data-row-control=""
          onClick={() => props.onAction(current().action)}
        />
      )}
    </Show>
  );
}

/** The transactions on the current page. Each row is the date, the description (which opens the
 * transaction), its category, what was spent or received, and one button. A transaction that waits has its
 * category on the row: filled in and reading as text when one is suggested, a field that says "Choose a
 * category" when none is, and Accept books the row as it reads.
 *
 * One tab stop for the whole table, then j and k or the arrow keys to move (the detail follows the focused
 * transaction), x or space to tick, a to accept, c to go to the category and e to exclude: the ticked ones,
 * or the focused one when none is ticked. A row's own controls are tab stops only on the row the keyboard
 * is on, so a page of fifty transactions is not two hundred tab stops. The component holds no selection and
 * decides nothing: the parent owns both, and what was chosen on each row, and does the work. */
export function InboxList(props: {
  items: readonly InboxItemView[];
  /** Every transaction matching the filter, across pages. */
  totalCount: number;
  activeId: string | null;
  selected: ReadonlySet<string>;
  state?: "ready" | "loading" | "error";
  /** The list is being refreshed; what is shown may be about to change. */
  stale?: boolean;
  disabled?: boolean;
  tab: InboxTab;
  /** Every transaction in a view has the same status, so only a mixed list says it on each row. */
  showStatus?: boolean;
  /** The account is said under the description only when the list holds more than one account's. */
  showAccount?: boolean;
  /** Posted transactions offer Undo on their row. */
  canUndo?: boolean;
  /** The chart, for the category field of each row. */
  accounts: readonly AccountOption[];
  /** The category a person chose on a row and has not accepted yet, by the transaction's id. */
  choices: ReadonlyMap<string, string>;
  onChoose: (id: string, accountId: string) => void;
  /** Text for a transaction's account: a chart account's name, or the provider's own key. */
  accountLabel: (item: InboxItemView) => string;
  /** Where the transaction goes: what is suggested, or what was decided. */
  categoryOf: (item: InboxItemView) => Category;
  empty: JSX.Element;
  onActive: (id: string) => void;
  /** The person chose to open a transaction (a click, or Enter), as opposed to passing over it. */
  onOpen?: (id: string) => void;
  onToggle: (ids: readonly string[], on: boolean) => void;
  onAction: (action: RowAction, ids: readonly string[]) => void;
  onRetry: () => void;
}) {
  const uid = createUniqueId();
  let body: HTMLTableSectionElement | undefined;
  let hadFocus = false;
  let shiftHeld = false;
  let anchor = 0;

  const current = createMemo(() => {
    const index = props.items.findIndex((item) => item.id === props.activeId);
    return index >= 0 ? index : 0;
  });
  const visibleSelected = createMemo(
    () => props.items.filter((item) => props.selected.has(item.id)).length,
  );
  const allSelected = () => props.items.length > 0 && visibleSelected() === props.items.length;
  /** The categories a row offers: the chart without the transaction's own account. One list for each
   * account the page holds, so fifty rows of one bank account share it. */
  const offered = createMemo(() => {
    const all = props.accounts;
    const lists = new Map<string, readonly AccountOption[]>();
    return (own: string | null): readonly AccountOption[] => {
      const key = own ?? "";
      let list = lists.get(key);
      if (!list) {
        list = all.filter((account) => account.value !== own);
        lists.set(key, list);
      }
      return list;
    };
  });

  const rowOf = (index: number) =>
    body?.querySelector<HTMLTableRowElement>(`tr[data-index="${index}"]`) ?? null;
  /** Where the keyboard stands on a row: its check box, or its description where the boxes are not shown
   * (a narrow list). */
  const rowStop = (index: number): HTMLElement | null => {
    const row = rowOf(index);
    const box = row?.querySelector<HTMLInputElement>("input.rt-inbox-checkbox") ?? null;
    const cell = box?.closest("td");
    if (box && (!cell || getComputedStyle(cell).display !== "none")) return box;
    return row?.querySelector<HTMLElement>(".rt-inbox-open") ?? box;
  };
  const focusRow = (index: number) => {
    const target = Math.min(Math.max(index, 0), props.items.length - 1);
    const item = props.items[target];
    if (item) props.onActive(item.id);
    queueMicrotask(() => rowStop(target)?.focus());
    return target;
  };
  // When an action removes the focused transaction from the page, keep the keyboard where it was
  // working. Only while the keyboard has nowhere to be: focus the person has moved on to (the search
  // box, the header's check box, a button) is theirs, and results arriving must never take it. A
  // removed element fires no focusout, so `hadFocus` can be stale, and is cleared here when it is.
  createEffect(
    on(
      () => props.items,
      () =>
        queueMicrotask(() => {
          const active = document.activeElement;
          const dropped = !active || active === document.body;
          if (!dropped) hadFocus = false;
          else if (hadFocus && props.items.length > 0) rowStop(current())?.focus();
        }),
      { defer: true },
    ),
  );

  const targets = (fallback: string): readonly string[] =>
    props.selected.size > 0 ? [...props.selected] : [fallback];

  const toggleRange = (from: number, to: number, on: boolean) => {
    const [start, end] = from <= to ? [from, to] : [to, from];
    props.onToggle(
      props.items.slice(start, end + 1).map((item) => item.id),
      on,
    );
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    // Keys work from a row's check box, from its description and from its button (which keep Enter and
    // Space for themselves). The category field is a text box: what is typed there is typed.
    const onBox = target instanceof HTMLInputElement && target.type === "checkbox";
    const onButton = target.closest("[data-row-control], .rt-inbox-open") !== null;
    if (!onBox && !onButton) return;
    if (event.ctrlKey || event.metaKey || event.altKey || props.disabled) return;
    const at = Number(target.closest("tr")?.getAttribute("data-index"));
    const item = props.items[at];
    if (!item) return;
    const key = event.key;
    const down = key === "ArrowDown" || key === "j" || key === "J";
    const up = key === "ArrowUp" || key === "k" || key === "K";
    if (down || up) {
      event.preventDefault();
      const next = Math.min(Math.max(at + (down ? 1 : -1), 0), props.items.length - 1);
      if (event.shiftKey && next !== at && onBox)
        toggleRange(next, next, (target as HTMLInputElement).checked);
      focusRow(next);
    } else if (key === "Home" || key === "End") {
      event.preventDefault();
      focusRow(key === "Home" ? 0 : props.items.length - 1);
    } else if (key === "PageDown" || key === "PageUp") {
      event.preventDefault();
      focusRow(at + (key === "PageDown" ? 10 : -10));
    } else if (key === "Enter" && onBox) {
      event.preventDefault();
      props.onOpen?.(item.id);
    } else if (key === "x" || key === "X") {
      event.preventDefault();
      toggleRange(at, at, !props.selected.has(item.id));
      anchor = at;
    } else if (key === "a" || key === "A") {
      event.preventDefault();
      props.onAction("accept", targets(item.id));
    } else if (key === "c" || key === "C") {
      event.preventDefault();
      // One transaction with a category field: the keyboard goes to it. Several, or one whose category is
      // not a field (a split, a transfer), are the page's to handle.
      const field =
        props.selected.size === 0 && hasCategoryField(item)
          ? rowOf(at)?.querySelector<HTMLInputElement>(".rt-account-picker input")
          : null;
      if (field) field.focus();
      else props.onAction("categorize", targets(item.id));
    } else if (key === "e" || key === "E") {
      event.preventDefault();
      props.onAction("exclude", targets(item.id));
    }
  };

  return (
    <div
      class="rt-inbox-list"
      aria-busy={props.stale ? true : undefined}
      onFocusIn={() => {
        hadFocus = true;
      }}
      onFocusOut={(event) => {
        if (
          event.relatedTarget &&
          !(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)
        )
          hadFocus = false;
      }}
    >
      <Show
        when={props.state !== "loading" && props.state !== "error"}
        fallback={
          <Show
            when={props.state === "error"}
            fallback={<PageSkeleton shape="table" label={words.loading} />}
          >
            <div class="rt-inbox-state" role="alert">
              <p>{words.loadFailed}</p>
              <Button variant="secondary" label={words.retry} onClick={props.onRetry} />
            </div>
          </Show>
        }
      >
        <Show when={props.items.length > 0} fallback={props.empty}>
          <div class="rt-table-scroll rt-inbox-scroll" data-stale={props.stale ? "" : undefined}>
            {/* The roles are said outright because a narrow list lays each row out as a grid, and a table
                that is not laid out as one would otherwise stop being read as one. */}
            <table class="rt-table rt-inbox-table" data-tab={props.tab} role="table">
              <caption class="rt-sr-only">
                {words.tableCaption(props.items.length, props.totalCount)}
              </caption>
              <thead role="rowgroup">
                <tr role="row">
                  <th scope="col" role="columnheader" class="rt-inbox-check">
                    <RowCheck
                      label={words.selectAllPage}
                      checked={
                        allSelected() ? true : visibleSelected() > 0 ? "indeterminate" : false
                      }
                      disabled={props.disabled}
                      input={{ class: "rt-inbox-checkbox" }}
                      onChange={(checked) =>
                        props.onToggle(
                          props.items.map((item) => item.id),
                          checked,
                        )
                      }
                    />
                  </th>
                  <th scope="col" role="columnheader" class="rt-inbox-col-date">
                    {words.date}
                  </th>
                  <th scope="col" role="columnheader">
                    {words.description}
                  </th>
                  <th scope="col" role="columnheader" class="rt-inbox-col-category">
                    {words.category}
                  </th>
                  <th scope="col" role="columnheader" class="amount rt-inbox-col-spent">
                    {words.spent}
                  </th>
                  <th scope="col" role="columnheader" class="amount rt-inbox-col-received">
                    {words.received}
                  </th>
                  <th scope="col" role="columnheader" class="amount rt-inbox-col-amount">
                    {words.amount}
                  </th>
                  <Show when={props.showStatus}>
                    <th scope="col" role="columnheader" class="rt-inbox-col-status">
                      {words.status}
                    </th>
                  </Show>
                  <th scope="col" role="columnheader" class="rt-inbox-col-action">
                    <span class="rt-sr-only">{words.actionsColumn}</span>
                  </th>
                </tr>
              </thead>
              <tbody
                role="rowgroup"
                ref={(element) => {
                  body = element;
                }}
                onKeyDown={onKeyDown}
              >
                <For each={props.items}>
                  {(item, index) => {
                    const inputId = `${uid}-${index()}`;
                    const out = () => isNegativeMoney(item.line.amount);
                    const rowTab = () => (index() === current() ? 0 : -1);
                    const about = () => shortened(item.line.description, 60);
                    const chosen = () => props.choices.get(item.id);
                    return (
                      <tr
                        role="row"
                        data-index={index()}
                        data-active={props.activeId === item.id ? "" : undefined}
                        data-selected={props.selected.has(item.id) ? "" : undefined}
                        // The row the keyboard or the pointer is working in is the one the keyboard
                        // moves from: its controls become the tab stops.
                        onFocusIn={() => {
                          if (props.activeId !== item.id) props.onActive(item.id);
                        }}
                        onClick={(event) => {
                          if (
                            !(event.target as HTMLElement).closest(
                              "a, button, input, .rt-account-picker",
                            )
                          ) {
                            focusRow(index());
                            props.onOpen?.(item.id);
                          }
                        }}
                      >
                        <td role="cell" class="rt-inbox-check">
                          <RowCheck
                            id={inputId}
                            label={words.selectLine(
                              formatDate(item.line.date),
                              shortened(item.line.description, 120),
                              formatMoneyAbsolute(item.line.amount),
                              out(),
                            )}
                            checked={props.selected.has(item.id)}
                            disabled={props.disabled}
                            input={{
                              class: "rt-inbox-checkbox",
                              "data-index": index(),
                              tabindex: rowTab(),
                            }}
                            onPress={(shiftKey) => {
                              shiftHeld = shiftKey;
                            }}
                            onChange={(on) => {
                              if (shiftHeld && anchor !== index()) toggleRange(anchor, index(), on);
                              else props.onToggle([item.id], on);
                              anchor = index();
                              shiftHeld = false;
                            }}
                          />
                        </td>
                        <td role="cell" class="rt-inbox-date rt-inbox-col-date">
                          <DateValue value={item.line.date} />
                        </td>
                        <td role="cell" class="rt-inbox-description">
                          <button
                            type="button"
                            class="rt-inbox-open"
                            tabindex={rowTab()}
                            onClick={() => {
                              props.onActive(item.id);
                              props.onOpen?.(item.id);
                            }}
                          >
                            <span class="rt-inbox-clamp rt-inbox-text">
                              <bdi>{item.line.description}</bdi>
                            </span>
                          </button>
                          <span class="rt-inbox-muted rt-inbox-source">
                            <span class="rt-inbox-inline-date">
                              <DateValue value={item.line.date} />
                            </span>
                            <Show when={props.showAccount}>
                              <span class="rt-inbox-account-name">
                                <span class="rt-inbox-inline-sep"> · </span>
                                <bdi>{props.accountLabel(item)}</bdi>
                              </span>
                            </Show>
                            <Show when={item.coveredBy}>
                              {(cover) => <> · {words.coveredBy(cover().providerId)}</>}
                            </Show>
                            <Show when={item.reconciled}>
                              {(mark) => (
                                <>
                                  {" · "}
                                  <ReconciledMark statementDate={mark().statementDate} />
                                </>
                              )}
                            </Show>
                          </span>
                          <Show when={item.status === "drafted" ? item.postError : undefined}>
                            {(reason) => (
                              <span class="rt-inbox-refused" role="note">
                                <TriangleAlert aria-hidden="true" />
                                <span>{words.postRefused(reason())}</span>
                              </span>
                            )}
                          </Show>
                          <FlagList flags={item.flags} currency={item.line.currency} compact />
                        </td>
                        <td role="cell" class="rt-inbox-col-category">
                          <Show
                            when={hasCategoryField(item)}
                            fallback={
                              <CategoryText item={item} category={props.categoryOf(item)} />
                            }
                          >
                            <AccountPicker
                              quiet
                              hideLabel
                              label={words.categoryFor(about())}
                              placeholder={words.chooseCategory}
                              accounts={offered()(item.ledgerAccountId)}
                              value={chosen() ?? suggestedCategory(item) ?? ""}
                              tabIndex={rowTab()}
                              disabled={props.disabled ?? false}
                              onChange={(id) => props.onChoose(item.id, id)}
                            />
                          </Show>
                        </td>
                        <td role="cell" class="amount rt-inbox-col-spent">
                          <Show when={out()}>
                            <Absolute amount={item.line.amount} />
                          </Show>
                        </td>
                        <td role="cell" class="amount rt-inbox-col-received">
                          <Show when={!out()}>
                            <Absolute amount={item.line.amount} />
                          </Show>
                        </td>
                        <td role="cell" class="amount rt-inbox-col-amount">
                          <Absolute amount={item.line.amount} signed />
                        </td>
                        <Show when={props.showStatus}>
                          <td role="cell" class="rt-inbox-col-status">
                            <StatusChip status={item.status} covered={Boolean(item.coveredBy)} />
                          </td>
                        </Show>
                        <td role="cell" class="rt-inbox-col-action">
                          <RowButton
                            item={item}
                            chosen={chosen()}
                            canUndo={props.canUndo ?? false}
                            disabled={props.disabled ?? false}
                            tabIndex={rowTab()}
                            onAction={(action) => props.onAction(action, [item.id])}
                          />
                        </td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Show>
    </div>
  );
}
