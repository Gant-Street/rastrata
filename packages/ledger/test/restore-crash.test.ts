import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { encodeDurableBook, hashCanonical } from "@rastrata/kernel";
import { SqliteArchiveCatalog } from "../src/archive-catalog.ts";
import { SqliteArchiveSelection } from "../src/archive-selection.ts";
import { SqliteBookStorage } from "../src/sqlite.ts";
import { atomicSqlite } from "../src/sqlite-transaction.ts";
import { R2ArchiveObjectStore, referenceArchivePayload } from "../src/r2-archive-store.ts";
import {
  ARCHIVE_RECORD_VERSION,
  createArchiveDurabilityPolicy,
  prepareArchiveGenesis,
  encodeArchiveManifest,
  encodeArchiveAnchor,
  decodeArchiveAnchor,
  type ArchiveAnchor,
} from "../src/archive-records.ts";
import { evaluateOutcomePayload } from "../src/outcome-payload.ts";
import { withBucket, type TestR2Bucket } from "./r2-fixtures.ts";
import { genesis, activation, posting } from "./fixtures.ts";
import {
  restoreCrashPoints,
  restoreCrashScope as scope,
  restoreCrashSqlite,
} from "./restore-process-fixture.ts";

type Condition = "damaged" | "absent";
const encoder = new TextEncoder();
const initial = encodeDurableBook(genesis());
async function currentAnchor(store: R2ArchiveObjectStore) {
  const control = await store.readControl();
  if (!control) throw new Error("Missing archive fixture");
  return decodeArchiveAnchor(control.body);
}
function canonicalSnapshot(file: ReturnType<typeof restoreCrashSqlite>) {
  const names = file.db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'ledger_*' AND name <> 'ledger_archive_restore' ORDER BY name",
    )
    .all() as { name: string }[];
  const tables = names.map((row) => row.name);
  const content = {
    tables,
    metadata: tables.includes("ledger_metadata")
      ? file.db.query("SELECT * FROM ledger_metadata").all()
      : [],
    outcomes: tables.includes("ledger_outcomes")
      ? file.db.query("SELECT * FROM ledger_outcomes ORDER BY sequence_length, sequence").all()
      : [],
    chunks: tables.includes("ledger_chunks")
      ? file.db
          .query(
            "SELECT record_id, ordinal, hex(bytes) AS bytes, digest FROM ledger_chunks ORDER BY record_id, ordinal",
          )
          .all()
      : [],
    owner: tables.includes("ledger_archive_owner")
      ? file.db.query("SELECT * FROM ledger_archive_owner").all()
      : [],
    selectedChunks: tables.includes("ledger_archive_chunks")
      ? file.db
          .query(
            "SELECT ordinal, hex(bytes) AS bytes, digest FROM ledger_archive_chunks ORDER BY ordinal",
          )
          .all()
      : [],
  };
  return hashCanonical({
    domain: "restore-crash-canonical-snapshot",
    value: JSON.stringify(content),
  }).digest;
}

async function seed(directory: string, bucket: TestR2Bucket, condition: Condition) {
  const book = restoreCrashSqlite(join(directory, "book.sqlite"));
  const control = restoreCrashSqlite(join(directory, "catalog.sqlite"));
  const catalog = new SqliteArchiveCatalog("restore-crash-catalog", control.storage, scope);
  const owner = new SqliteArchiveSelection(scope.objectId, book.storage, scope);
  const store = new R2ArchiveObjectStore(bucket, scope, scope.objectId);
  try {
    const manifest = prepareArchiveGenesis(
      scope,
      createArchiveDurabilityPolicy(true),
      initial,
      await store.putImmutable(encoder.encode(initial)),
    );
    const reference = await store.putImmutable(encoder.encode(encodeArchiveManifest(manifest)));
    const anchor: ArchiveAnchor = {
      version: ARCHIVE_RECORD_VERSION,
      kind: "anchor",
      identity: scope,
      format: manifest.format,
      head: manifest.initialHead,
      manifest: reference,
      manifestHash: manifest.contentHash,
      fenceGeneration: "0",
    };
    expect((await store.compareAndSwapControl(null, encodeArchiveAnchor(anchor))).disposition).toBe(
      "written",
    );
    const reserved = await catalog.reserve(initial, "reserve");
    await owner.reserveBook(initial);
    await catalog.activate(reserved, "activate", store, {
      verifyHead: (expected) => owner.verifyArchiveHead(store, expected),
    });
    let aggregate = genesis();
    for (const [index, command] of [
      activation(),
      posting("chunked-sale", 1n, true, "€".repeat(50_000)),
      posting("retained-rejection", 0n),
    ].entries()) {
      const evaluated = evaluateOutcomePayload(aggregate, command);
      if (!evaluated.encoded) throw new Error("Missing original fixture outcome");
      await owner.select(store, await currentAnchor(store), evaluated.encoded, `seed-${index}`);
      await owner.publishPending(store, catalog);
      await owner.reconcilePublished(store, catalog);
      aggregate = { state: evaluated.transition.state, protocol: evaluated.transition.protocol };
    }
    const adapter = new SqliteBookStorage(scope.objectId, book.storage);
    const original = atomicSqlite(book.storage, (transaction) =>
      adapter.loadForArchiveInTransaction(transaction, scope),
    );
    expect(original.outcomes.map((outcome) => outcome.revision)).toEqual(["1", "2", null]);
    expect(BigInt(original.outcomes[1]?.frame?.chunkCount ?? "0")).toBeGreaterThan(1n);
    const maintenance = await catalog.beginMaintenance(await catalog.read(), "maintain");
    const sealed = await catalog.sealFence(maintenance, "seal", store);
    const authorized = await catalog.authorizeRestore(sealed, "restore", "test-operator", store);
    if (!authorized.restorePermit) throw new Error("Missing restore permit");
    await Bun.write(
      join(directory, "restore-input.json"),
      JSON.stringify({
        catalogHash: authorized.contentHash,
        permitHash: authorized.restorePermit.contentHash,
      }),
    );
    if (condition === "absent") {
      book.db.exec(
        "DROP TABLE ledger_archive_owner; DROP TABLE ledger_archive_chunks; DROP TABLE ledger_chunks; DROP TABLE ledger_outcomes; DROP TABLE ledger_metadata",
      );
    } else {
      book.db.exec("DELETE FROM ledger_chunks WHERE record_id = '2' AND ordinal = 1");
      expect(book.db.query("SELECT changes() AS count").get()).toEqual({ count: 1 });
    }
    return {
      store,
      original,
      authorized,
      permit: authorized.restorePermit,
      before: canonicalSnapshot(book),
    };
  } finally {
    book.db.close();
    control.db.close();
  }
}

function bridge(bucket: TestR2Bucket) {
  const capability = randomUUID();
  const key = referenceArchivePayload(scope, scope.objectId, new Uint8Array([1])).objectKey;
  const prefix = key.slice(0, key.lastIndexOf("/immutable/"));
  let rejectedWrites = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "GET") {
        rejectedWrites++;
        return new Response("Read-only fixture", { status: 405 });
      }
      const url = new URL(request.url),
        requestedKey = url.searchParams.get("key");
      if (
        url.pathname !== "/archive" ||
        request.headers.get("X-Fixture-Capability") !== capability ||
        requestedKey === null ||
        !(
          requestedKey.startsWith(`${prefix}/immutable/`) ||
          requestedKey === `${prefix}/control/anchor`
        )
      )
        return new Response("Invalid fixture request", { status: 403 });
      const object = await bucket.get(requestedKey);
      if (!object) return new Response(null, { status: 404 });
      return new Response(object.body, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "no-store",
          "X-Archive-Key": object.key,
          "X-Archive-Etag": object.etag,
          "X-Archive-Size": String(object.size),
        },
      });
    },
  });
  return {
    endpoint: `http://127.0.0.1:${server.port}/archive`,
    capability,
    rejectedWrites: () => rejectedWrites,
    close: () => server.stop(true),
  };
}

async function runWorker(directory: string, point: string, endpoint: string, capability: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "restore-process-worker.ts"),
      directory,
      point,
      endpoint,
      capability,
    ],
    { cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { TMPDIR: tmpdir() } },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 15_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, signal: child.signalCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}

for (const condition of ["damaged", "absent"] as const)
  for (const point of restoreCrashPoints.filter(
    (value) => condition !== "absent" || value !== "tables-dropped",
  ))
    test(`restore SIGKILL at ${point} recovers ${condition} book without partial replacement`, async () => {
      await withBucket(async (bucket) => {
        const directory = mkdtempSync(join(tmpdir(), "rastrata-restore-crash-"));
        const service = bridge(bucket);
        try {
          const fixture = await seed(directory, bucket, condition);
          const killed = await runWorker(directory, point, service.endpoint, service.capability);
          expect(killed.timedOut, killed.stderr).toBe(false);
          expect(killed.signal, killed.stderr).toBe("SIGKILL");
          expect(killed.stderr.trim().split("\n")).toHaveLength(1);
          expect(killed.stderr.startsWith("REACHED:")).toBe(true);
          const reached = JSON.parse(killed.stderr.trim().slice("REACHED:".length));
          const initialBoundary = point === "selection-row" || point === "selection-committed";
          const finalBoundary =
            point === "installed-row" ||
            point === "install-committed" ||
            point === "response-ready";
          const totalChunks =
            1 +
            fixture.original.outcomes.reduce(
              (total, outcome) => total + Number(outcome.frame?.chunkCount),
              0,
            );
          const chunksAtPoint = initialBoundary
            ? condition === "damaged"
              ? totalChunks - 1
              : 0
            : point === "genesis-chunk"
              ? 1
              : point === "first-outcome-chunk"
                ? 2 + Number(fixture.original.outcomes[0]?.frame?.chunkCount)
                : point === "rejection-header"
                  ? totalChunks - Number(fixture.original.outcomes[2]?.frame?.chunkCount)
                  : finalBoundary
                    ? totalChunks
                    : 0;
          expect(reached).toEqual({
            point,
            phase: finalBoundary ? "installed" : "selected",
            tables: initialBoundary
              ? condition === "damaged"
                ? 5
                : 0
              : point === "tables-dropped"
                ? 0
                : 5,
            outcomes: initialBoundary
              ? condition === "damaged"
                ? 3
                : 0
              : point === "first-outcome-chunk"
                ? 2
                : point === "rejection-header" || finalBoundary
                  ? 3
                  : 0,
            chunks: chunksAtPoint,
          });
          expect(killed.stdout).toBe("");
          const committed = point === "install-committed" || point === "response-ready";
          const observed = restoreCrashSqlite(join(directory, "book.sqlite"));
          const authority = restoreCrashSqlite(join(directory, "catalog.sqlite"));
          try {
            expect(observed.db.query("PRAGMA integrity_check").all()).toEqual([
              { integrity_check: "ok" },
            ]);
            const marker = observed.db
              .query("SELECT name FROM sqlite_master WHERE name = 'ledger_archive_restore'")
              .get();
            if (point === "selection-row") expect(marker).toBeNull();
            else
              expect(observed.db.query("SELECT phase FROM ledger_archive_restore").get()).toEqual({
                phase: committed ? "installed" : "selected",
              });
            if (!committed) expect(canonicalSnapshot(observed)).toBe(fixture.before);
            else {
              const adapter = new SqliteBookStorage(scope.objectId, observed.storage);
              expect(
                atomicSqlite(observed.storage, (transaction) =>
                  adapter.loadForArchiveInTransaction(transaction, scope),
                ),
              ).toEqual(fixture.original);
            }
            const catalog = new SqliteArchiveCatalog(
              "restore-crash-catalog",
              authority.storage,
              scope,
            );
            expect(await catalog.read()).toEqual(fixture.authorized);
            if (!committed) {
              const owner = new SqliteArchiveSelection(scope.objectId, observed.storage, scope);
              await expect(
                catalog.finishMaintenance(fixture.authorized, "not-ready", fixture.store, {
                  verifyHead: (anchor) => owner.verifyArchiveHead(fixture.store, anchor),
                }),
              ).rejects.toThrow();
              expect(await catalog.read()).toEqual(fixture.authorized);
            }
          } finally {
            observed.db.close();
            authority.db.close();
          }
          const recovered = await runWorker(
            directory,
            "none",
            service.endpoint,
            service.capability,
          );
          expect(recovered.timedOut, recovered.stderr).toBe(false);
          expect(recovered.exitCode, recovered.stderr).toBe(0);
          expect(recovered.stderr).toBe("");
          const result = JSON.parse(recovered.stdout);
          expect(result.receipt.disposition).toBe(committed ? "already-installed" : "installed");
          expect(result.receipt.restoredHead).toEqual(fixture.original.head);
          expect(result.evidence.restoredUnderPermitHash).toBe(fixture.permit.contentHash);
          expect(result.outcomes).toEqual([
            { command_id: "activate", revision: "1" },
            { command_id: "chunked-sale", revision: "2" },
            { command_id: "retained-rejection", revision: null },
          ]);
          expect(result.catalogHash).toBe(fixture.authorized.contentHash);
          expect(result.writeAttempts).toBe(0);
          const finalBook = restoreCrashSqlite(join(directory, "book.sqlite"));
          const finalControl = restoreCrashSqlite(join(directory, "catalog.sqlite"));
          try {
            const adapter = new SqliteBookStorage(scope.objectId, finalBook.storage);
            expect(
              atomicSqlite(finalBook.storage, (transaction) =>
                adapter.loadForArchiveInTransaction(transaction, scope),
              ),
            ).toEqual(fixture.original);
            const owner = new SqliteArchiveSelection(scope.objectId, finalBook.storage, scope);
            const catalog = new SqliteArchiveCatalog(
              "restore-crash-catalog",
              finalControl.storage,
              scope,
            );
            expect(
              (
                await catalog.finishMaintenance(
                  fixture.authorized,
                  "verified-finish",
                  fixture.store,
                  { verifyHead: (anchor) => owner.verifyArchiveHead(fixture.store, anchor) },
                )
              ).entry.status,
            ).toBe("active");
          } finally {
            finalBook.db.close();
            finalControl.db.close();
          }
          const retried = await runWorker(directory, "none", service.endpoint, service.capability);
          expect(retried.exitCode, retried.stderr).toBe(0);
          expect(JSON.parse(retried.stdout).receipt).toEqual({
            ...result.receipt,
            disposition: "already-installed",
          });
          expect(service.rejectedWrites()).toBe(0);
        } finally {
          await service.close();
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }, 60_000);

test("restart after a killed restore keeps the book unavailable while an archive payload is missing", async () => {
  await withBucket(async (bucket) => {
    const directory = mkdtempSync(join(tmpdir(), "rastrata-restore-crash-"));
    const service = bridge(bucket);
    try {
      const fixture = await seed(directory, bucket, "damaged");
      const killed = await runWorker(
        directory,
        "first-outcome-chunk",
        service.endpoint,
        service.capability,
      );
      expect(killed.timedOut).toBe(false);
      expect(killed.signal, killed.stderr).toBe("SIGKILL");
      expect(JSON.parse(killed.stderr.trim().slice("REACHED:".length)).point).toBe(
        "first-outcome-chunk",
      );
      const body = fixture.original.outcomes[1]?.body;
      if (!body) throw new Error("Missing original chunked outcome");
      const reference = referenceArchivePayload(scope, scope.objectId, encoder.encode(body));
      expect(await bucket.get(reference.objectKey)).not.toBeNull();
      await bucket.delete(reference.objectKey);
      expect(await bucket.get(reference.objectKey)).toBeNull();
      const failed = await runWorker(directory, "none", service.endpoint, service.capability);
      expect(failed.timedOut).toBe(false);
      expect(failed.exitCode).toBe(1);
      expect(failed.stderr).toContain("archive_payload_missing");
      expect(failed.stdout).toBe("");
      const book = restoreCrashSqlite(join(directory, "book.sqlite"));
      const control = restoreCrashSqlite(join(directory, "catalog.sqlite"));
      try {
        expect(canonicalSnapshot(book)).toBe(fixture.before);
        expect(book.db.query("SELECT phase FROM ledger_archive_restore").get()).toEqual({
          phase: "selected",
        });
        const owner = new SqliteArchiveSelection(scope.objectId, book.storage, scope);
        await expect(owner.readPending()).rejects.toThrow("archive_restore_pending");
        const catalog = new SqliteArchiveCatalog("restore-crash-catalog", control.storage, scope);
        expect(await catalog.read()).toEqual(fixture.authorized);
      } finally {
        book.db.close();
        control.db.close();
      }
      expect(await fixture.store.putImmutable(encoder.encode(body))).toEqual(reference);
      const retried = await runWorker(directory, "none", service.endpoint, service.capability);
      expect(retried.exitCode, retried.stderr).toBe(0);
      expect(JSON.parse(retried.stdout).receipt.restoredHead).toEqual(fixture.original.head);
      const restored = restoreCrashSqlite(join(directory, "book.sqlite"));
      try {
        const adapter = new SqliteBookStorage(scope.objectId, restored.storage);
        expect(
          atomicSqlite(restored.storage, (transaction) =>
            adapter.loadForArchiveInTransaction(transaction, scope),
          ),
        ).toEqual(fixture.original);
      } finally {
        restored.db.close();
      }
    } finally {
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}, 60_000);

test("restore crash worker rejects wrong directories, unknown hooks and symlink targets before opening SQLite", async () => {
  for (const violation of ["directory", "hook", "symlink"] as const) {
    const directory = mkdtempSync(
      join(
        tmpdir(),
        violation === "directory" ? "rastrata-wrong-crash-" : "rastrata-restore-crash-",
      ),
    );
    try {
      await Bun.write(join(directory, "sentinel"), "must remain untouched");
      if (violation === "symlink")
        symlinkSync(join(directory, "sentinel"), join(directory, "book.sqlite"));
      const result = await runWorker(
        directory,
        violation === "hook" ? "unknown-hook" : "none",
        "http://127.0.0.1:1/archive",
        randomUUID(),
      );
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid isolated restore-process arguments");
      expect(result.stdout).toBe("");
      expect(await Bun.file(join(directory, "sentinel")).text()).toBe("must remain untouched");
      if (violation !== "symlink")
        expect(await Bun.file(join(directory, "book.sqlite")).exists()).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
