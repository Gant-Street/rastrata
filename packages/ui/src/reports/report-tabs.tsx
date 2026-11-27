import { Tabs as ArkTabs } from "@ark-ui/solid/tabs";
import { For, type JSX, Show } from "solid-js";

export interface ReportTabItem {
  readonly value: string;
  readonly label: string;
}

/** The statements as tabs, with the row of choices between the tabs and the statement: the tabs are
 * the first row of the toolbar and the dates, the comparison, how the figures are laid out and Export
 * are the second, so the table comes straight after them. Arrow keys move between the tabs, as they do
 * everywhere; the choices stay where they are while the tab changes, so what a person picked is still
 * picked on the next statement.
 *
 * Only the statement on screen is built (`panel` is called for it alone), so the others are neither
 * read nor laid out. */
export function ReportTabs(props: {
  /** Names the tab list for assistive technology. */
  label: string;
  value: string;
  items: readonly ReportTabItem[];
  onChange: (value: string) => void;
  /** The row of choices under the tabs. */
  controls: JSX.Element;
  panel: (value: string) => JSX.Element;
}) {
  return (
    <ArkTabs.Root
      class="rt-tabs rt-report-tabs"
      value={props.value}
      onValueChange={(detail) => props.onChange(detail.value)}
    >
      <ArkTabs.List aria-label={props.label}>
        <For each={props.items}>
          {(item) => <ArkTabs.Trigger value={item.value}>{item.label}</ArkTabs.Trigger>}
        </For>
      </ArkTabs.List>
      {props.controls}
      <For each={props.items}>
        {(item) => (
          <ArkTabs.Content value={item.value}>
            <Show when={props.value === item.value}>{props.panel(item.value)}</Show>
          </ArkTabs.Content>
        )}
      </For>
    </ArkTabs.Root>
  );
}
