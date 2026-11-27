import { secretsOf } from "./redact.ts";

/** The setup token and the access URL, and where the access URL may be kept and sent.
 *
 * A **setup token** is what a person copies from the SimpleFIN Bridge: "Base64-encoded URL" that
 * "will point to" the claim resource, used once. Claiming it (a POST with no body) returns the
 * **access URL**: "just a URL with included Basic Auth credentials", the long-lived secret that
 * every later request carries.
 *
 * The access URL is a credential for the person's bank data, so this module is strict about it:
 *
 *  - It is only ever sent to hosts under `simplefin.org`, over HTTPS. A setup token that points
 *    anywhere else is refused before anything is sent, so a pasted token cannot make this program
 *    send a request (or later a credential) to a host of someone else's choosing. A loopback
 *    `http` address is accepted only when the runtime says it is a test (`allowLoopback`).
 *  - It is held in a private file by a `CredentialStore` and in memory only inside one request. It
 *    is never part of an operation's input or output, a message, a log line or a record in the
 *    book. What may be said about it is `describeCredential`: whether it is present and which host.
 *
 * Portable: no filesystem. The local runtime supplies the file (`local/simplefin-credential.ts`). */

export const CREDENTIAL_FILE_NAME = "simplefin.access";

/** The Bridge's own hosts are the only ones credentials are sent to. */
export const BRIDGE_DOMAIN = "simplefin.org";

export interface HostPolicy {
  /** Accept `http` on 127.0.0.1, localhost or [::1]: a stand-in Bridge on this machine, for tests. */
  readonly allowLoopback: boolean;
  /** With `allowLoopback`, accept it only for this one origin (`http://127.0.0.1:20240`): a test
   * names the single address it may speak to, and nothing else on this machine is reachable by a
   * pasted token. */
  readonly onlyOrigin?: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Whether a URL may receive a SimpleFIN request: `https` to simplefin.org or one of its
 * sub-domains with no user, port, query or fragment of its own; or, for a stand-in on this
 * machine, `http` to a loopback address. */
export function isAllowedHost(url: URL, policy: HostPolicy): boolean {
  if (url.hash !== "" || url.search !== "") return false;
  if (policy.allowLoopback && url.protocol === "http:" && LOOPBACK.has(url.hostname))
    return policy.onlyOrigin === undefined || url.origin === policy.onlyOrigin;
  if (url.protocol !== "https:" || url.port !== "") return false;
  const host = url.hostname.toLowerCase();
  return host === BRIDGE_DOMAIN || host.endsWith(`.${BRIDGE_DOMAIN}`);
}

export type TokenCode = "bankfeed_token_invalid" | "bankfeed_host_refused";
export type SetupToken =
  | { readonly ok: true; readonly claimUrl: string; readonly token: string }
  | { readonly ok: false; readonly code: TokenCode; readonly message: string };

const TOKEN_SHAPE = /^[A-Za-z0-9+/_=-]{16,2048}$/;
const CLAIM_PATH = /^\/(?:[A-Za-z0-9._~-]+\/)*claim\/([A-Za-z0-9._~-]{4,200})$/;

const invalidToken = (): SetupToken => ({
  ok: false,
  code: "bankfeed_token_invalid",
  message:
    "That is not a SimpleFIN setup token. A setup token is one long line of letters and digits that the SimpleFIN Bridge shows when you create a connection for an application. Copy all of it, with nothing before or after it.",
});

/** Read a setup token. It is base64 of the claim URL; the URL is checked (HTTPS, a simplefin.org host,
 * a `/claim/<code>` path, no credentials) before it is ever used. The message never repeats the text
 * it was given. */
export function parseSetupToken(text: string, policy: HostPolicy): SetupToken {
  const token = text.replace(/\s+/g, "");
  if (!TOKEN_SHAPE.test(token)) return invalidToken();
  let decoded: string;
  try {
    const standard = token.replace(/-/g, "+").replace(/_/g, "/");
    const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalidToken();
  }
  let url: URL;
  try {
    url = new URL(decoded.trim());
  } catch {
    return invalidToken();
  }
  if (url.username !== "" || url.password !== "" || !CLAIM_PATH.test(url.pathname))
    return invalidToken();
  if (!isAllowedHost(url, policy))
    return {
      ok: false,
      code: "bankfeed_host_refused",
      message:
        "This setup token points to a server that is not the SimpleFIN Bridge (an address under simplefin.org). Rastrata only sends your bank connection to the Bridge, so nothing was sent. If it did not come from the Bridge, do not use it.",
    };
  return { ok: true, claimUrl: url.toString(), token };
}

/** True for any character below U+0020 or DEL: nothing a credential contains. */
function hasControl(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export interface AccessUrl {
  /** Origin and path without credentials and without a trailing slash: where `/accounts` is. */
  readonly base: string;
  readonly host: string;
  /** The `Authorization` header value, `Basic ...`. fetch refuses credentials in a URL on most
   * runtimes, and a thrown error could carry the URL, so the credentials only ever travel here. */
  readonly authorization: string;
  /** Everything the credential could be spelled as, for scrubbing messages. */
  readonly secrets: readonly string[];
}

/** Read an access URL: HTTPS (or a loopback stand-in) to an allowed host, with a user and a password. */
export function parseAccessUrl(text: string, policy: HostPolicy): AccessUrl | null {
  const trimmed = text.trim();
  if (trimmed.length < 12 || trimmed.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.username === "" || url.password === "" || !isAllowedHost(url, policy)) return null;
  let user: string;
  let password: string;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    return null;
  }
  if (hasControl(user + password) || user.includes(":")) return null;
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const authorization = `Basic ${btoa(binary)}`;
  const path = url.pathname.replace(/\/+$/, "");
  return {
    base: `${url.protocol}//${url.host}${path}`,
    host: url.host,
    authorization,
    secrets: secretsOf({
      accessUrl: trimmed,
      username: user,
      password,
      authorization,
    }).concat(secretsOf({ username: url.username, password: url.password })),
  };
}

export interface CredentialRead {
  /** The access URL text. Held in memory for one request and never shown. */
  readonly accessUrl: string;
}
export interface CredentialProblem {
  readonly problem: string;
}
export type CredentialResult = CredentialRead | CredentialProblem | null;

export const isCredentialProblem = (result: CredentialResult): result is CredentialProblem =>
  result !== null && "problem" in result;

/** Where the access URL is kept. The local runtime keeps it in a private file beside the book; a
 * test keeps it in memory. Nothing else may read or write it. */
export interface CredentialStore {
  /** The access URL, a problem if something unusable is where it should be, or null when there is
   * nothing. Never throws. */
  read(): CredentialResult;
  /** Check, without claiming anything, that `write` will work: a setup token can be claimed only
   * once, so the place to keep what it returns must be known to be writable first. Returns a
   * problem in words, or null. */
  probe(): string | null;
  /** Replace the stored access URL, atomically and readable only by its owner. Throws a plain
   * message-free error on failure; the caller says what to do. */
  write(accessUrl: string): void;
  /** Delete it. Deleting what is not there is not an error. */
  remove(): void;
}

/** A store that keeps the access URL in memory, for tests and for runtimes with no filesystem. */
export function memoryCredentialStore(
  initial?: string,
): CredentialStore & { held(): string | null } {
  let value: string | null = initial ?? null;
  return {
    read: () => (value === null ? null : { accessUrl: value }),
    probe: () => null,
    write(accessUrl) {
      value = accessUrl;
    },
    remove() {
      value = null;
    },
    held: () => value,
  };
}

export interface CredentialDescription {
  readonly present: boolean;
  /** The Bridge's host, or null when there is no usable credential. Not secret. */
  readonly host: string | null;
  /** Why the credential cannot be used (unreadable file, wrong shape); null when it can. */
  readonly problem: string | null;
}

/** What may be said about the credential: never the credential itself. */
export function describeCredential(
  store: CredentialStore,
  policy: HostPolicy,
): CredentialDescription {
  let result: CredentialResult;
  try {
    result = store.read();
  } catch {
    result = { problem: "The access URL could not be read." };
  }
  if (result === null) return { present: false, host: null, problem: null };
  if (isCredentialProblem(result)) return { present: false, host: null, problem: result.problem };
  const access = parseAccessUrl(result.accessUrl, policy);
  if (access === null)
    return {
      present: false,
      host: null,
      problem:
        "The saved access URL is not usable (it is not an HTTPS address of the SimpleFIN Bridge with a user and password). Disconnect and connect again with a new setup token.",
    };
  return { present: true, host: access.host, problem: null };
}
