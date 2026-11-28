import { Button, Dialog, Notice, TextField } from "@rastrata/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import type { Account } from "./account";
import { clear as forgetHeld } from "./held";
import { noteSetupPending } from "./new-book";

const POLL_MS = 1_500;

/** In-place modal to create another workspace (business / LLC) without leaving the app.
 * Uses an idempotent requestId per name, polls if the workspace starts in `"provisioning"`,
 * and opens the new workspace in this tab as soon as it is ready. */
export function CreateWorkspaceDialog(props: {
  open: boolean;
  account: Account;
  onClose: () => void;
  onOpened: (workspaceId: string) => void;
}) {
  const [name, setName] = createSignal("");
  const [phase, setPhase] = createSignal<"idle" | "creating" | "provisioning">("idle");
  const [error, setError] = createSignal<string | null>(null);
  let request: { name: string; id: string } | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const stopPolling = () => {
    if (pollTimer !== undefined) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  };
  onCleanup(() => {
    disposed = true;
    stopPolling();
  });

  const openCreated = (workspaceId: string) => {
    stopPolling();
    noteSetupPending(workspaceId, true);
    props.account.select(workspaceId);
    forgetHeld();
    props.onOpened(workspaceId);
  };

  const pollUntilReady = (workspaceId: string) => {
    stopPolling();
    pollTimer = setTimeout(async () => {
      if (disposed || !props.open) return;
      const listed = await props.account.workspaces();
      if (disposed || !props.open) return;
      if (listed.ok) {
        const found = listed.value.find((item) => item.id === workspaceId);
        if (found?.state === "ready") {
          openCreated(workspaceId);
          return;
        }
      }
      pollUntilReady(workspaceId);
    }, POLL_MS);
  };

  const submit = async () => {
    if (phase() !== "idle") return;
    const wanted = name().trim();
    if (wanted.length < 2) {
      setError("Enter a business or workspace name.");
      return;
    }
    setError(null);
    setPhase("creating");
    if (request?.name !== wanted) {
      request = { name: wanted, id: crypto.randomUUID() };
    }
    const answer = await props.account.createWorkspace(wanted, request.id);
    if (disposed) return;
    if (!answer.ok) {
      setPhase("idle");
      setError(answer.message);
      return;
    }
    if (answer.value.state === "ready") {
      openCreated(answer.value.id);
      return;
    }
    setPhase("provisioning");
    pollUntilReady(answer.value.id);
  };

  const close = () => {
    stopPolling();
    setPhase("idle");
    setError(null);
    setName("");
    request = null;
    props.onClose();
  };

  const busy = () => phase() !== "idle";
  const inputId = "create-workspace-name";

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="New workspace"
      description="Create an isolated set of books for another business you own. Covered under the same account plan."
      closeLabel="Close"
      closeOnInteractOutside={!busy()}
      initialFocusEl={() => document.getElementById(inputId)}
      footer={
        <>
          <Button variant="quiet" label="Cancel" disabled={busy()} onClick={close} />
          <Button
            variant="primary"
            label="Create workspace"
            pending={busy()}
            pendingLabel={phase() === "provisioning" ? "Preparing books…" : "Creating…"}
            onClick={() => void submit()}
          />
        </>
      }
    >
      <form
        class="rt-stack ws-create-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Show when={error()}>
          {(message) => <Notice title={message()} tone="problem" role="alert" />}
        </Show>
        <Show when={phase() === "provisioning"}>
          <Notice title="Preparing your books…" tone="info" role="status">
            <p>Your new workspace will open automatically in a moment.</p>
          </Notice>
        </Show>
        <TextField
          id={inputId}
          label="Business name"
          autocomplete="organization"
          maxLength={120}
          required
          disabled={busy()}
          value={name()}
          onInput={(event) => {
            setName(event.currentTarget.value);
            if (error()) setError(null);
          }}
        />
      </form>
    </Dialog>
  );
}
