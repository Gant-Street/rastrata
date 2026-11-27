import { createSignal, createUniqueId, Show } from "solid-js";
import { Button } from "../button";
import { Dialog, DialogClose } from "../dialog";
import { Notice } from "../notice";
import { TextArea } from "../text-field";
import { words } from "./words";
import { formatMoney } from "../format";

/** The confirmation before a reconciliation is frozen. The safe choice, Cancel, has the first
 * focus; the consequence (it can only be voided afterwards) is said before the button. */
export function ReconcileFinishDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: string;
  statementDate: string;
  lineCount: number;
  statementBalance: string;
  pending?: boolean;
  error?: string | undefined;
  onConfirm: () => void;
}) {
  let cancel: HTMLButtonElement | undefined;
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      role="alertdialog"
      title={words.finishTitle}
      description={words.finishSummary(
        props.account,
        props.statementDate,
        props.lineCount,
        formatMoney(props.statementBalance),
      )}
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
            label={words.finish}
            pendingLabel={words.finishing}
            pending={props.pending ?? false}
            onClick={props.onConfirm}
          />
        </>
      }
    >
      <p>{words.finishBody}</p>
      <Show when={props.error}>
        <Notice title={words.dialogError} tone="error" role="alert">
          {props.error}
        </Notice>
      </Show>
    </Dialog>
  );
}

/** Voiding appends a record with a reason; nothing is edited or deleted. The reason is required. */
export function ReconcileVoidDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: string;
  statementDate: string;
  pending?: boolean;
  error?: string | undefined;
  onConfirm: (reason: string) => void;
}) {
  const reasonId = `${createUniqueId()}-reason`;
  const [reason, setReason] = createSignal("");
  const [missing, setMissing] = createSignal(false);
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={words.voidTitle}
      description={words.voidSummary(props.account, props.statementDate)}
      initialFocusEl={() => document.getElementById(reasonId)}
      footer={
        <>
          <DialogClose class="rt-button" data-variant="secondary" data-size="md">
            {words.cancel}
          </DialogClose>
          <Button
            variant="danger"
            label={words.void}
            pendingLabel={words.voiding}
            pending={props.pending ?? false}
            onClick={() => {
              if (!reason().trim()) {
                setMissing(true);
                document.getElementById(reasonId)?.focus();
                return;
              }
              props.onConfirm(reason().trim());
            }}
          />
        </>
      }
    >
      <TextArea
        id={reasonId}
        label={words.reason}
        required
        maxlength={500}
        hint={words.reasonHint}
        value={reason()}
        onInput={(event) => {
          setReason(event.currentTarget.value);
          setMissing(false);
        }}
        {...(missing() ? { error: words.needReason } : {})}
      />
      <Show when={props.error}>
        <Notice title={words.dialogError} tone="error" role="alert">
          {props.error}
        </Notice>
      </Show>
    </Dialog>
  );
}

/** Abandoning a draft keeps nothing; the safe choice is to keep editing. */
export function ReconcileDiscardDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending?: boolean;
  error?: string | undefined;
  onConfirm: () => void;
}) {
  let keep: HTMLButtonElement | undefined;
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      role="alertdialog"
      title={words.discardTitle}
      description={words.discardBody}
      initialFocusEl={() => keep ?? null}
      footer={
        <>
          <DialogClose
            ref={(element: HTMLButtonElement) => {
              keep = element;
            }}
            class="rt-button"
            data-variant="secondary"
            data-size="md"
          >
            {words.keepEditing}
          </DialogClose>
          <Button
            variant="danger"
            label={words.discard}
            pendingLabel={words.discarding}
            pending={props.pending ?? false}
            onClick={props.onConfirm}
          />
        </>
      }
    >
      <Show when={props.error}>
        <Notice title={words.dialogError} tone="error" role="alert">
          {props.error}
        </Notice>
      </Show>
    </Dialog>
  );
}
