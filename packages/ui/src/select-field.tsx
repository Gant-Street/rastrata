import { createListCollection, Select } from "@ark-ui/solid/select";
import { createMemo, createUniqueId, For, Show, type JSX } from "solid-js";
import { FieldError, FieldHint } from "./field";
import { Check, ChevronDown } from "./icons";
import { useUi } from "./locale";

export type SelectItem = {
  label: string;
  value: string;
  disabled?: boolean | undefined;
  /** A heading over this item and its neighbours with the same one ("Income", "Expenses"). Items of a group are
   * given together. */
  group?: string | undefined;
};

export type SelectFieldProps = {
  label: string;
  items: readonly SelectItem[];
  /** Controlled value. Omit it (and use `defaultValue`) for an uncontrolled field. */
  value?: string | undefined;
  defaultValue?: string | undefined;
  onChange?: ((value: string) => void) | undefined;
  placeholder?: string | undefined;
  hint?: string | undefined;
  error?: string | undefined;
  disabled?: boolean | undefined;
  required?: boolean | undefined;
  /** Sent with a form under this name. Only then is there a form control behind the list. */
  name?: string | undefined;
  /** The trigger's id, for a page that points at the field (an error summary, a step's first field). */
  id?: string | undefined;
  /** Keep the label for assistive technology only, where what is chosen already says what the field is
   * ("All accounts" in a list's toolbar, a row of a table). */
  hideLabel?: boolean | undefined;
  /** Beside the label: a tag that says the field is optional, a help button. */
  aside?: JSX.Element;
  /** Ids of text elsewhere on the page that describes the field (why it is off, a status under it). */
  describedBy?: string | undefined;
  /** Shown when the pointer rests on the field: why it is off. */
  title?: string | undefined;
  class?: string | undefined;
};

type Group = { heading: string; items: SelectItem[] };

/** The items in the order given, cut where the heading changes. */
function grouped(items: readonly SelectItem[]): Group[] {
  const groups: Group[] = [];
  for (const item of items) {
    const heading = item.group ?? "";
    const last = groups[groups.length - 1];
    if (last && last.heading === heading) last.items.push(item);
    else groups.push({ heading, items: [item] });
  }
  return groups;
}

/** Choose one from a known list. Ark owns the behavior; callers own the value. The list itself is in the page
 * only while it is open, so a table with a field on every row costs a button a row. */
export function SelectField(props: SelectFieldProps) {
  const ui = useUi();
  const generated = createUniqueId();
  const id = props.id ?? generated;
  // Rebuilt when items change, so options that load later are never stale.
  const collection = createMemo(() => createListCollection({ items: [...props.items] }));
  const describedBy = () =>
    [props.describedBy, props.hint && `${id}-hint`, props.error && `${id}-error`]
      .filter(Boolean)
      .join(" ") || undefined;
  const groups = createMemo(() => grouped(collection().items));
  const label = () => (
    <Select.Label class={props.hideLabel ? "rt-sr-only" : undefined}>{props.label}</Select.Label>
  );
  const option = (item: SelectItem) => (
    <Select.Item item={item} class="rt-item">
      <Select.ItemText>{item.label}</Select.ItemText>
      <Select.ItemIndicator>
        <Check aria-hidden="true" />
      </Select.ItemIndicator>
    </Select.Item>
  );
  return (
    <Select.Root
      class={props.class ? `rt-field ${props.class}` : "rt-field"}
      collection={collection()}
      title={props.title}
      lazyMount
      unmountOnExit
      {...(props.id ? { ids: { trigger: props.id } } : {})}
      disabled={props.disabled ?? false}
      required={props.required ?? false}
      invalid={Boolean(props.error)}
      {...(props.name ? { name: props.name } : {})}
      {...(props.value !== undefined ? { value: [props.value] } : {})}
      {...(props.defaultValue !== undefined ? { defaultValue: [props.defaultValue] } : {})}
      onValueChange={(detail) => props.onChange?.(detail.value[0] ?? "")}
    >
      <Show when={props.aside} fallback={label()}>
        <div class="rt-label-row">
          {label()}
          {props.aside}
        </div>
      </Show>
      <Select.Control>
        <Select.Context>
          {(api) => (
            <Select.Trigger
              class="rt-input rt-control rt-select-trigger"
              aria-describedby={describedBy()}
              // What is chosen, as the page was given it: a stylesheet or a test can tell without the words.
              data-value={api().value[0] ?? ""}
            >
              <Select.ValueText placeholder={props.placeholder ?? ui.messages.select.placeholder} />
              <Select.Indicator>
                <ChevronDown aria-hidden="true" />
              </Select.Indicator>
            </Select.Trigger>
          )}
        </Select.Context>
      </Select.Control>
      <Show when={props.hint}>
        <FieldHint id={`${id}-hint`}>{props.hint}</FieldHint>
      </Show>
      <Show when={props.error}>
        <FieldError id={`${id}-error`}>{props.error}</FieldError>
      </Show>
      <Select.Positioner>
        <Select.Content class="rt-popup">
          <For each={groups()}>
            {(group) => (
              <Show when={group.heading !== ""} fallback={<For each={group.items}>{option}</For>}>
                <Select.ItemGroup>
                  {/* The heading the account picker's groups have. */}
                  <Select.ItemGroupLabel class="rt-account-group">
                    {group.heading}
                  </Select.ItemGroupLabel>
                  <For each={group.items}>{option}</For>
                </Select.ItemGroup>
              </Show>
            )}
          </For>
        </Select.Content>
      </Select.Positioner>
      <Show when={props.name}>
        <Select.HiddenSelect />
      </Show>
    </Select.Root>
  );
}
