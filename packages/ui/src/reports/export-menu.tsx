import { Menu } from "@ark-ui/solid/menu";
import { For } from "solid-js";
import { Portal } from "solid-js/web";
import { buttonAttrs } from "../button";
import { ChevronDown } from "../icons";

/** One thing the menu can do. */
export interface ExportAction {
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean | undefined;
}

/** The report's Export button: one button that opens the ways to take a report out of the page (a CSV file,
 * paper or a PDF). It is Ark's menu, as View beside it is: the Down arrow or Enter opens it, the arrow keys,
 * Home and End move between the items, Enter chooses one, Escape closes it and puts focus back on the button,
 * and pressing anywhere else or tabbing out closes it. */
export function ExportMenu(props: {
  /** The button's visible name: "Export". */
  label: string;
  actions: readonly ExportAction[];
  disabled?: boolean | undefined;
  /** Start with the list open (stories and tests). */
  defaultOpen?: boolean | undefined;
}) {
  return (
    <Menu.Root
      positioning={{ placement: "bottom-end" }}
      defaultOpen={props.defaultOpen ?? false}
      onSelect={(detail) => props.actions.find((action) => action.id === detail.value)?.onSelect()}
    >
      <Menu.Trigger {...buttonAttrs({ variant: "secondary" })} disabled={props.disabled ?? false}>
        {props.label}
        <ChevronDown aria-hidden="true" class="rt-export-chevron" />
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content class="rt-popup">
            <For each={props.actions}>
              {(action) => (
                <Menu.Item class="rt-item" value={action.id} disabled={action.disabled ?? false}>
                  {action.label}
                </Menu.Item>
              )}
            </For>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}
