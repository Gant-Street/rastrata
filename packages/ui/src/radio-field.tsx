import { RadioGroup } from "@ark-ui/solid/radio-group";
import { For, type JSX, Show } from "solid-js";

export type RadioItem = {
  value: string;
  label: string;
  /** A second, quieter line under the label: what choosing it means. */
  hint?: string | undefined;
  disabled?: boolean | undefined;
};

/** One from a few, all of them in sight. Ark owns the behavior (the arrow keys move and choose); callers own
 * the value. A longer list, or one that need not be read until asked for, is `SelectField`. */
export function RadioField(props: {
  label: string;
  items: readonly RadioItem[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean | undefined;
  /** Sent with a form under this name. */
  name?: string | undefined;
  class?: string | undefined;
}): JSX.Element {
  return (
    <RadioGroup.Root
      class={props.class ? `rt-radio-field ${props.class}` : "rt-radio-field"}
      value={props.value}
      disabled={props.disabled ?? false}
      {...(props.name ? { name: props.name } : {})}
      onValueChange={(detail) => {
        if (detail.value !== null && detail.value !== props.value) props.onChange(detail.value);
      }}
    >
      <RadioGroup.Label class="rt-radio-field-label">{props.label}</RadioGroup.Label>
      <For each={props.items}>
        {(item) => (
          <RadioGroup.Item
            class="rt-choice"
            value={item.value}
            disabled={item.disabled ?? false}
            data-hint={item.hint ? "" : undefined}
          >
            <RadioGroup.ItemControl />
            <RadioGroup.ItemText>
              {item.label}
              <Show when={item.hint}>
                <small class="rt-choice-hint">{item.hint}</small>
              </Show>
            </RadioGroup.ItemText>
            <RadioGroup.ItemHiddenInput />
          </RadioGroup.Item>
        )}
      </For>
    </RadioGroup.Root>
  );
}
