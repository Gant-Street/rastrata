import { createMemo, Show, type JSX } from "solid-js";
import { SelectField } from "../select-field";
import { FieldLabel, FieldMessages, useField } from "../field";
import type { RuleOption } from "./types";

type Common = {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  id?: string | undefined;
  disabled?: boolean | undefined;
  required?: boolean | undefined;
  /** Keep the label for assistive technology but not on the page, for a control whose neighbours
   * already say what it is (the "how" of a condition). */
  hideLabel?: boolean | undefined;
};

function Label(props: Common & { for: string }) {
  return (
    <Show
      when={!props.hideLabel}
      fallback={
        <label class="rt-sr-only" for={props.for}>
          {props.label}
        </label>
      }
    >
      <FieldLabel for={props.for} required={props.required}>
        {props.label}
      </FieldLabel>
    </Show>
  );
}

/** Options without a group first, then each group in the order it first appears. */
function ordered(options: readonly RuleOption[]): RuleOption[] {
  const names: string[] = [];
  for (const option of options)
    if (option.group !== undefined && !names.includes(option.group)) names.push(option.group);
  return [
    ...options.filter((option) => option.group === undefined),
    ...names.flatMap((name) => options.filter((option) => option.group === name)),
  ];
}

/** One from a short list inside a dense form, as the kit's select. It has the same label, hint and error
 * contract as the other fields: an error marks it invalid, says what is wrong beside it and is read out with
 * the control. */
export function RuleSelect(
  props: Common & {
    value: string;
    options: readonly RuleOption[];
    onChange: (value: string) => void;
    /** A first, empty choice that says what to do ("Choose an account"). */
    placeholder?: string | undefined;
  },
): JSX.Element {
  const items = createMemo(() => [
    ...(props.placeholder !== undefined ? [{ value: "", label: props.placeholder }] : []),
    ...ordered(props.options),
  ]);
  return (
    <SelectField
      class="rt-rules-field"
      label={props.label}
      hideLabel={props.hideLabel}
      hint={props.hint}
      error={props.error}
      id={props.id}
      disabled={props.disabled}
      required={props.required}
      value={props.value}
      items={items()}
      onChange={props.onChange}
    />
  );
}

/** A labelled text box that can keep its label out of sight (see `hideLabel`). Everything typed is
 * data: it is held as text and never interpreted. */
export function RuleInput(
  props: Common & {
    value: string;
    onInput: (value: string) => void;
    placeholder?: string | undefined;
    maxLength?: number | undefined;
    inputMode?: "decimal" | "text" | undefined;
    type?: "text" | "number" | undefined;
    min?: number | undefined;
    max?: number | undefined;
    autocomplete?: "off" | undefined;
    /** Enter does this instead of submitting the form the box sits in. */
    onEnter?: (() => void) | undefined;
  },
): JSX.Element {
  const field = useField(props);
  return (
    <div class="rt-field rt-rules-field">
      <Label {...props} for={field.id()} />
      <input
        id={field.id()}
        class="rt-input"
        type={props.type ?? "text"}
        value={props.value}
        disabled={props.disabled ?? false}
        required={props.required ?? false}
        autocomplete={props.autocomplete ?? "off"}
        {...(props.placeholder !== undefined ? { placeholder: props.placeholder } : {})}
        {...(props.maxLength !== undefined ? { maxlength: props.maxLength } : {})}
        {...(props.inputMode !== undefined ? { inputmode: props.inputMode } : {})}
        {...(props.min !== undefined ? { min: props.min } : {})}
        {...(props.max !== undefined ? { max: props.max } : {})}
        aria-invalid={field.invalid()}
        aria-describedby={field.describedBy()}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !props.onEnter) return;
          event.preventDefault();
          props.onEnter();
        }}
      />
      <FieldMessages
        hintId={field.hintId()}
        errorId={field.errorId()}
        hint={props.hint}
        error={props.error}
      />
    </div>
  );
}
