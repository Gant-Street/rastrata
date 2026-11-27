// Help is made from the how-tos in docs/, when the app is built: each topic of the manifest
// (src/routes/help/topics.ts) is read, cut for the people who will read it, and written as one small file the
// reader fetches when the topic is opened. Markdown is turned into HTML here, by a standard library, so no
// Markdown and no renderer is ever sent to a browser.
//
// What a document can say about itself, each on a line of its own (docs/reference/program/ux/simplify.md):
//
//   <!-- help: skip -->        to the next <!-- help: end -->: never in Help (a developer's note, an internal page)
//   <!-- help: installed -->   only where Rastrata runs on the person's own computer
//   <!-- help: hosted -->      only on the hosted service
//
// A link to another topic goes to that topic; a link to anything else in the repository is left as its words.
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { Marked, Renderer, type Token, type Tokens } from "marked";
import {
  type HelpAudience,
  type HelpBlock,
  type HelpDocument,
  type HelpTopic,
  helpContentPath,
  helpTopics,
  topicFor,
} from "../src/routes/help/topics";

export const docsRoot = resolve(import.meta.dir, "../../../docs");
export const AUDIENCES: readonly HelpAudience[] = ["hosted", "installed"];

/** Something the rendering did that a person should know of: the tests read these. */
export interface HelpNote {
  readonly topic: string;
  readonly audience: HelpAudience;
  readonly kind:
    | "plain" // a link to something that is not in Help, left as its words
    | "elsewhere" // a link to a topic these readers cannot open
    | "anchor" // a link to a heading that is not there
    | "html" // raw HTML in a document
    | "marker"; // a help marker that is not closed, or not known
  readonly detail: string;
}

const MARKER = /^\s*<!--\s*help:\s*([a-z]+)\s*-->\s*$/;

/** The document as these readers get it: the parts for others, and the parts for nobody, taken out. */
export function cutFor(
  source: string,
  audience: HelpAudience,
  note: (kind: HelpNote["kind"], detail: string) => void = () => {},
): string {
  const kept: string[] = [];
  let inside: string | null = null;
  let fence: string | null = null;
  for (const line of source.split("\n")) {
    // A marker inside a code block is the code's own text.
    const fenced = /^\s*(```+|~~~+)/.exec(line);
    if (fenced) {
      if (fence === null) fence = fenced[1] ?? null;
      else if (line.trim().startsWith(fence)) fence = null;
    }
    const marker = fence === null ? MARKER.exec(line) : null;
    if (marker) {
      const word = marker[1] ?? "";
      if (word === "end") {
        if (inside === null) note("marker", "an end with nothing open");
        inside = null;
      } else if (word === "skip" || word === "installed" || word === "hosted") {
        if (inside !== null) note("marker", `${word} inside ${inside}`);
        inside = word;
      } else note("marker", `unknown marker: ${word}`);
      continue;
    }
    if (inside === null || inside === audience) kept.push(line);
  }
  if (inside !== null) note("marker", `${inside} is not closed`);
  return kept.join("\n");
}

/** A heading's anchor, the way the pages these documents were written for make it. */
export function anchorOf(text: string, taken: Map<string, number>): string {
  const base = text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
  const count = taken.get(base) ?? 0;
  taken.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const textOf = (tokens: readonly Token[] | undefined): string =>
  (tokens ?? [])
    .map((token) =>
      "tokens" in token && token.tokens ? textOf(token.tokens) : "text" in token ? token.text : "",
    )
    .join("");

/** The headings of a topic as these readers get it, for links that point at one. */
function anchorsOf(topic: HelpTopic, audience: HelpAudience, read: (file: string) => string) {
  const taken = new Map<string, number>();
  const anchors = new Set<string>();
  for (const token of new Marked({ gfm: true }).lexer(cutFor(read(topic.file), audience)))
    if (token.type === "heading") anchors.add(anchorOf(textOf(token.tokens), taken));
  return anchors;
}

export interface RenderOptions {
  /** Reads a document by its path under docs/ (the tests hand in their own). */
  readonly read?: (file: string) => string;
  readonly topics?: readonly HelpTopic[];
}

const readDoc = (file: string): string => readFileSync(join(docsRoot, file), "utf8");

/** A document as Markdown's own pieces, for a reader that draws them itself (the public site, which injects no HTML:
 * scripts/generate-help-pages.ts). The same reading the pages here are made from. */
export function lexHelp(source: string): Token[] {
  return new Marked({ gfm: true }).lexer(source);
}

/** One topic as HTML in blocks, for one kind of reader. */
export function renderTopic(
  topic: HelpTopic,
  audience: HelpAudience,
  options: RenderOptions = {},
): { document: HelpDocument; notes: HelpNote[] } {
  const read = options.read ?? readDoc;
  const topics = options.topics ?? helpTopics;
  const notes: HelpNote[] = [];
  const note = (kind: HelpNote["kind"], detail: string) =>
    notes.push({ topic: topic.id, audience, kind, detail });
  const source = cutFor(read(topic.file), audience, note);
  const taken = new Map<string, number>();
  const anchorCache = new Map<string, Set<string>>();
  const anchorsIn = (other: HelpTopic) => {
    let anchors = anchorCache.get(other.file);
    if (!anchors) {
      anchors = anchorsOf(other, audience, read);
      anchorCache.set(other.file, anchors);
    }
    return anchors;
  };

  /** Where a link goes for these readers: an address, or nothing when its words are all that is left. */
  const destination = (href: string): { href: string; outside?: true } | null => {
    if (/^(https?:|mailto:)/.test(href)) return { href, outside: true };
    const [path = "", hash = ""] = href.split("#", 2);
    if (path === "") {
      if (!anchorsIn(topic).has(hash)) {
        note("anchor", `#${hash}`);
        return null;
      }
      return { href: `#${hash}` };
    }
    const file = relative(docsRoot, resolve(docsRoot, dirname(topic.file), path));
    const named = topics.find((candidate) => candidate.file === file);
    if (!named) {
      note("plain", href);
      return null;
    }
    // The same address holds the document for these readers (Connect Stripe is one for each).
    const target = topicFor(named.id, audience, topics);
    if (!target) {
      note("elsewhere", href);
      return null;
    }
    if (hash !== "" && !anchorsIn(target).has(hash)) {
      note("anchor", href);
      return { href: `/help/${target.id}` };
    }
    return { href: `/help/${target.id}${hash === "" ? "" : `#${hash}`}` };
  };

  const marked = new Marked({
    gfm: true,
    renderer: {
      heading(token: Tokens.Heading) {
        const id = anchorOf(textOf(token.tokens), taken);
        // The topic's own title is the page's one first-level heading, so nothing here is one.
        const level = Math.min(Math.max(token.depth, 2), 4);
        return `<h${level} id="${escapeHtml(id)}">${this.parser.parseInline(token.tokens)}</h${level}>\n`;
      },
      link(token: Tokens.Link) {
        const inner = this.parser.parseInline(token.tokens);
        const to = destination(token.href);
        if (!to) return inner;
        return to.outside
          ? `<a href="${escapeHtml(to.href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
          : `<a href="${escapeHtml(to.href)}">${inner}</a>`;
      },
      html(token: Tokens.HTML | Tokens.Tag) {
        // The documents are prose: a comment is dropped, and anything else is shown as the text it is.
        if (/^\s*<!--[\s\S]*-->\s*$/.test(token.text)) return "";
        note("html", token.text.trim().slice(0, 80));
        return escapeHtml(token.text);
      },
      // A table wider than the column scrolls inside its own region, which the keyboard can reach; it is
      // named by its headings. A command inside a list is a block the keyboard can scroll, too.
      table(token: Tokens.Table) {
        const label = token.header.map((cell) => textOf(cell.tokens)).join(", ");
        const table = Renderer.prototype.table.call(this, token);
        return `<div class="rt-prose-table" role="group" aria-label="${escapeHtml(label)}" tabindex="0">${table}</div>\n`;
      },
      code(token: Tokens.Code) {
        return `<pre tabindex="0"><code>${escapeHtml(token.text)}</code></pre>\n`;
      },
      image(token: Tokens.Image) {
        note("html", `image ${token.href}`);
        return escapeHtml(token.text);
      },
    },
  });

  const blocks: HelpBlock[] = [];
  let title: string | undefined;
  let prose: Token[] = [];
  const flush = () => {
    if (prose.length === 0) return;
    const html = marked.parser(prose).trim();
    if (html !== "") blocks.push({ kind: "prose", html });
    prose = [];
  };
  const tokens = marked.lexer(source);
  for (const token of tokens) {
    if (token.type === "space") continue;
    if (token.type === "heading" && token.depth === 1 && title === undefined) {
      title = textOf(token.tokens);
      // Its anchor is taken all the same, so the anchors below are what they are in the document.
      anchorOf(title, taken);
      continue;
    }
    if (token.type === "code") {
      flush();
      const code = token as Tokens.Code;
      blocks.push({ kind: "code", text: code.text });
      continue;
    }
    prose.push(token);
  }
  flush();
  return {
    document: { id: topic.id, title: topic.title, blocks },
    notes:
      title === undefined
        ? [...notes, { topic: topic.id, audience, kind: "marker", detail: "no title" }]
        : notes,
  };
}

/** The first-level heading of a document, as these readers get it. */
export function titleOf(source: string, audience: HelpAudience): string | undefined {
  for (const token of new Marked({ gfm: true }).lexer(cutFor(source, audience)))
    if (token.type === "heading" && token.depth === 1) return textOf(token.tokens);
  return undefined;
}

/** Every topic these readers can open, rendered. */
export function renderHelp(
  audience: HelpAudience,
  options: RenderOptions = {},
): { documents: HelpDocument[]; notes: HelpNote[] } {
  const topics = options.topics ?? helpTopics;
  const documents: HelpDocument[] = [];
  const notes: HelpNote[] = [];
  for (const topic of topics) {
    if (topic.only !== undefined && topic.only !== audience) continue;
    const rendered = renderTopic(topic, audience, options);
    documents.push(rendered.document);
    notes.push(...rendered.notes);
  }
  return { documents, notes };
}

/** One topic's file as the reader asks for it, or nothing when the address is not one. */
export function helpContentFor(pathname: string): string | null {
  for (const audience of AUDIENCES)
    for (const topic of helpTopics) {
      if (topic.only !== undefined && topic.only !== audience) continue;
      if (helpContentPath(topic.id, audience) === pathname)
        return JSON.stringify(renderTopic(topic, audience).document);
    }
  return null;
}

/** Writes Help into a build: one file a topic for each kind of reader. */
export async function writeHelp(outdir: string): Promise<number> {
  let written = 0;
  for (const audience of AUDIENCES) {
    for (const document of renderHelp(audience).documents) {
      const path = join(outdir, helpContentPath(document.id, audience));
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, JSON.stringify(document));
      written += 1;
    }
  }
  return written;
}
