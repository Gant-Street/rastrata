import {
  AgentConnect,
  AgentConnectedList,
  AgentDisconnectDialog,
  agentDisconnectId,
  agentWords,
  Button,
  connectCommand,
  Notice,
  PageHeader,
  PageSkeleton,
} from "@rastrata/ui";
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import type { Account } from "../../account";
import {
  type AgentChoiceId,
  AgentKeysController,
  type AgentKeysState,
  type AgentKeysView,
} from "../../agent-keys-controller";
import { currentAccount, START_PATH } from "../../boot";
import { returnAfterSignIn } from "../../return-after-sign-in";
import { keysWords as words } from "./keys-words";
import { AgentAccessPage } from "./page";
import { SITE } from "../../links";

const PATH = "/settings/agent";
/** What the person had chosen when they were sent to sign in again: on the way back the command is asked for with it, so that they do not press the button twice. For this
 * tab only, and taken out as it is read. */
const RESUME_KEY = "rastrata:agents:resume";
/** How often the page asks whether the code on the screen was used. */
const CHECK_EVERY_MS = 3000;

function takeResume(): AgentChoiceId | undefined {
  try {
    const kept = window.sessionStorage.getItem(RESUME_KEY);
    window.sessionStorage.removeItem(RESUME_KEY);
    return kept === "draft" || kept === "read-only" || kept === "bookkeeper" ? kept : undefined;
  } catch {
    return undefined;
  }
}

/** Settings, Agents: on a service with accounts an agent is a key of the control plane's (exchanged for a short-lived token at the service), connected with a code that the
 * command line exchanges; on any other it is a token of the book's own, which the command line makes as the owner (page.tsx). One route, so that an address that was typed or
 * bookmarked works on both. */
export function AgentsPage() {
  const account = currentAccount();
  return (
    <Show when={account} fallback={<AgentAccessPage />}>
      {(present) => {
        const resumed = takeResume();
        // Made once: the page talks to the one controller it listens to.
        const controller = new AgentKeysController({ account: present(), choice: resumed });
        return (
          <KeysBody controller={controller} account={present()} resume={resumed !== undefined} />
        );
      }}
    </Show>
  );
}

function KeysBody(props: {
  readonly controller: AgentKeysController;
  readonly account: Account;
  readonly resume: boolean;
}) {
  const [state, setState] = createSignal<AgentKeysState>(props.controller.state);
  onCleanup(props.controller.subscribe(setState));
  onMount(() => {
    void props.controller.load().then(() => {
      // Back from signing in again: the command they asked for.
      if (props.resume) void props.controller.getCommand();
    });
  });
  const view = createMemo<AgentKeysView | null>(() => {
    const current = state();
    return current.step === "ready" ? current.view : null;
  });
  const problem = () => {
    const current = state();
    return current.step === "problem" ? current.message : null;
  };
  // While a code is on the screen: was it used? The list gains the agent and the code goes, with no reload.
  createEffect(
    on(
      () => view()?.code ?? null,
      (code) => {
        if (code === null) return;
        const timer = window.setInterval(() => void props.controller.check(), CHECK_EVERY_MS);
        onCleanup(() => window.clearInterval(timer));
      },
    ),
  );

  return (
    <section class="rt-stack rt-agent-page" aria-labelledby="agent-access-title">
      <PageHeader
        titleId="agent-access-title"
        title={agentWords.title}
        description={agentWords.intro}
      />
      <Show when={state().step === "loading"}>
        <PageSkeleton shape="table" label={words.loading} />
      </Show>
      <Show when={problem()}>
        {(message) => (
          <Notice title={words.failed} tone="problem" role="alert">
            <p>{message()}</p>
            <Button
              variant="secondary"
              label={agentWords.retry}
              onClick={() => void props.controller.load()}
            />
          </Notice>
        )}
      </Show>
      <Show when={view()}>
        {(ready) => <Ready view={ready()} controller={props.controller} account={props.account} />}
      </Show>
    </section>
  );
}

function Ready(props: {
  readonly view: AgentKeysView;
  readonly controller: AgentKeysController;
  readonly account: Account;
}) {
  const signInAgain = async () => {
    try {
      window.sessionStorage.setItem(RESUME_KEY, props.view.choice);
    } catch {
      // They press the button once more when they are back.
    }
    returnAfterSignIn(PATH);
    await props.account.signOut();
    window.location.assign(START_PATH);
  };
  return (
    <>
      <span class="rt-sr-only" role="status">
        {props.view.announcement}
      </span>
      <AgentConnect
        choices={props.view.choices}
        choice={props.view.choice}
        onChoice={(choice) => props.controller.choose(choice)}
        command={
          props.view.code ? connectCommand(props.view.code.code, window.location.origin) : null
        }
        // While the sign-in is too old the one thing to press is "Sign in again": the command's button would only be refused.
        onGetCommand={props.view.needsSignIn ? undefined : () => void props.controller.getCommand()}
        pending={props.view.getting}
        problem={props.view.problem ?? undefined}
        once
        installHref={`${SITE}/install/#command-line`}
        ranOut={props.view.ranOut}
        connected={props.view.connected ?? undefined}
      >
        <Show when={props.view.needsSignIn}>
          <Notice title={words.signInAgain} tone="review" role="alert">
            <p>{words.signInAgainBody}</p>
            <Button
              variant="primary"
              label={words.signInAgainButton}
              onClick={() => void signInAgain()}
            />
          </Notice>
        </Show>
      </AgentConnect>
      <AgentConnectedList
        rows={props.view.rows}
        disconnecting={props.view.disconnectPending ? props.view.disconnecting?.id : undefined}
        onDisconnect={(row) => props.controller.askDisconnect(row)}
        changesHref={
          props.view.canSeeChanges && props.view.rows.length > 0 ? "/changes?who=agent" : undefined
        }
      />
      <AgentDisconnectDialog
        agent={props.view.disconnecting}
        pending={props.view.disconnectPending}
        failed={props.view.disconnectFailed}
        onConfirm={() => void props.controller.disconnect()}
        onCancel={() => {
          const row = props.view.disconnecting;
          props.controller.cancelDisconnect();
          if (row) document.getElementById(agentDisconnectId(row.id))?.focus();
        }}
      />
    </>
  );
}
