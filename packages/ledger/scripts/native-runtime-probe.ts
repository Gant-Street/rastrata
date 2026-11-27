/** Local workerd HTTP + Durable Object measurement, NOT a remote Cloudflare SLO.
 * Includes synthetic command construction, object routing and storage.sync(). */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { canonicalAccountingValue, canonicalEncode, executeBookCommand } from "@rastrata/kernel";
import { activation, genesis, posting } from "../test/fixtures.ts";

const count = Number(process.argv[2] ?? "10000");
assert.ok(Number.isSafeInteger(count) && count >= 64 && count <= 100000);
const entry = join(import.meta.dir, "../test/runtime-native-ledger-worker.ts");
const built = await Bun.build({
  entrypoints: [entry],
  target: "node",
  format: "esm",
  external: ["node:crypto"],
});
assert.ok(built.success);
if (!built.outputs[0]) throw new Error("Missing native runtime bundle");
const script = await built.outputs[0].text();
const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const probeHash = sha256(readFileSync(import.meta.path));
const directory = mkdtempSync(join(tmpdir(), "rastrata-native-runtime-probe-"));
const options = {
  modules: true,
  script,
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { BOOKS: { className: "NativeLedgerObject", useSQLite: true } },
  durableObjectsPersist: directory,
  cf: false,
};
let runtime = new Miniflare(options);
async function call(path: string) {
  const response = await runtime.dispatchFetch(`http://native-probe.test${path}`);
  if (response.status !== 200) throw new Error(await response.text());
  return (await response.json()) as {
    disposition: string;
    head: { sequence: string; bookRevision: string };
    outcomeSequence: string;
    original: string;
    sql: number;
    count: number;
  };
}
const samples: {
  index: number;
  wallMs: number;
  sql: number;
  restarted: boolean;
  processStartupMs: number;
}[] = [];
let oracle = genesis();
let revision = 1n;
const activated = executeBookCommand(oracle.state, oracle.protocol, activation());
oracle = { state: activated.state, protocol: activated.protocol };
const originals = new Map<number, { revision: string; original: string; sequence: string }>();
try {
  await call("/provision");
  for (let i = 0; i < count; i++) {
    const restarted = i % 1000 === 0;
    let processStartupMs = 0;
    if (restarted) {
      await runtime.dispose();
      const boot = performance.now();
      runtime = new Miniflare(options);
      await runtime.ready;
      processStartupMs = performance.now() - boot;
    }
    const expectedRevision = i % 10 === 9 ? 0n : revision;
    const start = performance.now();
    const value = await call(`/post?id=runtime-${i}&revision=${expectedRevision}`);
    const wallMs = performance.now() - start;
    samples.push({ index: i, wallMs, sql: value.sql, restarted, processStartupMs });
    assert.equal(value.disposition, i % 10 === 9 ? "rejected" : "committed");
    if (i % 10 !== 9) revision++;
    assert.equal(value.outcomeSequence, String(i + 2));
    assert.equal(value.head.bookRevision, revision.toString());
    assert.ok(value.sql <= 7);
    if (i < 64) {
      const next = executeBookCommand(
        oracle.state,
        oracle.protocol,
        posting(`runtime-${i}`, expectedRevision),
      );
      assert.equal(
        value.original,
        new TextDecoder().decode(canonicalEncode(canonicalAccountingValue(next.result))),
      );
      oracle = { state: next.state, protocol: next.protocol };
    }
    if (i % 1000 === 0 || i % 1000 === 9)
      originals.set(i, {
        revision: expectedRevision.toString(),
        original: value.original,
        sequence: value.outcomeSequence,
      });
  }
  await runtime.dispose();
  runtime = new Miniflare(options);
  for (const [index, original] of originals) {
    const retry = await call(`/post?id=runtime-${index}&revision=${original.revision}`);
    assert.equal(retry.disposition, "replayed");
    assert.equal(retry.original, original.original);
    assert.equal(retry.outcomeSequence, original.sequence);
  }
  assert.equal((await call("/count")).count, count + 1);
} finally {
  await runtime.dispose();
}
function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    p50: sorted[Math.ceil(values.length * 0.5) - 1],
    p95: sorted[Math.ceil(values.length * 0.95) - 1],
    p99: sorted[Math.ceil(values.length * 0.99) - 1],
    max: sorted.at(-1),
  };
}
assert.equal(sha256(readFileSync(import.meta.path)), probeHash, "Probe changed during measurement");
console.log(
  JSON.stringify(
    {
      schema: "rastrata-native-runtime-probe-v1",
      recordedAt: new Date().toISOString(),
      directory,
      runtime: Bun.version,
      bundleSha256: sha256(script),
      probeSha256: probeHash,
      count,
      timing:
        "Local dispatchFetch through Workers routing, command construction, native SQL and storage.sync; no remote replication or Internet latency. Restarted request samples include first DO access after runtime.ready. Process startup is measured separately and also included in the combined summary.",
      cpu: "Not measured: parent process CPU would omit workerd child CPU",
      wallMs: summary(samples.map((s) => s.wallMs)),
      warm: summary(samples.filter((s) => !s.restarted).map((s) => s.wallMs)),
      restarted: summary(samples.filter((s) => s.restarted).map((s) => s.wallMs)),
      processStartup: summary(samples.filter((s) => s.restarted).map((s) => s.processStartupMs)),
      combinedStartupAndFirstRequest: summary(
        samples.filter((s) => s.restarted).map((s) => s.processStartupMs + s.wallMs),
      ),
      over50ms: samples.filter((s) => s.wallMs >= 50).length,
      maxSql: Math.max(...samples.map((s) => s.sql)),
      canonicalOracleFirst: 64,
      originalRetriesAfterReplacement: originals.size,
      samples,
    },
    null,
    2,
  ),
);
