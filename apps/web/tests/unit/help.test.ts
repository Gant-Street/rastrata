import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { helpHref, helpPages } from "../../src/routes/help/pages";
import {
  type HelpAudience,
  type HelpTopic,
  helpContentPath,
  helpGroups,
  helpTopics,
  topicFor,
  topicsByGroup,
} from "../../src/routes/help/topics";
import {
  AUDIENCES,
  cutFor,
  docsRoot,
  helpContentFor,
  renderHelp,
  renderTopic,
  titleOf,
} from "../../tooling/help";

// Help is made from the how-tos in docs/ when the app is built. These tests read the real documents: what
// the manifest names exists, every link in a topic goes somewhere these readers can open, nothing the
// rulings keep out of Help is in it, and every page of the app has its topic or says it has none.

const source = (topic: HelpTopic) => readFileSync(join(docsRoot, topic.file), "utf8");
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

describe("the manifest", () => {
  test("every topic names a document that exists, in a group that exists", () => {
    expect(helpTopics.length).toBeGreaterThan(15);
    for (const topic of helpTopics) {
      expect(existsSync(join(docsRoot, topic.file)), topic.file).toBe(true);
      expect(
        helpGroups.some((group) => group.id === topic.group),
        topic.id,
      ).toBe(true);
      expect(topic.id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  test("a topic is called what its document is called, unless it says it was renamed", () => {
    for (const topic of helpTopics) {
      const title = titleOf(source(topic), topic.only ?? "hosted");
      if (topic.renamed) expect(title, topic.file).not.toBe(topic.title);
      else expect(title, topic.file).toBe(topic.title);
    }
  });

  test("each kind of reader has one document at an address, and no group with nothing in it", () => {
    for (const audience of AUDIENCES) {
      const mine = helpTopics.filter(
        (topic) => topic.only === undefined || topic.only === audience,
      );
      const ids = mine.map((topic) => topic.id);
      expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
      const titles = mine.map((topic) => topic.title);
      expect(titles.filter((title, index) => titles.indexOf(title) !== index)).toEqual([]);
      const groups = topicsByGroup(audience);
      expect(groups.every((group) => group.topics.length > 0)).toBe(true);
      expect(groups.flatMap((group) => group.topics).length).toBe(mine.length);
    }
  });

  test("nothing about running Rastrata yourself is a topic on the hosted service", () => {
    const hosted = topicsByGroup("hosted").flatMap((group) =>
      group.topics.map((topic) => topic.file),
    );
    for (const file of [
      "how-to/install-rastrata.md",
      "how-to/connect-your-bank-through-simplefin.md",
      "how-to/back-up-and-restore.md",
      "how-to/develop-repository.md",
      "how-to/operate-production-ledger.md",
    ])
      expect(hosted).not.toContain(file);
  });
});

describe("the parts a document marks", () => {
  const document = [
    "# Title",
    "",
    "For everyone.",
    "<!-- help: skip -->",
    "For a developer.",
    "<!-- help: end -->",
    "Still for everyone.",
    "",
    "1. One",
    "   <!-- help: installed -->",
    "   On your own computer.",
    "   <!-- help: end -->",
    "<!-- help: hosted -->",
    "2. On the service",
    "<!-- help: end -->",
    "",
    "```sh",
    "<!-- help: skip -->",
    "echo kept",
    "```",
  ].join("\n");

  test("a part for nobody is left out, and a part for some readers is theirs alone", () => {
    const hosted = cutFor(document, "hosted");
    const installed = cutFor(document, "installed");
    for (const text of [hosted, installed]) {
      expect(text).toContain("For everyone.\nStill for everyone.");
      expect(text).not.toContain("For a developer.");
      // A marker inside a block of code is the code's own text.
      expect(text).toContain("<!-- help: skip -->\necho kept");
    }
    expect(hosted).toContain("2. On the service");
    expect(hosted).not.toContain("On your own computer.");
    expect(installed).toContain("On your own computer.");
    expect(installed).not.toContain("2. On the service");
  });

  test("a marker that is not closed, or not known, is said", () => {
    const notes: string[] = [];
    cutFor("<!-- help: skip -->\ntext", "hosted", (kind, detail) =>
      notes.push(`${kind}: ${detail}`),
    );
    cutFor("<!-- help: sometimes -->\ntext", "hosted", (kind, detail) =>
      notes.push(`${kind}: ${detail}`),
    );
    expect(notes).toEqual(["marker: skip is not closed", "marker: unknown marker: sometimes"]);
  });

  test("a document becomes text and commands: a link to a topic goes to it, any other is left as its words", () => {
    const topics: HelpTopic[] = [
      { id: "one", file: "how-to/one.md", title: "One", group: "start" },
      { id: "two", file: "how-to/two.md", title: "Two", group: "start", only: "installed" },
    ];
    const files: Record<string, string> = {
      "how-to/one.md": [
        "# One",
        "",
        "See [two](two.md#a-part), [the notes](../reference/notes.md), [here](#steps) and [out](https://example.com).",
        "",
        "## Steps",
        "",
        "```sh",
        "rastrata help",
        "```",
        "",
        "| A | B |",
        "| --- | --- |",
        "| 1 | 2 |",
      ].join("\n"),
      "how-to/two.md": "# Two\n\n## A part\n\nText.",
    };
    const options = { topics, read: (file: string) => files[file] ?? "" };
    const installed = renderTopic(topics[0] as HelpTopic, "installed", options);
    expect(installed.document.title).toBe("One");
    expect(installed.document.blocks.map((block) => block.kind)).toEqual([
      "prose",
      "code",
      "prose",
    ]);
    const [first, code, last] = installed.document.blocks;
    const html = first?.kind === "prose" ? first.html : "";
    expect(html).toContain('<a href="/help/two#a-part">two</a>');
    expect(html).toContain("the notes,");
    expect(html).not.toContain("notes.md");
    expect(html).toContain('<a href="#steps">here</a>');
    expect(html).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">out</a>',
    );
    expect(html).toContain('<h2 id="steps">Steps</h2>');
    expect(html).not.toContain("<h1");
    expect(code).toEqual({ kind: "code", text: "rastrata help" });
    expect(last?.kind === "prose" ? last.html : "").toContain(
      '<div class="rt-prose-table" role="group" aria-label="A, B" tabindex="0"><table>',
    );
    expect(installed.notes.map((note) => `${note.kind} ${note.detail}`)).toEqual([
      "plain ../reference/notes.md",
    ]);
    // A reader who cannot open the other topic gets its words, and the rendering says so.
    const hosted = renderTopic(topics[0] as HelpTopic, "hosted", options);
    const hostedHtml =
      hosted.document.blocks[0]?.kind === "prose" ? hosted.document.blocks[0].html : "";
    expect(hostedHtml).toContain("See two,");
    expect(hosted.notes.map((note) => note.kind)).toEqual(["elsewhere", "plain"]);
  });
});

describe("what Help says", () => {
  const rendered = Object.fromEntries(
    AUDIENCES.map((audience) => [audience, renderHelp(audience)]),
  ) as Record<HelpAudience, ReturnType<typeof renderHelp>>;

  test("every marker is closed, every heading a link names is there, and no document carries raw HTML", () => {
    for (const audience of AUDIENCES)
      expect(
        rendered[audience].notes
          .filter((note) => note.kind !== "plain" && note.kind !== "elsewhere")
          .map((note) => `${note.audience} ${note.topic} ${note.kind}: ${note.detail}`),
      ).toEqual([]);
  });

  test("a link that is left as its words is one that was read and left that way", () => {
    // A link to a document Help does not hold reads as its words. Each one here was read: the sentence still
    // says something without the link. A new one fails, so that whoever adds it reads the sentence too (or
    // marks it `help: skip` in the document).
    const left = AUDIENCES.flatMap((audience) =>
      rendered[audience].notes
        .filter((note) => note.kind === "plain" || note.kind === "elsewhere")
        .map((note) => `${note.audience} ${note.topic}: ${note.detail}`),
    );
    expect(left.sort()).toEqual(
      [
        // "Keep the old book, or its open export": the export is in Settings, Business.
        "hosted change-your-books-after-you-have-entries: back-up-and-restore.md",
        // An installed copy came with the guide these name.
        "installed back-up-and-restore: install-rastrata.md",
        "installed back-up-and-restore: install-rastrata.md",
        "installed your-first-month: ../how-to/install-rastrata.md",
      ].sort(),
    );
  });

  test("every link between topics opens a topic these readers have, at a heading it has", () => {
    for (const audience of AUDIENCES) {
      const anchors = new Map<string, Set<string>>();
      for (const document of rendered[audience].documents) {
        const ids = new Set<string>();
        for (const block of document.blocks)
          if (block.kind === "prose")
            for (const match of block.html.matchAll(/<h[234] id="([^"]+)"/g))
              ids.add(match[1] ?? "");
        anchors.set(document.id, ids);
      }
      for (const document of rendered[audience].documents)
        for (const block of document.blocks) {
          if (block.kind !== "prose") continue;
          for (const match of block.html.matchAll(/<a href="([^"]+)"/g)) {
            const href = match[1] ?? "";
            if (/^(https?:|mailto:)/.test(href)) continue;
            const [path = "", hash = ""] = href.split("#", 2);
            const id = path === "" ? document.id : path.replace(/^\/help\//, "");
            expect(path === "" || path.startsWith("/help/"), `${document.id}: ${href}`).toBe(true);
            expect(anchors.has(id), `${audience} ${document.id}: ${href}`).toBe(true);
            if (hash !== "")
              expect(anchors.get(id)?.has(hash), `${audience} ${document.id}: ${href}`).toBe(true);
          }
        }
    }
  });

  test("nothing internal, no disclaimer and no word the product does not use is in the text", () => {
    // The rulings: no internal names, file paths or developer pages; no disclaimers; the words agent, For
    // review, Members. The running text is read without what is set as code (the name of a file a person is
    // given, a command they type); a developer's command is looked for in the code too.
    const anywhere: [string, RegExp][] = [
      ["a developer's command", /\bbun (?:run|install|ci)\b|\bbun [a-z]+\/|RASTRATA_LOCAL/],
      ["a development address", /127\.0\.0\.1:4\d{3}|localhost:4\d{3}/],
    ];
    const never: [string, RegExp][] = [
      ["a path into the repository", /\b(?:docs|apps|packages|scripts|src)\/|\.(?:md|tsx?)\b/],
      [
        "an internal page",
        /\blane(?:'s)? (?:record|notes)|\bthe lane\b|verification record|program notes/i,
      ],
      ["a disclaimer", /tax advice|books and reports\. It|books and reports; it/i],
      ["AI, for agent", /\bAI\b/],
      ["Inbox, for For review", /\bthe Inbox\b|\bInbox\b(?! tool)/],
    ];
    // What a person on the hosted service is not told: how to run Rastrata themselves.
    const notHosted: [string, RegExp][] = [
      ["SimpleFIN", /simplefin/i],
      ["the owner key", /owner[ -]key/i],
      ["the data directory", /data directory|data folder/i],
      ["an installed copy", /installed (?:service|Rastrata|copy)|If you installed/],
    ];
    const found: string[] = [];
    for (const audience of AUDIENCES)
      for (const document of rendered[audience].documents) {
        const whole = document.blocks
          .map((block) => (block.kind === "prose" ? textOf(block.html) : block.text))
          .join("\n");
        const prose = document.blocks
          .map((block) =>
            block.kind === "prose"
              ? textOf(block.html.replace(/<pre[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>/g, " "))
              : "",
          )
          .join("\n");
        const checks: [string, RegExp, string][] = [
          ...anywhere.map(([what, pattern]): [string, RegExp, string] => [what, pattern, whole]),
          ...[...never, ...(audience === "hosted" ? notHosted : [])].map(
            ([what, pattern]): [string, RegExp, string] => [what, pattern, prose],
          ),
        ];
        for (const [what, pattern, text] of checks) {
          const hit = pattern.exec(text);
          if (hit)
            found.push(
              `${audience} ${document.id}: ${what}: "${text.slice(Math.max(0, hit.index - 40), hit.index + 60).replace(/\s+/g, " ")}"`,
            );
        }
      }
    expect(found).toEqual([]);
  });

  test("the reader's file for a topic is the topic, and an address that is no topic has none", () => {
    const file = helpContentFor(helpContentPath("reconcile-an-account", "hosted"));
    expect(JSON.parse(file ?? "{}")).toMatchObject({
      id: "reconcile-an-account",
      title: "Reconcile a bank or card account",
    });
    expect(helpContentFor("/help-content/hosted/no-such-topic.json")).toBeNull();
    expect(helpContentFor("/help-content/hosted/../../index.html")).toBeNull();
    // A topic that is only for a person's own copy is not written for the hosted service.
    expect(helpContentFor(helpContentPath("back-up-and-restore", "hosted"))).toBeNull();
    expect(helpContentFor(helpContentPath("back-up-and-restore", "installed"))).not.toBeNull();
  });
});

describe("the topic of each page", () => {
  test("every topic a page names is in Help, with the heading it points at", () => {
    const named = helpPages.flatMap((page) => [
      ...(page.topic === null ? [] : [page.topic]),
      ...Object.values(page.tabs ?? {}),
    ]);
    expect(named.length).toBeGreaterThan(20);
    for (const topic of named) {
      const [id = "", hash = ""] = topic.split("#", 2);
      const readers = AUDIENCES.filter((audience) => topicFor(id, audience) !== undefined);
      expect(readers.length, topic).toBeGreaterThan(0);
      for (const audience of readers) {
        if (hash === "") continue;
        const { document } = renderTopic(topicFor(id, audience) as HelpTopic, audience);
        const html = document.blocks
          .map((block) => (block.kind === "prose" ? block.html : ""))
          .join("");
        expect(html, `${audience} ${topic}`).toContain(` id="${hash}"`);
      }
    }
  });

  test("Help opens the page's topic, the tool's own on a page of several, and the list where there is none", () => {
    expect(helpHref("/reconcile", "", "hosted")).toBe("/help/reconcile-an-account");
    expect(helpHref("/reconcile/abc", "", "hosted")).toBe("/help/reconcile-an-account");
    expect(helpHref("/journal", "", "hosted")).toBe(
      "/help/work-through-the-inbox#all-transactions",
    );
    expect(helpHref("/tax", "?tab=vendors&year=2026", "hosted")).toBe("/help/track-1099-vendors");
    expect(helpHref("/tax", "?tab=worksheet", "hosted")).toBe(
      "/help/get-your-books-ready-for-tax-time",
    );
    expect(helpHref("/", "", "hosted")).toBe("/help");
    expect(helpHref("/settings/members", "", "hosted")).toBe("/help/invite-people-to-your-books");
    expect(helpHref("/settings/bring-in", "", "hosted")).toBe("/help");
    expect(helpHref("/no-such-page", "", "hosted")).toBe("/help");
    // A topic these readers do not have is not offered: the list is.
    expect(helpHref("/settings/backups", "", "hosted")).toBe("/help");
    expect(helpHref("/settings/backups", "", "installed")).toBe("/help/back-up-and-restore");
    // The same address is each reader's own document.
    expect(topicFor("connect-stripe", "hosted")?.file).toBe(
      "how-to/connect-stripe-in-a-hosted-workspace.md",
    );
    expect(topicFor("connect-stripe", "installed")?.file).toBe("how-to/connect-stripe.md");
  });
});
