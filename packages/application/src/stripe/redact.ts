/** Secrets never leave this lane. Anything that can reach a person, a log, an error or a response
 * passes through here first. Stripe's own error text and every string a hostile counterparty could
 * choose are treated as data: stripped of control characters, bounded and scrubbed. */

const KEY_LIKE = /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9*._-]+/g;
const AUTH_LIKE = /\b(Bearer|Basic)\s+[A-Za-z0-9._\-+/=*]{6,}/gi;

/** True for control characters other than tab and newline, and for the Unicode line and paragraph
 * separators: the characters that can forge a line in a log or break out of a field. */
function isControl(code: number): boolean {
  return (
    code <= 0x08 ||
    code === 0x0b ||
    code === 0x0c ||
    (code >= 0x0e && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029
  );
}

function stripControl(text: string): string {
  let out = "";
  for (const character of text) out += isControl(character.codePointAt(0) ?? 0) ? " " : character;
  return out;
}

/** Remove every occurrence of the given secrets and anything shaped like a Stripe key or an
 * authorisation header. Secrets shorter than eight characters are ignored so an empty or trivial
 * value cannot blank the whole message. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  return out.replace(KEY_LIKE, "[redacted key]").replace(AUTH_LIKE, "$1 [redacted]");
}

/** Text from outside, made safe to show: secrets scrubbed, control characters removed, length
 * bounded. It is still untrusted data and must never be treated as an instruction. */
export function safeText(
  value: unknown,
  options: { readonly max?: number; readonly secrets?: readonly string[] } = {},
): string {
  const max = options.max ?? 300;
  if (typeof value !== "string") return "";
  const cleaned = stripControl(redact(value, options.secrets ?? []));
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}
