import { NumberInput } from "@ark-ui/solid/number-input";
import { createUniqueId, type JSX, Show } from "solid-js";
import { FieldError, FieldHint } from "./field";

/** A whole number typed into a box: Ark's number input, so the arrow keys step it and anything that is not a
 * number cannot be typed. The value is kept as the text in the box, without grouping, and is not pulled into
 * range when the box is left: the screen says what is wrong with it, as it does for any other field. Money is
 * not a number field; it is text the books read exactly. */
export function NumberField(props: {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  value: string;
  onChange: (value: string) => void;
  min?: number | undefined;
  max?: number | undefined;
  disabled?: boolean | undefined;
  required?: boolean | undefined;
  /** The box's id, for a page that points at the field (an error summary). */
  id?: string | undefined;
  class?: string | undefined;
}): JSX.Element {
  const generated = createUniqueId();
  const id = props.id ?? generated;
  const describedBy = () =>
    [props.hint && `${id}-hint`, props.error && `${id}-error`].filter(Boolean).join(" ") ||
    undefined;
  return (
    <NumberInput.Root
      class={props.class ? `rt-field ${props.class}` : "rt-field"}
      ids={{ input: id }}
      value={props.value}
      {...(props.min !== undefined ? { min: props.min } : {})}
      {...(props.max !== undefined ? { max: props.max } : {})}
      disabled={props.disabled ?? false}
      required={props.required ?? false}
      invalid={Boolean(props.error)}
      clampValueOnBlur={false}
      allowMouseWheel={false}
      formatOptions={{ useGrouping: false, maximumFractionDigits: 0 }}
      onValueChange={(detail) => props.onChange(detail.value)}
    >
      <NumberInput.Label>{props.label}</NumberInput.Label>
      <NumberInput.Input class="rt-input" aria-describedby={describedBy()} />
      <Show when={props.hint}>
        <FieldHint id={`${id}-hint`}>{props.hint}</FieldHint>
      </Show>
      <Show when={props.error}>
        <FieldError id={`${id}-error`}>{props.error}</FieldError>
      </Show>
    </NumberInput.Root>
  );
}
