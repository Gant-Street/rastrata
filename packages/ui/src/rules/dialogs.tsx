import { createSignal, createUniqueId, Show } from "solid-js";
import { Button } from "../button";
import { Dialog, DialogClose } from "../dialog";
import { Notice } from "../notice";
import { TextArea } from "../text-field";
import { words } from "./words";

/** The confirmation before a rule is retired. The safe choice, Cancel, takes the first focus; what
 * deleting does (the rule stops suggesting at once, its history stays, it cannot be switched back
 * on) is said before the button, and so is the alternative that keeps the rule. */
export function RuleDeleteDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The rule's name: untrusted text, shown as text. */
  name: string;
  pending?: boolean | undefined;
  error?: string | undefined;
  onConfirm: (reason: string) => void;
}) {
  const reasonId = `${createUniqueId()}-reason`;
  const [reason, setReason] = createSignal("");
  let cancel: HTMLButtonElement | undefined;
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      role="alertdialog"
      title={words.deleteTitle}
      description={<bdi>{props.name}</bdi>}
      initialFocusEl={() => cancel ?? null}
      footer={
        <>
          <DialogClose
            ref={(element: HTMLButtonElement) => {
              cancel = element;
            }}
            class="rt-button"
            data-variant="secondary"
            data-size="md"
          >
            {words.cancel}
          </DialogClose>
          <Button
            variant="danger"
            label={words.deleteConfirm}
            pendingLabel={words.deleting}
            pending={props.pending ?? false}
            onClick={() => props.onConfirm(reason().trim())}
          />
        </>
      }
    >
      <p>{words.deleteBody}</p>
      <TextArea
        id={reasonId}
        label={words.deleteReason}
        hint={words.deleteReasonHint}
        maxlength={200}
        value={reason()}
        onInput={(event) => setReason(event.currentTarget.value)}
      />
      <Show when={props.error}>
        <Notice title={words.deleteFailedTitle} tone="error" role="alert">
          {props.error}
        </Notice>
      </Show>
    </Dialog>
  );
}
