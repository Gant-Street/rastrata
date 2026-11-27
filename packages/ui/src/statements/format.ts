/** Making what came from a person's disk or a bank file safe to show. Money, dates and sizes are
 * shown through the shared formatter (`../format`). */

/** A file name from a person's disk, safe to show: control and direction characters removed. */
export function shownName(name: string): string {
  let cleaned = "";
  for (const symbol of name) {
    const code = symbol.codePointAt(0) ?? 0;
    cleaned +=
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
        ? " "
        : symbol;
  }
  return cleaned.replace(/\s+/g, " ").trim();
}

/** Text that came from a bank file, made safe to put on a screen: control characters, line breaks and
 * direction-changing or invisible characters are shown as visible escapes, so a memo can neither
 * reorder the text around it (a right-to-left override) nor hide what it says. Ordinary text, in any
 * script, is unchanged. The stored text is never altered; this is only how it is displayed. */
export function safeText(text: string): string {
  let shown = "";
  for (const symbol of text) {
    const code = symbol.codePointAt(0) ?? 0;
    if (code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) shown += "\u21b5 ";
    else if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x2064) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff ||
      code === 0x00ad ||
      code === 0x061c ||
      code === 0x180e
    )
      shown += `\\u${code.toString(16).padStart(4, "0")}`;
    else shown += symbol;
  }
  return shown;
}
