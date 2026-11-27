import assert from "node:assert/strict";
import { cpus } from "node:os";
import { hashCanonical } from "@rastrata/kernel";
import {
  auditLogicalMap,
  emptyLogicalMap,
  logicalMapHash,
  prepareLogicalChange,
} from "../src/logical-map.ts";
import { rebuildLogicalMap } from "../test/logical-map-oracle.ts";

const domain = hashCanonical({
  financialIdentity: "logical-probe",
  profile: "candidate",
  collection: "rows",
  keySchema: "sha256",
}).digest;
const nodes = new Map<string, string>();
const values = new Map<string, string>();
const read = async (digest: string) => nodes.get(digest);
let root = emptyLogicalMap(domain);
let rootHash = logicalMapHash(root, domain);
let historyNodeBytes = 0;
let samples: number[] = [];
let maxReads = 0;
let maxCreated = 0;
const milestones = new Set([100, 1000, 10000]);
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const value = sorted[Math.floor(sorted.length / 2)];
  assert.ok(value !== undefined);
  return value;
}
const sourceHashes: Record<string, string> = {};
for (const path of [
  import.meta.path,
  new URL("../src/logical-map.ts", import.meta.url).pathname,
  new URL("../test/logical-map-oracle.ts", import.meta.url).pathname,
])
  sourceHashes[path] = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(path).arrayBuffer())
    .digest("hex");
console.log(
  JSON.stringify({
    event: "metadata",
    runtime: Bun.version,
    cpu: cpus()[0]?.model,
    sourceHashes,
    scope:
      "In-memory logical-map candidate only; no SQLite/R2 I/O, accounting execution, production capacity or SLO claim",
  }),
);
for (let i = 0; i < 10000; i++) {
  const key = hashCanonical({ key: BigInt(i) }).digest;
  const value = hashCanonical({ value: BigInt(i) }).digest;
  const start = performance.now();
  const result = await prepareLogicalChange(root, rootHash, domain, key, null, value, read);
  samples.push(performance.now() - start);
  maxReads = Math.max(maxReads, result.metrics.nodesRead);
  maxCreated = Math.max(maxCreated, result.metrics.nodesCreated);
  for (const node of result.nodes) {
    if (!nodes.has(node.digest)) historyNodeBytes += node.encoded.length;
    nodes.set(node.digest, node.encoded);
  }
  root = result.encodedRoot;
  rootHash = result.rootHash;
  values.set(key, value);
  if (!milestones.has(i + 1)) continue;
  const rebuildMs: number[] = [];
  let liveBytes = 0;
  for (let repeat = 0; repeat < 3; repeat++) {
    const start = performance.now();
    const oracle = rebuildLogicalMap(domain, values);
    rebuildMs.push(performance.now() - start);
    assert.equal(root, oracle.encodedRoot);
    assert.equal(rootHash, oracle.rootHash);
    assert.equal(oracle.nodes.size, 2 * values.size - 1);
    liveBytes = [...oracle.nodes.values()].reduce((n, body) => n + body.length, 0);
  }
  const observed = new Map<string, string>();
  const audit = await auditLogicalMap(root, rootHash, domain, read, (k, v) => {
    observed.set(k, v);
  });
  assert.deepEqual(observed, values);
  assert.equal(audit.population, BigInt(values.size));
  console.log(
    JSON.stringify({
      event: "sample",
      rows: values.size,
      appendSamples: samples.length,
      appendMedianMs: median(samples),
      maxNodesRead: maxReads,
      maxNodesCreated: maxCreated,
      fullRebuildMedianMs: median(rebuildMs),
      liveLogicalNodes: 2 * values.size - 1,
      liveLogicalBytes: liveBytes,
      allHistoricalLogicalNodes: nodes.size,
      allHistoricalLogicalBytes: historyNodeBytes,
      fullAuditNodesRead: audit.metrics.nodesRead,
      rssBytes: process.memoryUsage().rss,
      rootHash,
      independentRebuildAndCompletePopulationVerified: true,
    }),
  );
  samples = [];
  maxReads = 0;
  maxCreated = 0;
}
