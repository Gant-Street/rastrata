/** Where the Stripe key comes from, and what may be said about it.
 *
 * The key is read when a sync starts and held only by the client that signs requests. It is never
 * returned by any operation, never logged, never put in an error, a fixture or the repository. What
 * this module lets the rest of the lane say about a key is a small, safe description: whether it is
 * present, where it was found, whether it is a live or test key, whether it is restricted.
 *
 * Portable: no filesystem. The local runtime supplies the private-file source (see
 * `local/stripe-key.ts`); the environment source works wherever a process environment exists. */

export interface KeyRead {
  readonly key: string;
  readonly source: "environment" | "file";
}
export interface KeyProblem {
  readonly problem: string;
}
export type KeyResult = KeyRead | KeyProblem | null;

export interface KeySource {
  /** The key if there is one, a problem if there is something unusable where a key should be, or
   * null when there is nothing. Never throws. */
  read(): KeyResult;
}

/** `rk_` is a restricted key, `sk_` an unrestricted secret key. Anything else is not a Stripe key. */
const SHAPE = /^(rk|sk)_(live|test)_[A-Za-z0-9]{16,250}$/;

export const ENVIRONMENT_VARIABLE = "RASTRATA_STRIPE_KEY";
export const KEY_FILE_NAME = "stripe.key";

export function isKeyProblem(result: KeyResult): result is KeyProblem {
  return result !== null && "problem" in result;
}

/** Check the shape of a candidate key. The message never repeats the candidate. */
export function inspectKey(candidate: string, source: KeyRead["source"]): KeyRead | KeyProblem {
  const key = candidate.trim();
  if (key.length === 0) return { problem: "The Stripe key is empty." };
  if (!SHAPE.test(key))
    return {
      problem:
        "That is not a Stripe API key. Use a restricted key (it starts with rk_live_ or rk_test_) created in the Stripe dashboard.",
    };
  return { key, source };
}

export function environmentKeySource(
  env: Readonly<Record<string, string | undefined>> | undefined,
): KeySource {
  return {
    read() {
      const value = env?.[ENVIRONMENT_VARIABLE];
      if (value === undefined || value.trim() === "") return null;
      return inspectKey(value, "environment");
    },
  };
}

/** The first source that has something to say wins; a problem is reported, not skipped, so a
 * broken file is never silently replaced by another key. */
export function firstKeySource(...sources: readonly KeySource[]): KeySource {
  return {
    read() {
      for (const source of sources) {
        const result = source.read();
        if (result !== null) return result;
      }
      return null;
    },
  };
}

/** Which mode a key reads: live, or test (a sandbox's key and the account's test key both). */
export const keyMode = (key: string): "live" | "test" => (key.includes("_live_") ? "live" : "test");

export interface KeyDescription {
  readonly present: boolean;
  readonly source: "environment" | "file" | null;
  readonly mode: "live" | "test" | null;
  readonly restricted: boolean | null;
  readonly problem: string | null;
  readonly warning: string | null;
}

/** What may be shown about the key: never the key itself. */
export function describeKey(source: KeySource): KeyDescription {
  let result: KeyResult;
  try {
    result = source.read();
  } catch {
    result = { problem: "The Stripe key could not be read." };
  }
  if (result === null)
    return {
      present: false,
      source: null,
      mode: null,
      restricted: null,
      problem: null,
      warning: null,
    };
  if (isKeyProblem(result))
    return {
      present: false,
      source: null,
      mode: null,
      restricted: null,
      problem: result.problem,
      warning: null,
    };
  const restricted = result.key.startsWith("rk_");
  return {
    present: true,
    source: result.source,
    mode: keyMode(result.key),
    restricted,
    problem: null,
    warning: restricted
      ? null
      : "This is an unrestricted secret key. Rastrata only reads from Stripe; a restricted read-only key (rk_...) means a leak could not move money.",
  };
}
