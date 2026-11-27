import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { summarizeWorkload, workloadProfiles } from "./workload-plan.ts";

// A bounded local storage-layout experiment, not the production ledger or a DO benchmark.
const root = resolve(import.meta.dir, "../../..");
const maxRows = 300_000;
const maxElapsedMs = 180_000;
const maxRssBytes = 1024 * 1024 * 1024;
export const layouts = [
  { id: "text36-rowid", idBytes: 36, withoutRowid: false, hashedKey: false, storeInputHash: true },
  {
    id: "text36-without-rowid",
    idBytes: 36,
    withoutRowid: true,
    hashedKey: false,
    storeInputHash: true,
  },
  {
    id: "text256-rowid",
    idBytes: 256,
    withoutRowid: false,
    hashedKey: false,
    storeInputHash: true,
  },
  {
    id: "text256-without-rowid",
    idBytes: 256,
    withoutRowid: true,
    hashedKey: false,
    storeInputHash: true,
  },
  {
    id: "hash32-with-input",
    idBytes: 256,
    withoutRowid: true,
    hashedKey: true,
    storeInputHash: true,
  },
  {
    id: "hash32-locator-only",
    idBytes: 256,
    withoutRowid: true,
    hashedKey: true,
    storeInputHash: false,
  },
] as const;
type Layout = (typeof layouts)[number];

function indexKey(id: string, hashed: boolean): string | Uint8Array {
  return hashed ? new Uint8Array(new Bun.CryptoHasher("sha256").update(id).digest()) : id;
}

export function identityRow(sequence: number, idBytes: number) {
  assert.ok(Number.isSafeInteger(sequence) && sequence > 0);
  assert.ok(idBytes === 36 || idBytes === 256);
  // Hash-distributed insertion order, with a deterministic unique suffix; no random seed drift.
  const hash = new Bun.CryptoHasher("sha256").update(`identity:${sequence}`).digest("hex");
  const suffix = sequence.toString(16).padStart(12, "0");
  const id = hash.repeat(4).slice(0, idBytes - suffix.length) + suffix;
  const inputHash = new Bun.CryptoHasher("sha256").update(`command:${sequence}`).digest();
  return { id, inputHash, sequence: String(sequence) };
}

export function projectedBytes(bytes: bigint, rows: bigint, targetRows: bigint): bigint {
  assert.ok(bytes > 0n && rows > 0n && targetRows >= 0n);
  return (bytes * targetRows + rows - 1n) / rows;
}

export function measureIndex(path: string, layout: Layout, targetRows: number) {
  assert.ok(Number.isSafeInteger(targetRows) && targetRows > 0 && targetRows <= maxRows);
  // Refuse to modify an existing database, including an empty file.
  try {
    statSync(path);
    throw new Error("Experiment database already exists");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const db = new Database(path, { create: true });
  const start = performance.now();
  const samples = [];
  try {
    db.run("PRAGMA page_size = 4096");
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = FULL");
    db.run("PRAGMA cache_size = -16384");
    db.run(`CREATE TABLE retry_identity (
      command_id ${layout.hashedKey ? "BLOB" : "TEXT"} PRIMARY KEY NOT NULL,
      ${layout.storeInputHash ? "input_hash BLOB NOT NULL CHECK(length(input_hash) = 32)," : ""}
      outcome_sequence TEXT NOT NULL
    ) ${layout.withoutRowid ? "WITHOUT ROWID" : ""}`);
    const insert = db.query(
      layout.storeInputHash
        ? "INSERT INTO retry_identity VALUES (?, ?, ?)"
        : "INSERT INTO retry_identity VALUES (?, ?)",
    );
    const batch = db.transaction((first: number, last: number) => {
      for (let sequence = first; sequence <= last; sequence++) {
        const row = identityRow(sequence, layout.idBytes);
        const key = indexKey(row.id, layout.hashedKey);
        if (layout.storeInputHash) insert.run(key, row.inputHash, row.sequence);
        else insert.run(key, row.sequence);
      }
    });
    const samplePoints = [10_000, 100_000, targetRows]
      .filter((n, i, points) => n <= targetRows && points.indexOf(n) === i)
      .sort((a, b) => a - b);
    let inserted = 0;
    for (const rows of samplePoints) {
      while (inserted < rows) {
        assert.ok(performance.now() - start < maxElapsedMs, "Experiment time budget exceeded");
        assert.ok(process.memoryUsage().rss < maxRssBytes, "Experiment RSS budget exceeded");
        const end = Math.min(inserted + 1_000, rows);
        batch(inserted + 1, end);
        inserted = end;
      }
      const count = db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM retry_identity")
        .get();
      assert.equal(count?.count, rows);
      const pageCount = db.query<{ page_count: number }, []>("PRAGMA page_count").get();
      const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").get();
      assert.ok(pageCount && pageSize);
      samples.push({ rows, databaseBytes: pageCount.page_count * pageSize.page_size });
    }
    const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
    assert.deepEqual(integrity, [{ integrity_check: "ok" }]);
    // Verify every stored mapping against generation, not merely a handful of lookups.
    let verified = 0;
    for (const row of db
      .query<
        {
          command_id: string | Uint8Array;
          input_hash: Uint8Array | null;
          outcome_sequence: string;
        },
        []
      >(
        `SELECT command_id, ${layout.storeInputHash ? "input_hash" : "NULL AS input_hash"}, outcome_sequence FROM retry_identity`,
      )
      .iterate()) {
      const expected = identityRow(Number(row.outcome_sequence), layout.idBytes);
      assert.deepEqual(row.command_id, indexKey(expected.id, layout.hashedKey));
      assert.deepEqual(
        row.input_hash,
        layout.storeInputHash ? new Uint8Array(expected.inputHash) : null,
      );
      verified++;
    }
    assert.equal(verified, targetRows);
    const queryPlan = db
      .query<{ detail: string }, [string | Uint8Array]>(
        "EXPLAIN QUERY PLAN SELECT * FROM retry_identity WHERE command_id = ?",
      )
      .all(indexKey(identityRow(targetRows, layout.idBytes).id, layout.hashedKey));
    assert.ok(queryPlan.every((row) => String(row.detail).includes("SEARCH")));
    const checkpoint = db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
    assert.equal(checkpoint?.busy, 0);
    const last = samples.at(-1);
    assert.ok(last);
    assert.equal(statSync(path).size, last.databaseBytes);
    const sqliteVersion = db
      .query<{ version: string }, []>("SELECT sqlite_version() AS version")
      .get();
    return {
      layout,
      targetRows,
      samples,
      sqliteVersion: sqliteVersion?.version,
      queryPlan,
      allMappingsVerified: true,
      elapsedMsIncludingGenerationAndVerification: performance.now() - start,
      rssBytesAfterVerification: process.memoryUsage().rss,
      projections: workloadProfiles.flatMap((profile) =>
        [1, 2].map((scale) => {
          const planned = summarizeWorkload(profile, scale);
          const bytes = projectedBytes(
            BigInt(last.databaseBytes),
            BigInt(targetRows),
            planned.retainedOutcomes,
          );
          return {
            profileId: profile.id,
            volumeMultiplier: scale,
            targetOutcomes: String(planned.retainedOutcomes),
            projectedIndexBytes: String(bytes),
            // Arithmetic only; excludes current state, all other indexes, log and checkpoints.
            exceedsSevenDecimalGbBudget: bytes > 7_000_000_000n,
            measuredAtTargetVolume: false,
          };
        }),
      ),
    };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const base = join(root, "coverage/ledger-index-capacity");
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, "run-"));
  const results: ReturnType<typeof measureIndex>[] = [];
  const evidence = {
    schema: "rastrata-index-layout-investigation-v1",
    startedAt: new Date().toISOString(),
    environment: { bun: Bun.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
    sourceIdentities: [
      "packages/ledger/scripts/index-capacity-probe.ts",
      "packages/ledger/scripts/workload-plan.ts",
      "bun.lock",
    ].map((path) => ({
      path,
      sha256: new Bun.CryptoHasher("sha256").update(readFileSync(join(root, path))).digest("hex"),
    })),
    completed: false,
    productionReadinessProven: false,
    results,
  };
  try {
    for (const layout of layouts) {
      const result = measureIndex(join(directory, `${layout.id}.sqlite`), layout, maxRows);
      results.push(result);
      console.log(JSON.stringify({ layout: layout.id, samples: result.samples }));
    }
    evidence.completed = results.length === layouts.length;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await Bun.write(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2));
    console.log(`Evidence: ${join(directory, "evidence.json")}`);
  }
}
