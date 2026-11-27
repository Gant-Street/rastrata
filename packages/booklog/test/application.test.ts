import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EntryError } from "../src/entry.ts";
import { importBookFile } from "../src/import.ts";
import { readLog } from "../src/logreader.ts";
import { BookKeys } from "../src/objectstore.ts";
import { GENESIS_HASH } from "../src/tier.ts";
import {
  APPLICATION_DERIVED,
  APPLICATION_SCHEMA,
  callOperation,
  openHostedApplication,
  operationRequest,
} from "./support/app.ts";
import { Worlds } from "./support/world.ts";

const worlds = new Worlds();
afterEach(() => worlds.disposeAll());

const BOOK = {
  name: "Hosted Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1010", name: "Checking", role: "asset" },
    { code: "2100", name: "Credit card", role: "liability" },
    { code: "3100", name: "Owner draw", role: "equity" },
    { code: "4000", name: "Revenue", role: "income" },
    { code: "6100", name: "Software", role: "expense" },
    { code: "6200", name: "Hosting", role: "expense" },
  ],
};

type Book = Awaited<ReturnType<typeof openHostedApplication>>;

async function ok(book: Book, name: string, input: unknown = {}, operationId?: string) {
  const reply = await callOperation(book, name, input, operationId);
  if (reply.status !== 200 || reply.body.ok !== true)
    throw new Error(
      `${name} answered ${reply.status}: ${JSON.stringify(reply.body).slice(0, 400)}`,
    );
  return reply.body.data;
}

/** What a person does on the Journal screen: an entry written by hand, prepared and posted. */
async function enter(book: Book, n: number): Promise<string> {
  const draft = await ok(book, "drafts.create", {
    data: {
      date: `2026-03-${String(1 + (n % 27)).padStart(2, "0")}`,
      reference: `ref-${n}`,
      narration: `Entry ${n}`,
      lines: [
        { accountId: n % 2 ? "6100" : "6200", debit: `${10 + n}.00`, credit: "" },
        { accountId: "1010", debit: "", credit: `${10 + n}.00` },
      ],
    },
  });
  const plan = await ok(book, "journal.prepare", {
    draftId: draft.id,
    expectedVersion: draft.version,
  });
  const done = await ok(book, "operations.commit", {
    planId: plan.planId,
    planHash: plan.planHash,
  });
  expect(done.disposition).toBe("committed");
  return plan.effects.journals[0].id as string;
}

test("the application runs on a book in the log, and a cold process serves the same book", async () => {
  const w = worlds.make();
  const book = await openHostedApplication(w.runtimeOptions("pod-a#1"));
  await ok(book, "book.setup", BOOK);
  const ids: string[] = [];
  for (let n = 1; n <= 12; n += 1) ids.push(await enter(book, n));
  const listed = await ok(book, "journal.list", { page: 1, status: "Posted" });
  expect(listed.count).toBe(12);
  // Ordinary work never makes the application start over.
  expect(book.resets).toBe(0);
  expect(book.runtime.stats.rollbacks).toBe(0);
  expect(book.runtime.stats.conflicts).toBe(0);
  const entries = w.tier.peek(w.bookId).entries.length;
  expect(entries).toBeGreaterThanOrEqual(12 * 3);
  const hash = book.runtime.capture.stateHash();
  const original = await ok(book, "reports.get", { asOf: "2026-03-31" });
  await book.close();

  const cold = await openHostedApplication(w.runtimeOptions("pod-b#1", "cold.sqlite"));
  expect(cold.runtime.capture.stateHash()).toBe(hash);
  expect((await ok(cold, "journal.list", { page: 1, status: "Posted" })).count).toBe(12);
  expect(await ok(cold, "reports.get", { asOf: "2026-03-31" })).toEqual(original);
  expect((await ok(cold, "journal.get", { journalId: ids[3] })).id).toBe(ids[3]);
  await cold.close();
});

test("an operation sent again under its identity is answered from the book, once", async () => {
  const w = worlds.make();
  const book = await openHostedApplication(w.runtimeOptions("pod-a#1"));
  await ok(book, "book.setup", BOOK);
  const draftId = crypto.randomUUID();
  const input = {
    data: {
      date: "2026-03-02",
      reference: "r",
      narration: "n",
      lines: [
        { accountId: "6100", debit: "5.00", credit: "" },
        { accountId: "1010", debit: "", credit: "5.00" },
      ],
    },
  };
  const first = await ok(book, "drafts.create", input, draftId);
  const before = w.tier.peek(w.bookId).entries.length;
  const second = await ok(book, "drafts.create", input, draftId);
  expect(second).toEqual(first);
  expect(w.tier.peek(w.bookId).entries.length).toBe(before);
  await book.close();
});

test("an agent's read is on record before it is answered, an owner's is not made to wait, and with the tail down the agent is refused and the owner served", async () => {
  const w = worlds.make();
  const book = await openHostedApplication(w.runtimeOptions("pod-a#1"));
  await ok(book, "book.setup", BOOK);
  const created = await ok(book, "tokens.create", { label: "Claude", permissions: ["read"] });
  const agent = () =>
    operationRequest("book.get", {}, undefined, { authorization: `Bearer ${created.secret}` });
  const entries = () => w.tier.peek(w.bookId).entries.length;

  // The owner's read leaves no row and waits for no append.
  const before = entries();
  const flushes = book.runtime.stats.readFlushes;
  await ok(book, "book.get");
  expect(entries()).toBe(before);
  expect(book.runtime.stats.readFlushes).toBe(flushes);

  // The agent's read is in the log when its answer is given.
  expect((await book.fetch(agent())).status).toBe(200);
  expect(entries()).toBe(before + 1);
  expect(book.runtime.stats.readFlushes).toBe(flushes + 1);

  // The process dies right after the answer. A process that has only the log still has the row.
  book.runtime.abandon();
  book.runtime.db.close();
  await w.sleep(6000);
  const cold = await openHostedApplication(w.runtimeOptions("pod-b#1", "cold.sqlite"));
  const activity = await ok(cold, "tokens.activity", {});
  expect(
    activity.events.filter((event: { operation: string }) => event.operation === "book.get"),
  ).toHaveLength(1);

  // With the tail down, the agent's read is refused (it cannot be on record) and the owner's is served.
  w.tier.script([
    { op: "append", fault: "failBefore", times: 100 },
    { op: "head", fault: "failBefore", times: 100 },
  ]);
  w.tier.wire.configure({ timeoutMs: 100 });
  const refused = await w.clock.drive(cold.fetch(agent()));
  expect(refused.status).toBe(503);
  expect(await refused.json()).toMatchObject({ ok: false, error: { code: "read_not_logged" } });
  const served = await w.clock.drive(cold.fetch(operationRequest("book.get", {})));
  expect(served.status).toBe(200);
  w.tier.wire.clearScript();
  // Stopping logs what the refused read left (its row), which takes virtual time like any append.
  await w.clock.drive(cold.close());
});

/** A closed book file made by the code of schema 1 (`experiments/e2-legacy-book.ts`): what a month of
 * bookkeeping leaves in a book, made through the application's own boundary. */
const LEGACY_FIXTURE = join(import.meta.dir, "fixtures/schema1-book.sqlite.gz");
const LEGACY_SCHEMA = 1;

test("a book written at schema 1 is opened by this release, which migrates it as ordinary entries and goes on writing, and a process of schema 1 will not open what this release wrote", async () => {
  const w = worlds.make();
  const file = join(w.directory, "legacy.sqlite");
  writeFileSync(file, Bun.gunzipSync(readFileSync(LEGACY_FIXTURE)));
  await importBookFile({
    tier: w.tier,
    bulk: w.bulk,
    bookId: w.bookId,
    prefix: "runs/t/",
    path: file,
    schema: LEGACY_SCHEMA,
    exclude: APPLICATION_DERIVED,
    clock: w.clock,
  });

  const book = await openHostedApplication({
    ...w.runtimeOptions("pod-a#1"),
    schema: APPLICATION_SCHEMA,
  });
  const posted = (await ok(book, "journal.list", { page: 1, status: "Posted" })).count;
  expect(posted).toBeGreaterThan(0);
  const token = await ok(book, "tokens.create", {
    label: "after the migration",
    permissions: ["read"],
  });
  expect(token.secret).toBeTruthy();
  expect(book.runtime.stats.rollbacks).toBe(0);
  const hash = book.runtime.capture.stateHash();
  await book.close();

  // The log: the book the older release wrote, then this release's entries, all stamped, none above it.
  const stamps: number[] = [];
  let second: { schema: number; changes: number } | null = null;
  for await (const entry of readLog({
    tier: w.tier,
    bulk: w.bulk,
    keys: new BookKeys("runs/t/", w.bookId),
    schema: APPLICATION_SCHEMA,
    after: { seq: 0, hash: GENESIS_HASH },
  })) {
    stamps.push(entry.header.schema);
    if (entry.header.seq === 2)
      second = { schema: entry.header.schema, changes: entry.header.changes };
  }
  expect(stamps[0]).toBe(LEGACY_SCHEMA);
  expect(Math.max(...stamps)).toBeLessThanOrEqual(APPLICATION_SCHEMA);
  expect(stamps.at(-1)).toBe(APPLICATION_SCHEMA);
  if (APPLICATION_SCHEMA > LEGACY_SCHEMA)
    // The migration is an entry like any other: it carries its changes, at the new schema.
    expect(second).toMatchObject({ schema: APPLICATION_SCHEMA });
  if (APPLICATION_SCHEMA > LEGACY_SCHEMA) expect(second?.changes).toBeGreaterThan(0);

  // A cold process of this release has the same book, and keeps writing to it.
  const cold = await openHostedApplication({
    ...w.runtimeOptions("pod-b#1", "cold.sqlite"),
    schema: APPLICATION_SCHEMA,
  });
  expect(cold.runtime.capture.stateHash()).toBe(hash);
  expect((await ok(cold, "journal.list", { page: 1, status: "Posted" })).count).toBe(posted);
  await ok(cold, "tokens.create", { label: "and after that", permissions: ["read"] });
  await cold.close();

  // The release before it cannot read what this one wrote and says so, rather than serving half a book.
  if (APPLICATION_SCHEMA > LEGACY_SCHEMA) {
    const failure = await openHostedApplication({
      ...w.runtimeOptions("old#1", "old.sqlite"),
      schema: LEGACY_SCHEMA,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(EntryError);
    expect((failure as EntryError).code).toBe("schema");
  }
});
