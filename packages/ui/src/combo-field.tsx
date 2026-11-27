import { Combobox, createListCollection } from "@ark-ui/solid/combobox";
import { createMemo, createSignal, createUniqueId, For, type JSX, Show } from "solid-js";
import { buttonAttrs } from "./button";
import { FieldError, FieldHint } from "./field";
import { ChevronDown } from "./icons";

/** A box to type in with a short list of the usual answers under it: Ark's combobox, taking what is typed as
 * well as what is chosen. It is for a value that has more right answers than a list should hold (a time zone:
 * eight are usual, hundreds are valid), where the screen says what is wrong with one it cannot use. For a
 * choice among the listed things only, use `SelectField`; for an account, `AccountPicker`.
 *
 * Typing narrows the list to what holds the words typed; opening it with its button shows it whole. The value
 * is the words in the box, whether typed or chosen, so the box says what is chosen and the list ticks nothing. */
export function ComboField(props: {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  /** The words in the box. */
  value: string;
  onChange: (value: string) => void;
  /** The usual answers, in the order to list them. */
  items: readonly string[];
  /** What the button that opens the list is called, for assistive technology ("List of zones"). */
  showLabel: string;
  disabled?: boolean | undefined;
  /** The box's id, for a page that points at the field (an error summary). */
  id?: string | undefined;
}): JSX.Element {
  const generated = createUniqueId();
  const id = props.id ?? generated;
  const [query, setQuery] = createSignal("");
  const matches = createMemo(() => {
    const typed = query().trim().toLowerCase();
    return typed === ""
      ? [...props.items]
      : props.items.filter((item) => item.toLowerCase().includes(typed));
  });
  const collection = createMemo(() => createListCollection<string>({ items: matches() }));
  const describedBy = () =>
    [props.hint && `${id}-hint`, props.error && `${id}-error`].filter(Boolean).join(" ") ||
    undefined;
  return (
    <Combobox.Root
      // The box and its button look like the account picker's: one box with the chevron inside it.
      class="rt-field rt-account-picker rt-combo-field"
      collection={collection()}
      allowCustomValue
      openOnClick
      lazyMount
      unmountOnExit
      selectionBehavior="replace"
      positioning={{ strategy: "fixed", sameWidth: true, hideWhenDetached: true }}
      disabled={props.disabled ?? false}
      invalid={Boolean(props.error)}
      ids={{ input: id }}
      inputValue={props.value}
      // Only typing narrows the list. When the words are put there (a choice was made) the list is whole again.
      onInputValueChange={(detail) => {
        setQuery(detail.reason === "input-change" ? detail.inputValue : "");
        if (detail.inputValue !== props.value) props.onChange(detail.inputValue);
      }}
    >
      <Combobox.Label>{props.label}</Combobox.Label>
      <Combobox.Control class="rt-control">
        <Combobox.Input
          class="rt-input"
          autocomplete="off"
          spellcheck={false}
          aria-describedby={describedBy()}
        />
        <Combobox.Trigger
          {...buttonAttrs({ variant: "secondary", iconOnly: true })}
          aria-label={props.showLabel}
          onClick={() => setQuery("")}
        >
          <ChevronDown aria-hidden="true" />
        </Combobox.Trigger>
      </Combobox.Control>
      <Show when={props.hint}>
        <FieldHint id={`${id}-hint`}>{props.hint}</FieldHint>
      </Show>
      <Show when={props.error}>
        <FieldError id={`${id}-error`}>{props.error}</FieldError>
      </Show>
      <Combobox.Positioner>
        {/* Nothing listed is no list: what is typed is the answer, and an empty box under the field would say
            there is something to choose. Pressing in the list keeps focus in the field. */}
        <div
          class="rt-popup rt-account-popup"
          hidden={matches().length === 0}
          onPointerDown={(event) => event.preventDefault()}
        >
          <Combobox.Content class="rt-account-list">
            <For each={matches()}>
              {(item) => (
                <Combobox.Item class="rt-item" item={item}>
                  <Combobox.ItemText>{item}</Combobox.ItemText>
                </Combobox.Item>
              )}
            </For>
          </Combobox.Content>
        </div>
      </Combobox.Positioner>
    </Combobox.Root>
  );
}
