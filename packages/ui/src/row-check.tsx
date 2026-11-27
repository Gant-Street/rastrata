import { Checkbox } from "@ark-ui/solid/checkbox";
import type { JSX } from "solid-js";
import { Check, Minus } from "./icons";

/** The checkbox of a row of a table, or of the table's head (which is neither on nor off while only some rows
 * are ticked). It is Ark's checkbox with nothing written beside it: the row says what it is, and assistive
 * technology is told in `label`. The screen may put its own class, row number and place in the tab order on the
 * input, which is what the keyboard stands on, and may ask whether Shift was held when it was pressed. */
export function RowCheck(props: {
  label: string;
  checked: boolean | "indeterminate";
  onChange: (checked: boolean) => void;
  disabled?: boolean | undefined;
  /** The input's id, where a label elsewhere in the row is for it. */
  id?: string | undefined;
  /** What the screen needs on the input itself. Never an id (see `id`). */
  input?:
    | (JSX.InputHTMLAttributes<HTMLInputElement> & { [name: `data-${string}`]: unknown })
    | undefined;
  /** The box was pressed with the pointer: whether Shift was held, for a range. */
  onPress?: ((shiftKey: boolean) => void) | undefined;
}): JSX.Element {
  // The press this box is passing on to its input itself (see below).
  let passing = false;
  return (
    <Checkbox.Root
      class="rt-choice rt-row-check"
      checked={props.checked}
      disabled={props.disabled ?? false}
      {...(props.id ? { ids: { hiddenInput: props.id } } : {})}
      onCheckedChange={(detail) => props.onChange(detail.checked === true)}
      onClick={(event) => {
        if (passing) return;
        props.onPress?.(event.shiftKey);
        // Firefox does not pass a press on a label to its input while Shift, Control or Command is held, so a
        // range could not be ticked there. Such a press is passed on here instead, the same in every browser.
        const input = event.currentTarget.querySelector("input");
        if (!input || event.target === input || input.disabled) return;
        if (!(event.shiftKey || event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        passing = true;
        try {
          input.click();
        } finally {
          passing = false;
        }
      }}
    >
      <Checkbox.HiddenInput aria-label={props.label} {...props.input} />
      <Checkbox.Control>
        <Checkbox.Indicator>
          <Check aria-hidden="true" />
        </Checkbox.Indicator>
        <Checkbox.Indicator indeterminate>
          <Minus aria-hidden="true" />
        </Checkbox.Indicator>
      </Checkbox.Control>
    </Checkbox.Root>
  );
}
