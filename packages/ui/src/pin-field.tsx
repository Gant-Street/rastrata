import { PinInput } from "@ark-ui/solid/pin-input";
import { createUniqueId, Index } from "solid-js";
import { FieldMessages } from "./field";
import { useUi } from "./locale";

export type PinFieldProps = {
  label: string;
  /** How many characters: one box each. */
  count: number;
  hint?: string;
  /** Says what is wrong and what to do. Presence marks the field invalid. */
  error?: string;
  /** The form field the whole value is submitted as. */
  name?: string;
  id?: string;
  /** A code sent by mail or text: the browser may fill it in (autocomplete="one-time-code"). */
  otp?: boolean;
  autofocus?: boolean;
  disabled?: boolean;
  /** Every box is filled. */
  onComplete?: (value: string) => void;
};

/** A short code of digits, one box per digit, on Ark's pin input: typing moves on, backspace moves back, a pasted or
 * autofilled code fills every box. */
export function PinField(props: PinFieldProps) {
  const ui = useUi();
  const generated = createUniqueId();
  const id = () => props.id ?? generated;
  const describedBy = () =>
    [props.hint && `${id()}-hint`, props.error && `${id()}-error`].filter(Boolean).join(" ") ||
    undefined;
  return (
    <PinInput.Root
      class="rt-field"
      ids={{ root: id() }}
      count={props.count}
      type="numeric"
      placeholder=""
      otp={props.otp ?? false}
      autoFocus={props.autofocus ?? false}
      disabled={props.disabled ?? false}
      invalid={props.error !== undefined}
      translations={{ inputLabel: (index, length) => ui.messages.pin.digit(index + 1, length) }}
      {...(props.name ? { name: props.name } : {})}
      onValueComplete={(details) => props.onComplete?.(details.valueAsString)}
    >
      <PinInput.Label>{props.label}</PinInput.Label>
      <PinInput.Control class="rt-pin">
        <Index each={Array.from({ length: props.count })}>
          {(_, index) => (
            <PinInput.Input
              class="rt-input rt-pin-box"
              index={index}
              aria-describedby={describedBy()}
            />
          )}
        </Index>
      </PinInput.Control>
      <PinInput.HiddenInput />
      <FieldMessages
        hintId={`${id()}-hint`}
        errorId={`${id()}-error`}
        hint={props.hint}
        error={props.error}
      />
    </PinInput.Root>
  );
}
