import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { cpus, platform, arch } from "node:os";
import { join, resolve } from "node:path";
import {
  encodeDurableBook,
  decodeDurableBook,
  executeBookCommand,
  ExactRational,
  type DurableBookAggregate,
  type BookCommand,
} from "@rastrata/kernel";
import {
  COMPACT_LEDGER_FORMAT,
  LEDGER_FORMAT,
  ProductionLedger,
  SqliteBookStorage,
  type SqliteStorage,
  type LedgerFormat,
} from "../src/index.ts";
import { BOOK, activation, genesis, posting } from "../test/fixtures.ts";

const root = resolve(import.meta.dir, "../../..");
const milestones = new Set([
  0, 10, 25, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10_000,
]);
const maxSales = 10_000;
const maxElapsedMs = 180_000;
const maxRssBytes = 1024 * 1024 * 1024;

interface Observation {
  event: string;
  sales?: number;
  stop?: string;
  reason?: string;
  exactBalanceAndRoundTripVerified?: boolean;
}

export function assessCapacity(events: Observation[], exitCode: number) {
  const failure = events.find((event) => event.event === "limit_or_failure");
  const finished = events.filter((event) => event.event === "finished");
  const lastSample = events.filter((event) => event.event === "sample").at(-1);
  const targetReached =
    exitCode === 0 &&
    !failure &&
    finished.length === 1 &&
    finished[0]?.stop === "target_reached" &&
    finished[0].sales === maxSales &&
    lastSample?.sales === maxSales &&
    lastSample.exactBalanceAndRoundTripVerified === true;
  return {
    targetReached,
    targetSales: maxSales,
    lastVerifiedSnapshotSales: lastSample?.sales ?? null,
    reason:
      failure?.reason ??
      (exitCode !== 0
        ? "worker_failed_or_timed_out"
        : (finished[0]?.stop ?? "incomplete_measurement")),
  };
}

async function assessDirectory(directory: string) {
  assert.ok(resolve(directory).startsWith(join(root, "coverage/ledger-capacity/")));
  const metadata = await Bun.file(join(directory, "metadata.json")).json();
  const modes: unknown = metadata.modes ?? ["kernel", "ledger"];
  assert.ok(
    Array.isArray(modes) &&
      modes.length > 0 &&
      new Set(modes).size === modes.length &&
      modes.every((mode) => mode === "kernel" || mode === "ledger" || mode === "compact"),
    "invalid capacity modes",
  );
  const assessments: Record<string, ReturnType<typeof assessCapacity>> = {};
  for (const mode of modes) {
    const raw = await Bun.file(join(directory, `${mode}.jsonl`)).text();
    const events = raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Observation);
    const { exitCode } = (await Bun.file(join(directory, `${mode}.exit.json`)).json()) as {
      exitCode: number;
    };
    assessments[mode] = assessCapacity(events, exitCode);
  }
  const result = {
    targetReached: Object.values(assessments).every((item) => item.targetReached),
    assessments,
  };
  await Bun.write(join(directory, "assessment.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!result.targetReached) process.exitCode = 1;
}

export function latency(samples: number[]) {
  assert.ok(samples.length > 0 && samples.every((s) => Number.isFinite(s) && s >= 0));
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  return {
    samples: sorted.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: sorted.at(-1),
  };
}

export function assertSales(aggregate: DurableBookAggregate, sales: number) {
  assert.equal(aggregate.state.journals.length, sales);
  assert.equal(aggregate.state.bookRevision, BigInt(sales + 1));
  assert.equal(aggregate.protocol.retainedResults.length, sales + 1);
  let cash = ExactRational.zero();
  let income = ExactRational.zero();
  for (const booked of aggregate.state.journals) {
    assert.equal(booked.journal.postings.length, 2);
    for (const p of booked.journal.postings) {
      if (p.accountId === "cash") cash = cash.add(p.bookValue.amount.toRational());
      else if (p.accountId === "income") income = income.add(p.bookValue.amount.toRational());
      else assert.fail("Unexpected account");
    }
  }
  assert.ok(cash.equals(ExactRational.of(BigInt(sales) * 100n, 1n)));
  assert.ok(income.equals(cash.negate()));
}

export function openDatabase(path: string, format: LedgerFormat = LEDGER_FORMAT) {
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = FULL");
  const port: SqliteStorage = {
    sql: {
      exec(query, ...bindings) {
        const rows = db
          .query(query)
          .all(
            ...bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)),
          ) as Record<string, unknown>[];
        return rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              value instanceof Uint8Array
                ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
                : value,
            ]),
          ),
        );
      },
    },
    transactionSync: (operation) => db.transaction(operation)(),
    // Local SQLite FULL commit is synchronous. This is not a DO storage.sync timing model.
    async sync() {},
  };
  const storage = new SqliteBookStorage("capacity-local-object", port);
  const scope = {
    tenantId: "capacity-synthetic",
    bookId: BOOK,
    objectId: storage.objectId,
  };
  const ledger = new ProductionLedger(
    storage,
    format === COMPACT_LEDGER_FORMAT
      ? { ...scope, namespaceId: "capacity-local-namespace", generation: "0" }
      : scope,
    format,
  );
  return { db, ledger };
}

function emit(value: Record<string, unknown>) {
  console.log(JSON.stringify(value));
}

async function probe(mode: string, directory: string) {
  assert.ok(mode === "kernel" || mode === "ledger" || mode === "compact");
  const format = mode === "compact" ? COMPACT_LEDGER_FORMAT : LEDGER_FORMAT;
  const started = performance.now();
  const cpuStart = process.cpuUsage();
  let aggregate = genesis();
  let local = mode !== "kernel" ? openDatabase(join(directory, "book.sqlite"), format) : undefined;
  let sales = 0;
  let peakSampledRss = process.memoryUsage().rss;
  let timings: number[] = [];
  let lastCommand: BookCommand = activation();
  let lastReportedSales = -1;
  let lastProgress = performance.now();
  let stage = "activation";
  function resources() {
    const rssBytes = process.memoryUsage().rss;
    peakSampledRss = Math.max(peakSampledRss, rssBytes);
    const cpu = process.cpuUsage(cpuStart);
    return {
      elapsedMs: performance.now() - started,
      cpuMs: (cpu.user + cpu.system) / 1000,
      rssBytes,
      peakSampledRssBytes: peakSampledRss,
    };
  }
  async function sample() {
    const encodeStart = performance.now();
    const encoded = encodeDurableBook(aggregate);
    const encodeMs = performance.now() - encodeStart;
    const decodeStart = performance.now();
    const decoded = decodeDurableBook(encoded);
    const decodeMs = performance.now() - decodeStart;
    assert.equal(
      decoded.disposition,
      "decoded",
      decoded.disposition === "rejected" ? decoded.message : "",
    );
    if (decoded.disposition !== "decoded") throw new Error("decode failed");
    assertSales(decoded.aggregate, sales);
    assert.equal(encodeDurableBook(decoded.aggregate), encoded);
    let recoveryMs: number | null = null;
    let retryMs: number | null = null;
    let logicalPayloadBytes: number | null = null;
    let databaseBytes: number | null = null;
    if (local) {
      const payload = local.db
        .query("SELECT SUM(length(bytes)) AS bytes FROM ledger_chunks")
        .get() as { bytes: number };
      logicalPayloadBytes = payload.bytes;
      const pageCount = local.db.query("PRAGMA page_count").get() as { page_count: number };
      const pageSize = local.db.query("PRAGMA page_size").get() as { page_size: number };
      databaseBytes = pageCount.page_count * pageSize.page_size;
      local.db.close();
      const recoveryStart = performance.now();
      local = openDatabase(join(directory, "book.sqlite"), format);
      const recovered = await local.ledger.read();
      recoveryMs = performance.now() - recoveryStart;
      assert.equal(encodeDurableBook(recovered.aggregate), encoded);
      assert.equal(recovered.head.sequence, String(sales + 1));
      const retryStart = performance.now();
      const replay = await local.ledger.execute(lastCommand);
      retryMs = performance.now() - retryStart;
      assert.equal(replay.result.disposition, "replayed");
      assert.equal(replay.outcomeSequence, BigInt(sales + 1));
      assert.equal(replay.head.sequence, String(sales + 1));
    }
    emit({
      event: "sample",
      mode,
      sales,
      outcomes: sales + 1,
      ...resources(),
      windowLatency: timings.length ? latency(timings) : null,
      encodeMs,
      decodeMs,
      recoveryMs,
      retryMs,
      aggregateBytes: Buffer.byteLength(encoded),
      logicalPayloadBytes,
      databaseBytes,
      stateHash: aggregate.state.contentHash.digest,
      exactBalanceAndRoundTripVerified: true,
    });
    timings = [];
    lastReportedSales = sales;
  }
  try {
    if (local) {
      await local.ledger.provision(aggregate);
      assert.equal((await local.ledger.execute(lastCommand)).result.disposition, "committed");
    }
    let expected = executeBookCommand(aggregate.state, aggregate.protocol, lastCommand);
    assert.equal(expected.result.disposition, "committed");
    aggregate = { state: expected.state, protocol: expected.protocol };
    await sample();
    let stop = "target_reached";
    for (let index = 1; index <= maxSales; index++) {
      if (performance.now() - started >= maxElapsedMs) {
        stop = "probe_time_budget";
        break;
      }
      if (process.memoryUsage().rss >= maxRssBytes) {
        stop = "probe_memory_budget";
        break;
      }
      stage = "command";
      const command = posting(
        `sale-${String(index).padStart(6, "0")}`,
        aggregate.state.bookRevision,
      );
      const before = performance.now();
      if (local) {
        const receipt = await local.ledger.execute(command);
        assert.equal(receipt.result.disposition, "committed");
        assert.equal(receipt.outcomeSequence, BigInt(index + 1));
      } else {
        expected = executeBookCommand(aggregate.state, aggregate.protocol, command);
        assert.equal(expected.result.disposition, "committed");
      }
      timings.push(performance.now() - before);
      // The independent direct execution is outside the ledger latency timer.
      if (local) expected = executeBookCommand(aggregate.state, aggregate.protocol, command);
      assert.equal(expected.result.disposition, "committed");
      aggregate = { state: expected.state, protocol: expected.protocol };
      sales = index;
      lastCommand = command;
      resources();
      if (milestones.has(index)) {
        stage = "snapshot_sample";
        await sample();
      }
      if (performance.now() - lastProgress > 10_000) {
        emit({ event: "progress", mode, sales, ...resources() });
        lastProgress = performance.now();
      }
    }
    stage = "final_sample";
    if (lastReportedSales !== sales) await sample();
    emit({ event: "finished", mode, stop, sales, targetSales: maxSales, ...resources() });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // A capacity failure is recorded as a failure, not as success at the requested target.
    emit({
      event: "limit_or_failure",
      mode,
      stage,
      sales,
      attemptedSale: stage === "command" ? sales + 1 : null,
      reason,
      ...resources(),
    });
    if (local) {
      const recovered = await local.ledger.read();
      assert.equal(encodeDurableBook(recovered.aggregate), encodeDurableBook(aggregate));
      const retry = await local.ledger.execute(lastCommand);
      assert.equal(retry.result.disposition, "replayed");
      assert.equal(retry.outcomeSequence, BigInt(sales + 1));
      emit({
        event: "failure_safety_verified",
        mode,
        sales,
        unchangedHead: recovered.head.sequence,
        retainedRetry: true,
      });
    }
  } finally {
    local?.db.close();
  }
}

async function main(modes = ["kernel", "ledger"]) {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const directory = join(root, "coverage/ledger-capacity", stamp);
  mkdirSync(directory, { recursive: true });
  function files(path: string): string[] {
    return readdirSync(path).flatMap((name) => {
      const file = join(path, name);
      return statSync(file).isDirectory() ? files(file) : [file];
    });
  }
  const sources = [
    ...files(join(root, "packages/kernel/src")),
    ...files(join(root, "packages/ledger/src")),
    import.meta.path,
    join(root, "packages/ledger/test/fixtures.ts"),
    join(root, "bun.lock"),
  ];
  const identities = Object.fromEntries(
    sources
      .sort()
      .map((path) => [
        path.slice(root.length + 1),
        new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex"),
      ]),
  );
  const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root })
    .stdout.toString()
    .trim();
  const metadata = {
    modes,
    date: new Date().toISOString(),
    revision,
    dirtyWorkingTree:
      Bun.spawnSync(["git", "status", "--porcelain"], { cwd: root }).stdout.toString().trim()
        .length > 0,
    sourceIdentities: identities,
    runtime: `Bun ${Bun.version}`,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    workload:
      "Two-account, two-line, $100 synthetic cash sales in January 2026; no tax/inventory/close; minimum-complexity baseline, not an enterprise workload",
    limits: { maxSales, maxElapsedMs, maxRssBytes },
    caveats: [
      "Local SQLite timings are not Cloudflare durability or CPU timings",
      "Latency windows vary in sample count; percentiles are descriptive, not SLA evidence",
      "RSS includes the harness and direct oracle; sampled peak is not an exact peak",
      "Recovery reopens SQLite and reconstructs the ledger, but does not flush OS caches or crash a process",
      "Memory/time thresholds are cooperative between commands; the worker has a separate 240-second process timeout",
    ],
  };
  await Bun.write(join(directory, "metadata.json"), JSON.stringify(metadata, null, 2));
  console.log(`Capacity evidence: ${directory}`);
  for (const mode of modes) {
    const output = Bun.file(join(directory, `${mode}.jsonl`)).writer();
    const child = Bun.spawn([process.execPath, import.meta.path, "--worker", mode, directory], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 240_000,
    });
    const stderr = new Response(child.stderr).text();
    for await (const chunk of child.stdout) {
      output.write(chunk);
      process.stdout.write(chunk);
    }
    await output.end();
    const exitCode = await child.exited;
    await Bun.write(join(directory, `${mode}.stderr.txt`), await stderr);
    await Bun.write(join(directory, `${mode}.exit.json`), JSON.stringify({ exitCode }));
    if (exitCode !== 0)
      console.log(`${mode}: worker exited ${exitCode}; incomplete measurements are not a pass`);
  }
  await assessDirectory(directory);
}

if (import.meta.main) {
  if (process.argv[2] === "--worker") await probe(process.argv[3] ?? "", process.argv[4] ?? "");
  else if (process.argv[2] === "--assess") await assessDirectory(process.argv[3] ?? "");
  else if (process.argv[2] === "--compact") await main(["compact"]);
  else await main();
}
