import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBookService } from "@rastrata/application/local";
import { APPLICATION_API_VERSION } from "@rastrata/application/schema";
import { BULK_BOOK, postBulk } from "@rastrata/application/testing/bulk-book";
import { setupLegacyBook } from "@rastrata/application/testing/legacy-book";
import { bookHistoryMaterializations } from "@rastrata/application/testing/materializations";
import { bookCapacity, SNAPSHOT_CEILING_BYTES } from "../src/capacity.ts";
import { startLocalApplicationServer } from "../src/server.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  // Last made, first undone: a book is closed before the folder it lives in is removed.
  for (const work of cleanup.splice(0).reverse()) work();
});

const KEY = "rso_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";
const BOOK = {
  name: "Capacity Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Cash", role: "asset" },
    { code: "3000", name: "Capital", role: "equity" },
    { code: "4000", name: "Sales", role: "income" },
  ],
} as const;

const authorized = { authorization: `Bearer ${KEY}` };

const call = async (base: string, name: string, input: unknown = {}, operationId?: string) =>
  (
    await fetch(`${base}/v1/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authorized },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: "local-book",
        input,
        ...(operationId ? { operationId } : {}),
      }),
    })
  ).json();

async function postJournal(base: string, reference: string) {
  const draft = await call(
    base,
    "drafts.create",
    {
      data: {
        date: "2026-01-15",
        reference,
        narration: "Sale",
        lines: [
          { accountId: "1000", debit: "10.00", credit: "" },
          { accountId: "4000", debit: "", credit: "10.00" },
        ],
      },
    },
    crypto.randomUUID(),
  );
  const prepared = await call(
    base,
    "journal.prepare",
    { draftId: draft.data.id, expectedVersion: 1 },
    crypto.randomUUID(),
  );
  const done = await call(base, "operations.commit", {
    planId: prepared.data.planId,
    planHash: prepared.data.planHash,
  });
  expect(done.data.disposition).toBe("committed");
}

test("the service says how much the book holds, to its owner only, and the saved snapshot after a stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rastrata-api-capacity-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "book.sqlite");
  let runtime = await startLocalApplicationServer({ path, port: 0, ownerKey: KEY });
  let base = `http://127.0.0.1:${runtime.server.port}`;
  let outcomes = 0;
  const capacity = async () => {
    const response = await fetch(`${base}/api/capacity`, { headers: authorized });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return response.json();
  };
  try {
    // Nobody without the key gets even this.
    expect((await fetch(`${base}/api/capacity`)).status).toBe(401);
    expect(await capacity()).toEqual({
      configured: false,
      journals: 0,
      outcomes: 0,
      ceilingBytes: SNAPSHOT_CEILING_BYTES,
      snapshot: null,
      commitment: null,
      replay: null,
      fromStartSeconds: null,
      restartSeconds: null,
    });
    await call(base, "book.setup", BOOK, crypto.randomUUID());
    for (let index = 1; index <= 12; index += 1) await postJournal(base, `S${index}`);
    const held = await capacity();
    expect(held).toMatchObject({ configured: true, journals: 12, ceilingBytes: 16777216 });
    expect(held.outcomes).toBeGreaterThanOrEqual(12);
    // Every book the application makes is of the kind that reads back in linear time. A start is never
    // faster than a second, so a small book says one.
    expect(held).toMatchObject({
      commitment: "chain-head",
      replay: "linear",
      fromStartSeconds: 1,
      restartSeconds: 1,
    });
    // The first snapshot is saved after a hundred entries, or when the service stops.
    expect(held.snapshot).toBeNull();
    // Only a GET is a capacity request; a POST to the path is left to the browser routes.
    expect(
      (await fetch(`${base}/api/capacity`, { method: "POST", headers: authorized })).status,
    ).not.toBe(200);
    outcomes = held.outcomes as number;
  } finally {
    await runtime.stop();
  }
  runtime = await startLocalApplicationServer({ path, port: 0, ownerKey: KEY });
  base = `http://127.0.0.1:${runtime.server.port}`;
  try {
    const after = await capacity();
    expect(after.journals).toBe(12);
    expect(after.snapshot.sequence).toBe(outcomes);
    expect(after.snapshot.bytes).toBeGreaterThan(1000);
    expect(after.snapshot.bytes).toBeLessThan(SNAPSHOT_CEILING_BYTES);
    // A restart now reads that snapshot and nothing else: a tenth of a second, where reading the whole
    // book from the start is the second a start is never faster than.
    expect(after).toMatchObject({ commitment: "chain-head", fromStartSeconds: 1 });
    expect(after.restartSeconds).toBeLessThan(0.5);
  } finally {
    await runtime.stop();
  }
});

// ---- books of both kinds, built the way the volume tests build one ------------------------------

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-api-capacity-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "book.sqlite");
}

async function open(path: string, kind: "chain-head" | "legacy", journals: number) {
  const service = await LocalBookService.open(path, { safety: false });
  cleanup.push(() => service.close());
  if (kind === "legacy") await setupLegacyBook(service);
  else await service.setup(BULK_BOOK);
  await postBulk(service, journals);
  return service;
}

test("a book made before the chain-head commitment is reported as such, with the estimate that grows with its square", async () => {
  const path = scratch();
  const service = await open(path, "legacy", 400);
  const capacity = await bookCapacity(service, path);
  expect(capacity).toMatchObject({
    configured: true,
    journals: 400,
    outcomes: 401,
    snapshot: { sequence: 401 },
    commitment: "legacy",
    replay: "quadratic",
  });
  // 22 seconds at a thousand journals, and each entry costs in proportion to the journals the book holds:
  // 22 x 0.4 x 0.401 = 3.5 to read the whole book. The first read saved a snapshot of 4 MB, so a restart
  // reads that instead.
  expect(capacity.fromStartSeconds).toBe(3.5);
  expect(capacity.restartSeconds).toBe(0.2);
}, 120_000);

test("a chain-head book is told it restarts in about a second for every thousand entries, however big it is", async () => {
  const path = scratch();
  const service = await open(path, "chain-head", 3000);
  const capacity = await bookCapacity(service, path);
  // Three thousand journals are 30 MB, too big for a snapshot: there is none, and the whole book is read.
  expect(capacity).toMatchObject({
    journals: 3000,
    outcomes: 3001,
    snapshot: null,
    commitment: "chain-head",
    replay: "linear",
    fromStartSeconds: 3,
    restartSeconds: 3,
  });
}, 120_000);

test("past what a snapshot can hold the last one saved stays, and the estimate reads it and the entries since", async () => {
  const path = scratch();
  const service = await open(path, "chain-head", 1200);
  // The first read saves a snapshot of 1,200 journals (12 MB, under the 16 MiB a snapshot can be).
  const first = await bookCapacity(service, path);
  expect(first.snapshot).toMatchObject({ sequence: 1201 });
  expect(first.snapshot?.bytes).toBeGreaterThan(10_000_000);
  expect(first.snapshot?.bytes).toBeLessThan(SNAPSHOT_CEILING_BYTES);
  expect(first.restartSeconds).toBeCloseTo(0.4, 1);
  // Six hundred more make the book too big to encode (18 MB). The service cannot save another snapshot,
  // and the one it has stays, 600 entries behind.
  await postBulk(service, 600);
  const grown = await bookCapacity(service, path);
  expect(grown).toMatchObject({ journals: 1800, outcomes: 1801, snapshot: first.snapshot });
  // A restart reads that snapshot (0.4 s) and replays the 600 entries after it (0.6 s), not the whole book.
  expect(grown.fromStartSeconds).toBe(1.8);
  expect(grown.restartSeconds).toBeCloseTo(1.0, 1);
}, 120_000);

test("counting a book's journals and telling its kind copy no list of the book", async () => {
  const path = scratch();
  const service = await open(path, "chain-head", 50);
  await bookCapacity(service, path);
  // Posting reads the list for its own use; the count starts after it.
  await postBulk(service, 1);
  const before = bookHistoryMaterializations();
  const capacity = await bookCapacity(service, path);
  expect(capacity.journals).toBe(51);
  expect(bookHistoryMaterializations()).toBe(before);
});
