import {
  type AgentChoiceId,
  AgentConnect,
  type AgentConnectedRow,
  AgentConnectedList,
  AgentDisconnectDialog,
  type AgentTokenRow,
  agentDisconnectId,
  agentWords,
  choicesFor,
  connectedRows,
  localConnectCommand,
  PageHeader,
  type TokenPermission,
} from "@rastrata/ui";
import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { BrowserApplicationClient } from "../../application-client";
import { createLoader } from "../../loader";

/** Settings, Agents on a computer that runs the service itself. An agent here is a token of the book's own, and the
 * person at this computer is its owner, so connecting needs no code: the command line asks the service for the token
 * as the owner (`rastrata connect`), keeps it for the folder, and the page lists it. The command follows the choice.
 * The page never holds a credential. Disconnecting goes through the retained-request client, so a lost reply is
 * found again and never a second request. */
export function AgentAccessPage() {
  const client = new BrowserApplicationClient(window.localStorage);
  // Reads use the shared loader: a read never suspends the page, so focus stays where the person
  // put it while the list is read again.
  const list = createLoader(() => client.read("tokens.list", {}));
  const [choice, setChoice] = createSignal<AgentChoiceId>("draft");
  const [disconnecting, setDisconnecting] = createSignal<AgentConnectedRow | null>(null);
  const [pending, setPending] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [announcement, setAnnouncement] = createSignal("");

  // The command is run in a terminal: when the person comes back to the page, what is connected is read again.
  onMount(() => {
    const again = () => {
      if (document.visibilityState === "visible") void list.reload();
    };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    onCleanup(() => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    });
  });

  const choices = createMemo(() =>
    choicesFor(
      (list.value()?.grantable as readonly TokenPermission[] | undefined) ?? [
        "read",
        "draft",
        "post",
      ],
    ),
  );
  const rows = createMemo(() =>
    connectedRows((list.value()?.tokens ?? []) as readonly AgentTokenRow[], new Date()),
  );

  const disconnect = async () => {
    const row = disconnecting();
    if (!row) return;
    setPending(true);
    setFailed(false);
    try {
      await client.write("tokens.revoke", { tokenId: row.id }, `agent:revoke:${row.id}`);
      setDisconnecting(null);
      setAnnouncement(agentWords.disconnected(row.name));
      void list.reload();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <section class="rt-stack rt-agent-page" aria-labelledby="agent-access-title">
      <PageHeader
        titleId="agent-access-title"
        title={agentWords.title}
        description={agentWords.intro}
      />
      <span class="rt-sr-only" role="status">
        {announcement()}
      </span>
      <AgentConnect
        choices={choices()}
        choice={choice()}
        onChoice={setChoice}
        command={localConnectCommand(choice())}
      />
      <AgentConnectedList
        rows={rows()}
        loading={list.loading()}
        failed={Boolean(list.error())}
        onRetry={() => void list.reload()}
        disconnecting={pending() ? disconnecting()?.id : undefined}
        onDisconnect={(row) => {
          setFailed(false);
          setDisconnecting(row);
        }}
        changesHref={rows().length > 0 ? "/changes?who=agent" : undefined}
      />
      <AgentDisconnectDialog
        agent={disconnecting()}
        pending={pending()}
        failed={failed()}
        onConfirm={() => void disconnect()}
        onCancel={() => {
          const row = disconnecting();
          setDisconnecting(null);
          if (row) document.getElementById(agentDisconnectId(row.id))?.focus();
        }}
      />
    </section>
  );
}
