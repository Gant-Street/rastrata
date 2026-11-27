import { Tabs as ArkTabs } from "@ark-ui/solid/tabs";
import { For, type JSX } from "solid-js";

export type TabItem = { value: string; label: string; content: JSX.Element; disabled?: boolean };

/** Arrow keys move between related views of the same thing. Tabs are not primary navigation. */
export function Tabs(props: {
  items: readonly TabItem[];
  /** Names the tab list for assistive technology. */
  label?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
}) {
  return (
    <ArkTabs.Root
      class="rt-tabs"
      {...(props.value !== undefined ? { value: props.value } : {})}
      defaultValue={props.defaultValue ?? props.items[0]?.value ?? ""}
      onValueChange={(detail) => props.onChange?.(detail.value)}
    >
      <ArkTabs.List aria-label={props.label}>
        <For each={props.items}>
          {(item) => (
            <ArkTabs.Trigger value={item.value} disabled={item.disabled ?? false}>
              {item.label}
            </ArkTabs.Trigger>
          )}
        </For>
      </ArkTabs.List>
      <For each={props.items}>
        {(item) => <ArkTabs.Content value={item.value}>{item.content}</ArkTabs.Content>}
      </For>
    </ArkTabs.Root>
  );
}
