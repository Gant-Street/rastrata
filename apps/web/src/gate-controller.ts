/** What the sign-in page of a service with accounts does, as a state machine with no screen in it: the steps a person goes through (an address, a code, a choice or
 * the making of a workspace, or an invitation to accept), and what each asks of the control plane. The Solid view (gate.tsx) draws the state and calls these
 * functions; the tests drive them with a stand-in for the account layer. Nothing here knows about the DOM.
 *
 * The page is served to anyone who has no hint of a sign-in, at `/`, at `/start` (where the application sends someone who needs to choose a workspace) and at `/invite/<token>`
 * (the link in an invitation). A person who is already signed in and has one workspace is through it in one step. */
import type {
  Account,
  CaptchaConfig,
  InvitationView,
  Person,
  Result,
  WorkspaceSummary,
} from "./account";
import { DeleteAccountController } from "./delete-account-controller";
import { noteSetupPending } from "./new-book";
import { PasskeysController, passkeyProblem } from "./passkeys-controller";
import { browserWebAuthn, PasskeyCancelled, type WebAuthn } from "./passkeys";

type Calls = Pick<
  Account,
  | "config"
  | "session"
  | "askForCode"
  | "signInWithCode"
  | "workspaces"
  | "createWorkspace"
  | "restoreWorkspace"
  | "deleteAccount"
  | "restoreHint"
  | "peekInvitation"
  | "acceptInvitation"
  | "signOut"
  | "signOutEverywhere"
  | "passkeyOptions"
  | "signInWithPasskey"
  | "passkeys"
  | "passkeyRegisterOptions"
  | "addPasskey"
  | "removePasskey"
  | "select"
  | "scope"
>;

export type GateState =
  | { readonly step: "loading" }
  /** Ask for the address. `invitation`: the page was opened by an invitation's link, and the person signs in to accept it. */
  | {
      readonly step: "email";
      readonly error?: string;
      readonly invitation?: InvitationView;
      readonly captcha: CaptchaConfig | null;
      /** Goes up each time a bot check token has been used or has failed, so that the view makes a new one. */
      readonly captchaNonce: number;
      readonly notice?: string;
      /** What was typed, when the step is shown again after a refusal: the person corrects an address and does not type it afresh. */
      readonly email?: string;
      /** Whether the page shows a button to sign in with a passkey: where the browser offers a passkey among the email field's suggestions, it needs none, and a person who has
       * no passkey yet is not shown a way in that cannot work for them. */
      readonly passkeys: boolean;
    }
  /** Just signed in with a code, on a device that can make a passkey, by a person who has none: they are offered one before they go on. */
  | {
      readonly step: "passkey";
      readonly person: Person;
      readonly error?: string;
      readonly notice?: string;
    }
  | {
      readonly step: "code";
      readonly email: string;
      readonly error?: string;
      readonly notice?: string;
      readonly invitation?: InvitationView;
      readonly captcha: CaptchaConfig | null;
      readonly captchaNonce: number;
    }
  | {
      readonly step: "workspaces";
      readonly person: Person;
      readonly workspaces: readonly WorkspaceSummary[];
      readonly error?: string;
      /** A workspace being made, or being prepared: the view asks `refresh` every few seconds. */
      readonly waiting: boolean;
    }
  | {
      readonly step: "invitation";
      readonly invitation: InvitationView;
      readonly token: string;
      readonly person: Person;
      readonly error?: string;
    }
  | { readonly step: "problem"; readonly message: string; readonly retry: boolean }
  | { readonly step: "done" };

const wait = (milliseconds: number, then: () => void): (() => void) => {
  const timer = setTimeout(then, milliseconds);
  return () => clearTimeout(timer);
};

const INVITATION = /^\/invite\/([A-Za-z0-9_-]{43})$/;
const SHAPE_OF_AN_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** The control plane's words for a code that did not work are the library's ("Invalid OTP"); these are a person's. */
function codeProblem(failure: Extract<Result<unknown>, { ok: false }>): string {
  if (failure.code === "INVALID_OTP") return "That code is not right. Check it and try again.";
  if (failure.code === "OTP_EXPIRED" || failure.code === "TOO_MANY_ATTEMPTS")
    return "That code has run out. Ask for a new one.";
  return failure.message;
}

export interface GateOptions {
  readonly account: Calls;
  /** Where the browser goes next. */
  readonly go: (path: string) => void;
  /** The address the page was opened at. */
  readonly path: string;
  /** A UUID for each form that makes a workspace. */
  readonly newRequestId?: () => string;
  /** The person came to choose, or to make another workspace (the application's "Workspaces" link): a workspace is never opened for them, however few they have. */
  readonly choose?: boolean;
  /** The browser's passkeys; a test replaces it. */
  readonly webauthn?: WebAuthn;
  /** Whether this browser was told "Not now" to a passkey, and the telling of it; a test replaces it. */
  readonly declined?: { readonly said: () => boolean; readonly say: () => void };
  /** How a request that waits for the email field's suggestions is begun again before its challenge runs out (the control plane keeps one five minutes); a test replaces it. */
  readonly later?: (milliseconds: number, then: () => void) => () => void;
}

const DECLINED = "rastrata-passkey-declined";
/** Kept in the browser, so that a person who said "Not now" is not asked again on it. Blocked storage asks again; nothing else is lost. */
const browserDeclined = {
  said: () => {
    try {
      return localStorage.getItem(DECLINED) === "yes";
    } catch {
      return false;
    }
  },
  say: () => {
    try {
      localStorage.setItem(DECLINED, "yes");
    } catch {
      // Blocked storage: the offer comes again at the next sign-in with a code.
    }
  },
};
/** Under the five minutes the control plane keeps a challenge. */
const SUGGESTION_LIFE = 4 * 60 * 1000;
const NOT_KEPT =
  "You are signed in, but this browser did not keep the sign-in. Allow cookies for this site and try again.";

export class GateController {
  #state: GateState = { step: "loading" };
  readonly #listeners = new Set<(state: GateState) => void>();
  readonly #options: GateOptions;
  #captcha: CaptchaConfig | null = null;
  #nonce = 0;
  #invitation: { view: InvitationView; token: string } | null = null;
  #request: { name: string; id: string } | null = null;
  /** The workspace id returned in `"provisioning"` state so `refresh()` opens it as soon as it becomes ready, even when the account already owns other workspaces. */
  #pendingWorkspaceId: string | null = null;
  /** The address a code was last asked for. */
  #email = "";
  /** Whether this browser offers passkeys among the email field's suggestions; read once, at the start. */
  #suggests = false;
  /** The request that waits for a passkey from the suggestions, and its renewal: ended when the page leaves the address or asks the browser in another way. */
  #quiet: { readonly stop: AbortController; readonly cancel: () => void } | null = null;

  constructor(options: GateOptions) {
    this.#options = options;
  }

  get state(): GateState {
    return this.#state;
  }

  subscribe(listener: (state: GateState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(state: GateState): void {
    if (state.step !== "email") this.#hush();
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }

  /** Read what the page needs to know, and show the first step. */
  async start(): Promise<void> {
    const { account, path } = this.#options;
    const [config, session, suggests] = await Promise.all([
      account.config(),
      account.session(),
      this.#webauthn.inSuggestions(),
    ]);
    this.#suggests = suggests;
    this.#captcha = config.ok ? config.value.captcha : null;
    if (!session.ok) {
      this.#set({ step: "problem", message: session.message, retry: true });
      return;
    }
    const token = INVITATION.exec(path)?.[1];
    if (token) {
      const peek = await account.peekInvitation(token);
      if (!peek.ok) {
        this.#set({
          step: "problem",
          message:
            peek.status === 404
              ? "This invitation does not exist. The link may be incomplete: ask whoever sent it for another."
              : peek.message,
          retry: peek.status !== 404,
        });
        return;
      }
      this.#invitation = { view: peek.value, token };
      if (peek.value.state !== "pending") {
        this.#set({
          step: "problem",
          message:
            peek.value.state === "expired"
              ? "This invitation has expired. Ask whoever sent it for a new one."
              : "This invitation has been used.",
          retry: false,
        });
        return;
      }
    }
    if (session.value === null) this.#askForAddress();
    else await this.#afterSignIn(session.value);
  }

  get #webauthn(): WebAuthn {
    return this.#options.webauthn ?? browserWebAuthn;
  }

  #askForAddress(error?: string, notice?: string, typed?: string): void {
    this.#set({
      step: "email",
      captcha: this.#captcha,
      captchaNonce: this.#nonce,
      passkeys: this.#webauthn.available() && !this.#suggests,
      ...(this.#invitation ? { invitation: this.#invitation.view } : {}),
      ...(error ? { error } : {}),
      ...(notice ? { notice } : {}),
      ...(typed ? { email: typed } : {}),
    });
    if (this.#suggests && !this.#quiet) void this.#listen();
  }

  /** Wait, with no dialog, for the person to choose a passkey from the email field's suggestions; one chosen signs them in. Begun again before its challenge runs out. */
  async #listen(): Promise<void> {
    const stop = new AbortController();
    const cancel = (this.#options.later ?? wait)(SUGGESTION_LIFE, () => {
      this.#hush();
      if (this.#state.step === "email") void this.#listen();
    });
    const quiet = { stop, cancel };
    this.#quiet = quiet;
    const asked = await this.#options.account.passkeyOptions();
    if (stop.signal.aborted || this.#quiet !== quiet) return;
    // Nothing to wait with: the person still has the emailed code, and is not told of a suggestion they never saw.
    if (!asked.ok) return this.#hush();
    let response: unknown;
    try {
      response = await this.#webauthn.get(asked.value, stop.signal);
    } catch {
      // Ended by the page, or by the browser; either way the person is where they were.
      if (this.#quiet === quiet) this.#hush();
      return;
    }
    if (this.#quiet !== quiet || this.#state.step !== "email") return;
    this.#hush();
    await this.#enterWithPasskey(response, this.#state.email);
  }

  /** End the wait for a suggestion, if there is one. */
  #hush(): void {
    const quiet = this.#quiet;
    if (!quiet) return;
    this.#quiet = null;
    quiet.cancel();
    quiet.stop.abort();
  }

  /** The person gave an address: ask for a code. `captcha` is the bot check's token, or null where there is none. */
  async submitEmail(email: string, captcha: string | null): Promise<void> {
    this.#hush();
    const address = email.trim();
    if (!SHAPE_OF_AN_ADDRESS.test(address)) {
      // An empty field is asked for the address; a typed one that is not an address is told what one looks like.
      this.#askForAddress(
        address === ""
          ? "Enter your email address."
          : "Enter a valid email address, like name@example.com.",
        undefined,
        address,
      );
      return;
    }
    if (this.#captcha !== null && captcha === null) {
      this.#askForAddress(
        "Wait for the check to finish, then ask for the code.",
        undefined,
        address,
      );
      return;
    }
    const answer = await this.#options.account.askForCode(address, captcha);
    // A token for the bot check can be used once; the view makes another whatever happened.
    this.#nonce += 1;
    if (!answer.ok) {
      this.#askForAddress(answer.message, undefined, address);
      return;
    }
    this.#email = address;
    this.#set({
      step: "code",
      email: address,
      captcha: this.#captcha,
      captchaNonce: this.#nonce,
      ...(this.#invitation ? { invitation: this.#invitation.view } : {}),
    });
  }

  /** Sign in with a passkey: the options from the control plane, the browser's dialog, the answer back; then as after a code that was right. A browser that cannot, a dialog that was dismissed and
   * a passkey the service does not know are each said in a line that sends the person to the emailed code, which always works. */
  async signInWithPasskey(): Promise<void> {
    if (this.#state.step !== "email") return;
    const typed = this.#state.email;
    const { account } = this.#options;
    // The browser shows one request at a time: the quiet one ends before the dialog opens.
    this.#hush();
    const again = (error: string) => this.#askForAddress(error, undefined, typed);
    const asked = await account.passkeyOptions();
    if (!asked.ok) return again(asked.message);
    let response: unknown;
    try {
      response = await this.#webauthn.get(asked.value);
    } catch (error) {
      return again(
        error instanceof PasskeyCancelled
          ? "No passkey was used. If you do not have one yet, continue with your email and add one after you sign in."
          : "This browser could not use a passkey. Ask for a code instead.",
      );
    }
    await this.#enterWithPasskey(response, typed);
  }

  /** The browser's answer to a passkey request goes to the control plane; accepted, it is a sign-in like a code that was right. */
  async #enterWithPasskey(response: unknown, typed: string | undefined): Promise<void> {
    const { account } = this.#options;
    const again = (error: string) => this.#askForAddress(error, undefined, typed);
    const entered = await account.signInWithPasskey(response);
    if (!entered.ok)
      return again(
        entered.status === 401 || entered.status === 400
          ? "That passkey is not known here. Ask for a code instead."
          : entered.message,
      );
    const session = await account.session();
    if (!session.ok || session.value === null) {
      this.#set({ step: "problem", message: NOT_KEPT, retry: true });
      return;
    }
    await this.#afterSignIn(session.value);
  }

  /** The person's passkeys, for the list of workspaces: made once for the list, so that what it shows is not lost when the list is read again. */
  accountPasskeys(): PasskeysController {
    return new PasskeysController({ account: this.#options.account, webauthn: this.#webauthn });
  }

  /** The same address, a new code. */
  async resend(captcha: string | null): Promise<void> {
    if (this.#state.step !== "code") return;
    const current = this.#state;
    if (this.#captcha !== null && captcha === null) {
      this.#set({ ...current, error: "Wait for the check to finish, then ask again." });
      return;
    }
    const answer = await this.#options.account.askForCode(this.#email, captcha);
    this.#nonce += 1;
    this.#set(
      answer.ok
        ? { ...current, captchaNonce: this.#nonce, notice: "We sent a new code." }
        : { ...current, captchaNonce: this.#nonce, error: answer.message },
    );
  }

  async submitCode(code: string): Promise<void> {
    if (this.#state.step !== "code") return;
    const current = this.#state;
    const digits = code.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(digits)) {
      this.#set({ ...current, error: "The code is six digits." });
      return;
    }
    const answer = await this.#options.account.signInWithCode(this.#email, digits);
    if (!answer.ok) {
      this.#set({ ...current, error: codeProblem(answer) });
      return;
    }
    const session = await this.#options.account.session();
    if (!session.ok || session.value === null) {
      this.#set({ step: "problem", message: NOT_KEPT, retry: true });
      return;
    }
    if (await this.#shouldOffer()) {
      this.#set({ step: "passkey", person: session.value });
      return;
    }
    await this.#afterSignIn(session.value);
  }

  get #declined() {
    return this.#options.declined ?? browserDeclined;
  }

  /** Whether to offer a passkey after a code: the device can make one it checks itself, the person has none, and this browser was not told "Not now". */
  async #shouldOffer(): Promise<boolean> {
    if (!this.#webauthn.available() || this.#declined.said()) return false;
    if (!(await this.#webauthn.onThisDevice())) return false;
    const held = await this.#options.account.passkeys();
    return held.ok && held.value.length === 0;
  }

  /** Make a passkey on this device, from the offer, and go on. Dismissed, the offer stays; refused, it says why, and "Not now" still goes on. */
  async makePasskey(): Promise<void> {
    if (this.#state.step !== "passkey") return;
    const current = { step: "passkey" as const, person: this.#state.person };
    const { account } = this.#options;
    const asked = await account.passkeyRegisterOptions();
    if (!asked.ok) {
      this.#set({ ...current, error: passkeyProblem(asked.code, asked.message) });
      return;
    }
    let made: unknown;
    try {
      made = await this.#webauthn.create(asked.value);
    } catch (error) {
      this.#set(
        error instanceof PasskeyCancelled
          ? { ...current, notice: "No passkey was made." }
          : { ...current, error: "This device could not make a passkey." },
      );
      return;
    }
    const stored = await account.addPasskey(made);
    if (!stored.ok) {
      this.#set({ ...current, error: passkeyProblem(stored.code, stored.message) });
      return;
    }
    await this.#afterSignIn(current.person);
  }

  /** "Not now": this browser is not asked again, and the person goes on. A passkey can still be added from the list of workspaces. */
  async skipPasskey(): Promise<void> {
    if (this.#state.step !== "passkey") return;
    this.#declined.say();
    await this.#afterSignIn(this.#state.person);
  }

  /** Back to the address, to use another: a person who is signed in is signed out first. */
  async useAnotherAddress(): Promise<void> {
    await this.#options.account.signOut();
    this.#nonce += 1;
    this.#askForAddress();
  }

  /** End every session of the person, this one too, and ask for an address again. */
  async signOutEverywhere(): Promise<void> {
    if (this.#state.step !== "workspaces") return;
    const current = this.#state;
    if (!(await this.#options.account.signOutEverywhere())) {
      this.#set({
        ...current,
        error: "Could not sign out of every browser. Try again in a moment.",
      });
      return;
    }
    this.#options.account.select(null);
    this.#nonce += 1;
    this.#askForAddress(undefined, "You were signed out of every browser.");
  }

  async #afterSignIn(person: Person): Promise<void> {
    if (this.#invitation) {
      this.#set({
        step: "invitation",
        invitation: this.#invitation.view,
        token: this.#invitation.token,
        person,
      });
      return;
    }
    await this.#chooseWorkspace(person);
  }

  /** The workspaces of a person who is in: one is opened at once, several are listed, none is the form to make the first. */
  async #chooseWorkspace(person: Person): Promise<void> {
    const { account } = this.#options;
    const listed = await account.workspaces();
    if (!listed.ok) {
      this.#set({ step: "problem", message: listed.message, retry: true });
      return;
    }
    const workspaces = listed.value;
    const ready = workspaces.filter((workspace) => workspace.state === "ready");
    const remembered = ready.find((workspace) => workspace.id === account.scope());
    if (!this.#options.choose) {
      if (remembered) return this.open(remembered.id);
      if (ready.length === 1 && workspaces.length === 1 && ready[0]) return this.open(ready[0].id);
    }
    this.#set({
      step: "workspaces",
      person,
      workspaces,
      waiting: workspaces.some((workspace) => workspace.state === "provisioning"),
    });
  }

  /** Open a workspace: the page remembers the choice and goes to the application. First the hint a service reads to send a browser the application and not this page is
   * made certain: a person who is signed in and has lost it (it ran out before the session did) would otherwise be sent back here for ever. */
  async open(workspaceId: string): Promise<void> {
    const hint = await this.#options.account.restoreHint();
    if (!hint.ok) {
      this.#set({ step: "problem", message: hint.message, retry: true });
      return;
    }
    this.#options.account.select(workspaceId);
    this.#set({ step: "done" });
    this.#options.go("/");
  }

  /** Bring back a workspace that is being deleted (an owner may, until its books begin to be erased). The list is read again; the person opens it when they like. */
  async restore(workspaceId: string): Promise<void> {
    if (this.#state.step !== "workspaces") return;
    const current = this.#state;
    const answer = await this.#options.account.restoreWorkspace(workspaceId);
    if (!answer.ok) {
      this.#set({ ...current, error: answer.message });
      return;
    }
    const listed = await this.#options.account.workspaces();
    const workspaces = listed.ok
      ? listed.value
      : current.workspaces.map((workspace) =>
          workspace.id === workspaceId ? answer.value : workspace,
        );
    this.#set({
      step: "workspaces",
      person: current.person,
      workspaces,
      waiting: workspaces.some((workspace) => workspace.state === "provisioning"),
    });
  }

  /** The form that deletes the account of the person the list of workspaces is shown to. It is made once for the list, so that what is typed in it is not lost when the list is read again. */
  accountDeletion(address: string): DeleteAccountController {
    const { account, go } = this.#options;
    return new DeleteAccountController({
      account,
      address,
      forget: () => account.select(null),
      go,
      leaveFor: "/",
    });
  }

  /** Read the list again, for a workspace that is being prepared. */
  async refresh(): Promise<void> {
    if (this.#state.step !== "workspaces") return;
    const current = this.#state;
    const listed = await this.#options.account.workspaces();
    if (!listed.ok) return;
    const waiting = listed.value.some((workspace) => workspace.state === "provisioning");
    // The workspace the person has just made is opened as soon as it is ready, whether it is their first or their tenth.
    const created =
      this.#pendingWorkspaceId !== null
        ? listed.value.find((workspace) => workspace.id === this.#pendingWorkspaceId)
        : this.#request && listed.value.length === 1
          ? listed.value[0]
          : undefined;
    if (created?.state === "ready") {
      this.#pendingWorkspaceId = null;
      noteSetupPending(created.id, true);
      await this.open(created.id);
      return;
    }
    this.#set({ ...current, workspaces: listed.value, waiting });
  }

  /** Make a workspace. Asking again with the same name is the same workspace: the page holds the key of the form until the name changes. */
  async createWorkspace(name: string): Promise<void> {
    if (this.#state.step !== "workspaces") return;
    const current = this.#state;
    const wanted = name.trim();
    if (wanted === "") {
      this.#set({ ...current, error: "Give the workspace a name." });
      return;
    }
    if (this.#request?.name !== wanted)
      this.#request = {
        name: wanted,
        id: (this.#options.newRequestId ?? (() => crypto.randomUUID()))(),
      };
    const answer = await this.#options.account.createWorkspace(wanted, this.#request.id);
    if (!answer.ok) {
      this.#set({ ...current, error: answer.message });
      return;
    }
    if (answer.value.state === "ready") {
      this.#pendingWorkspaceId = null;
      noteSetupPending(answer.value.id, true);
      await this.open(answer.value.id);
      return;
    }
    this.#pendingWorkspaceId = answer.value.id;
    const listed = await this.#options.account.workspaces();
    this.#set({
      ...current,
      workspaces: listed.ok ? listed.value : [answer.value],
      waiting: true,
    });
  }

  /** Accept the invitation the page was opened by. */
  async acceptInvitation(): Promise<void> {
    if (this.#state.step !== "invitation") return;
    const current = this.#state;
    const answer = await this.#options.account.acceptInvitation(current.token);
    if (!answer.ok) {
      if (
        answer.code === "invitation_expired" ||
        answer.code === "invitation_used" ||
        answer.code === "invitation_not_found"
      )
        this.#set({ step: "problem", message: answer.message, retry: false });
      else this.#set({ ...current, error: answer.message });
      return;
    }
    await this.open(answer.value.id);
  }
}
