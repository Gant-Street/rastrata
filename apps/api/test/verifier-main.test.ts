// The verifier as a program (src/verifier-main.ts): what it is told, what it prints, what it exits with, and the two things that keep a run from doing harm when something other than the books is wrong
// (a run that finds several books wrong at once stops writing stops; a run that cannot reach the storage stops). The books are real ones, in a bucket the program reaches through the environment
// as a pod's job would. See docs/reference/program/hosting/verifier.md.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BookKeys,
  FileObjectStore,
  ObjectStoreLogTier,
  ObjectStoreUncertain,
  readReviews,
} from "@rastrata/booklog";
import { parseArguments, run, type Output } from "../src/verifier-main.ts";
import { breakOutcome, importedBook, tierWith } from "./support/verifier-books.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A bucket on disk, the tail kept in it (`tail=objects`), and the environment a job would be given to read them. */
function bucket() {
  const root = mkdtempSync(join(tmpdir(), "rastrata-verifier-main-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, "bucket");
  const store = new FileObjectStore(folder);
  const tier = new ObjectStoreLogTier(store);
  const env = {
    RASTRATA_BOOK_STORE: `r2log://verifier?bulk=${pathToFileURL(folder).href}&tail=objects`,
    RASTRATA_VERIFIER_SCRATCH: join(root, "scratch"),
  };
  const book = (name: string, change?: Parameters<typeof importedBook>[0]["change"]) =>
    importedBook({
      folder: root,
      tier,
      bulk: store,
      book: name,
      journals: 8,
      ...(change ? { change } : {}),
    });
  return { root, store, tier, env, book };
}

function output() {
  const out: string[] = [];
  const err: string[] = [];
  const io: Output = { out: (text) => out.push(text), err: (text) => err.push(text) };
  const lines = () => out.map((text) => JSON.parse(text) as Record<string, unknown>);
  return { io, out, err, lines, summary: () => lines().at(-1)?.summary as Record<string, number> };
}

test("what the program is told is checked before anything is read", () => {
  expect(parseArguments(["--all"])).toMatchObject({
    all: true,
    snapshots: true,
    record: true,
    confirm: 1,
    maxFindings: 3,
  });
  expect(
    parseArguments([
      "--book",
      "a",
      "--book",
      "b-2",
      "--no-snapshots",
      "--no-record",
      "--confirm",
      "0",
      "--limit",
      "5",
      "--keep",
      "/k",
      "--detail",
    ]),
  ).toMatchObject({
    books: ["a", "b-2"],
    snapshots: false,
    record: false,
    confirm: 0,
    limit: 5,
    keep: "/k",
    detail: true,
  });
  for (const bad of [
    [],
    ["--all", "--book", "a"],
    ["--book"],
    ["--book", "../etc"],
    ["--book", "a b"],
    ["--limit", "0", "--all"],
    ["--limit", "x", "--all"],
    ["--confirm", "-1", "--all"],
    ["--max-findings", "0", "--all"],
    ["--delete", "--all"],
    ["--books-file"],
    ["--keep"],
  ])
    expect(typeof parseArguments(bad), bad.join(" ")).toBe("string");
});

test("a run over every book exits 1 for a book that is wrong, stops only that one, and leaves it alone the next time while a person who names it gets it looked at", async () => {
  const b = bucket();
  await b.book("sound-1");
  await b.book("broken-1", breakOutcome(4));
  await b.book("sound-2");
  const first = output();
  expect(await run(["--all"], b.env, first.io)).toBe(1);
  const lines = first.lines();
  expect(lines.map((line) => [line.book, line.status])).toEqual([
    ["broken-1", "failed"],
    ["sound-1", "ok"],
    ["sound-2", "ok"],
    [undefined, undefined],
  ]);
  expect(lines[0]).toMatchObject({
    kind: "replay_failed",
    check: "ledger_replay",
    stop: "recorded",
    marker: 1,
  });
  expect(lines[1]).toMatchObject({ ledger: true, snapshot: "none", warnings: [] });
  expect(first.summary()).toMatchObject({
    books: 3,
    ok: 2,
    failed: 1,
    skipped: 0,
    recordingStopped: false,
    aborted: false,
  });
  // Only the book that is wrong has a stop, and a line of the output holds no words from the book.
  expect(await readReviews(b.store, new BookKeys("", "broken-1"))).toHaveLength(1);
  expect(await readReviews(b.store, new BookKeys("", "sound-1"))).toHaveLength(0);
  expect(first.out.join("\n")).not.toContain("detail");

  // The next run leaves the stopped book alone and finds nothing new: it exits 0.
  const second = output();
  expect(await run(["--all"], b.env, second.io)).toBe(0);
  expect(second.lines()[0]).toMatchObject({
    book: "broken-1",
    status: "skipped",
    reason: "reviewed",
  });
  expect(second.summary()).toMatchObject({
    ok: 2,
    failed: 0,
    skipped: 1,
    reviewed: 1,
    troubled: 0,
  });

  // A person who names the book has it looked at, and gets the words for what is wrong with --detail; no second stop is made.
  const third = output();
  expect(await run(["--book", "broken-1", "--detail"], b.env, third.io)).toBe(1);
  expect(third.lines()[0]).toMatchObject({ status: "failed", stop: "already" });
  expect(String(third.lines()[0]?.detail).length).toBeGreaterThan(10);
  expect(await readReviews(b.store, new BookKeys("", "broken-1"))).toHaveLength(1);
}, 120_000);

test("--no-record reports a book that is wrong and writes nothing, and --limit looks at the first few books only", async () => {
  const b = bucket();
  await b.book("broken-1", breakOutcome(4));
  await b.book("sound-1");
  const result = output();
  expect(await run(["--all", "--no-record", "--limit", "1"], b.env, result.io)).toBe(1);
  expect(result.lines()[0]).toMatchObject({
    book: "broken-1",
    status: "failed",
    stop: "dry_run",
    marker: null,
  });
  expect(result.summary()).toMatchObject({ books: 1, failed: 1, ok: 0 });
  expect(await readReviews(b.store, new BookKeys("", "broken-1"))).toEqual([]);
}, 60_000);

test("a run that finds several books wrong stops writing stops after a few, for the verifier may be what is wrong", async () => {
  const b = bucket();
  for (const name of ["broken-1", "broken-2", "broken-3"]) await b.book(name, breakOutcome(4));
  const result = output();
  expect(await run(["--all", "--max-findings", "2"], b.env, result.io)).toBe(1);
  expect(
    result
      .lines()
      .slice(0, 3)
      .map((line) => line.stop),
  ).toEqual(["recorded", "recorded", "dry_run"]);
  expect(result.summary()).toMatchObject({ failed: 3, recordingStopped: true });
  expect(result.err.join("\n")).toContain("no more stops are written");
  expect(await readReviews(b.store, new BookKeys("", "broken-3"))).toEqual([]);
}, 120_000);

test("a run that cannot reach the storage gives up after a few books, exits 3 and stops nothing", async () => {
  const b = bucket();
  const names = Array.from({ length: 9 }, (_, n) => `book-${n}`);
  const file = join(b.root, "books.txt");
  writeFileSync(file, `# the books of the pilot\n\n${names.join("\n")}\n`);
  const silent = tierWith(b.tier, {
    head: async () => {
      throw new ObjectStoreUncertain("the tail did not answer");
    },
  });
  const result = output();
  expect(await run(["--books-file", file], b.env, result.io, { bulk: b.store, tier: silent })).toBe(
    3,
  );
  const lines = result.lines();
  expect(lines.filter((line) => line.status === "skipped").map((line) => line.reason)).toEqual(
    Array(5).fill("unavailable"),
  );
  expect(result.summary()).toMatchObject({ books: 9, skipped: 5, troubled: 5, aborted: true });
  expect(result.err.join("\n")).toContain("could not be reached");
});

test("the program says what is wrong when it is started wrongly, and exits 2", async () => {
  const b = bucket();
  const cases: [string[], Record<string, string>, string][] = [
    [["--all"], {}, "RASTRATA_BOOK_STORE is not set"],
    [[], b.env, "name the books to look at"],
    [["--books-file", join(b.root, "nothing.txt")], b.env, "is not there"],
    [["--all"], { RASTRATA_BOOK_STORE: "postgres://nope" }, "could not start"],
  ];
  for (const [argv, env, message] of cases) {
    const result = output();
    expect(await run(argv, env, result.io), argv.join(" ")).toBe(2);
    expect(result.err.join("\n")).toContain(message);
  }
});
