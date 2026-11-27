import { Menu } from "@ark-ui/solid/menu";
import { For, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type { RowAction } from "../accounting-types";
import { buttonAttrs } from "../button";
import { Ellipsis } from "../icons";

/** The id of the button that opens a row's actions, so a host can return focus to it when the dialog an
 * action opened closes. */
export const registerActionsId = (entryId: string): string => `rt-register-actions-${entryId}`;

/** What can be done to one row, as a menu: a button at the end of the row that opens a short list. Ark
 * keeps the keyboard (arrows, Escape, Home and End) and focus; the host says what each action does.
 * `label` is the button's accessible name, and it names the row ("Actions for No. 23"). */
export function RowMenu(props: {
  id: string;
  label: string;
  actions: readonly RowAction[];
}): JSX.Element {
  return (
    <Menu.Root
      // The trigger's id is the host's (registerActionsId), told to Ark so that it still finds the button when it
      // places the list (an id set on the element alone leaves the list off-screen since Ark 5.40).
      ids={{ trigger: props.id }}
      onSelect={(detail) => props.actions.find((action) => action.id === detail.value)?.onSelect()}
    >
      <Menu.Trigger
        {...buttonAttrs({ variant: "quiet", size: "sm", iconOnly: true })}
        aria-label={props.label}
      >
        <Ellipsis aria-hidden="true" />
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content class="rt-popup">
            <For each={props.actions}>
              {(action) => (
                <Menu.Item class="rt-item" value={action.id}>
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
