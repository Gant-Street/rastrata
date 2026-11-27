import { createToaster, Toast, Toaster } from "@ark-ui/solid/toast";
import { createContext, onCleanup, onMount, Show, useContext, type JSX } from "solid-js";
import { buttonAttrs } from "../button";
import { X } from "../icons";
import { useUi } from "../locale";
import { trackFocusReturn } from "./focus-return";
import { isTextEntry, isToastHotkey } from "./toast-hotkey";
import { planToast, TOASTS_VISIBLE, type ToastApi, type ToastOptions } from "./toast-options";
import { toneOf, type Tone } from "./tones";

export type { ToastAction, ToastApi, ToastOptions } from "./toast-options";

const ToastContext = createContext<ToastApi>();

/** Show a toast from anywhere under a `ToastProvider`:
 *
 *     const toast = useToast();
 *     toast.show({ message: "Posted 6 transactions.", action: { label: "Undo", onSelect: undo } });
 *
 * A toast says that something already happened and may offer to take it back. It never asks a question and
 * never carries information that exists nowhere else: a failure that needs fixing is a `Notice` on the page.
 *
 * It throws when there is no provider, while the screen is being made, so a missing provider is found
 * the first time the screen opens and not in the middle of an operation that had already succeeded. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api)
    throw new Error(
      "useToast needs a <ToastProvider> above it. The application mounts one at its root; a story or a test wraps its content in one.",
    );
  return api;
}

export interface ToastProviderProps {
  children: JSX.Element;
  /** Where the toasts sit. Default `bottom-start`: the corner the Inbox's detail pane does not use. */
  placement?: "top-start" | "top-end" | "bottom-start" | "bottom-end" | undefined;
}

/** Mount once, at the root of the application, inside `UiProvider`. It holds the queue and renders the
 * region the toasts appear in.
 *
 * The region is present from the start and is a polite live region, so a screen reader reads each toast
 * as it arrives without interrupting what it was saying. Pointing at the region or focusing anything in
 * it pauses every toast's clock; Alt+T moves focus into it (Tab then reaches a toast's action), Escape
 * dismisses the toast that has focus, and focus goes back to where it was when the region is left. At
 * most three toasts show at once and the rest wait their turn, a problem first.
 *
 * Alt+T does nothing while text is being typed (a text box, a text area, a list, an editable region, an
 * account picker's box), because on a Mac Option+T types a character and focus must stay where it is for
 * that character to arrive; it does nothing with another modifier held, and nothing when there is no toast
 * to go to. Tab out of the field first. */
export function ToastProvider(props: ToastProviderProps): JSX.Element {
  const ui = useUi();
  const toaster = createToaster({
    placement: props.placement ?? "bottom-start",
    max: TOASTS_VISIBLE,
    overlap: false,
    gap: 12,
    offsets: "1rem",
    removeDelay: 200,
    pauseOnPageIdle: true,
    // Ark's own hotkey fires from any element and with any other modifier held, and it moves focus before a
    // typed character has arrived. The kit's (below) is Alt+T and never in a field, so Ark's is given a key
    // nothing can press. It cannot be an empty list: every key of an empty list "is pressed".
    hotkey: ["Disabled"],
  });
  const focus = trackFocusReturn();
  let region: HTMLElement | undefined;
  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isToastHotkey(event)) return;
      const target = event.target instanceof Element ? event.target : document.activeElement;
      if (isTextEntry(target)) return;
      if (!region || toaster.getVisibleToasts().length === 0) return;
      // Firefox on Windows would open its Tools menu for Alt+T.
      event.preventDefault();
      region.focus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    onCleanup(() => document.removeEventListener("keydown", onKeyDown, true));
  });
  const api: ToastApi = {
    show(options: ToastOptions) {
      const plan = planToast(options);
      return toaster.create({
        ...(options.id !== undefined ? { id: options.id } : {}),
        title: options.message,
        type: plan.type,
        duration: plan.duration,
        closable: true,
        ...(options.action
          ? { action: { label: options.action.label, onClick: options.action.onSelect } }
          : {}),
        meta: { tone: plan.tone },
        onStatusChange: ({ status }) => {
          if (status === "unmounted") focus.restore();
        },
      });
    },
    dismiss(id) {
      // One toast leaves with its exit; no id clears the lot, the queue included, at once.
      if (id === undefined) {
        toaster.remove();
        focus.restore();
      } else toaster.dismiss(id);
    },
  };
  return (
    <ToastContext.Provider value={api}>
      {props.children}
      <Toaster
        toaster={toaster}
        class="rt-toasts"
        aria-label={ui.messages.kit.toast.region}
        aria-keyshortcuts="Alt+T"
        ref={(element: HTMLElement) => {
          region = element;
          onCleanup(focus.attach(element));
        }}
      >
        {(toast) => (
          <ToastCard
            tone={toneOf(toast().meta?.tone as Tone | undefined, "calm")}
            message={toast().title as JSX.Element}
            action={toast().action?.label}
            dismissLabel={ui.messages.kit.toast.dismiss}
          />
        )}
      </Toaster>
    </ToastContext.Provider>
  );
}

function ToastCard(props: {
  tone: Tone;
  message: JSX.Element;
  action: string | undefined;
  dismissLabel: string;
}): JSX.Element {
  return (
    <Toast.Root class="rt-toast" data-tone={props.tone}>
      <Toast.Title class="rt-toast-message">{props.message}</Toast.Title>
      <div class="rt-toast-actions">
        <Show when={props.action}>
          <Toast.ActionTrigger {...buttonAttrs({ variant: "secondary", size: "sm" })}>
            {props.action}
          </Toast.ActionTrigger>
        </Show>
        <Toast.CloseTrigger
          {...buttonAttrs({ variant: "quiet", size: "sm", iconOnly: true })}
          aria-label={props.dismissLabel}
        >
          <X aria-hidden="true" />
        </Toast.CloseTrigger>
      </div>
    </Toast.Root>
  );
}
