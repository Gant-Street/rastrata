import { PasswordInput } from "@ark-ui/solid/password-input";
import { createUniqueId, Show } from "solid-js";
import { FieldError, FieldHint } from "./field";
import { useUi } from "./locale";
import { buttonAttrs } from "./button";

export type PasswordFieldProps = {
  label: string;
  hint?: string;
  error?: string;
  name?: string;
  id?: string;
  required?: boolean;
  disabled?: boolean;
  autocomplete?: "current-password" | "new-password";
  value?: string;
  onInput?: (value: string) => void;
};

/** A familiar control with an explicit reveal action and password-manager support. */
export function PasswordField(props: PasswordFieldProps) {
  const ui = useUi();
  const generated = createUniqueId();
  const id = () => props.id ?? generated;
  const describedBy = () =>
    [props.hint && `${id()}-hint`, props.error && `${id()}-error`].filter(Boolean).join(" ") ||
    undefined;
  return (
    <PasswordInput.Root class="rt-field" ids={{ input: id() }} disabled={props.disabled ?? false}>
      <PasswordInput.Label>{props.label}</PasswordInput.Label>
      <PasswordInput.Control class="rt-control">
        <PasswordInput.Input
          class="rt-input"
          autocomplete={props.autocomplete ?? "current-password"}
          required={props.required ?? false}
          aria-invalid={props.error ? true : undefined}
          aria-describedby={describedBy()}
          {...(props.name ? { name: props.name } : {})}
          {...(props.value !== undefined ? { value: props.value } : {})}
          onInput={(event) => props.onInput?.(event.currentTarget.value)}
        />
        <PasswordInput.VisibilityTrigger {...buttonAttrs({ variant: "secondary" })}>
          <PasswordInput.Indicator fallback={ui.messages.password.show}>
            {ui.messages.password.hide}
          </PasswordInput.Indicator>
        </PasswordInput.VisibilityTrigger>
      </PasswordInput.Control>
      <Show when={props.hint}>
        <FieldHint id={`${id()}-hint`}>{props.hint}</FieldHint>
      </Show>
      <Show when={props.error}>
        <FieldError id={`${id()}-error`}>{props.error}</FieldError>
      </Show>
    </PasswordInput.Root>
  );
}
