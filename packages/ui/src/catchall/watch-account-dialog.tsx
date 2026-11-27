import { type JSX, Show } from "solid-js";
import { Button } from "../button";
import { Dialog } from "../dialog";
import { formatFiguresInText } from "../format";
import { Notice } from "../notice";
import { catchallWords } from "./words";

export interface WatchAccountDialogProps {
  open: boolean;
  /** `watch` marks the account to be watched at month end; `stop` takes the mark off. */
  mode: "watch" | "stop";
  /** The account, by name, and whether it takes expenses or income. */
  account: { readonly name: string; readonly role: "expense" | "income" };
  /** The account that is watched now for the same purpose, when watching this one replaces it. */
  replaces?: string | undefined;
  /** The request is on its way. */
  busy?: boolean | undefined;
  /** What went wrong, in words, when the change was refused. */
  error?: string | undefined;
  /** A request was sent and never answered: it must be resumed, not repeated. */
  uncertain?: boolean | undefined;
  onResume?: (() => void) | undefined;
  onConfirm: () => void;
  onCancel: () => void;
  returnFocus?: (() => HTMLElement | null) | undefined;
}

/** Watching an account at month end: Close the books says what it took in the month. The account itself is
 * not changed, and neither is any entry; it is a mark on the account, and the dialog says what the mark
 * does before it is put on. */
export function WatchAccountDialog(props: WatchAccountDialogProps): JSX.Element {
  const w = catchallWords.watch;
  const stopping = () => props.mode === "stop";
  const name = () => props.account.name;
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && props.busy !== true) props.onCancel();
      }}
      title={stopping() ? w.stopTitle(name()) : w.watchTitle(name())}
      closeLabel={w.close}
      class="rt-watch-account"
      closeOnInteractOutside={false}
      {...(props.returnFocus ? { finalFocusEl: props.returnFocus } : {})}
      footer={
        <>
          <Button
            variant="quiet"
            label={w.cancel}
            disabled={props.busy === true}
            onClick={props.onCancel}
          />
          <Button
            label={stopping() ? w.stopConfirm : w.confirm}
            pending={props.busy === true}
            pendingLabel={w.working}
            disabled={props.uncertain === true}
            onClick={props.onConfirm}
          />
        </>
      }
    >
      <p>
        {stopping()
          ? w.stopExplain(name())
          : props.account.role === "income"
            ? w.explainIncome(name())
            : w.explainExpense(name())}
      </p>
      <Show when={!stopping() && props.replaces}>
        {(other) => (
          <Notice title={w.replacesTitle} tone="attention" role="status">
            <p>{w.replaces(other())}</p>
          </Notice>
        )}
      </Show>
      <Show when={props.error}>
        {(message) => (
          <Notice title={w.failedTitle} tone="problem" role="alert">
            <p>{formatFiguresInText(message())}</p>
          </Notice>
        )}
      </Show>
      <Show when={props.uncertain}>
        <Notice title={w.uncertainTitle} tone="attention" role="status">
          <p>{w.uncertain}</p>
          <Show when={props.onResume}>
            <Button
              variant="secondary"
              label={w.resume}
              disabled={props.busy === true}
              onClick={() => props.onResume?.()}
            />
          </Show>
        </Notice>
      </Show>
    </Dialog>
  );
}
