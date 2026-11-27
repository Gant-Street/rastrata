import { Show } from "solid-js";
import { Button } from "../button";
import { Dialog } from "../dialog";
import { Notice } from "../notice";
import type { AgentConnectedRow } from "./types";
import { words } from "./words";

/** Confirm disconnecting an agent. The safe choice ("Keep it") has focus; it cannot be undone, so the
 * button says what it does and is the only red thing. A failed attempt stays in the dialog, and the
 * agent is still listed until the service says otherwise. Nothing is asked: a person who wants the
 * agent back connects it again. */
export function AgentDisconnectDialog(props: {
  agent: AgentConnectedRow | null;
  pending?: boolean | undefined;
  failed?: boolean | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  let keep: HTMLButtonElement | undefined;
  return (
    <Dialog
      open={props.agent !== null}
      onOpenChange={(open) => {
        if (!open && !props.pending) props.onCancel();
      }}
      role="alertdialog"
      title={props.agent ? words.disconnectTitle(props.agent.name) : ""}
      description={words.disconnectBody}
      initialFocusEl={() => keep ?? null}
      footer={
        <>
          <Button
            label={words.disconnectKeep}
            variant="secondary"
            ref={(element: HTMLButtonElement) => {
              keep = element;
            }}
            disabled={props.pending ?? false}
            onClick={props.onCancel}
          />
          <Button
            label={words.disconnectConfirm}
            pendingLabel={words.disconnecting}
            variant="danger"
            pending={props.pending ?? false}
            onClick={props.onConfirm}
          />
        </>
      }
    >
      <Show when={props.failed}>
        <Notice title={words.disconnectFailed} tone="error" role="alert" />
      </Show>
    </Dialog>
  );
}
