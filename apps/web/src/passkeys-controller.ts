/** What the list of workspaces does about the person's passkeys, as a state machine with no screen in it: read them, add one on this device, remove one. The Solid view (the passkeys section of
 * gate.tsx) draws the state and calls these; the tests drive it with stand-ins for the control plane and the browser. Nothing here knows about the DOM. */
import type { Account, PasskeySummary } from "./account";
import { PasskeyCancelled, type WebAuthn } from "./passkeys";

type Calls = Pick<Account, "passkeys" | "passkeyRegisterOptions" | "addPasskey" | "removePasskey">;

export type PasskeysState =
  | { readonly step: "loading" }
  | { readonly step: "failed"; readonly message: string }
  | {
      readonly step: "ready";
      readonly passkeys: readonly PasskeySummary[];
      /** What is being done now. */
      readonly busy: "adding" | "removing" | null;
      readonly notice?: string;
      readonly error?: string;
    };

export interface PasskeysOptions {
  readonly account: Calls;
  readonly webauthn: WebAuthn;
}

/** The control plane's words for what it refuses are the library's; these are a person's, for the ones that have a remedy. */
export function passkeyProblem(code: string, message: string): string {
  if (code === "SESSION_NOT_FRESH")
    return "To add a passkey, sign in again first: it asks for a sign-in from the last few minutes.";
  if (code === "passkey_needs_verification")
    return "This passkey would not check who is using it. Use one that asks for your screen lock or a biometric check.";
  // The library's own refusal of a response it could not verify; for a person on the site that is a passkey made or
  // used without the device checking who was holding it (the library requires that check since 1.7.16).
  if (code === "FAILED_TO_VERIFY_REGISTRATION" || code === "AUTHENTICATION_FAILED")
    return "This passkey could not be verified. Use one that asks for your screen lock or a biometric check.";
  if (code === "too_many_passkeys") return message;
  return message;
}

export class PasskeysController {
  #state: PasskeysState = { step: "loading" };
  readonly #listeners = new Set<(state: PasskeysState) => void>();
  readonly #options: PasskeysOptions;
  #working = false;

  constructor(options: PasskeysOptions) {
    this.#options = options;
  }

  get state(): PasskeysState {
    return this.#state;
  }

  /** Whether this browser can make and use passkeys at all; if it cannot the section is not drawn. */
  get available(): boolean {
    return this.#options.webauthn.available();
  }

  subscribe(listener: (state: PasskeysState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(state: PasskeysState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }

  async load(): Promise<void> {
    const listed = await this.#options.account.passkeys();
    this.#set(
      listed.ok
        ? { step: "ready", passkeys: listed.value, busy: null }
        : { step: "failed", message: listed.message },
    );
  }

  #ready(): Extract<PasskeysState, { step: "ready" }> | null {
    return this.#state.step === "ready" ? this.#state : null;
  }

  /** Make a passkey on this device: the control plane's options, the browser's dialog, the answer back. */
  async add(): Promise<void> {
    const current = this.#ready();
    if (current === null || this.#working) return;
    this.#working = true;
    try {
      this.#set({ ...current, busy: "adding" });
      const { account, webauthn } = this.#options;
      const asked = await account.passkeyRegisterOptions();
      if (!asked.ok) {
        this.#set({ ...current, busy: null, error: passkeyProblem(asked.code, asked.message) });
        return;
      }
      let made: unknown;
      try {
        made = await webauthn.create(asked.value);
      } catch (error) {
        this.#set({
          ...current,
          busy: null,
          ...(error instanceof PasskeyCancelled
            ? { notice: "No passkey was added." }
            : { error: "This device could not make a passkey." }),
        });
        return;
      }
      const stored = await account.addPasskey(made);
      if (!stored.ok) {
        this.#set({ ...current, busy: null, error: passkeyProblem(stored.code, stored.message) });
        return;
      }
      await this.load();
      const after = this.#ready();
      if (after) this.#set({ ...after, notice: "The passkey was added." });
    } finally {
      this.#working = false;
    }
  }

  async remove(id: string): Promise<void> {
    const current = this.#ready();
    if (current === null || this.#working) return;
    this.#working = true;
    try {
      this.#set({ ...current, busy: "removing" });
      const answer = await this.#options.account.removePasskey(id);
      if (!answer.ok) {
        this.#set({ ...current, busy: null, error: answer.message });
        return;
      }
      await this.load();
      const after = this.#ready();
      if (after) this.#set({ ...after, notice: "The passkey was removed." });
    } finally {
      this.#working = false;
    }
  }
}
