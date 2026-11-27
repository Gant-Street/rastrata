/** Folds a paragraph of introduction into what a page header holds: its first sentence is the one line
 * under the title, and the rest, when there is any, is the text of "How this works". A page whose copy is
 * already split into a line and an explanation does not need it. */
export function introParts(text: string): {
  readonly line: string;
  readonly rest: string | undefined;
} {
  const clean = text.trim().replace(/\s+/g, " ");
  const match = /^(.+?[.!?])(?:\s+(\S.*))?$/.exec(clean);
  if (!match) return { line: clean, rest: undefined };
  return { line: match[1] ?? clean, rest: match[2] };
}
