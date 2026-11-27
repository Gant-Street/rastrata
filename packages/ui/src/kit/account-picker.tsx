import { Combobox, createListCollection } from "@ark-ui/solid/combobox";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  on,
  onCleanup,
  Show,
  untrack,
  type JSX,
} from "solid-js";
import { buttonAttrs } from "../button";
import { FieldError } from "../field";
import { Check, ChevronDown, Plus } from "../icons";
import { useUi } from "../locale";
import { type AccountOption, groupedInOrder, matchAccounts, offeredAccounts } from "./accounts";
import { guardLateRefocus } from "./late-refocus";

export type { AccountOption } from "./accounts";

/** The one entry that is not an account: "New account…" at the foot of the list. Its value cannot be an
 * account's id, so choosing it can never be mistaken for choosing an account. */
const CREATE = "\u0000new-account";
/** The other: "All accounts" at the head of a filter's list. It stands for no account, so choosing it gives
 * the empty id, and it is what the box shows while nothing is chosen. */
const ALL = "\u0000all-accounts";
type Entry = AccountOption & { readonly create?: true; readonly all?: true };

export interface AccountPickerProps {
  /** The accounts to choose from. A group account (`isGroup`) is not offered unless `allowGroups`. */
  accounts: readonly AccountOption[];
  /** The id of the box (the input), for a screen that links to it: an `ErrorSummary` link does
   * `document.getElementById(id).focus()`. The label's `for` follows it, so the label still names the field.
   * Left out, the picker makes its own. */
  id?: string | undefined;
  /** The chosen account's id. It is adopted whenever it changes, so a reset or a new draft reaches the
   * control; `onChange` is how the choice leaves it. */
  value?: string | undefined;
  onChange?: ((id: string) => void) | undefined;
  /** What the field is called. Default "Account". */
  label?: string | undefined;
  /** What is wrong with the choice, in words: shown beside the field and said with it. */
  error?: string | undefined;
  /** What to choose, in one sentence in the page's own words, while nothing is chosen; the kit's words otherwise. */
  hint?: string | undefined;
  /** Offer "New account…" at the foot of the list. It is called with what was typed, so the form it opens
   * can start with that as the name. Nothing is chosen; the screen adds the account and passes its id in as
   * the new `value`. */
  onCreate?: ((typed: string) => void) | undefined;
  /** Offer group accounts too (for a report filter, say, where a group stands for all it holds). */
  allowGroups?: boolean | undefined;
  /** For a filter: "All accounts". The list starts with this as its first entry; choosing it calls
   * `onChange("")`, and while the value is empty the box says it, so a filter can be cleared and a cleared
   * filter reads as what it is. Nothing under the box says "choose a posting account" then. Leave it out
   * for a form, where an account has to be chosen. */
  allLabel?: string | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Keep the label for assistive technology only, where a column heading or a row already names it. */
  hideLabel?: boolean | undefined;
  /** For a dense row (a line of a journal): no line under the box saying where the chosen account sits,
   * and the box fills its cell. The code is still muted inside each option. A chosen account that no longer
   * exists is still said, because that is not a detail. */
  compact?: boolean | undefined;
  /** For a row of a list (a transaction's category): what is chosen reads as text with a chevron, and the box
   * is a field only while nothing is chosen or while it is being changed. A click opens the list, the text is
   * selected when the box takes focus (so typing replaces it), and the list of accounts is made when it opens,
   * so fifty rows are not fifty lists. Nothing is said under the box. */
  quiet?: boolean | undefined;
  /** What the empty box says ("Choose a category"); the kit's words otherwise. */
  placeholder?: string | undefined;
  /** The box's place in the tab order: a row's controls are tab stops only on the row the keyboard is on. */
  tabIndex?: number | undefined;
  state?: "ready" | "loading" | "error" | undefined;
}

/** The one account picker for the whole application. A combobox that matches what is typed against the
 * name, the code and where the account sits, in any order ("bus chec" finds "Business checking", "6100"
 * finds the account numbered 6100), shows the name first and the code muted after it, never offers a group
 * account, and can end with "New account…".
 *
 * It keeps everything the three pickers it replaces did well: Ark owns the keyboard (type to filter, the
 * arrows to move, Enter to choose, Escape to close), the option ids come from position so an account id with
 * a space or a quote cannot break a description, a chosen account that is no longer in the list is kept and
 * said so until it is replaced on purpose, and loading, failure and no match are three different words. */
export function AccountPicker(props: AccountPickerProps): JSX.Element {
  const ui = useUi();
  const m = () => ui.messages.account;
  const id = createUniqueId();
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal(props.value ?? "");
  // An external change (a form reset, a different saved draft, an account just created) must reach the
  // control, and so must one made in the same tick the picker was created: a parent that sets the value as it
  // mounts changes it after the picker was made and before this first runs. So the first run is not skipped
  // (a deferred one would take that value as the baseline and never apply it): it applies what the value is
  // now, and does nothing when that is what was already taken.
  createEffect(() => {
    const value = props.value ?? "";
    untrack(() => {
      if (value !== selected()) setSelected(value);
    });
  });

  const offered = createMemo(() => offeredAccounts(props.accounts, props.allowGroups === true));
  const current = () => props.accounts.find((item) => item.value === selected());
  // Not while the chart is still being read: an account that has not arrived yet is not an account that is gone.
  const unavailable = () => ready() && selected() !== "" && current() === undefined;
  const ready = () => props.state === undefined || props.state === "ready";
  const matches = createMemo(() => (ready() ? matchAccounts(offered(), query()) : []));
  // "All accounts" heads the list while what is typed could be it (nothing typed, or "all").
  const allEntry = createMemo<Entry | undefined>(() => {
    const label = props.allLabel;
    if (label === undefined) return undefined;
    const entry: Entry = { value: ALL, label, all: true };
    return query() === "" || matchAccounts([entry], query()).length > 0 ? entry : undefined;
  });
  const entries = createMemo<Entry[]>(() => {
    const first = allEntry();
    // The accounts in the order the list shows them (see groupedInOrder), so the arrow keys follow the screen.
    const list: Entry[] = [...(first ? [first] : []), ...groupedInOrder(matches())];
    if (props.onCreate && ready()) list.push({ value: CREATE, label: m().create, create: true });
    return list;
  });
  /** What the box says for the choice: the account's name, or "All accounts" while a filter has none. */
  const boxText = () => current()?.label ?? (selected() === "" ? (props.allLabel ?? "") : "");
  // Choosing "New account…" must leave the box saying what it said: its text is the current choice's.
  const collection = createMemo(() =>
    createListCollection<Entry>({
      items: entries(),
      itemToString: (item) => (item.create ? boxText() : item.label),
    }),
  );
  // Account IDs are data, not identifiers: option ids come from list position so a space or a quote in an
  // ID can never break the aria-describedby reference.
  const optionId = (item: Entry) =>
    `${id}-option-${entries().findIndex((entry) => entry.value === item.value)}`;
  const headings = () => [...new Set(matches().map((item) => item.group ?? ""))];
  const detail = () => {
    const account = current();
    if (!account) return undefined;
    return [account.code, account.path].filter(Boolean).join(" · ");
  };
  const [open, setOpen] = createSignal(false);
  // Ark gives the box focus from a frame of its own, when the list opens and when it closes. Focus is settled
  // here instead, when the choice is made, and a late call from Ark is dropped when a person (or a test) has
  // already moved on to the next field: what they type next goes there and not into the box. See
  // `guardLateRefocus`.
  let root: HTMLElement | undefined;
  let box: HTMLInputElement | undefined;
  let lateRefocus: ReturnType<typeof guardLateRefocus> | undefined;
  onCleanup(() => lateRefocus?.dispose());
  const settleFocus = () => {
    if (box && box.ownerDocument.activeElement !== box && !lateRefocus?.heldElsewhere())
      box.focus({ preventScroll: true });
  };
  /** The words for a list with nothing to show, or "" when it has accounts. */
  const status = () =>
    props.state === "loading"
      ? m().loading
      : props.state === "error"
        ? m().loadError
        : matches().length > 0 || (query() !== "" && allEntry() !== undefined)
          ? ""
          : props.accounts.length === 0
            ? m().none
            : m().noMatch;
  const hint = () =>
    unavailable()
      ? m().unavailable(selected())
      : selected() === ""
        ? (props.hint ??
          (props.allLabel !== undefined ? "" : props.allowGroups ? m().chooseAny : m().choose))
        : (detail() ?? "");
  const dense = () => props.compact === true || props.quiet === true;
  const showHint = () => (!dense() || unavailable()) && hint() !== "";

  return (
    <Combobox.Root
      ref={(element: HTMLElement) => {
        root = element;
      }}
      class="rt-field rt-account-picker"
      data-compact={dense() ? "" : undefined}
      data-quiet={props.quiet ? "" : undefined}
      data-empty={selected() === "" ? "" : undefined}
      collection={collection()}
      // A row's picker makes its list when it opens and lets it go when it closes.
      {...(props.quiet === true ? { lazyMount: true, unmountOnExit: true, openOnClick: true } : {})}
      positioning={{ strategy: "fixed", hideWhenDetached: true }}
      disabled={props.disabled ?? false}
      invalid={Boolean(props.error)}
      value={selected() ? [selected()] : props.allLabel !== undefined ? [ALL] : []}
      // Ark would build option ids from the account ID itself; position-based ids stay valid however an
      // account is named.
      ids={{
        item: (_value, index) => `${id}-item-${index ?? 0}`,
        // A screen that links to the field by id (an error summary) sets it here, so the input's id and the
        // label's `for` move together and the label keeps naming the field.
        ...(props.id ? { input: props.id } : {}),
      }}
      // Only typing filters the list. When the text is put there (a choice was made, the box was reset, focus
      // left it) the list is whole again, so opening it shows every account and not just the chosen one.
      onInputValueChange={(detail) =>
        setQuery(detail.reason === "input-change" ? detail.inputValue : "")
      }
      onOpenChange={(detail) => {
        setOpen(detail.open);
        lateRefocus?.listChanged();
      }}
      onValueChange={(detail) => {
        // Before anything of the screen's runs: a handler that moves focus on (to the next field, to a drawer)
        // is not undone by what comes after.
        settleFocus();
        const value = detail.value[0] ?? "";
        if (value === CREATE) {
          props.onCreate?.(query().trim());
          return;
        }
        // "All accounts" is no account: choosing it clears the choice.
        const chosen = value === ALL ? "" : value;
        setSelected(chosen);
        props.onChange?.(chosen);
      }}
    >
      <Combobox.Context>
        {(api) => {
          // Accounts that arrive after the box was made (a saved line is on screen while the chart is read)
          // leave it with no name to show for the chosen account. When the account appears, or is renamed,
          // the box takes its name, and never while a person is typing.
          createEffect(
            on(
              () => current()?.label,
              (label) => {
                if (label !== undefined && query() === "" && api().inputValue !== label)
                  api().setInputValue(label);
              },
            ),
          );
          return null;
        }}
      </Combobox.Context>
      <Combobox.Label class={props.hideLabel ? "rt-sr-only" : undefined}>
        {props.label ?? m().label}
      </Combobox.Label>
      <Combobox.Control class="rt-control">
        <Combobox.Input
          ref={(element: HTMLInputElement) => {
            box = element;
            lateRefocus = guardLateRefocus(element, () => root);
          }}
          class="rt-input"
          placeholder={props.placeholder ?? m().placeholder}
          tabindex={props.tabIndex}
          onFocus={(event) => {
            if (props.quiet) event.currentTarget.select();
          }}
          aria-describedby={
            [showHint() ? `${id}-context` : undefined, props.error ? `${id}-error` : undefined]
              .filter(Boolean)
              .join(" ") || undefined
          }
        />
        <Combobox.Trigger
          {...buttonAttrs({ variant: "secondary", iconOnly: true })}
          aria-label={m().show}
          onClick={() => setQuery("")}
        >
          <ChevronDown aria-hidden="true" />
        </Combobox.Trigger>
      </Combobox.Control>
      <Show when={showHint()}>
        <p id={`${id}-context`} class="rt-hint">
          {hint()}
        </p>
      </Show>
      <Show when={props.error}>
        <FieldError id={`${id}-error`}>{props.error}</FieldError>
      </Show>
      <Combobox.Positioner>
        {/* The popup's box. What the open list says when it has no accounts to show (reading, failed,
            none yet, no match) is a status line in the box and not in the listbox, which may hold only
            options. Pressing in the box keeps focus in the field, as it does in the list. */}
        <div
          class="rt-popup rt-account-popup"
          hidden={!open()}
          onPointerDown={(event) => event.preventDefault()}
        >
          <Show when={status()}>
            <p class="rt-hint" role="status">
              {status()}
            </p>
          </Show>
          <Combobox.Content class="rt-account-list">
            <Show when={allEntry()}>
              {(entry) => (
                <Combobox.Item
                  class="rt-item rt-account-all"
                  item={entry()}
                  aria-label={entry().label}
                >
                  <Combobox.ItemText>{entry().label}</Combobox.ItemText>
                  <Combobox.ItemIndicator>
                    <Check aria-hidden="true" />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Show>
            <For each={headings()}>
              {(heading) => (
                <Combobox.ItemGroup>
                  <Show when={heading !== ""}>
                    <Combobox.ItemGroupLabel class="rt-account-group">
                      {heading}
                    </Combobox.ItemGroupLabel>
                  </Show>
                  <For each={matches().filter((item) => (item.group ?? "") === heading)}>
                    {(item) => (
                      <Combobox.Item
                        class="rt-item"
                        item={item}
                        aria-label={item.code ? `${item.label}, ${item.code}` : item.label}
                        aria-describedby={optionId(item)}
                      >
                        <div>
                          <Combobox.ItemText>{item.label}</Combobox.ItemText>
                          <Show when={item.code}>
                            <span class="rt-account-code">{item.code}</span>
                          </Show>
                          <small id={optionId(item)} class="rt-account-path">
                            {item.path}
                            {item.reason ? `${item.path ? " · " : ""}${item.reason}` : ""}
                          </small>
                        </div>
                        <Combobox.ItemIndicator>
                          <Check aria-hidden="true" />
                        </Combobox.ItemIndicator>
                      </Combobox.Item>
                    )}
                  </For>
                </Combobox.ItemGroup>
              )}
            </For>
            <Show when={props.onCreate && ready()}>
              <Combobox.Item class="rt-item rt-account-create" item={entries().at(-1) as Entry}>
                <span>
                  <Plus aria-hidden="true" />
                  <Combobox.ItemText>{m().create}</Combobox.ItemText>
                </span>
              </Combobox.Item>
            </Show>
          </Combobox.Content>
        </div>
      </Combobox.Positioner>
    </Combobox.Root>
  );
}
