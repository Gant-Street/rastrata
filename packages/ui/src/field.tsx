import { createUniqueId, Show, type JSX } from "solid-js";
import { TriangleAlert } from "./icons";
import { useUi } from "./locale";

/** Shared wiring for every labelled control: one id scheme, one description order. */
export function useField(props: {
  id?: string | undefined;
  hint?: string | undefined;
  error?: string | undefined;
  "aria-describedby"?: string | undefined;
  "aria-invalid"?: JSX.HTMLAttributes<HTMLElement>["aria-invalid"] | undefined;
}) {
  const generated = createUniqueId();
  const id = () => props.id ?? generated;
  return {
    id,
    hintId: () => `${id()}-hint`,
    errorId: () => `${id()}-error`,
    describedBy: () =>
      [props["aria-describedby"], props.hint && `${id()}-hint`, props.error && `${id()}-error`]
        .filter(Boolean)
        .join(" ") || undefined,
    invalid: () => (props.error ? true : props["aria-invalid"]),
  };
}

/** Plain-language error beside the answer. Never color alone: icon, "Error:" prefix and text. */
export function FieldError(props: { id: string; children: JSX.Element }) {
  const ui = useUi();
  return (
    <p id={props.id} class="rt-error">
      <TriangleAlert aria-hidden="true" />
      <span class="rt-sr-only">{ui.messages.field.error}: </span>
      <span>{props.children}</span>
    </p>
  );
}

export function FieldHint(props: { id: string; children: JSX.Element }) {
  return (
    <p id={props.id} class="rt-hint">
      {props.children}
    </p>
  );
}

export function FieldMessages(props: {
  hintId: string;
  errorId: string;
  hint?: string | undefined;
  error?: string | undefined;
}) {
  return (
    <>
      <Show when={props.hint}>
        <FieldHint id={props.hintId}>{props.hint}</FieldHint>
      </Show>
      <Show when={props.error}>
        <FieldError id={props.errorId}>{props.error}</FieldError>
      </Show>
    </>
  );
}

/** The label row: label text and optional contextual help beside it. A required field is not labelled "(required)"
 * (the founder, 2026-10-27: "not a normal pattern"); the input says it is required, and its error says what to do. */
export function FieldLabel(props: {
  for?: string;
  required?: boolean | undefined;
  help?: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <div class="rt-label-row">
      <label for={props.for}>{props.children}</label>
      {props.help}
    </div>
  );
}
