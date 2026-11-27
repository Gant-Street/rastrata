import { redact as redactKnown, safeText as safeKnown } from "../stripe/redact.ts";
import { MAX_MESSAGE } from "./constants.ts";

/** Secrets never leave this lane. The Stripe lane's `redact` and `safeText` are reused (they scrub
 * what is shaped like a key or an authorisation header, strip control characters and bound length);
 * this adds what is particular to SimpleFIN: the **access URL carries its credentials in the URL**
 * (`https://user:password@host/path`), so anything shaped like a URL with credentials is scrubbed
 * whether or not the exact secret is known, and the exact secrets (the access URL, the user, the
 * password, the Basic header, the setup token) are removed wherever they appear. */

/** `scheme://user:password@` and `scheme://user@`. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;

/** Remove every secret, and anything shaped like credentials in a URL or an authorisation header,
 * from `text`. Secrets shorter than eight characters are ignored, so a trivial value can never blank
 * a whole message (a real access URL's user and password are long random strings). */
export function scrub(text: string, secrets: readonly string[] = []): string {
  return redactKnown(text, secrets).replace(URL_CREDENTIALS, "$1[redacted]@");
}

/** Text that came from outside (the Bridge's messages, an account or bank name), made safe to store
 * and show: secrets scrubbed, control characters removed, length bounded. It is still untrusted
 * data and is never an instruction. */
export function safeText(
  value: unknown,
  options: { readonly max?: number; readonly secrets?: readonly string[] } = {},
): string {
  if (typeof value !== "string") return "";
  const secrets = options.secrets ?? [];
  return safeKnown(scrub(value, secrets), { max: options.max ?? MAX_MESSAGE, secrets }).trim();
}

/** Everything a credential could be spelled as, for scrubbing. Built once from the access URL and
 * handed to anything that makes a message. */
export function secretsOf(parts: {
  readonly accessUrl?: string | undefined;
  readonly username?: string | undefined;
  readonly password?: string | undefined;
  readonly authorization?: string | undefined;
  readonly setupToken?: string | undefined;
}): string[] {
  const out = new Set<string>();
  const add = (value: string | undefined) => {
    if (value !== undefined && value.length >= 8) out.add(value);
  };
  add(parts.accessUrl);
  add(parts.username);
  add(parts.password);
  if (parts.authorization) {
    add(parts.authorization);
    add(parts.authorization.replace(/^Basic\s+/i, ""));
  }
  add(parts.setupToken);
  // The same secrets as they look inside a URL.
  for (const value of [parts.username, parts.password])
    if (value !== undefined) {
      try {
        add(encodeURIComponent(value));
      } catch {
        // A lone surrogate cannot be percent-encoded; the plain value is already in the set.
      }
    }
  return [...out];
}
