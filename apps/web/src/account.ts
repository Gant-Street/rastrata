/** The page's side of accounts, for a service whose people sign in with an emailed code (see docs/reference/program/hosting/workspaces.md and
 * control-worker.md): the calls to the control plane at `/auth`, and the token for the workspace that is open, which every request of the application then carries.
 *
 * A token is signed by the control plane, lives ten minutes and names the person, the workspace and its book; the service finds the person's role in the book.
 * The page asks for a new one when less than three minutes are left, behind the request that finds it so that no request waits for it, once at a time however
 * many ask, and again at once if the service refuses one (ambient.ts). It keeps the token in memory only: a page that is closed has none to leave behind.
 *
 * Every function that talks to the control plane answers with a `Result`: either the value, or what went wrong in the words the control plane chose for a
 * person, with its status and code for the page to act on. None throws for an answer the control plane gave. */
import type { Authorizer } from "./ambient";
import { takeEarlyToken } from "./early";

export type Role = "owner" | "admin" | "accountant" | "member";

export interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  readonly state: "provisioning" | "ready" | "deleting" | "deleted";
  /** When the books will be erased, while the workspace is being deleted: an owner can bring it back until then. */
  readonly deleteAfter?: string;
  /** How the workspace stands as to its trial and subscription, where the service charges for workspaces. */
  readonly billing?: BillingSummary;
}
export type BillingState = "complimentary" | "trialing" | "active" | "past_due" | "read_only";
/** How a workspace stands as to its trial and subscription, as the control plane says it. */
export interface BillingSummary {
  readonly state: BillingState;
  /** While the trial runs: when it ends, and the days left (a part of a day counts as one). */
  readonly trialEndsAt: string | null;
  readonly daysLeft: number | null;
  readonly readOnly: boolean;
  readonly plan: "month" | "year" | null;
  readonly periodEnd: string | null;
  /** The subscription ends at the period's end: asked for, and not yet in effect. */
  readonly cancelAtPeriodEnd: boolean;
}
export interface BillingPrice {
  /** In the smallest unit of the currency (cents). */
  readonly amount: number;
  readonly currency: string;
}
export type BillingAnswer =
  | { readonly available: false }
  | (BillingSummary & {
      readonly available: true;
      readonly prices: { readonly month: BillingPrice; readonly year: BillingPrice };
      /** Only an owner subscribes and manages the subscription. */
      readonly canManage: boolean;
    });
export interface Member {
  readonly userId: string;
  readonly email: string;
  readonly role: Role;
  /** Whether the service has them yet; a person invited a moment ago may not be. */
  readonly ready: boolean;
}
export interface PendingInvitation {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly expiresAt: string;
}
export interface WorkspaceDetail {
  readonly workspace: WorkspaceSummary;
  readonly members: readonly Member[];
  /** Only an owner and an admin are told who is invited. */
  readonly invitations?: readonly PendingInvitation[];
}
/** A passkey as the page shows it: what it is called and when it was made, and nothing that signs in. */
export interface PasskeySummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  /** Whether it is kept in the person's password manager or cloud account, and so is on their other devices too. */
  readonly synced: boolean;
}
/** What an agent key may be given, as the control plane names it: the same words as an agent token's permissions in the book. */
export type AgentScope = "read" | "draft" | "post" | "configure" | "correct" | "close";
/** An agent key as the page shows it. The secret is never in it: that is told once, when the key is made. */
export interface AgentKeySummary {
  readonly id: string;
  /** `rsa_<id>`: enough to match a key in a list to the one in a program's environment. */
  readonly prefix: string;
  readonly workspace: string;
  /** The person the key acts for. */
  readonly userId: string;
  readonly name: string;
  readonly scopes: readonly AgentScope[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
  readonly status: "active" | "revoked" | "expired";
}
export interface AgentKeyList {
  readonly keys: readonly AgentKeySummary[];
  /** What this person may give a key. */
  readonly grantable: readonly AgentScope[];
  readonly defaultExpiryDays: number;
  readonly maxExpiryDays: number;
}
export interface InvitationView {
  readonly workspace: string;
  readonly role: Role;
  /** The address with all but its first letter hidden. */
  readonly email: string;
  readonly state: "pending" | "accepted" | "expired";
}
export interface CaptchaConfig {
  readonly provider: "turnstile";
  readonly siteKey: string;
}
/** An account an owner connected, as the control plane knows it: how the connection stands and how the last reading went. The book has the rest (where it is booked). */
export interface BankConnection {
  readonly id: string;
  readonly institution: string;
  readonly name: string;
  readonly last4: string | null;
  readonly kind: string;
  readonly state: "active" | "inactive" | "disconnected";
  /** When the book last took what the bank had, or null. */
  readonly syncedAt: string | null;
  /** A short code for what went wrong the last time, or null. */
  readonly problem: string | null;
}
export interface BankConnections {
  /** Whether this service can connect banks at all (the control plane has the keys). */
  readonly available: boolean;
  /** How many accounts a workspace may have connected. */
  readonly limit: number;
  readonly accounts: readonly BankConnection[];
}
/** The Stripe account an owner connected with the button, as the control plane knows it: how the connection stands and how the last reading went. */
export interface StripeAppConnection {
  readonly accountId: string;
  /** Stripe's live mode (real sales) or a sandbox (practice data). */
  readonly livemode: boolean;
  readonly state: "active" | "disconnected";
  readonly connectedAt: string;
  /** When a reading last finished, or null. */
  readonly syncedAt: string | null;
  /** A reading is waiting or under way. */
  readonly reading: boolean;
  /** A short code for what went wrong, or null. */
  readonly problem: string | null;
}
export interface StripeAppConnections {
  /** Whether this service can connect Stripe at all (the control plane has the app). */
  readonly available: boolean;
  readonly connection: StripeAppConnection | null;
}
export interface Person {
  readonly id: string;
  readonly email: string;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      /** 0: the control plane could not be reached. */
      readonly status: number;
      readonly code: string;
      readonly message: string;
      /** Seconds, when the control plane says when to try again. */
      readonly retryAfter: number | null;
      /** What else the refusal said besides its message and code, when it said anything (the workspaces a person is the only owner of). */
      readonly detail?: Record<string, unknown>;
    };

const UNREACHABLE = "The service could not be reached. Try again in a moment.";
const ok = <T>(value: T): Result<T> => ({ ok: true, value });

type Ask = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Notes = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Where the page remembers which workspace is open. Not a secret; read at the start of the page. */
export const WORKSPACE_KEY = "rastrata:workspace";
/** A new token is asked for, behind the request that finds the old one this close to its end, when this much of its life is left, or less: the request goes with the old one. */
export const REFRESH_BEFORE_MS = 180_000;
/** A request waits for a new token only when the old one has less than this left (a person who came back after a long pause): one with more is as good as a fresh one. */
export const WAIT_BELOW_MS = 30_000;

/** `promise`, or a failure when it has not answered within `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no answer")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Raised, only inside the token provider, for the three things that end the page's right to ask: the session has ended, the workspace has gone from the person, the control plane cannot say. */
export class AccountError extends Error {
  constructor(readonly kind: "session_ended" | "workspace_gone" | "unavailable") {
    super(kind);
  }
}

/** How long ending a session waits for what the page keeps on the device to be deleted: a device that does not answer (a browser whose storage is stuck) must not be a person who cannot sign out. */
export const FORGET_WAIT_MS = 1_500;

export interface AccountOptions {
  readonly ask?: Ask;
  readonly storage?: Notes | null;
  /** Milliseconds, for tests. */
  readonly now?: () => number;
  /** Waits, for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Told when the session has ended or the workspace is gone, so that the page can leave. */
  readonly onEnded?: (why: "session_ended" | "workspace_gone") => void;
  /** What the page keeps on the device of the book (held.ts) is locked with a key that comes with the token: the application's page says what to do with it, and the sign-in page keeps nothing. */
  readonly copy?: {
    /** The key has come with the token for this workspace. */
    readonly unlock: (key: string, workspace: string) => void;
    /** No key will come (the token could not be had, or came without one). */
    readonly giveUp: () => void;
    /** The person has signed out: nothing of the book stays on the device. */
    readonly forget: () => Promise<void>;
  };
  /** The control plane has changed the book without a request of the page's own (a bank or Stripe was read, or stopped): what the page holds of the book is no longer so (held.ts), as after a change it makes itself. */
  readonly bookChanged?: () => void;
}

function storageOf(): Notes | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export class Account implements Authorizer {
  readonly #ask: Ask;
  readonly #storage: Notes | null;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #onEnded: (why: "session_ended" | "workspace_gone") => void;
  readonly #copy: NonNullable<AccountOptions["copy"]>;
  readonly #bookChanged: () => void;
  #token: { value: string; workspace: string; expiresAt: number } | null = null;
  #fetching: { workspace: string; promise: Promise<string> } | null = null;

  constructor(options: AccountOptions = {}) {
    this.#ask = options.ask ?? ((input, init) => fetch(input, init));
    this.#storage = options.storage === undefined ? storageOf() : options.storage;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.#onEnded = options.onEnded ?? (() => {});
    this.#copy = options.copy ?? { unlock: () => {}, giveUp: () => {}, forget: async () => {} };
    this.#bookChanged = options.bookChanged ?? (() => {});
  }

  // ---- the control plane ------------------------------------------------------------------------------

  async #call<T>(
    method: "GET" | "POST",
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      /** The request the page's first lines have already made for this call (early.ts): its answer is used in place of asking. */
      early?: Promise<Response>;
    } = {},
  ): Promise<Result<T>> {
    let response: Response;
    try {
      response = await (options.early !== undefined
        ? within(options.early, 15_000)
        : this.#ask(path, {
            method,
            headers: {
              ...(options.body === undefined ? {} : { "content-type": "application/json" }),
              ...options.headers,
            },
            ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
            cache: "no-store",
            signal: AbortSignal.timeout(15_000),
          }));
    } catch {
      return { ok: false, status: 0, code: "unreachable", message: UNREACHABLE, retryAfter: null };
    }
    const unreachable = {
      ok: false as const,
      status: 0,
      code: "unreachable",
      message: UNREACHABLE,
      retryAfter: null,
    };
    // An answer whose body does not arrive is no answer: the connection dropped after the status came, or the
    // page was left while it was being read (Safari hands that to the code that was waiting). It is never a
    // success with nothing in it, which a screen would then read a workspace out of.
    let text: string;
    try {
      text = await response.text();
    } catch {
      return unreachable;
    }
    let body: unknown = null;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      // An answer that is not JSON. Refused, the status says what there is to say; accepted, it is not the
      // control plane that answered (a network's own sign-in page, a proxy's error with a good status).
      if (response.ok) return unreachable;
    }
    if (response.ok) return ok(body as T);
    const failure = (body ?? {}) as { message?: unknown; code?: unknown };
    const more =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? Object.fromEntries(
            Object.entries(body as Record<string, unknown>).filter(
              ([name]) => name !== "message" && name !== "code",
            ),
          )
        : {};
    const wait = Number(response.headers.get("retry-after"));
    return {
      ok: false,
      status: response.status,
      code: typeof failure.code === "string" ? failure.code : `http_${response.status}`,
      message:
        typeof failure.message === "string" && failure.message !== ""
          ? failure.message
          : "That could not be done. Try again in a moment.",
      retryAfter: Number.isFinite(wait) && wait > 0 ? wait : null,
      ...(Object.keys(more).length > 0 ? { detail: more } : {}),
    };
  }

  /** What the sign-in page needs before anyone is signed in: whether to show the bot check, and with which key. */
  async config(): Promise<
    Result<{
      captcha: CaptchaConfig | null;
      banks?: boolean;
      billing?: boolean;
      stripeApp?: boolean;
    }>
  > {
    return this.#call("GET", "/auth/config");
  }

  /** Who is signed in, or null. A failure to reach the control plane is a failure, not a null: a person is not signed out because a request did not come back. */
  async session(): Promise<Result<Person | null>> {
    const answer = await this.#call<{ user?: { id?: unknown; email?: unknown } } | null>(
      "GET",
      "/auth/get-session",
    );
    if (!answer.ok) return answer;
    const user = answer.value?.user;
    return ok(
      typeof user?.id === "string" && typeof user.email === "string"
        ? { id: user.id, email: user.email }
        : null,
    );
  }

  /** Ask for a sign-in code. `captcha` is the bot check's token, when the control plane has one. */
  askForCode(email: string, captcha: string | null): Promise<Result<unknown>> {
    return this.#call("POST", "/auth/email-otp/send-verification-otp", {
      body: { email: email.trim(), type: "sign-in" },
      headers: captcha === null ? {} : { "x-captcha-response": captcha },
    });
  }

  signInWithCode(email: string, code: string): Promise<Result<unknown>> {
    return this.#call("POST", "/auth/sign-in/email-otp", {
      body: { email: email.trim(), otp: code.replace(/\s+/g, "") },
    });
  }

  /** The cookie of a person who is signed in and has lost the hint a service reads (control-worker.md). */
  restoreHint(): Promise<Result<unknown>> {
    return this.#call("POST", "/auth/hint");
  }

  /** End the session. True when it is over: the control plane ended it, or it was over already. */
  async signOut(): Promise<boolean> {
    this.#token = null;
    this.#fetching = null;
    // Nothing of the book stays on a device the person has signed out of (held.ts).
    await this.#forgetCopy();
    // The library will not hear a request without a JSON body, even one with nothing to say (it answers 415 and the session goes on).
    const answer = await this.#call("POST", "/auth/sign-out", { body: {} });
    return answer.ok || answer.status === 401;
  }

  /** End every session of the person, this browser's included: for a lost phone, or a browser someone else used. True when it is over: the control plane ended them, or they were over already. */
  async signOutEverywhere(): Promise<boolean> {
    this.#token = null;
    this.#fetching = null;
    await this.#forgetCopy();
    const answer = await this.#call("POST", "/auth/account/sign-out-everywhere", { body: {} });
    return answer.ok || answer.status === 401;
  }

  // ---- passkeys ---------------------------------------------------------------------------------------------

  /** The options (a challenge) for signing in with a passkey, as the browser's WebAuthn takes them. */
  passkeyOptions(): Promise<Result<unknown>> {
    return this.#call("GET", "/auth/passkey/generate-authenticate-options");
  }

  /** Sign in with the browser's answer to those options: a session, like a code that was right. */
  signInWithPasskey(response: unknown): Promise<Result<unknown>> {
    return this.#call("POST", "/auth/passkey/verify-authentication", { body: { response } });
  }

  /** The signed-in person's passkeys. */
  async passkeys(): Promise<Result<readonly PasskeySummary[]>> {
    const answer = await this.#call<
      { id?: unknown; name?: unknown; createdAt?: unknown; backedUp?: unknown }[]
    >("GET", "/auth/passkey/list-user-passkeys");
    if (!answer.ok) return answer;
    return ok(
      (Array.isArray(answer.value) ? answer.value : []).flatMap((row) =>
        typeof row.id === "string"
          ? [
              {
                id: row.id,
                name: typeof row.name === "string" && row.name !== "" ? row.name : "Passkey",
                createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
                synced: row.backedUp === true,
              },
            ]
          : [],
      ),
    );
  }

  /** The options for making a passkey on this device. Asked of a person who signed in in the last few minutes. */
  passkeyRegisterOptions(): Promise<Result<unknown>> {
    return this.#call("GET", "/auth/passkey/generate-register-options");
  }

  /** Keep the passkey the browser made. */
  addPasskey(response: unknown): Promise<Result<unknown>> {
    return this.#call("POST", "/auth/passkey/verify-registration", { body: { response } });
  }

  removePasskey(id: string): Promise<Result<unknown>> {
    return this.#call("POST", "/auth/passkey/delete-passkey", { body: { id } });
  }

  async workspaces(): Promise<Result<readonly WorkspaceSummary[]>> {
    const answer = await this.#call<{ workspaces: WorkspaceSummary[] }>("GET", "/auth/workspaces");
    return answer.ok ? ok(answer.value.workspaces) : answer;
  }

  /** `requestId` is made once for a form and sent again if the answer is not heard: the same key is the same workspace. */
  async createWorkspace(name: string, requestId: string): Promise<Result<WorkspaceSummary>> {
    const answer = await this.#call<{ workspace: WorkspaceSummary }>("POST", "/auth/workspaces", {
      body: { name, requestId },
    });
    return answer.ok ? ok(answer.value.workspace) : answer;
  }

  workspace(id: string): Promise<Result<WorkspaceDetail>> {
    return this.#call("GET", `/auth/workspaces/${encodeURIComponent(id)}`);
  }

  async invite(
    workspace: string,
    email: string,
    role: Exclude<Role, "owner">,
  ): Promise<Result<PendingInvitation>> {
    const answer = await this.#call<{ invitation: PendingInvitation }>(
      "POST",
      "/auth/invitations",
      {
        body: { workspace, email: email.trim(), role },
      },
    );
    return answer.ok ? ok(answer.value.invitation) : answer;
  }

  async revokeInvitation(id: string): Promise<Result<unknown>> {
    return this.#call("POST", "/auth/invitations/revoke", { body: { id } });
  }

  async peekInvitation(token: string): Promise<Result<InvitationView>> {
    const answer = await this.#call<{ invitation: InvitationView }>(
      "POST",
      "/auth/invitations/peek",
      { body: { token } },
    );
    return answer.ok ? ok(answer.value.invitation) : answer;
  }

  async acceptInvitation(token: string): Promise<Result<WorkspaceSummary & { ready: boolean }>> {
    const answer = await this.#call<{ workspace: WorkspaceSummary & { ready: boolean } }>(
      "POST",
      "/auth/invitations/accept",
      {
        body: { token },
      },
    );
    return answer.ok ? ok(answer.value.workspace) : answer;
  }

  /** Delete a workspace (an owner, with its name typed): its books are closed to everyone at once and erased after thirty days, unless an owner brings them back. */
  async deleteWorkspace(workspace: string, confirm: string): Promise<Result<WorkspaceSummary>> {
    const answer = await this.#call<{ workspace: WorkspaceSummary }>(
      "POST",
      "/auth/workspaces/delete",
      { body: { workspace, confirm } },
    );
    return answer.ok ? ok(answer.value.workspace) : answer;
  }

  /** Bring back a workspace that is being deleted, until the books begin to be erased. */
  async restoreWorkspace(workspace: string): Promise<Result<WorkspaceSummary>> {
    const answer = await this.#call<{ workspace: WorkspaceSummary }>(
      "POST",
      "/auth/workspaces/restore",
      { body: { workspace } },
    );
    return answer.ok ? ok(answer.value.workspace) : answer;
  }

  /** Delete the account (the person's address, typed): every session ends and the person is taken out of every workspace. A person who is the only owner of a workspace in use is
   * refused (`sole_owner`, the workspaces in `detail`) and nothing is done. */
  async deleteAccount(confirm: string): Promise<Result<unknown>> {
    const answer = await this.#call("POST", "/auth/account/delete", { body: { confirm } });
    if (answer.ok) {
      this.#token = null;
      this.#fetching = null;
      // The person is gone from every device: nothing of their books stays on this one.
      await this.#forgetCopy();
    }
    return answer;
  }

  /** What the page keeps on the device is deleted, and the sign-out does not wait for a device that does not say it has. */
  async #forgetCopy(): Promise<void> {
    await Promise.race([
      this.#copy.forget().catch(() => {}),
      this.#sleep(FORGET_WAIT_MS).then(() => {}),
    ]);
  }

  /** An action of the control plane that changes the book: whatever the page holds of the book is let go once it is done, whether it went through or not, so that the next read asks the service
   * (a read that was held for under two seconds would otherwise be given as if nothing had happened). */
  async #changesBook<T>(done: Promise<Result<T>>): Promise<Result<T>> {
    try {
      return await done;
    } finally {
      this.#bookChanged();
    }
  }

  // ---- bank connections -------------------------------------------------------------------------------------

  /** The accounts connected to a workspace, as the control plane knows them: for an owner or an admin. */
  bankConnections(workspace: string): Promise<Result<BankConnections>> {
    return this.#call("GET", `/auth/bank/accounts?workspace=${encodeURIComponent(workspace)}`);
  }

  /** Where the window that connects a bank is: a page of its own, which Stripe's script runs on and the application's pages do not. */
  bankLinkPath(workspace: string): string {
    return `/auth/bank/link?workspace=${encodeURIComponent(workspace)}`;
  }

  /** Stop a connected account (an owner): the bank is no longer read, and what is already in the books stays. */
  bankDisconnect(workspace: string, account: string): Promise<Result<unknown>> {
    return this.#changesBook(
      this.#call("POST", "/auth/bank/disconnect", { body: { workspace, account } }),
    );
  }

  /** Read the workspace's accounts again now: after an account is booked, or to see the day's transactions at once. */
  bankReadNow(workspace: string): Promise<Result<unknown>> {
    return this.#changesBook(this.#call("POST", "/auth/bank/sync", { body: { workspace } }));
  }

  // ---- Stripe, connected with the button ---------------------------------------------------------------------

  /** The Stripe account connected to a workspace, as the control plane knows it: for an owner or an admin. */
  stripeAppConnection(workspace: string): Promise<Result<StripeAppConnections>> {
    return this.#call(
      "GET",
      `/auth/stripe-app/connection?workspace=${encodeURIComponent(workspace)}`,
    );
  }

  /** An owner begins connecting Stripe: the answer is the address of the app's install page at Stripe, which the person is sent to. */
  stripeAppStart(workspace: string): Promise<Result<{ url: string }>> {
    return this.#call("POST", "/auth/stripe-app/start", { body: { workspace } });
  }

  /** Stop reading the connected account (an owner): what is already in the books stays. */
  stripeAppDisconnect(workspace: string): Promise<Result<unknown>> {
    return this.#changesBook(
      this.#call("POST", "/auth/stripe-app/disconnect", { body: { workspace } }),
    );
  }

  /** Read the connected account now (an owner or an admin): the reading goes on after the answer, and the connection says when it is done. */
  stripeAppReadNow(workspace: string): Promise<Result<unknown>> {
    return this.#changesBook(this.#call("POST", "/auth/stripe-app/sync", { body: { workspace } }));
  }

  // ---- billing ----------------------------------------------------------------------------------------------

  /** How the workspace stands as to its trial and subscription, and what a subscription costs. */
  billing(workspace: string): Promise<Result<BillingAnswer>> {
    return this.#call("GET", `/auth/billing?workspace=${encodeURIComponent(workspace)}`);
  }

  /** An owner subscribes: the answer is the address of Stripe's page, which the person is sent to. */
  billingCheckout(workspace: string, plan: "month" | "year"): Promise<Result<{ url: string }>> {
    return this.#call("POST", "/auth/billing/checkout", { body: { workspace, plan } });
  }

  /** The person is back from Stripe's page: the control plane asks Stripe how it went and answers with how the workspace stands. */
  billingComplete(
    workspace: string,
    session: string,
  ): Promise<Result<BillingSummary & { completed: boolean }>> {
    return this.#call("POST", "/auth/billing/complete", { body: { workspace, session } });
  }

  /** An owner opens Stripe's customer portal: the answer is its address. */
  billingPortal(workspace: string): Promise<Result<{ url: string }>> {
    return this.#call("POST", "/auth/billing/portal", { body: { workspace } });
  }

  // ---- agent keys -------------------------------------------------------------------------------------------

  /** The agent keys of a workspace that the person may see: their own, or everyone's if they run the workspace. */
  agentKeys(workspace: string): Promise<Result<AgentKeyList>> {
    return this.#call("GET", `/auth/agent-keys?workspace=${encodeURIComponent(workspace)}`);
  }

  /** Make a key for an agent that acts for the person. The secret is in the answer and nowhere else, once. Asked of a person who signed in in the last few minutes. */
  createAgentKey(
    workspace: string,
    name: string,
    scopes: readonly AgentScope[],
    expiresInDays: number,
  ): Promise<Result<{ readonly key: AgentKeySummary; readonly secret: string }>> {
    return this.#call("POST", "/auth/agent-keys", {
      body: { workspace, name: name.trim(), scopes, expiresInDays },
    });
  }

  /** A code that connects an agent with one command (`rastrata connect <code>`): it works once, for ten minutes, and the key it becomes may do what `scopes` says. The
   * key's secret never comes to the page. Asked of a person who signed in in the last few minutes; asking again ends the code before. */
  createAgentCode(
    workspace: string,
    scopes: readonly AgentScope[],
  ): Promise<Result<{ readonly code: string; readonly expiresAt: string }>> {
    return this.#call("POST", "/auth/agent-codes", { body: { workspace, scopes } });
  }

  /** End a key. `reason` is a note for the person's own records. */
  revokeAgentKey(id: string, reason?: string): Promise<Result<unknown>> {
    return this.#call("POST", "/auth/agent-keys/revoke", {
      body: { id, ...(reason ? { reason } : {}) },
    });
  }

  changeRole(workspace: string, userId: string, role: Role): Promise<Result<unknown>> {
    return this.#call("POST", "/auth/members/role", { body: { workspace, userId, role } });
  }

  removeMember(workspace: string, userId: string): Promise<Result<unknown>> {
    return this.#call("POST", "/auth/members/remove", { body: { workspace, userId } });
  }

  // ---- the workspace that is open, and its token -----------------------------------------------------------

  /** The workspace the page has open, as the browser remembers it. */
  scope(): string | null {
    try {
      return this.#storage?.getItem(WORKSPACE_KEY) || null;
    } catch {
      return null;
    }
  }

  /** Open another workspace. Its token is asked for with the next request; the one held belongs to the workspace before. */
  select(id: string | null): void {
    try {
      if (id === null) this.#storage?.removeItem(WORKSPACE_KEY);
      else this.#storage?.setItem(WORKSPACE_KEY, id);
    } catch {
      // Storage that cannot be written only means the choice is not remembered.
    }
    this.#token = null;
    this.#fetching = null;
  }

  ended(): void {
    this.#token = null;
    this.#onEnded("session_ended");
  }

  /** `Authorization` for the open workspace: the token held while it has more than three minutes to live; one that has less goes out with the request all the same and a new one is asked for
   * behind it, so that nothing waits for the refill; one that has under half a minute (or none) is waited for, asked for once however many are waiting. Null when no workspace is open.
   * A person who has no right to ask any more (the session has ended, they are no longer in the workspace) is told to the page through `onEnded`, and gets no token. */
  async authorization(force = false): Promise<string | null> {
    const workspace = this.scope();
    if (workspace === null) return null;
    const held = this.#token;
    if (!force && held && held.workspace === workspace) {
      const left = held.expiresAt - this.#now();
      if (left > REFRESH_BEFORE_MS) return `Bearer ${held.value}`;
      if (left > WAIT_BELOW_MS) {
        this.#fresh(workspace).catch((error: unknown) => this.#refused(error));
        return `Bearer ${held.value}`;
      }
    }
    try {
      return `Bearer ${await this.#fresh(workspace)}`;
    } catch (error) {
      this.#refused(error);
      return null;
    }
  }

  /** The token being asked for, once at a time. */
  #fresh(workspace: string): Promise<string> {
    if (!this.#fetching || this.#fetching.workspace !== workspace) {
      const promise = this.#fetchToken(workspace);
      this.#fetching = { workspace, promise };
      const clear = () => {
        if (this.#fetching?.promise === promise) this.#fetching = null;
      };
      promise.then(clear, clear);
    }
    return this.#fetching.promise;
  }

  /** What a token that could not be had means: the session or the place in the workspace is gone (the page is told), or the control plane could not be reached (nothing has ended). */
  #refused(error: unknown): void {
    // No token, no key: the page goes on without what was kept on the device.
    this.#copy.giveUp();
    if (error instanceof AccountError && error.kind !== "unavailable") {
      this.#token = null;
      this.#onEnded(error.kind);
    }
  }

  async #fetchToken(workspace: string): Promise<string> {
    // The page's first lines may have asked already (early.ts): their answer is the first attempt.
    let early = takeEarlyToken(workspace);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const first = early;
      early = null;
      const answer = await this.#call<{ token: string; expiresIn: number; copyKey?: string }>(
        "POST",
        "/auth/workspace-token",
        {
          body: { workspace },
          ...(first === null ? {} : { early: first }),
        },
      );
      if (answer.ok) {
        this.#token = {
          value: answer.value.token,
          workspace,
          expiresAt: this.#now() + answer.value.expiresIn * 1000,
        };
        // The key that locks what the page keeps on the device comes with the token: read back what was kept (held.ts).
        if (typeof answer.value.copyKey === "string")
          this.#copy.unlock(answer.value.copyKey, workspace);
        else this.#copy.giveUp();
        return answer.value.token;
      }
      if (answer.status === 401) throw new AccountError("session_ended");
      if (answer.status === 404) throw new AccountError("workspace_gone");
      // A workspace that is being deleted is closed to everyone: waiting would not change that, so it is the same as one the person is not in.
      if (answer.status === 409 && answer.code === "workspace_deleting")
        throw new AccountError("workspace_gone");
      // The first lines asked and nothing came back (the connection, a server that was starting): ask again now, as the code would have, and do not wait first.
      if (first !== null && (answer.status === 0 || answer.status >= 500)) continue;
      // 409: the workspace, or the person in it, is still being prepared. Wait as long as it says (two seconds by default), a few times.
      if (answer.status === 409 || answer.status === 0 || answer.status >= 500) {
        await this.#sleep(Math.min(10, answer.retryAfter ?? 2) * 1000);
        continue;
      }
      throw new AccountError("unavailable");
    }
    throw new AccountError("unavailable");
  }
}
