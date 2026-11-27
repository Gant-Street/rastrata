/** The page's side of passkeys, which is the browser's WebAuthn and nothing else: asking it to make a passkey or to sign with one, for the options the control plane made (as JSON, which the browser
 * turns into what it needs), and giving the answer back as JSON. It is a small interface so that the controllers are tested without a browser and a browser test can use a virtual authenticator. A page in a
 * browser that cannot do this is not offered passkeys and loses nothing: the emailed code is always there. */

/** The person dismissed the browser's passkey dialog, or it ran out of time, or there is no passkey to use. Not a failure of the service. */
export class PasskeyCancelled extends Error {
  constructor() {
    super("The passkey was not used");
  }
}

export interface WebAuthn {
  /** Whether this browser can do passkeys from JSON options (a recent one). */
  available(): boolean;
  /** Whether the device itself can make a passkey that it checks with its own fingerprint, face or screen lock (Touch ID on a Mac, Face ID on an iPhone, an Android phone's lock). */
  onThisDevice(): Promise<boolean>;
  /** Whether the browser can offer a passkey among the suggestions of the email field (conditional mediation), so that no button is needed to find one. */
  inSuggestions(): Promise<boolean>;
  /** Sign in with a passkey: `navigator.credentials.get` for the service's options. Throws {@link PasskeyCancelled} when nothing was chosen. With `quietly`, the request waits, with no dialog,
   * for the person to choose a passkey from the email field's suggestions, until the signal aborts it. */
  get(options: unknown, quietly?: AbortSignal): Promise<unknown>;
  /** Make a passkey: `navigator.credentials.create`. Throws {@link PasskeyCancelled} when the person dismissed it. */
  create(options: unknown): Promise<unknown>;
}

/** What the browser says when the person said no, or there was nothing to choose. */
const isCancel = (error: unknown): boolean =>
  error instanceof DOMException &&
  (error.name === "NotAllowedError" || error.name === "AbortError");

interface JsonCredential {
  toJSON(): unknown;
}
interface JsonWebAuthn {
  parseRequestOptionsFromJSON(options: unknown): PublicKeyCredentialRequestOptions;
  parseCreationOptionsFromJSON(options: unknown): PublicKeyCredentialCreationOptions;
}

const statics = (): Partial<JsonWebAuthn> | null =>
  typeof PublicKeyCredential === "undefined"
    ? null
    : (PublicKeyCredential as unknown as Partial<JsonWebAuthn>);

export const browserWebAuthn: WebAuthn = {
  available: () => {
    const found = statics();
    return (
      found !== null &&
      typeof found.parseRequestOptionsFromJSON === "function" &&
      typeof found.parseCreationOptionsFromJSON === "function" &&
      typeof navigator.credentials?.get === "function"
    );
  },
  async onThisDevice() {
    try {
      return (
        browserWebAuthn.available() &&
        (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())
      );
    } catch {
      return false;
    }
  },
  async inSuggestions() {
    try {
      const found = statics() as {
        isConditionalMediationAvailable?: () => Promise<boolean>;
      } | null;
      return (
        browserWebAuthn.available() &&
        typeof found?.isConditionalMediationAvailable === "function" &&
        (await found.isConditionalMediationAvailable())
      );
    } catch {
      return false;
    }
  },
  async get(options, quietly) {
    const found = statics() as JsonWebAuthn;
    try {
      const credential = await navigator.credentials.get({
        publicKey: found.parseRequestOptionsFromJSON(options),
        ...(quietly ? { mediation: "conditional" as const, signal: quietly } : {}),
      });
      if (credential === null) throw new PasskeyCancelled();
      return (credential as unknown as JsonCredential).toJSON();
    } catch (error) {
      throw isCancel(error) ? new PasskeyCancelled() : error;
    }
  },
  async create(options) {
    const found = statics() as JsonWebAuthn;
    try {
      const credential = await navigator.credentials.create({
        publicKey: found.parseCreationOptionsFromJSON(options),
      });
      if (credential === null) throw new PasskeyCancelled();
      return (credential as unknown as JsonCredential).toJSON();
    } catch (error) {
      throw isCancel(error) ? new PasskeyCancelled() : error;
    }
  },
};
