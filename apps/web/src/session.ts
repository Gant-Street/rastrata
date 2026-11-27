/** Signing in to a hosted Rastrata service, from the page.
 *
 * The installed service and the development server act for the owner themselves, so a page served by
 * them is never asked to sign in. The hosted service does not: it answers a request that carries no
 * session with 401 `authentication_required`, and the page then shows its sign-in screen. The owner
 * gives the key once (`POST /session/owner`); the service answers with a cookie the page cannot read
 * (HttpOnly) and keeps the key itself. The page never holds the key longer than the one request that
 * sends it, and keeps it nowhere. A page served by something that has no such routes is never asked to
 * sign in, and learns from GET /health (`readService`) whether the service is a hosted one. */

/** Told to the window when the service says nobody is signed in. */
export const SIGN_IN_REQUIRED_EVENT = "rastrata:signin-required";

/** The application's own code for a request that carried no credentials. */
export const SIGN_IN_REQUIRED_CODE = "authentication_required";

/** What a person is told when the session ends in the middle of their work. */
export const SESSION_ENDED_MESSAGE = "Your session ended. Sign in to continue.";

/** What a person is told when the service took the key and the very next request showed that the browser did
 * not keep the session: a cookie that must be secure was refused because the page is not on https. */
export const SESSION_NOT_KEPT_MESSAGE =
  "The key was accepted, but this browser did not keep the session. Open this service at its https address.";

/** How soon after a sign-in a request that is refused again means the session was not kept. */
export const SESSION_KEPT_WITHIN_MS = 10_000;

const SIGNED_IN_AT = "rastrata:signed-in-at";
type Notes = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const tabNotes = (): Notes | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

/** The sign-in page notes the time the service took the key, in the tab's own storage (never the key), because the
 * page is read again straight after: see `signInJustTaken`. */
export function rememberSignIn(notes: Notes | null = tabNotes(), now: number = Date.now()): void {
  try {
    notes?.setItem(SIGNED_IN_AT, String(now));
  } catch {
    // Storage that cannot be written only loses the explanation `signInJustTaken` gives.
  }
}

/** Whether the service took the key a moment ago and the page being shown is the sign-in again: the browser did not
 * keep the session. Read once: the note is gone after it is read. */
export function signInJustTaken(
  notes: Notes | null = tabNotes(),
  now: number = Date.now(),
): boolean {
  try {
    const noted = notes?.getItem(SIGNED_IN_AT) ?? null;
    notes?.removeItem(SIGNED_IN_AT);
    const age = noted === null ? Number.NaN : now - Number(noted);
    return Number.isFinite(age) && age >= 0 && age < SESSION_KEPT_WITHIN_MS;
  } catch {
    return false;
  }
}

/** Say, to whatever on the page is listening, that the service wants a sign-in. */
export function announceSignInRequired(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(SIGN_IN_REQUIRED_EVENT));
  } catch {
    // A listener that throws is not the request's problem.
  }
}

/** Whether a failure of a request is the service asking for a sign-in. */
export function wantsSignIn(failure: unknown): boolean {
  return (
    typeof failure === "object" &&
    failure !== null &&
    (failure as { code?: unknown }).code === SIGN_IN_REQUIRED_CODE
  );
}

type Ask = typeof fetch;

export type SignInResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** `refused`: the key was wrong. `limited`: too many tries. `unsupported`: this service takes no
       * sign-in. `unavailable`: it could not be reached or did not answer as expected. */
      readonly reason: "refused" | "limited" | "unsupported" | "unavailable";
      readonly message: string;
    };

const failed = (reason: "refused" | "limited" | "unsupported" | "unavailable", message: string) =>
  ({ ok: false, reason, message }) as const;

/** Send the key. The answer is one of the results above; the key is in no message and is not kept. */
export async function signIn(key: string, ask: Ask = fetch): Promise<SignInResult> {
  let response: Response;
  try {
    response = await ask("/session/owner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: key.trim() }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return failed("unavailable", "The service could not be reached. Try again in a moment.");
  }
  if (response.ok) return { ok: true };
  if (response.status === 401)
    return failed("refused", "That key was not accepted. Check it and try again.");
  if (response.status === 429)
    return failed("limited", "Too many tries. Wait a minute and try again.");
  if (response.status === 404)
    return failed("unsupported", "This service does not take a sign-in.");
  return failed("unavailable", "The service could not sign you in. Try again in a moment.");
}

/** End the session. True when the service did. */
export async function signOut(ask: Ask = fetch): Promise<boolean> {
  try {
    const response = await ask("/session", {
      method: "DELETE",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
