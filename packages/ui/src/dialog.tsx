import { Dialog as ArkDialog } from "@ark-ui/solid/dialog";
import { Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { buttonAttrs, type ButtonVariant } from "./button";
import { X } from "./icons";
import { useUi } from "./locale";

export type DialogProps = {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Required: it names the dialog for assistive technology. */
  title: JSX.Element;
  description?: JSX.Element;
  children?: JSX.Element;
  /** Actions. Put the safe choice first and give it initial focus for consequential dialogs. */
  footer?: JSX.Element;
  /** `alertdialog` for interruptions that need an answer, such as confirming a discard. */
  role?: "dialog" | "alertdialog";
  /** `end` makes a side sheet; `center` is a conventional dialog. */
  placement?: "center" | "end";
  /** Renders a trigger button when the dialog manages its own open state. */
  triggerLabel?: string;
  triggerVariant?: ButtonVariant;
  /** Adds a close button in the header, with this accessible name. */
  closeLabel?: string;
  initialFocusEl?: () => HTMLElement | null;
  finalFocusEl?: () => HTMLElement | null;
  /** Whether a click outside the dialog closes it (default true). A form someone has typed into turns it
   * off, so a stray click does not throw the work away; Escape and the buttons still close it. */
  closeOnInteractOutside?: boolean;
  /** Whether Escape closes it (default true). Off only for a dialog that must be answered: a sign-in that
   * stands between the person and everything else. */
  closeOnEscape?: boolean;
  /** Cover the page behind it whole, where nothing of the page may show until the dialog is answered. */
  opaque?: boolean;
  /** A line above the title (the product's name over a sign-in). It is not part of the dialog's name. */
  lead?: JSX.Element;
  /** Render in a portal (default). Turn off only for a dialog nested inside another dialog. */
  portal?: boolean;
  class?: string;
};

/** Modal dialog. Ark keeps focus, dismissal and stacking; this owns the look and the copy. */
export function Dialog(props: DialogProps) {
  const ui = useUi();
  const body = () => (
    <>
      <ArkDialog.Backdrop class="rt-backdrop" data-opaque={props.opaque ? "" : undefined} />
      <ArkDialog.Positioner
        class={`rt-positioner${props.placement === "end" ? " rt-inspector-positioner" : ""}`}
      >
        <ArkDialog.Content class={`rt-dialog rt-theme ${props.class ?? ""}`.trim()}>
          <Show when={props.lead}>
            <div class="rt-dialog-lead">{props.lead}</div>
          </Show>
          <div class="rt-dialog-header">
            <ArkDialog.Title>{props.title}</ArkDialog.Title>
            <Show when={props.closeLabel}>
              <ArkDialog.CloseTrigger
                {...buttonAttrs({ variant: "quiet", iconOnly: true })}
                aria-label={props.closeLabel ?? ui.messages.dialog.close}
              >
                <X aria-hidden="true" />
              </ArkDialog.CloseTrigger>
            </Show>
          </div>
          <Show when={props.description}>
            <ArkDialog.Description>{props.description}</ArkDialog.Description>
          </Show>
          <Show when={props.children}>
            <div class="rt-dialog-body rt-stack">{props.children}</div>
          </Show>
          <Show when={props.footer}>
            <div class="rt-dialog-actions">{props.footer}</div>
          </Show>
        </ArkDialog.Content>
      </ArkDialog.Positioner>
    </>
  );
  return (
    <ArkDialog.Root
      {...(props.role ? { role: props.role } : {})}
      {...(props.open !== undefined ? { open: props.open } : {})}
      {...(props.defaultOpen !== undefined ? { defaultOpen: props.defaultOpen } : {})}
      {...(props.initialFocusEl ? { initialFocusEl: props.initialFocusEl } : {})}
      {...(props.finalFocusEl ? { finalFocusEl: props.finalFocusEl } : {})}
      {...(props.closeOnInteractOutside !== undefined
        ? { closeOnInteractOutside: props.closeOnInteractOutside }
        : {})}
      {...(props.closeOnEscape !== undefined ? { closeOnEscape: props.closeOnEscape } : {})}
      onOpenChange={(detail) => props.onOpenChange?.(detail.open)}
    >
      <Show when={props.triggerLabel}>
        <ArkDialog.Trigger {...buttonAttrs({ variant: props.triggerVariant ?? "primary" })}>
          {props.triggerLabel}
        </ArkDialog.Trigger>
      </Show>
      <Show when={props.portal !== false} fallback={body()}>
        <Portal>{body()}</Portal>
      </Show>
    </ArkDialog.Root>
  );
}

/** Close the nearest dialog. Use it for the safe, non-destructive action. */
export const DialogClose = ArkDialog.CloseTrigger;
