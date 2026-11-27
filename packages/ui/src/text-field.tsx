import { splitProps, type JSX } from "solid-js";
import { FieldLabel, FieldMessages, useField } from "./field";
import { HelpTip } from "./help-tip";

type FieldExtras = {
  label: string;
  /** Persistent guidance. Placeholders are examples, never instructions. */
  hint?: string;
  /** Says what is wrong and what to do. Presence marks the field invalid. */
  error?: string;
  /** Longer explanation, shown on demand beside the label (help in context). */
  help?: JSX.Element;
};

export type TextFieldProps = Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "children"> &
  FieldExtras;

export function TextField(props: TextFieldProps) {
  const [local, rest] = splitProps(props, [
    "label",
    "hint",
    "error",
    "help",
    "id",
    "class",
    "aria-describedby",
    "aria-invalid",
    "value",
  ]);
  const field = useField(local);
  return (
    <div class="rt-field">
      <FieldLabel
        for={field.id()}
        required={props.required}
        help={local.help ? <HelpTip topic={local.label}>{local.help}</HelpTip> : undefined}
      >
        {local.label}
      </FieldLabel>
      <input
        {...rest}
        id={field.id()}
        class={`rt-input ${local.class ?? ""}`}
        value={local.value}
        aria-invalid={field.invalid()}
        aria-describedby={field.describedBy()}
      />
      <FieldMessages
        hintId={field.hintId()}
        errorId={field.errorId()}
        hint={local.hint}
        error={local.error}
      />
    </div>
  );
}

export type TextAreaProps = Omit<JSX.TextareaHTMLAttributes<HTMLTextAreaElement>, "children"> &
  FieldExtras;

/** Multi-line text with the same label, hint, error and help contract as TextField. */
export function TextArea(props: TextAreaProps) {
  const [local, rest] = splitProps(props, [
    "label",
    "hint",
    "error",
    "help",
    "id",
    "class",
    "aria-describedby",
    "aria-invalid",
    "value",
  ]);
  const field = useField(local);
  return (
    <div class="rt-field">
      <FieldLabel
        for={field.id()}
        required={props.required}
        help={local.help ? <HelpTip topic={local.label}>{local.help}</HelpTip> : undefined}
      >
        {local.label}
      </FieldLabel>
      <textarea
        {...rest}
        id={field.id()}
        class={`rt-input ${local.class ?? ""}`}
        value={local.value}
        aria-invalid={field.invalid()}
        aria-describedby={field.describedBy()}
      />
      <FieldMessages
        hintId={field.hintId()}
        errorId={field.errorId()}
        hint={local.hint}
        error={local.error}
      />
    </div>
  );
}
