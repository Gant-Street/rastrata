/** Compare physical receipt encodings on the same real, read-only source rows.
 * Creates disposable table/index copies, never rewrites the source database.
 * This isolates compression/page packing, not total-book or full-save cost. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { Database } from "bun:sqlite";
import {
  decodeStoredNativeOutcome,
  MAX_NATIVE_OUTCOME_BYTES,
} from "../src/native-outcome-storage.ts";

const sourcePath = process.argv[2];
const count = Number(process.argv[3] ?? "10000");
assert.ok(sourcePath, "Usage: bun scripts/storage-profile.ts /path/to/book.sqlite [count]");
assert.ok(Number.isSafeInteger(count) && count > 0 && count <= 100000);
const source = new Database(sourcePath, { readonly: true });
type Row = {
  sequence: number;
  command_id: string;
  body: unknown;
  previous_hash: string;
  head: string;
};
let rows: Row[];
try {
  rows = source
    .query(
      "SELECT sequence,command_id,body,previous_hash,head FROM ledger_native_outcomes ORDER BY sequence LIMIT ?",
    )
    .all(count) as Row[];
} finally {
  source.close();
}
assert.equal(rows.length, count, "Source has fewer receipts than requested");
const canonical = rows.map((row) => decodeStoredNativeOutcome(row.body));
const buffers = canonical.map((text) => new TextEncoder().encode(text));
assert.ok(buffers.every((bytes) => bytes.length <= MAX_NATIVE_OUTCOME_BYTES));
const fingerprint = createHash("sha256");
for (const text of canonical) fingerprint.update(JSON.stringify(text));
const directory = mkdtempSync(join(tmpdir(), "rastrata-storage-profile-"));
const results = [];
for (let trial = 0; trial < 3; trial++) {
  // Reverse the order in the middle trial; no simultaneous benchmark workers.
  for (const level of trial === 1 ? [6, 3, 1] : [1, 3, 6]) {
    const cpu = process.cpuUsage(),
      start = performance.now();
    const encoded = canonical.map((text, i) => {
      const bytes = buffers[i];
      assert.ok(bytes);
      if (bytes.length < 1024) return text;
      const candidate = `rastrata-deflate-v1:${deflateRawSync(bytes, { level }).toString("base64")}`;
      return candidate.length <= bytes.length * 0.875 ? candidate : text;
    });
    const encodeWallMs = performance.now() - start,
      used = process.cpuUsage(cpu);
    const file = join(directory, `level-${level}-${trial}.sqlite`),
      db = new Database(file);
    try {
      db.exec(
        "CREATE TABLE ledger_native_outcomes (sequence INTEGER PRIMARY KEY CHECK(sequence > 0), command_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, previous_hash TEXT NOT NULL, head TEXT NOT NULL)",
      );
      const insert = db.query(
        "INSERT INTO ledger_native_outcomes(sequence,command_id,body,previous_hash,head) VALUES(?,?,?,?,?)",
      );
      db.transaction(() =>
        rows.forEach((row, i) => {
          const body = encoded[i];
          assert.ok(body !== undefined);
          insert.run(row.sequence, row.command_id, body, row.previous_hash, row.head);
        }),
      )();
      assert.deepEqual(db.query("PRAGMA integrity_check").get(), { integrity_check: "ok" });
      const saved = db.query("SELECT body FROM ledger_native_outcomes ORDER BY sequence").all() as {
        body: unknown;
      }[];
      assert.equal(saved.length, count);
      saved.forEach((row, i) => {
        assert.equal(decodeStoredNativeOutcome(row.body), canonical[i]);
      });
    } finally {
      db.close();
    }
    results.push({
      level,
      trial,
      rows: count,
      encodeCpuMs: (used.user + used.system) / 1000,
      encodeWallMs,
      storedBytes: encoded.reduce((n, text) => n + Buffer.byteLength(text), 0),
      databaseBytes: statSync(file).size,
    });
  }
}
console.log(
  JSON.stringify(
    {
      schema: "rastrata-receipt-storage-profile-v1",
      recordedAt: new Date().toISOString(),
      runtime: Bun.version,
      sourcePath,
      inputHash: fingerprint.digest("hex"),
      directory,
      scope:
        "Identical real receipts in fresh SQLite tables/indexes. Compression CPU excludes UTF-8 preparation, inserts and verification. Not total-book bytes or full-save latency. Source is read-only.",
      results,
    },
    null,
    2,
  ),
);
