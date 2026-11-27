/** The words of the application, read out of its source: every string literal and every template literal
 * in `packages/ui/src` and `apps/web/src` that looks like something a person reads.
 *
 * The source is read the way the application is built: through Bun's own transpiler, which turns JSX
 * text and attributes into ordinary string literals and drops comments, so what is left to read is
 * plain JavaScript. `stringsIn` takes the strings out of it (a template's expressions are shown as
 * `{}`), and `looksLikeCopy` leaves out what is code: a class name, a path, an operation name, a key.
 * It is a guard and not a parser, and it fails safe: a string it takes for code is not checked, and the
 * glossary test lists what it would have said. */
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const root = join(import.meta.dir, "..", "..", "..", "..");

/** Where the words of the application are written. */
export const copyFolders = ["packages/ui/src", "apps/web/src"] as const;

/** The text of every string literal and template literal in printed JavaScript. A template's
 * expressions are shown as `{}`, and the strings inside them are found too. */
export function stringsIn(js: string): string[] {
  const found: string[] = [];
  const n = js.length;
  let i = 0;

  const unescaped = (): string => {
    const next = js[i + 1];
    i += 2;
    switch (next) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "v":
        return "\v";
      case "0":
        return "\0";
      case "x": {
        const code = Number.parseInt(js.slice(i, i + 2), 16);
        i += 2;
        return String.fromCharCode(code);
      }
      case "u": {
        if (js[i] === "{") {
          const end = js.indexOf("}", i);
          const code = Number.parseInt(js.slice(i + 1, end), 16);
          i = end + 1;
          return String.fromCodePoint(code);
        }
        const code = Number.parseInt(js.slice(i, i + 4), 16);
        i += 4;
        return String.fromCharCode(code);
      }
      case "\n":
        return "";
      default:
        return next ?? "";
    }
  };

  const quoted = (quote: string): string => {
    i++;
    let text = "";
    while (i < n && js[i] !== quote) {
      if (js[i] === "\\") text += unescaped();
      else text += js[i++];
    }
    i++;
    return text;
  };

  const template = (): string => {
    i++;
    let text = "";
    while (i < n && js[i] !== "`") {
      if (js[i] === "\\") text += unescaped();
      else if (js[i] === "$" && js[i + 1] === "{") {
        i += 2;
        text += "{}";
        code(true);
      } else text += js[i++];
    }
    i++;
    return text;
  };

  /** Whether a "/" after this token starts a regular expression and not a division. */
  const startsRegex = (previous: string, word: string): boolean => {
    if (previous === "" || "(,=:[!&|?{};+-*%<>~^".includes(previous)) return true;
    if (previous === ")" || previous === "]" || previous === "}") return false;
    return [
      "return",
      "typeof",
      "case",
      "do",
      "else",
      "in",
      "of",
      "void",
      "delete",
      "throw",
      "yield",
      "await",
    ].includes(word);
  };

  const skipRegex = (): void => {
    i++;
    let inClass = false;
    while (i < n) {
      const c = js[i] as string;
      if (c === "\\") i += 2;
      else if (c === "[") {
        inClass = true;
        i++;
      } else if (c === "]") {
        inClass = false;
        i++;
      } else if (c === "/" && !inClass) {
        i++;
        break;
      } else if (c === "\n") break;
      else i++;
    }
    while (i < n && /[a-z]/i.test(js[i] as string)) i++;
  };

  /** Read code. Inside a template's expression, stop after the brace that closes it. */
  const code = (insideTemplate: boolean): void => {
    let depth = 0;
    let previous = "";
    let word = "";
    while (i < n) {
      const c = js[i] as string;
      if (c === '"' || c === "'") {
        found.push(quoted(c));
        previous = '"';
        word = "";
      } else if (c === "`") {
        found.push(template());
        previous = "`";
        word = "";
      } else if (c === "/" && js[i + 1] === "/") {
        while (i < n && js[i] !== "\n") i++;
      } else if (c === "/" && js[i + 1] === "*") {
        const end = js.indexOf("*/", i + 2);
        i = end < 0 ? n : end + 2;
      } else if (c === "/") {
        if (startsRegex(previous, word)) skipRegex();
        else i++;
        previous = "/";
        word = "";
      } else if (c === "{") {
        depth++;
        previous = c;
        word = "";
        i++;
      } else if (c === "}") {
        if (insideTemplate && depth === 0) {
          i++;
          return;
        }
        depth--;
        previous = c;
        word = "";
        i++;
      } else if (/\s/.test(c)) {
        i++;
      } else {
        if (/[A-Za-z0-9_$]/.test(c)) word = /[A-Za-z0-9_$]/.test(previous) ? word + c : c;
        else word = "";
        previous = c;
        i++;
      }
    }
  };

  code(false);
  return found;
}

/** Whether a string is something a person reads, and not a class name, a selector, a path, an operation
 * name or a key. Prose has a space between words; a lone word is copy when it is capitalized ("Inbox"). A
 * list of class names has no plain word in it: every token carries a hyphen, an underscore, a colon or a
 * dot. */
export function looksLikeCopy(text: string): boolean {
  const trimmed = text.trim();
  if (!/[A-Za-z]/.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 1) return /^[A-Z][a-z][A-Za-z]*[.!?…:]?$/.test(trimmed);
  // A list of class names (`amount rt-inbox-amount`): every token is lowercase code and at least one
  // carries a hyphen, an underscore, a colon, a dot or a bracket, which a plain word does not. A list of
  // selectors (`[data-row], .rt-inbox-why`) is the same: commas and combinators between the tokens.
  const code = tokens.every((token) => /^(?:[>+~]|[.#[]?[a-z][\w:.[\]'="*>,~+-]*)$/.test(token));
  return !(code && tokens.some((token) => /[-_:.[]/.test(token)));
}

/** Words that are spelled out one at a time and so do not look like prose: the singular and the plural
 * in `plural(count, "line", "lines")`, and the two words of `count === 1 ? "line" : "lines"`. They are
 * what a person reads once the count is in front of them. */
export function pluralWordsIn(js: string): string[] {
  const found: string[] = [];
  for (const match of js.matchAll(
    /\bplural(?:ize|ise)?\([^()]*?,\s*"([^"\\]+)",\s*"([^"\\]+)"\s*\)/g,
  ))
    found.push(match[1] as string, match[2] as string);
  for (const match of js.matchAll(/\?\s*"([A-Za-z' -]+)"\s*:\s*"([A-Za-z' -]+)"/g))
    found.push(match[1] as string, match[2] as string);
  return found;
}

/** A screen's search keywords are the words people type to find it, and they keep the names people knew
 * on purpose ("bank feed" still finds Connections), so they are not the application's own words. */
export function withoutKeywords(js: string): string {
  return js.replace(/\bkeywords:\s*\[[^\]]*\]/g, "keywords: []");
}

function transpile(path: string): string {
  const transpiler = new Bun.Transpiler({
    loader: path.endsWith(".tsx") ? "tsx" : "ts",
    tsconfig: JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "solid-js" },
    }),
  });
  return withoutKeywords(transpiler.transformSync(readFileSync(path, "utf8")));
}

export interface CopyString {
  /** Relative to the repository root. */
  readonly file: string;
  readonly text: string;
}

/** The words of one source file. */
export function copyIn(path: string): CopyString[] {
  const file = relative(root, path);
  const js = transpile(path);
  const words = [...stringsIn(js).filter(looksLikeCopy), ...pluralWordsIn(js)];
  return [...new Set(words)].map((text) => ({ file, text }));
}

let everything: CopyString[] | undefined;

/** The words of the whole application, file by file. Read once and kept. */
export function allCopy(): CopyString[] {
  if (everything) return everything;
  const found: CopyString[] = [];
  for (const folder of copyFolders)
    for (const path of new Bun.Glob("**/*.{ts,tsx}").scanSync({
      cwd: join(root, folder),
      absolute: true,
    }))
      found.push(...copyIn(path));
  everything = found.sort((a, b) => (a.file === b.file ? 0 : a.file < b.file ? -1 : 1));
  return everything;
}

/** The line a string starts on in its file, or 0 when it cannot be found (a string the transpiler
 * wrote differently from the source, such as JSX text that was folded). */
export function lineOf(file: string, text: string): number {
  const source = readFileSync(join(root, file), "utf8");
  const pieces = text
    .split("{}")
    .map((piece) => piece.trim())
    .filter((piece) => piece.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const piece of pieces) {
    const at = source.indexOf(piece);
    if (at >= 0) return source.slice(0, at).split("\n").length;
  }
  return 0;
}
