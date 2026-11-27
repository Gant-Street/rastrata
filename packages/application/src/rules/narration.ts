import { clip, plainText } from "./text.ts";

/** Narration templates: plain text with `{name}` placeholders, for example "Software: {merchant}".
 * `{{` and `}}` write a literal brace. A template is data, not code: it is scanned once, character
 * by character, and the only thing it can do is paste in the named fields of the line. Pasted text
 * is hostile (a memo is attacker-controlled), so it is stripped of control characters and clipped.
 * No expression, loop or lookup exists, and nothing is evaluated. */

export const NARRATION_PLACEHOLDERS = [
  "description",
  "counterparty",
  "merchant",
  "reference",
  "date",
  "amount",
] as const;
export type NarrationPlaceholder = (typeof NARRATION_PLACEHOLDERS)[number];

export const NARRATION_TEMPLATE_LIMIT = 200;
const VALUE_LIMIT = 120;
const NARRATION_LIMIT = 500;

export type NarrationFields = Readonly<Record<NarrationPlaceholder, string>>;

type Piece = { readonly text: string } | { readonly placeholder: NarrationPlaceholder };
type Parsed =
  | { readonly ok: true; readonly pieces: readonly Piece[] }
  | { readonly ok: false; readonly problem: string };

function isPlaceholder(name: string): name is NarrationPlaceholder {
  return (NARRATION_PLACEHOLDERS as readonly string[]).includes(name);
}

function parse(template: string): Parsed {
  if (template.length > NARRATION_TEMPLATE_LIMIT)
    return {
      ok: false,
      problem: `The narration is longer than ${NARRATION_TEMPLATE_LIMIT} characters`,
    };
  const pieces: Piece[] = [];
  let literal = "";
  for (let index = 0; index < template.length; index++) {
    const char = template.charAt(index);
    const next = template.charAt(index + 1);
    if (char === "{" && next === "{") {
      literal += "{";
      index++;
    } else if (char === "}" && next === "}") {
      literal += "}";
      index++;
    } else if (char === "{") {
      const close = template.indexOf("}", index + 1);
      if (close < 0) return { ok: false, problem: "A { in the narration is never closed" };
      const name = template.slice(index + 1, close);
      if (!isPlaceholder(name))
        return {
          ok: false,
          problem: `{${clip(name, 30)}} is not a field; use ${NARRATION_PLACEHOLDERS.map((item) => `{${item}}`).join(", ")}`,
        };
      if (literal) pieces.push({ text: literal });
      literal = "";
      pieces.push({ placeholder: name });
      index = close;
    } else if (char === "}")
      return { ok: false, problem: "A } in the narration has no matching {" };
    else literal += char;
  }
  if (literal) pieces.push({ text: literal });
  return { ok: true, pieces };
}

/** The reason a template cannot be used, or null when it is fine. */
export function narrationProblem(template: string): string | null {
  const parsed = parse(template);
  return parsed.ok ? null : parsed.problem;
}

/** Fill a template. An invalid template renders as nothing: callers validate at save time and
 * must never fail a whole batch of lines over one bad narration. */
export function renderNarration(template: string, fields: NarrationFields): string {
  const parsed = parse(template);
  if (!parsed.ok) return "";
  let out = "";
  for (const piece of parsed.pieces)
    out += "text" in piece ? piece.text : clip(plainText(fields[piece.placeholder]), VALUE_LIMIT);
  return clip(plainText(out), NARRATION_LIMIT);
}
