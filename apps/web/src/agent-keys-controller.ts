/** What Settings, Agents does on a service with accounts, as a state machine with no screen in it: the agents that are connected (the agent keys the person may see), the
 * code that connects another with one command, and disconnecting one. The Solid view (routes/agent/keys-page.tsx) draws the state and calls these functions; the tests drive
 * them with a stand-in for the account layer. Nothing here knows about the DOM.
 *
 * The control plane decides everything and says why when it refuses (docs/reference/program/hosting/agents.md); the page repeats what a role may give (`grantable`, told by the
 * control plane) so that it offers only what will be accepted, never so that it decides. The page never holds a credential: it shows a code that works once, for ten minutes,
 * and the command line (`rastrata connect <code>`) is what is answered with the key. */
import type { Account, AgentKeySummary, AgentScope, Result, Role } from "./account";

// What the components of the UI package take, written out here as the UI package writes out what the service returns: this file is exercised without the components (and without
// their JSX), and a type that is not the same shape is found where the page hands one to the other.
export type TokenPermission = AgentScope;
export type AgentChoiceId = "draft" | "read-only" | "bookkeeper";
export interface AgentChoice {
  readonly id: AgentChoiceId;
  readonly permissions: readonly TokenPermission[];
}
export interface AgentConnectedRow {
  readonly id: string;
  readonly name: string;
  readonly permissions: readonly TokenPermission[];
  readonly status: "active" | "expired";
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly owner?: string | undefined;
}

type Calls = Pick<
  Account,
  "agentKeys" | "createAgentCode" | "revokeAgentKey" | "scope" | "workspace" | "session"
>;

/** What a person may let an agent do, the usual one first. They are the service's presets (`TOKEN_PRESETS`): none closes a month, and finishing a reconciliation stays with a
 * person. The same three, in the same order, as the UI package's `AGENT_CHOICES`. */
export const CHOICES: readonly AgentChoice[] = [
  { id: "draft", permissions: ["read", "draft"] },
  { id: "read-only", permissions: ["read"] },
  { id: "bookkeeper", permissions: ["read", "draft", "post"] },
];

/** An agent that ran out stays on the list this long, so that one that stopped working is explained. */
const KEEP_EXPIRED_MS = 30 * 86_400_000;

export interface ShownCode {
  readonly code: string;
  /** When it stops working. */
  readonly expiresAt: string;
}

export interface AgentKeysView {
  readonly workspace: string;
  readonly role: Role;
  /** What is connected: the keys that work, and those that ran out in the last month. */
  readonly rows: readonly AgentConnectedRow[];
  /** What this person may let an agent do. */
  readonly choices: readonly AgentChoice[];
  readonly choice: AgentChoiceId;
  /** The code on the screen. */
  readonly code: ShownCode | null;
  readonly getting: boolean;
  /** Why a code could not be made, in the service's words. */
  readonly problem: string | null;
  /** The refusal was that the sign-in is too old: the page offers to sign in again. */
  readonly needsSignIn: boolean;
  /** The code that was showing ran out before it was used. */
  readonly ranOut: boolean;
  /** The name of the agent that connected with the code that was showing. */
  readonly connected: string | null;
  /** Only an owner may read what the agents changed (the book's list of changes names agent keys to the owner). */
  readonly canSeeChanges: boolean;
  readonly disconnecting: AgentConnectedRow | null;
  readonly disconnectPending: boolean;
  readonly disconnectFailed: boolean;
  /** Said to a screen reader: what has just happened. */
  readonly announcement: string;
}

export type AgentKeysState =
  | { readonly step: "loading" }
  | { readonly step: "problem"; readonly message: string }
  | { readonly step: "ready"; readonly view: AgentKeysView };

export interface AgentKeysOptions {
  readonly account: Calls;
  /** The clock; a test fixes it. */
  readonly now?: () => Date;
  /** The choice to begin with, when the person had made one before signing in again. */
  readonly choice?: AgentChoiceId | undefined;
}

/** What the list calls the person an agent acts for, when it is not the one reading it. */
const FORMER_MEMBER = "a former member";

export class AgentKeysController {
  #state: AgentKeysState = { step: "loading" };
  readonly #listeners = new Set<(state: AgentKeysState) => void>();
  readonly #account: Calls;
  readonly #now: () => Date;
  readonly #wanted: AgentChoiceId | undefined;
  #getting = false;
  /** The keys there were when the code on the screen was made: one that is not among them, and is this person's, is the agent that used the code. */
  #before: ReadonlySet<string> = new Set();
  #me: string | null = null;
  #emails: ReadonlyMap<string, string> = new Map();

  constructor(options: AgentKeysOptions) {
    this.#account = options.account;
    this.#now = options.now ?? (() => new Date());
    this.#wanted = options.choice;
  }

  get state(): AgentKeysState {
    return this.#state;
  }

  subscribe(listener: (state: AgentKeysState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(state: AgentKeysState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }

  #change(change: Partial<AgentKeysView>): void {
    if (this.#state.step === "ready")
      this.#set({ step: "ready", view: { ...this.#state.view, ...change } });
  }

  /** The keys as the list shows them: those that work, and those that ran out in the last month. */
  #rows(keys: readonly AgentKeySummary[]): readonly AgentConnectedRow[] {
    const recent = this.#now().getTime() - KEEP_EXPIRED_MS;
    return keys
      .filter(
        (key) =>
          key.status === "active" ||
          (key.status === "expired" && Date.parse(key.expiresAt) >= recent),
      )
      .map((key) => ({
        id: key.id,
        name: key.name,
        permissions: key.scopes,
        status: key.status === "active" ? ("active" as const) : ("expired" as const),
        expiresAt: key.expiresAt,
        lastUsedAt: key.lastUsedAt,
        owner:
          key.userId === this.#me ? undefined : (this.#emails.get(key.userId) ?? FORMER_MEMBER),
      }));
  }

  /** Read the keys the person may see, and what they may give one. Called when the page opens, and after each change. The keys as the control plane listed them are returned
   * to the caller that needs them (the check for the agent that used the code). */
  async load(): Promise<readonly AgentKeySummary[] | null> {
    const workspace = this.#account.scope();
    if (workspace === null) {
      this.#set({ step: "problem", message: "No workspace is open." });
      return null;
    }
    const [keys, detail, session] = await Promise.all([
      this.#account.agentKeys(workspace),
      this.#account.workspace(workspace),
      this.#account.session(),
    ]);
    if (!keys.ok || !detail.ok) {
      const message = !keys.ok ? keys.message : !detail.ok ? detail.message : "";
      // A list that could not be read again leaves the one on the screen: what is showing was true a moment ago, and the next read replaces it.
      if (this.#state.step !== "ready") this.#set({ step: "problem", message });
      return null;
    }
    const grantable = keys.value.grantable as readonly TokenPermission[];
    const held = this.#state.step === "ready" ? this.#state.view : null;
    // Who is "you" is a detail of the list and not worth a failed page: without it the person's own address is shown as another member's is.
    this.#me = session.ok ? (session.value?.id ?? null) : null;
    this.#emails = new Map(detail.value.members.map((member) => [member.userId, member.email]));
    const role = detail.value.workspace.role;
    const choices = CHOICES.filter((choice) =>
      choice.permissions.every((permission) => grantable.includes(permission)),
    );
    const wanted = held?.choice ?? this.#wanted;
    this.#set({
      step: "ready",
      view: {
        workspace,
        role,
        rows: this.#rows(keys.value.keys),
        choices,
        choice: choices.find((choice) => choice.id === wanted)?.id ?? choices[0]?.id ?? "read-only",
        code: held?.code ?? null,
        getting: held?.getting ?? false,
        problem: held?.problem ?? null,
        needsSignIn: held?.needsSignIn ?? false,
        ranOut: held?.ranOut ?? false,
        connected: held?.connected ?? null,
        canSeeChanges: role === "owner",
        disconnecting: held?.disconnecting ?? null,
        disconnectPending: held?.disconnectPending ?? false,
        disconnectFailed: held?.disconnectFailed ?? false,
        announcement: held?.announcement ?? "",
      },
    });
    return keys.value.keys;
  }

  /** What the agent may do. The code on the screen was made for the choice before, so it goes: the next one is asked for with the button. */
  choose(choice: AgentChoiceId): void {
    if (this.#state.step !== "ready" || this.#getting) return;
    if (!this.#state.view.choices.some((offered) => offered.id === choice)) return;
    this.#change({ choice, code: null, problem: null, ranOut: false, connected: null });
  }

  /** Ask for the code that the command carries. A second call while one is under way is that one. */
  async getCommand(): Promise<boolean> {
    if (this.#state.step !== "ready" || this.#getting) return false;
    const { view } = this.#state;
    const choice = view.choices.find((offered) => offered.id === view.choice);
    if (!choice) return false;
    this.#getting = true;
    this.#change({
      getting: true,
      problem: null,
      needsSignIn: false,
      ranOut: false,
      connected: null,
    });
    try {
      const answer = await this.#account.createAgentCode(view.workspace, choice.permissions);
      if (!answer.ok) {
        this.#refused(answer);
        return false;
      }
      this.#before = new Set(view.rows.map((row) => row.id));
      this.#change({ code: { code: answer.value.code, expiresAt: answer.value.expiresAt } });
      return true;
    } finally {
      this.#getting = false;
      this.#change({ getting: false });
    }
  }

  #refused(failure: Extract<Result<unknown>, { ok: false }>): void {
    const stale = failure.code === "session_not_fresh";
    this.#change({ problem: stale ? null : failure.message, needsSignIn: stale, code: null });
  }

  /** While a code is on the screen the page asks, every few seconds: was it used, or has it run out? A code that was used is taken away and its agent named; one that
   * ran out is taken away and the page says so. Returns whether there is still a code to ask about. */
  async check(): Promise<boolean> {
    if (this.#state.step !== "ready" || this.#state.view.code === null) return false;
    const shown = this.#state.view.code;
    // The list alone: who is in the workspace and who is signed in were read when the page opened.
    const listed = await this.#account.agentKeys(this.#state.view.workspace);
    if (this.#state.step !== "ready" || this.#state.view.code !== shown) return false;
    const keys = listed.ok ? listed.value.keys : null;
    if (keys) this.#change({ rows: this.#rows(keys) });
    const made = keys?.find(
      (key) => !this.#before.has(key.id) && key.userId === this.#me && key.status === "active",
    );
    if (made) {
      this.#change({
        code: null,
        connected: made.name,
        announcement: `${made.name} is connected`,
      });
      return false;
    }
    if (Date.parse(shown.expiresAt) <= this.#now().getTime()) {
      this.#change({ code: null, ranOut: true });
      return false;
    }
    return true;
  }

  askDisconnect(row: AgentConnectedRow): void {
    this.#change({ disconnecting: row, disconnectFailed: false });
  }

  cancelDisconnect(): void {
    this.#change({ disconnecting: null, disconnectFailed: false });
  }

  async disconnect(): Promise<boolean> {
    if (this.#state.step !== "ready") return false;
    const row = this.#state.view.disconnecting;
    if (row === null || this.#state.view.disconnectPending) return false;
    this.#change({ disconnectPending: true, disconnectFailed: false });
    const answer = await this.#account.revokeAgentKey(row.id);
    if (!answer.ok) {
      this.#change({ disconnectPending: false, disconnectFailed: true });
      return false;
    }
    const current = this.state;
    this.#change({
      disconnectPending: false,
      disconnecting: null,
      // The line that said it had just connected is no longer true.
      ...(current.step === "ready" && current.view.connected === row.name
        ? { connected: null }
        : {}),
      announcement: `${row.name} was disconnected`,
    });
    await this.load();
    return true;
  }
}
