/** Secret redaction and untrusted-text sanitization for plugins.
 *
 * Provider descriptions, customer memos, and API error messages are untrusted external data.
 * Plugins must never let auth secrets or bidi/control characters leak into logs, errors, or lines. */

function stripControlAndBidi(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const isAsciiControl =
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f);
    const isBidi =
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    if (!isAsciiControl && !isBidi) out += text[i];
  }
  return out;
}

const BUILTIN_SECRET_PATTERNS: readonly RegExp[] = [
  /(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{12,}/g,
  /\bwhsec_[A-Za-z0-9]{12,}/g,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret)=([^&\s'"]{6,})/gi,
];

/** Remove ASCII control characters and Unicode directional overrides, collapse newlines/tabs if
 * desired, and enforce a maximum length. */
export function sanitizeText(value: string, maxLength = 500): string {
  const cleaned = stripControlAndBidi(value).replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return maxLength > 1 ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned.slice(0, maxLength);
}

/** Scrub explicit secret values plus common credential patterns (Bearer headers, Stripe keys,
 * token query parameters) and control characters from any string before it leaves a plugin. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = stripControlAndBidi(text);
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    out = out.split(secret).join("[redacted]");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret && encoded.length >= 4) {
      out = out.split(encoded).join("[redacted]");
    }
  }
  for (const pattern of BUILTIN_SECRET_PATTERNS) {
    out = out.replace(pattern, (match, group?: string) => {
      if (match.includes("=") && typeof group === "string") {
        return match.replace(group, "[redacted]");
      }
      if (/^(Bearer|Basic)\s/i.test(match)) {
        return `${match.split(/\s+/)[0]} [redacted]`;
      }
      return "[redacted]";
    });
  }
  return out;
}
