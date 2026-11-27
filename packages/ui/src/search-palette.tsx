import { Dialog as ArkDialog } from "@ark-ui/solid/dialog";
import { createListCollection, Listbox } from "@ark-ui/solid/listbox";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  on,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import { buttonAttrs } from "./button";
import { Search, X } from "./icons";
import { shellWords } from "./shell-words";

/** One thing a search found. The palette shows `label` and `detail` and gives the whole hit back when it
 * is chosen; where it goes is the application's business. */
export interface SearchHitView {
  readonly id: string;
  readonly label: string;
  readonly detail?: string | undefined;
  readonly kind: "transaction" | "review" | "account" | "page" | "action";
}

/** The results of one source, under its own heading. A group still being read, or one that could not
 * be, says so in the status line; it never blocks the others. */
export interface SearchGroupView {
  readonly id: string;
  readonly label: string;
  readonly hits: readonly SearchHitView[];
  readonly state: "loading" | "ready" | "error";
}

export type SearchWords = {
  readonly [K in keyof typeof shellWords.search]: (typeof shellWords.search)[K];
};

const hasHits = (group: SearchGroupView): boolean => group.hits.length > 0;

/** One result and the source it came from. */
type Entry = { readonly group: SearchGroupView; readonly hit: SearchHitView };

/**
 * Search and jump: a dialog with one box and the results of every source under their own headings. It is
 * Ark's listbox with its input, inside Ark's dialog: focus stays in the box, the arrow keys move a
 * highlighted result (wrapping at the ends), Enter opens it, Escape closes the dialog and gives focus back
 * to where it was. The first result is highlighted until someone moves, so typing and pressing Enter is
 * the fast path.
 *
 * The palette only draws. The application owns the sources, the debounce and what choosing a result does.
 */
export function SearchPalette(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQuery: (query: string) => void;
  groups: readonly SearchGroupView[];
  onChoose: (group: SearchGroupView, hit: SearchHitView) => void;
  words?: Partial<SearchWords> | undefined;
}): JSX.Element {
  const words = (): SearchWords => ({ ...shellWords.search, ...props.words });
  const uid = createUniqueId();
  const optionId = (group: string, hit: string) => `${uid}-${group}-${hit}`;
  let input: HTMLInputElement | undefined;

  const visible = createMemo(() => props.groups.filter(hasHits));
  /** Every result in the order it is drawn, so the arrow keys have one line to walk. */
  const flat = createMemo<Entry[]>(() =>
    visible().flatMap((group) => group.hits.map((hit) => ({ group, hit }))),
  );
  // The highlighted result is remembered by identity, so a source that answers late and adds results
  // above it does not move the highlight under someone's finger. Until a key or the pointer chooses,
  // it is simply the first.
  const [chosenKey, setChosenKey] = createSignal<string | null>(null);
  const keyOf = (entry: Entry) => optionId(entry.group.id, entry.hit.id);
  /** The results as the listbox walks them. */
  const collection = createMemo(() =>
    createListCollection({
      items: flat(),
      itemToValue: keyOf,
      itemToString: (entry) => entry.hit.label,
    }),
  );
  const activeIndex = createMemo(() => {
    const key = chosenKey();
    if (key === null) return flat().length > 0 ? 0 : -1;
    const at = flat().findIndex((entry) => keyOf(entry) === key);
    return at >= 0 ? at : flat().length > 0 ? 0 : -1;
  });
  const active = () => flat()[activeIndex()];
  const activeKey = (): string | undefined => {
    const entry = active();
    return entry ? keyOf(entry) : undefined;
  };
  // A new question starts from the top again.
  createEffect(
    on(
      () => props.query,
      () => setChosenKey(null),
      { defer: true },
    ),
  );
  createEffect(
    on(
      () => props.open,
      () => setChosenKey(null),
    ),
  );
  const pending = () => props.groups.some((group) => group.state === "loading");
  const failed = () => props.groups.filter((group) => group.state === "error");
  const status = (): string => {
    if (pending() && flat().length === 0) return words().searching;
    if (flat().length > 0) return words().found(flat().length);
    if (props.query.trim() !== "") return words().none(props.query.trim());
    return "";
  };

  return (
    <ArkDialog.Root
      open={props.open}
      onOpenChange={(detail) => props.onOpenChange(detail.open)}
      initialFocusEl={() => input ?? null}
      lazyMount
      unmountOnExit
    >
      <Portal>
        <ArkDialog.Backdrop class="rt-backdrop" />
        <ArkDialog.Positioner class="rt-positioner rt-search-positioner">
          <ArkDialog.Content class="rt-search rt-theme">
            <ArkDialog.Title class="rt-sr-only">{words().title}</ArkDialog.Title>
            {/* Nothing stays chosen: choosing a result opens it. What is highlighted is ours to say (the
                first, until someone moves), and Ark moves it with the keys and the pointer. */}
            <Listbox.Root
              class="rt-search-list"
              collection={collection()}
              value={[]}
              highlightedValue={activeKey() ?? null}
              onHighlightChange={(detail) => {
                if (detail.highlightedValue !== null) setChosenKey(detail.highlightedValue);
              }}
              onSelect={(detail) => {
                const entry = flat().find((item) => keyOf(item) === detail.value);
                if (entry) props.onChoose(entry.group, entry.hit);
              }}
              loopFocus
              typeahead={false}
            >
              <div class="rt-search-field">
                <Search aria-hidden="true" />
                <Listbox.Input
                  ref={(element) => {
                    input = element;
                  }}
                  class="rt-search-input"
                  type="text"
                  role="combobox"
                  aria-label={words().label}
                  aria-expanded={flat().length > 0}
                  placeholder={words().placeholder}
                  value={props.query}
                  onInput={(event) => props.onQuery(event.currentTarget.value)}
                />
                <ArkDialog.CloseTrigger
                  {...buttonAttrs({ variant: "quiet", iconOnly: true, size: "sm" })}
                  aria-label={words().close}
                >
                  <X aria-hidden="true" />
                </ArkDialog.CloseTrigger>
              </div>
              <div class="rt-search-body">
                <Listbox.Label class="rt-sr-only">{words().results}</Listbox.Label>
                {/* The list is reached with the arrow keys from the box, so it is no tab stop of its own. */}
                <Listbox.Content
                  class="rt-search-results"
                  tabIndex={-1}
                  hidden={flat().length === 0}
                >
                  <For each={visible()}>
                    {(group) => (
                      <Listbox.ItemGroup class="rt-search-group">
                        <Listbox.ItemGroupLabel class="rt-search-group-label">
                          {group.label}
                        </Listbox.ItemGroupLabel>
                        <For each={group.hits}>
                          {(hit) => {
                            const id = optionId(group.id, hit.id);
                            return (
                              <Listbox.Item
                                item={{ group, hit }}
                                highlightOnHover
                                class="rt-search-option"
                                data-kind={hit.kind}
                                // The option the box points at is the selected one, as a combobox says it.
                                aria-selected={activeKey() === id}
                              >
                                <span class="rt-search-option-label">{hit.label}</span>
                                <Show when={hit.detail}>
                                  <span class="rt-search-option-detail">{hit.detail}</span>
                                </Show>
                              </Listbox.Item>
                            );
                          }}
                        </For>
                      </Listbox.ItemGroup>
                    )}
                  </For>
                </Listbox.Content>
                <Show when={flat().length === 0 && !pending() && props.query.trim() !== ""}>
                  <p class="rt-search-empty">{words().none(props.query.trim())}</p>
                </Show>
                <Show when={pending() && flat().length === 0}>
                  <p class="rt-search-empty">{words().searching}</p>
                </Show>
                <Show when={failed().length > 0}>
                  <p class="rt-search-failed">
                    {failed()
                      .map((group) => words().failedSource(group.label))
                      .join(" ")}
                  </p>
                </Show>
                <p class="rt-sr-only" role="status">
                  {status()}
                </p>
              </div>
            </Listbox.Root>
            <p class="rt-search-legend" aria-hidden="true">
              <span>
                <kbd>↑</kbd> <kbd>↓</kbd> {words().footerMove}
              </span>
              <span>
                <kbd>Enter</kbd> {words().footerOpen}
              </span>
              <span>
                <kbd>Esc</kbd> {words().footerClose}
              </span>
            </p>
          </ArkDialog.Content>
        </ArkDialog.Positioner>
      </Portal>
    </ArkDialog.Root>
  );
}
