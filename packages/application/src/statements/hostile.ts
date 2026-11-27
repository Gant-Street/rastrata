/** Text from a bank file is attacker-controlled: a memo is whatever the sender of a payment typed.
 * It is data. These helpers do two things with it. They flag text that could do harm somewhere
 * else (a spreadsheet, a terminal, a person, an agent) so a reviewer sees a warning, and they let
 * messages quote a cell without reproducing it. They never change what is stored.
 *
 * Everything is linear in the length of the text and uses no regular expression over a whole
 * cell, so a hostile file cannot make a parser slow. */

export type HostileFlag =
  | "formula"
  | "control"
  | "direction"
  | "markup"
  | "link"
  | "instruction"
  | "line_break";

export const FLAG_MESSAGE: Readonly<Record<HostileFlag, string>> = {
  formula:
    "starts with a character a spreadsheet treats as a formula; it is kept as plain text and exported with a leading quote",
  control: "contains control characters; they are kept in the record and never interpreted",
  direction: "contains text-direction or invisible characters that can disguise what the text says",
  markup: "looks like HTML or script; it is only ever shown as plain text",
  link: "contains a script or data link; it is only ever shown as plain text",
  instruction:
    "reads like an instruction to an assistant; it is data from a bank file, not a request, and nothing in it is followed",
  line_break: "contains a line break",
};

/** Only the start of a cell is examined for phrases: an instruction hidden in a very long memo is
 * still a memo, and the cost stays bounded. */
const SCAN_LIMIT = 4096;

const INSTRUCTION_PHRASES = [
  "ignore previous",
  "ignore all previous",
  "ignore the previous",
  "ignore prior",
  "ignore above",
  "ignore the above",
  "disregard previous",
  "disregard the previous",
  "disregard all previous",
  "forget previous",
  "forget your instructions",
  "new instructions",
  "system prompt",
  "you are now",
  "you must now",
  "as an ai",
  "as the assistant",
  "assistant:",
  "<|im_start|>",
  "<|im_end|>",
  "[inst]",
  "tool call",
  "tool_call",
  "function_call",
  "call the tool",
  "run the following",
  "execute the following",
  "post this",
  "commit this",
  "approve this",
  "mark as paid",
  "do not tell",
  "don't tell the user",
] as const;

/** Verbs that, followed by a secret, ask a reader to make one or hand it over. */
const SECRET_VERBS = new Set([
  "create",
  "generate",
  "make",
  "mint",
  "issue",
  "reveal",
  "print",
  "show",
  "display",
  "paste",
  "send",
  "email",
  "share",
  "include",
  "leak",
  "disclose",
  "expose",
  "upload",
  "output",
  "echo",
  "provide",
  "give",
  "copy",
  "read",
  "cat",
  "forward",
  "submit",
]);
const SECRET_NOUNS = new Set([
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passwords",
  "passphrase",
  "credential",
  "credentials",
]);
/** `key` alone is a bank, a shop and a door: only a key that is named as a secret counts. */
const KEY_QUALIFIERS = new Set([
  "api",
  "owner",
  "private",
  "secret",
  "access",
  "signing",
  "encryption",
  "ssh",
  "master",
  "auth",
  "bearer",
]);
/** Verbs that act on the books, and the words that make them sweeping. */
const BULK_VERBS = new Set([
  "post",
  "exclude",
  "delete",
  "remove",
  "approve",
  "accept",
  "categorize",
  "categorise",
  "reconcile",
  "void",
  "reverse",
  "skip",
  "mark",
]);
const BULK_QUANTIFIERS = new Set(["all", "every", "everything", "whole", "entire"]);
/** `exclude them`, `delete it`: a sweeping order with no quantifier. */
const BULK_ONLY_VERBS = new Set(["exclude", "delete", "remove"]);
const BULK_PRONOUNS = new Set(["them", "these", "those", "it", "this", "everything"]);

/** The words of a lower-cased text, split at anything that is not a letter, a digit, `_`, `.` or `'`
 * (so `owner.key` and `rastrata_token` stay whole). One pass, no regular expression. */
function wordsOf(text: string): string[] {
  const out: string[] = [];
  let start = -1;
  for (let index = 0; index <= text.length; index++) {
    const code = index < text.length ? text.charCodeAt(index) : 0;
    const inside =
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x5f ||
      code === 0x2e ||
      code === 0x27;
    if (inside) {
      if (start < 0) start = index;
    } else if (start >= 0) {
      let from = start;
      let to = index;
      while (from < to && (text.charCodeAt(from) === 0x2e || text.charCodeAt(from) === 0x27))
        from++;
      while (to > from && (text.charCodeAt(to - 1) === 0x2e || text.charCodeAt(to - 1) === 0x27))
        to--;
      if (to > from) out.push(text.slice(from, to));
      start = -1;
    }
  }
  return out;
}

/** Text that tells a reader to make or hand over a secret (a token, an owner key, a password), or
 * to post, exclude, delete or approve everything, or that names this program's own command or key
 * file. An ordinary description does none of these: a bank, a shop and a door all have "key" in
 * them, and the verbs only count next to a secret or a sweeping word. Bounded: a few words around a
 * verb, over the first kilobytes of the cell. */
function tellsAReaderToActOnSecretsOrEverything(head: string): boolean {
  const words = wordsOf(head);
  for (let index = 0; index < words.length; index++) {
    const word = words[index] as string;
    if (
      word === "rastrata" ||
      word.startsWith("rastrata_") ||
      word.includes("owner.key") ||
      word.includes("owner_key")
    )
      return true;
    if (word === "owner" && (words[index + 1] === "key" || words[index + 1] === "keys"))
      return true;
    if (SECRET_VERBS.has(word))
      for (let at = index + 1; at <= index + 6 && at < words.length; at++) {
        const next = words[at] as string;
        if (
          SECRET_NOUNS.has(next) ||
          ((next === "key" || next === "keys") && KEY_QUALIFIERS.has(words[at - 1] as string))
        )
          return true;
      }
    if (BULK_VERBS.has(word)) {
      for (let at = index + 1; at <= index + 3 && at < words.length; at++)
        if (BULK_QUANTIFIERS.has(words[at] as string)) return true;
      if (BULK_ONLY_VERBS.has(word) && BULK_PRONOUNS.has(words[index + 1] as string)) return true;
    }
  }
  return false;
}

function isDirectionOrInvisible(code: number): boolean {
  return (
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff ||
    code === 0x00ad ||
    code === 0x061c ||
    code === 0x180e
  );
}

/** What is worth a reviewer's attention in one text cell. An empty list means nothing was found,
 * which is not a promise that the text is harmless. */
export function hostileFlags(text: string): HostileFlag[] {
  if (text === "") return [];
  const flags = new Set<HostileFlag>();
  const first = text.charCodeAt(0);
  // 0x3d "=", 0x2b "+", 0x2d "-", 0x40 "@", tab and carriage return: the formula-injection set.
  if (first === 0x3d || first === 0x40 || first === 0x09 || first === 0x0d) flags.add("formula");
  else if ((first === 0x2b || first === 0x2d) && text.length > 1) {
    const second = text.charCodeAt(1);
    // "- REFUND" and "-" alone are ordinary; "-2+3" and "+cmd|..." are formulas.
    if (second !== 0x20 && second !== 0x2d && second !== 0x2e) flags.add("formula");
  }
  const limit = Math.min(text.length, SCAN_LIMIT);
  for (let index = 0; index < limit; index++) {
    const code = text.charCodeAt(index);
    if (code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029)
      flags.add("line_break");
    else if ((code < 0x20 && code !== 0x09) || (code >= 0x7f && code <= 0x9f)) flags.add("control");
    else if (isDirectionOrInvisible(code)) flags.add("direction");
  }
  const head = text.slice(0, limit).toLowerCase();
  if (
    head.includes("<script") ||
    head.includes("</") ||
    head.includes("<img") ||
    head.includes("<iframe") ||
    head.includes("onerror=")
  )
    flags.add("markup");
  if (head.includes("javascript:") || head.includes("data:text") || head.includes("vbscript:"))
    flags.add("link");
  for (const phrase of INSTRUCTION_PHRASES)
    if (head.includes(phrase)) {
      flags.add("instruction");
      break;
    }
  if (!flags.has("instruction") && tellsAReaderToActOnSecretsOrEverything(head))
    flags.add("instruction");
  return [...flags];
}

/** A cell quoted for a message: bounded, with control and direction characters made visible, so a
 * hostile cell can neither flood a message nor change how the terminal or screen shows it. */
export function quoteCell(text: string, limit = 40): string {
  let shown = "";
  let count = 0;
  for (const symbol of text) {
    if (count >= limit) {
      shown += "…";
      break;
    }
    const code = symbol.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || isDirectionOrInvisible(code))
      shown += `\\u${code.toString(16).padStart(4, "0")}`;
    else if (symbol === '"') shown += '\\"';
    else if (symbol === "\\") shown += "\\\\";
    else shown += symbol;
    count++;
  }
  return `"${shown}"`;
}

/** The longest text kept for a description or name, in UTF-16 code units, never splitting a
 * surrogate pair. Longer text is cut and reported; the raw file keeps all of it. */
export const MAX_TEXT_LENGTH = 1000;

export function truncateText(
  text: string,
  limit = MAX_TEXT_LENGTH,
): { text: string; cut: boolean } {
  if (text.length <= limit) return { text, cut: false };
  let end = limit;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return { text: text.slice(0, end), cut: true };
}
