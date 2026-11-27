import { Show, splitProps, type JSX } from "solid-js";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

/**
 * The attributes that make any element a Rastrata button. Spread them onto an Ark trigger
 * (`<Pagination.NextTrigger {...buttonAttrs({ iconOnly: true })} />`) so every button on every
 * screen is styled from one place instead of re-typing class names.
 */
export function buttonAttrs(
  options: { variant?: ButtonVariant; size?: ButtonSize; iconOnly?: boolean } = {},
) {
  return {
    class: options.iconOnly ? "rt-button rt-icon-button" : "rt-button",
    "data-variant": options.variant ?? "primary",
    "data-size": options.size ?? "md",
  } as const;
}

export type ButtonProps = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  /** Visible text. For `iconOnly` buttons it becomes the accessible name. */
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Decorative icon. It is hidden from assistive technology; the label carries the meaning. */
  icon?: JSX.Element;
  iconOnly?: boolean;
  /**
   * Work is in progress. The button stays focusable and announces `aria-busy`, but ignores
   * clicks so a slow save cannot be submitted twice (error prevention).
   */
  pending?: boolean;
  /** Text shown while pending, e.g. "Saving…". Defaults to the label. */
  pendingLabel?: string;
};

/** Native button styled with Rastrata tokens. Semantics, refs and events are preserved. */
export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, [
    "label",
    "variant",
    "size",
    "class",
    "type",
    "icon",
    "iconOnly",
    "pending",
    "pendingLabel",
    "onClick",
  ]);
  const text = () => (local.pending && local.pendingLabel ? local.pendingLabel : local.label);
  return (
    <button
      {...rest}
      type={local.type ?? "button"}
      class={`rt-button${local.iconOnly ? " rt-icon-button" : ""} ${local.class ?? ""}`.trim()}
      data-variant={local.variant ?? "primary"}
      data-size={local.size ?? "md"}
      data-pending={local.pending ? "" : undefined}
      aria-busy={local.pending ? true : undefined}
      aria-disabled={local.pending ? true : undefined}
      aria-label={local.iconOnly ? local.label : undefined}
      onClick={(event) => {
        if (local.pending) {
          event.preventDefault();
          return;
        }
        const handler = local.onClick;
        if (typeof handler === "function") handler(event);
        else if (handler) handler[0](handler[1], event);
      }}
    >
      <Show when={local.icon}>
        <span class="rt-button-icon" aria-hidden="true">
          {local.icon}
        </span>
      </Show>
      <Show when={!local.iconOnly}>{text()}</Show>
    </button>
  );
}
