import { Menu } from "@ark-ui/solid/menu";
import { Index, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { buttonAttrs } from "../button";
import { Check, ChevronDown } from "../icons";

/** One way a report can be laid out, on or off. */
export interface ViewChoice {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (on: boolean) => void;
}

/** The report's View button: the ways the same figures can be laid out (a column for each month, each
 * amount with its share of income), as a menu of choices that are on or off. Ark keeps the keyboard
 * (arrows, Enter, Escape) and puts focus back on the button; a choice that is on has a tick and says so
 * to a screen reader. Choosing one closes the menu, so the report is what is looked at next. */
export function ViewMenu(props: {
  /** The button's visible name: "View". */
  label: string;
  choices: readonly ViewChoice[];
  disabled?: boolean | undefined;
}): JSX.Element {
  return (
    <Menu.Root positioning={{ placement: "bottom-end" }}>
      <Menu.Trigger {...buttonAttrs({ variant: "secondary" })} disabled={props.disabled ?? false}>
        {props.label}
        <ChevronDown aria-hidden="true" class="rt-export-chevron" />
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content class="rt-popup rt-view-menu">
            <Index each={props.choices}>
              {(choice) => (
                <Menu.CheckboxItem
                  class="rt-item"
                  value={choice().id}
                  checked={choice().checked}
                  onCheckedChange={(on) => choice().onChange(on)}
                >
                  <Menu.ItemText>{choice().label}</Menu.ItemText>
                  <Menu.ItemIndicator class="rt-view-tick">
                    <Check aria-hidden="true" />
                  </Menu.ItemIndicator>
                </Menu.CheckboxItem>
              )}
            </Index>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}
