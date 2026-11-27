/** What the list of workspaces does about deleting the account, as a state machine with no screen in it: the address is typed, the control plane ends every session, takes the person out of
 * every workspace and erases the address, and the page leaves for the sign-in page. A person who is the only owner of a workspace is told which, and nothing is done. The Solid view
 * (the end of gate.tsx's list of workspaces) draws the state and calls `run`; the tests drive it with a stand-in for the control plane. Nothing here knows about the DOM. */
import type { Account } from "./account";

export interface BlockingWorkspace {
  readonly id: string;
  readonly name: string;
}

export type DeleteAccountState =
  | { readonly step: "idle" }
  | { readonly step: "deleting" }
  /** The person is the only owner of these workspaces in use, and nothing was done. */
  | { readonly step: "blocked"; readonly workspaces: readonly BlockingWorkspace[] }
  | { readonly step: "failed"; readonly message: string }
  | { readonly step: "done" };

export interface DeleteAccountOptions {
  readonly account: Pick<Account, "deleteAccount">;
  /** The address the person is signed in with. */
  readonly address: string;
  /** Forget the workspace that is open: the person is nobody's now. */
  readonly forget: () => void;
  /** Where the browser goes next. */
  readonly go: (path: string) => void;
  /** Where that is: the sign-in page. */
  readonly leaveFor: string;
}

/** An address is read as the service reads it: without the spaces around it, whatever the case. */
export const sameAddress = (typed: string, address: string): boolean =>
  typed.trim().toLowerCase() === address.trim().toLowerCase();

/** The workspaces the control plane names in its refusal, or none if it named them in a way that is not understood. */
function workspacesIn(detail: Record<string, unknown> | undefined): BlockingWorkspace[] {
  const listed = detail?.workspaces;
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((item: unknown) => {
    const { id, name } = (item ?? {}) as { id?: unknown; name?: unknown };
    return typeof id === "string" && typeof name === "string" ? [{ id, name }] : [];
  });
}

export class DeleteAccountController {
  #state: DeleteAccountState = { step: "idle" };
  readonly #listeners = new Set<(state: DeleteAccountState) => void>();
  readonly #options: DeleteAccountOptions;
  #running = false;

  constructor(options: DeleteAccountOptions) {
    this.#options = options;
  }

  get state(): DeleteAccountState {
    return this.#state;
  }

  subscribe(listener: (state: DeleteAccountState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(state: DeleteAccountState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }

  /** Nothing is sent until what was typed is the address; the control plane checks it again. */
  async run(typed: string): Promise<void> {
    if (this.#running) return;
    const { account, address } = this.#options;
    if (!sameAddress(typed, address)) {
      this.#set({ step: "failed", message: "Type your email address to delete your account." });
      return;
    }
    this.#running = true;
    try {
      this.#set({ step: "deleting" });
      const answer = await account.deleteAccount(typed.trim());
      if (!answer.ok) {
        const workspaces = answer.code === "sole_owner" ? workspacesIn(answer.detail) : [];
        this.#set(
          workspaces.length > 0
            ? { step: "blocked", workspaces }
            : { step: "failed", message: answer.message },
        );
        return;
      }
      this.#set({ step: "done" });
      this.#options.forget();
      this.#options.go(this.#options.leaveFor);
    } finally {
      this.#running = false;
    }
  }
}
