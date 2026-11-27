/** What the Stripe card does where Stripe is connected with the button, as a state machine with no screen in it: which Stripe account is connected, how the last reading went, and the few things
 * a person may do about that (connect it, read it now, stop reading it). The Solid view (routes/stripe/page.tsx) draws the state and calls these functions; the tests drive them with a stand-in
 * for the control plane. Nothing here knows about the DOM.
 *
 * The control plane decides who may connect and stop (an owner) and who may read now (an owner or an admin); the card repeats the roles' rules so that it offers only what will be accepted,
 * never so that it decides. After each change the connection is read again: the card shows what the control plane holds, not what it expects. */
import type { StripeAppBusy, StripeAppNotice, StripeAppView } from "@rastrata/ui/stripe/types";
import { words as stripeWords } from "@rastrata/ui/stripe/words";
import type { Result, Role, StripeAppConnections, WorkspaceSummary } from "./account.ts";

/** The control plane's side. */
export interface StripeAppControl {
  scope(): string | null;
  workspace(id: string): Promise<Result<{ workspace: WorkspaceSummary }>>;
  stripeAppConnection(workspace: string): Promise<Result<StripeAppConnections>>;
  stripeAppStart(workspace: string): Promise<Result<{ url: string }>>;
  stripeAppDisconnect(workspace: string): Promise<Result<unknown>>;
  stripeAppReadNow(workspace: string): Promise<Result<unknown>>;
}

/** Roles that may connect and stop: the control plane's rule. */
const MAY_CONNECT: ReadonlySet<Role> = new Set(["owner"]);
/** Roles that may read now, and are told how the connection stands. */
const MAY_READ: ReadonlySet<Role> = new Set(["owner", "admin"]);

/** What the book says of the connection (`stripe.status`), for a person the control plane does not tell: whom it reads. */
export interface BookLink {
  readonly accountId: string;
  readonly livemode: boolean;
  readonly since: string;
}

/** How the card is drawn for a role, from what the control plane says (for an owner or an admin) and what the book says. */
export function viewOf(
  role: Role,
  standing: StripeAppConnections | null,
  link: BookLink | null,
): StripeAppView {
  const mayConnect = MAY_CONNECT.has(role);
  const none: StripeAppView = {
    stage: "none",
    accountId: null,
    live: true,
    connectedAt: null,
    syncedAt: null,
    reading: false,
    problem: null,
    canConnect: false,
    canReadNow: false,
    canDisconnect: false,
  };
  // A person the control plane does not tell: the book's word of whom it reads, and nothing to do.
  if (standing === null)
    return link
      ? {
          ...none,
          stage: "connected",
          accountId: link.accountId,
          live: link.livemode,
          connectedAt: link.since,
        }
      : none;
  if (!standing.available && standing.connection === null) return { ...none, stage: "unavailable" };
  const connection = standing.connection;
  if (connection === null) return { ...none, canConnect: mayConnect && standing.available };
  const problem = stripeWords.appProblem(connection.problem);
  if (connection.state === "disconnected")
    return {
      ...none,
      stage: "stopped",
      accountId: connection.accountId,
      live: connection.livemode,
      connectedAt: connection.connectedAt,
      syncedAt: connection.syncedAt,
      problem,
      canConnect: mayConnect && standing.available,
    };
  return {
    stage: "connected",
    accountId: connection.accountId,
    live: connection.livemode,
    connectedAt: connection.connectedAt,
    syncedAt: connection.syncedAt,
    reading: connection.reading,
    problem,
    canConnect: false,
    canReadNow: MAY_READ.has(role),
    canDisconnect: mayConnect,
  };
}

/** What a person is told on coming back from Stripe: the outcome the control plane sent them back with, in words, or none for one it does not know. */
export function noticeOf(outcome: string | null): StripeAppNotice | null {
  if (outcome === null) return null;
  return stripeWords.appBack[outcome] ?? null;
}

export type StripeAppState =
  | { readonly step: "loading" }
  | { readonly step: "problem"; readonly message: string }
  | {
      readonly step: "ready";
      readonly role: Role;
      readonly view: StripeAppView;
      readonly busy: StripeAppBusy;
      /** Asking whether to stop reading. */
      readonly stopping: boolean;
      /** What went wrong the last time something was asked, in the control plane's words. */
      readonly error?: string;
    };

export interface StripeAppOptions {
  readonly control: StripeAppControl;
  /** What the book says of the connection, read again with every look at the card. */
  readonly link: () => BookLink | null;
  /** Where the browser goes next: Stripe's page. */
  readonly go: (address: string) => void;
}

export class StripeAppController {
  #state: StripeAppState = { step: "loading" };
  readonly #listeners = new Set<(state: StripeAppState) => void>();
  readonly #options: StripeAppOptions;

  constructor(options: StripeAppOptions) {
    this.#options = options;
  }

  get state(): StripeAppState {
    return this.#state;
  }

  subscribe(listener: (state: StripeAppState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(state: StripeAppState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }

  #ready(): Extract<StripeAppState, { step: "ready" }> | null {
    return this.#state.step === "ready" ? this.#state : null;
  }

  /** Read the card: when the page opens, and again every few seconds while a reading is under way. */
  async load(): Promise<void> {
    const { control, link } = this.#options;
    const id = control.scope();
    if (id === null) {
      this.#set({ step: "problem", message: "No workspace is open." });
      return;
    }
    const detail = await control.workspace(id);
    if (!detail.ok) {
      this.#fail(detail.message);
      return;
    }
    const role = detail.value.workspace.role;
    // How the connection stands is for an owner or an admin; a failure to learn it is not a failure to draw the card.
    const standing = MAY_READ.has(role) ? await control.stripeAppConnection(id) : null;
    const known = standing?.ok ? standing.value : null;
    if (standing !== null && !standing.ok && this.#ready() === null) {
      this.#fail(standing.message);
      return;
    }
    const before = this.#ready();
    this.#set({
      step: "ready",
      role,
      view: viewOf(role, known, link()),
      busy: before?.busy ?? null,
      stopping: before?.stopping ?? false,
      ...(before?.error ? { error: before.error } : {}),
    });
  }

  #fail(message: string): void {
    const ready = this.#ready();
    if (ready) this.#set({ ...ready, error: message });
    else this.#set({ step: "problem", message });
  }

  async #act(
    kind: Exclude<StripeAppBusy, null>,
    work: (id: string) => Promise<Result<unknown>>,
    then: () => void = () => {},
  ): Promise<void> {
    const id = this.#options.control.scope();
    const ready = this.#ready();
    if (id === null || ready === null || ready.busy !== null) return;
    const { error: _old, ...clear } = ready;
    this.#set({ ...clear, busy: kind });
    const done = await work(id);
    if (!done.ok) {
      const current = this.#ready() ?? ready;
      this.#set({ ...current, busy: null, error: done.message });
      return;
    }
    then();
    await this.load();
    const after = this.#ready();
    if (after) this.#set({ ...after, busy: null });
  }

  /** Send the owner to the app's install page at Stripe. */
  connect(): Promise<void> {
    return this.#act(
      "connect",
      async (id) => {
        const started = await this.#options.control.stripeAppStart(id);
        if (started.ok) this.#options.go(started.value.url);
        return started;
      },
      () => {},
    );
  }

  readNow(): Promise<void> {
    return this.#act("readNow", (id) => this.#options.control.stripeAppReadNow(id));
  }

  askToStop(): void {
    const ready = this.#ready();
    if (ready) this.#set({ ...ready, stopping: true });
  }

  keepReading(): void {
    const ready = this.#ready();
    if (ready) this.#set({ ...ready, stopping: false });
  }

  async stop(): Promise<void> {
    await this.#act(
      "disconnect",
      (id) => this.#options.control.stripeAppDisconnect(id),
      () => {
        const ready = this.#ready();
        if (ready) this.#set({ ...ready, stopping: false });
      },
    );
  }
}
