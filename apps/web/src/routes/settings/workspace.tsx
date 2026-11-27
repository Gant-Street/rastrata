import { Button, Notice, PageHeader, PageSkeleton } from "@rastrata/ui";
import { TextField } from "@rastrata/ui/text-field";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { ambientFetch } from "../../ambient";
import { BrowserApplicationClient } from "../../application-client";
import { currentAccount, START_PATH } from "../../boot";
import { saveFile } from "../../download";
import { createLoader } from "../../loader";
import {
  DeleteController,
  type DeleteState,
  ExportController,
  type ExportState,
  sameName,
} from "../../workspace-controller";
import { workspaceWords as words } from "./workspace-words";

/** Settings, Workspace: what can be done with the books as a whole. It exists only on a service with accounts; a page opened by its address on any other says that it is not there. */
export function WorkspacePage() {
  const account = currentAccount();
  return (
    <section aria-labelledby="workspace-title">
      <PageHeader titleId="workspace-title" title={words.title} />
      <Show
        when={account}
        fallback={
          <Notice title={words.notHere} tone="info">
            <p>{words.notHereBody}</p>
          </Notice>
        }
      >
        {(present) => <WorkspaceBody account={present()} />}
      </Show>
    </section>
  );
}

function WorkspaceBody(props: {
  readonly account: NonNullable<ReturnType<typeof currentAccount>>;
}) {
  const workspace = createLoader(async () => {
    const id = props.account.scope();
    if (id === null) throw new Error("No workspace is open.");
    const answer = await props.account.workspace(id);
    if (!answer.ok) throw new Error(answer.message);
    return answer.value.workspace;
  });
  return (
    <Show
      when={workspace.value()}
      fallback={
        <Show
          when={workspace.error() !== undefined}
          fallback={<PageSkeleton shape="form" label={words.loading} />}
        >
          <Notice title={words.failed} tone="problem" role="alert">
            <p>{workspace.error() instanceof Error ? (workspace.error() as Error).message : ""}</p>
            <Button
              variant="secondary"
              label={words.retry}
              onClick={() => void workspace.reload()}
            />
          </Notice>
        </Show>
      }
    >
      {(current) => (
        <>
          <Export mayExport={current().role === "owner" || current().role === "admin"} />
          <Delete
            account={props.account}
            workspace={{ id: current().id, name: current().name }}
            mayDelete={current().role === "owner"}
          />
        </>
      )}
    </Show>
  );
}

function Export(props: { readonly mayExport: boolean }) {
  // Made once: a prop written as an expression is read each time it is used, and the page must talk to the one controller it listens to.
  const controller = new ExportController({
    client: new BrowserApplicationClient(window.localStorage),
    fetcher: (path) => ambientFetch(path),
    save: saveFile,
  });
  const [state, setState] = createSignal<ExportState>(controller.state);
  const unsubscribe = controller.subscribe(setState);
  onCleanup(unsubscribe);
  const busy = createMemo(() => ["making", "fetching"].includes(state().step));
  /** What is being done, or was, in words; read out as it changes. */
  const line = createMemo(() => {
    const current = state();
    if (current.step === "making")
      return current.stage === null
        ? words.exportMaking
        : words.exportStage(current.stage, current.percent);
    if (current.step === "fetching") return words.exportFetching;
    if (current.step === "done") return words.exportDone(current.name);
    return "";
  });
  const failure = createMemo(() => {
    const current = state();
    return current.step === "failed" ? current.message : null;
  });
  return (
    <section class="rt-settings-block" aria-labelledby="workspace-export">
      <h2 id="workspace-export">{words.exportTitle}</h2>
      <p>{words.exportBody}</p>
      <Show when={props.mayExport} fallback={<p>{words.exportOnlyOwners}</p>}>
        <Show when={failure()}>
          {(message) => <Notice title={message()} tone="problem" role="alert" />}
        </Show>
        <p role="status">{line()}</p>
        <Button
          label={state().step === "done" ? words.exportAgain : words.exportAction}
          pending={busy()}
          pendingLabel={words.exportMaking}
          onClick={() => void controller.run()}
        />
      </Show>
    </section>
  );
}

function Delete(props: {
  readonly account: NonNullable<ReturnType<typeof currentAccount>>;
  readonly workspace: { readonly id: string; readonly name: string };
  readonly mayDelete: boolean;
}) {
  // Made once, outside the JSX (a prop written as an expression is read each time it is used).
  const controller = new DeleteController({
    account: props.account,
    workspace: props.workspace,
    forget: () => props.account.select(null),
    go: (path) => window.location.assign(path),
    leaveFor: `${START_PATH}?choose=1`,
  });
  const [state, setState] = createSignal<DeleteState>(controller.state);
  const unsubscribe = controller.subscribe(setState);
  onCleanup(unsubscribe);
  const [typed, setTyped] = createSignal("");
  const busy = createMemo(() => ["deleting", "done"].includes(state().step));
  const failure = createMemo(() => {
    const current = state();
    return current.step === "failed" ? current.message : null;
  });
  return (
    <section class="rt-settings-block" aria-labelledby="workspace-delete">
      <h2 id="workspace-delete">{words.deleteTitle}</h2>
      <p>{words.deleteBody}</p>
      <Show when={props.mayDelete} fallback={<p>{words.deleteOnlyOwners}</p>}>
        <form
          class="workspace-delete"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void controller.run(typed());
          }}
        >
          <Show when={failure()}>
            {(message) => <Notice title={message()} tone="problem" role="alert" />}
          </Show>
          <TextField
            label={words.deleteLabel(props.workspace.name)}
            name="confirm"
            autocomplete="off"
            value={typed()}
            onInput={(event) => setTyped(event.currentTarget.value)}
          />
          <Button
            type="submit"
            variant="danger"
            label={words.deleteAction}
            pending={busy()}
            pendingLabel={words.deleting}
            disabled={!sameName(typed(), props.workspace.name)}
          />
        </form>
      </Show>
    </section>
  );
}
