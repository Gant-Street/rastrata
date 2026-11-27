/** Local resource/workflow campaign. WAL/FULL is real local durability, NOT
 * Cloudflare replication. No credentials, remote deployment or customer data. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { heapStats } from "bun:jsc";
import {
  encodeBookCommand,
  resolveJournal,
  postingId,
  sealCommand,
  type BookCommand,
  type DurableBookAggregate,
} from "@rastrata/kernel";
import { NativeLedger } from "../src/native-ledger.ts";
import { AuthorizedNativeLedger } from "../src/authorized-native-ledger.ts";
import { NativeLedgerHttp } from "../src/native-ledger-http.ts";
import { SqliteLedgerRepository } from "../src/sqlite-ledger-repository.ts";
import { evaluateOutcomePayload } from "../src/outcome-payload.ts";
import type { SqliteStorage } from "../src/sqlite.ts";
import {
  genesis,
  chartGenesis,
  activation,
  posting,
  openItemRecognition,
  settlementPayment,
  closing,
  reopening,
} from "../test/fixtures.ts";
import {
  allocationAndTaxWorkflow,
  currencyRecoveryWorkflow,
} from "../test/accounting-workflows.ts";
import { consolidationWorkflow } from "../test/commercial-workflow.ts";
import { nativeInventoryWorkflow } from "../test/native-inventory-workflow.ts";
import { authorizationFixture } from "../test/authorization-fixtures.ts";

export function distribution(values: readonly number[]) {
  assert.ok(values.length > 0 && values.every((n) => Number.isFinite(n) && n >= 0));
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    p99: sorted[Math.floor(sorted.length * 0.99)],
    max: sorted.at(-1),
  };
}
function memory() {
  const usage = process.memoryUsage(),
    heap = heapStats();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    external: usage.external,
    heapSize: heap.heapSize,
    objectCount: heap.objectCount,
  };
}
export function widePosting(id: string, revision: bigint, lines: number): BookCommand {
  assert.ok(Number.isSafeInteger(lines) && lines >= 2 && lines % 2 === 0);
  const seed = posting(id, revision),
    initial = genesis().state;
  assert.equal(seed.type, "postJournal");
  if (seed.type !== "postJournal") throw new Error("Expected journal");
  const journal = {
    ...seed.resolved.journal,
    postings: Array.from({ length: lines }, (_, i) => {
      const row = seed.resolved.journal.postings[i % 2];
      assert.ok(row);
      return { ...row, id: postingId(`${id}-${i}`), ordinal: BigInt(i) };
    }),
  };
  const quantization = initial.quantizationPolicies[0];
  assert.ok(quantization);
  const resolved = resolveJournal(
    journal,
    initial.policies,
    initial.identity.ownerId,
    quantization,
    journal.postings.map((p) => p.bookValue.amount.toRational()),
  );
  assert.ok("journal" in resolved);
  return sealCommand({ ...seed, resolved });
}

async function campaign() {
  const quick = process.argv.includes("--quick");
  const selectedCase = process.argv.find((argument) => argument.startsWith("--case="))?.slice(7);
  const selected = (name: string) => selectedCase === undefined || selectedCase === name;
  const populationAccounts = Number(
    process.argv.find((argument) => argument.startsWith("--book-accounts="))?.slice(16) ?? "2",
  );
  assert.ok(
    Number.isSafeInteger(populationAccounts) &&
      populationAccounts >= 2 &&
      populationAccounts <= 1000,
  );
  const directory = mkdtempSync(join(tmpdir(), "rastrata-local-profile-"));
  const auth = await authorizationFixture();
  const token = await auth.token();
  const sourcePaths = [
    ...new Bun.Glob("**/*.ts").scanSync({ cwd: join(import.meta.dir, "../src") }),
  ]
    .map((p) => join(import.meta.dir, "../src", p))
    .concat(
      [...new Bun.Glob("**/*.ts").scanSync({ cwd: join(import.meta.dir, "../../kernel/src") })].map(
        (p) => join(import.meta.dir, "../../kernel/src", p),
      ),
      [...new Bun.Glob("**/*.{ts,json}").scanSync({ cwd: join(import.meta.dir, "../test") })].map(
        (p) => join(import.meta.dir, "../test", p),
      ),
      import.meta.path,
    )
    .sort();
  const fingerprint = () =>
    createHash("sha256")
      .update(
        JSON.stringify(
          sourcePaths.map((p) => [
            p.replace(join(import.meta.dir, "../../.."), ""),
            createHash("sha256").update(readFileSync(p)).digest("hex"),
          ]),
        ),
      )
      .digest("hex");
  const sourceHash = fingerprint();
  let serial = 0,
    sql = 0,
    commitMs = 0;
  const opened = new Set<Database>();
  function owner(initial = genesis() as DurableBookAggregate, scope = auth.scope) {
    const path = join(directory, `book-${serial++}.sqlite`),
      db = new Database(path);
    opened.add(db);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
    const storage: SqliteStorage = {
      sql: {
        exec(query, ...bindings) {
          sql++;
          const statement = db.query(query);
          const values = bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
          return (
            query.startsWith("SELECT") ? statement.iterate(...values) : statement.all(...values)
          ) as Iterable<Record<string, unknown>>;
        },
      },
      transactionSync(work) {
        let end = 0;
        const result = db
          .transaction(() => {
            const value = work();
            end = performance.now();
            return value;
          })
          .immediate();
        commitMs += performance.now() - end;
        return result;
      },
      async sync() {},
    };
    const repository = new SqliteLedgerRepository(storage, scope, scope.objectId, () => ({
      fence: "0",
      pending: false,
    }));
    const ledger = new NativeLedger(repository);
    const authorized = new AuthorizedNativeLedger(
      storage,
      scope,
      scope.objectId,
      () => ({ fence: "0", pending: false }),
      auth.authorizer,
    );
    return {
      db,
      path,
      initial,
      ledger,
      authorized,
      repository,
      close() {
        assert.deepEqual(db.query("PRAGMA integrity_check").get(), { integrity_check: "ok" });
        db.close();
        opened.delete(db);
      },
    };
  }
  type Sample = { kind: string; wallMs: number; cpuMs: number; sql: number; commitMs: number };
  const results: unknown[] = [];
  const sample = async <T>(samples: Sample[], kind: string, work: () => Promise<T>) => {
    const beforeSql = sql,
      beforeCommit = commitMs,
      cpu = process.cpuUsage(),
      start = performance.now();
    const result = await work(),
      wallMs = performance.now() - start,
      used = process.cpuUsage(cpu);
    samples.push({
      kind,
      wallMs,
      cpuMs: (used.user + used.system) / 1000,
      sql: sql - beforeSql,
      commitMs: commitMs - beforeCommit,
    });
    return result;
  };
  function record(name: string, samples: Sample[], extra: Record<string, unknown> = {}) {
    const byKind = Object.fromEntries(
      [...new Set(samples.map((s) => s.kind))].map((kind) => {
        const rows = samples.filter((s) => s.kind === kind);
        return [
          kind,
          {
            wallMs: distribution(rows.map((s) => s.wallMs)),
            cpuMs: distribution(rows.map((s) => s.cpuMs)),
            sql: distribution(rows.map((s) => s.sql)),
            commitMs: distribution(rows.map((s) => s.commitMs)),
          },
        ];
      }),
    );
    results.push({ name, byKind, ...extra, samples });
    console.error(`Profiled ${name}: ${samples.length} samples`);
  }
  try {
    for (const lines of [2, 20, 100]) {
      if (!selected(`journal-${lines}-lines`)) continue;
      const f = owner(),
        samples: Sample[] = [],
        n = quick ? 12 : lines === 2 ? 2000 : lines === 20 ? 300 : 100;
      await f.ledger.provision(f.initial, activation());
      const memories: unknown[] = [];
      for (let i = 0; i < n; i++) {
        const command =
          lines === 2
            ? posting(`post-${i}`, BigInt(i + 1))
            : widePosting(`post-${i}`, BigInt(i + 1), lines);
        const result = await sample(samples, i < 8 ? "warmup" : "commit", () =>
          f.ledger.execute(command),
        );
        assert.equal(result.value.result.disposition, "committed");
        if (i % Math.max(1, Math.floor(n / 4)) === 0 || i === n - 1) {
          Bun.gc(true);
          memories.push({ outcomes: i + 2, ...memory() });
        }
      }
      const close = await sample(samples, "close", () =>
        f.ledger.execute(closing("close", BigInt(n + 1))),
      );
      assert.equal(close.value.result.disposition, "committed");
      const reopen = await sample(samples, "reopen", () =>
        f.ledger.execute(reopening("reopen", BigInt(n + 2))),
      );
      assert.equal(reopen.value.result.disposition, "committed");
      record(`journal-${lines}-lines`, samples, {
        memoryAfterFullGc: memories,
        databaseBytes: statSync(f.path).size,
      });
      f.close();
    }
    for (const mode of ["http", "retry", "rejection"] as const) {
      if (!selected(mode)) continue;
      const f = owner(),
        samples: Sample[] = [],
        n = quick ? 12 : 500;
      await f.authorized.provision(token, f.initial, activation());
      const http = new NativeLedgerHttp(f.authorized);
      const original = posting("original");
      await f.authorized.execute(token, original);
      for (let i = 0; i < n; i++) {
        const command =
          mode === "retry"
            ? original
            : posting(`post-${i}`, mode === "rejection" ? 0n : BigInt(i + 2));
        if (mode === "http") {
          const request = new Request("http://local.test/commands", {
            method: "POST",
            headers: { authorization: token, "content-type": "application/json" },
            body: encodeBookCommand(command),
          });
          const body = await sample(samples, i < 8 ? "warmup" : mode, async () => {
            const response = await http.fetch(request);
            assert.equal(response.status, 200);
            return (await response.json()) as { result: { disposition: string } };
          });
          assert.equal(body.result.disposition, "committed");
        } else {
          const result = await sample(samples, i < 8 ? "warmup" : mode, () =>
            f.authorized.execute(token, command),
          );
          assert.equal(result.value.result.disposition, mode === "retry" ? "replayed" : "rejected");
        }
      }
      record(mode, samples);
      f.close();
    }
    // Retained history and live configuration are independent dimensions. A
    // large chart can be expensive even when an ordinary save reads few rows.
    for (const accounts of [200, 1000]) {
      if (!selected(`chart-${accounts}`)) continue;
      const initial = chartGenesis(accounts);
      const f = owner(initial),
        samples: Sample[] = [];
      await f.ledger.provision(initial, activation());
      for (let i = 0; i < (quick ? 12 : 100); i++) {
        const command = posting(`chart-${i}`, BigInt(i + 1));
        const result = await sample(samples, i < 8 ? "warmup" : "commit", () =>
          f.ledger.execute(command),
        );
        assert.equal(result.value.result.disposition, "committed");
      }
      record(`chart-${accounts}`, samples, { accounts });
      f.close();
    }
    const sale = openItemRecognition("invoice", 1n);
    const workflows = [
      {
        name: "settlement",
        initial: genesis(),
        commands: [
          activation(),
          sale,
          settlementPayment("paid", 2n, [{ openItemId: sale.request.value.id, amount: 100n }]),
        ],
      },
      { name: "allocation-tax", ...allocationAndTaxWorkflow("1.1.0") },
      { name: "currency", ...currencyRecoveryWorkflow() },
      { name: "consolidation", ...consolidationWorkflow() },
      { name: "inventory", ...(await nativeInventoryWorkflow()) },
    ];
    for (const workflow of workflows) {
      if (!selected(workflow.name)) continue;
      let oracle: DurableBookAggregate = workflow.initial;
      const expected = workflow.commands.map((command, index) => {
        const evaluated = evaluateOutcomePayload(oracle, command);
        oracle = { state: evaluated.transition.state, protocol: evaluated.transition.protocol };
        assert.equal(
          evaluated.transition.result.disposition,
          workflow.name === "currency" && (index === 5 || index === 7) ? "rejected" : "committed",
        );
        return evaluated.transition.result;
      });
      const samples: Sample[] = [];
      for (let cycle = 0; cycle < (quick ? 1 : 20); cycle++) {
        const f = owner(workflow.initial);
        for (const [i, command] of workflow.commands.entries()) {
          const result =
            command.type === "activateBook"
              ? await f.ledger.provision(f.initial, command)
              : (
                  await sample(samples, `${command.type}:${expected[i]?.disposition}`, () =>
                    f.ledger.execute(command),
                  )
                ).value;
          assert.deepEqual(result.result, expected[i]);
        }
        f.close();
      }
      record(workflow.name, samples, {
        oracle:
          "Every measured result matches the full canonical evaluator; activation excluded from timed samples.",
      });
    }
    if (selected("paced-books-100")) {
      const books = 100,
        rate = 100,
        rounds = quick ? 2 : 30;
      const initial = chartGenesis(populationAccounts);
      const owners = Array.from({ length: books }, (_, i) =>
        owner(initial, {
          ...auth.scope,
          tenantId: `paced-tenant-${i}`,
          objectId: `paced-object-${i}`,
        }),
      );
      for (const f of owners) await f.ledger.provision(initial, activation());
      const activated = evaluateOutcomePayload(initial, activation());
      let oracle: DurableBookAggregate = {
        state: activated.transition.state,
        protocol: activated.transition.protocol,
      };
      const expected = Array.from({ length: rounds }, (_, i) => {
        const command = posting(`paced-${i}`, BigInt(i + 1));
        const evaluated = evaluateOutcomePayload(oracle, command);
        oracle = { state: evaluated.transition.state, protocol: evaluated.transition.protocol };
        assert.equal(evaluated.transition.result.disposition, "committed");
        return { command, result: evaluated.transition.result };
      });
      const observations: {
        index: number;
        latenessMs: number;
        serviceMs: number;
        scheduledResponseMs: number;
        sql: number;
      }[] = [];
      const received: Awaited<ReturnType<NativeLedger["execute"]>>[] = [];
      Bun.gc(true);
      const before = memory(),
        cpuStart = process.cpuUsage(),
        started = performance.now();
      for (let index = 0; index < rounds * books; index++) {
        const due = started + (index * 1000) / rate;
        while (performance.now() < due)
          await Bun.sleep(Math.max(1, Math.ceil(due - performance.now())));
        const f = owners[index % books],
          entry = expected[Math.floor(index / books)];
        assert.ok(f && entry);
        const began = performance.now(),
          beforeSql = sql;
        received.push(await f.ledger.execute(entry.command));
        const completed = performance.now();
        observations.push({
          index,
          latenessMs: began - due,
          serviceMs: completed - began,
          scheduledResponseMs: completed - due,
          sql: sql - beforeSql,
        });
      }
      const elapsedMs = performance.now() - started,
        cpu = process.cpuUsage(cpuStart);
      const cpuMs = (cpu.user + cpu.system) / 1000;
      // Oracle checks happen after the timed workload, not inside save CPU samples.
      for (const [index, value] of received.entries())
        assert.deepEqual(value.value.result, expected[Math.floor(index / books)]?.result);
      Bun.gc(true);
      const after = memory();
      const scheduled = distribution(observations.map((s) => s.scheduledResponseMs));
      results.push({
        name: "paced-books-100",
        books,
        accountsPerBook: populationAccounts,
        offeredPerSecond: rate,
        completed: received.length,
        elapsedMs,
        cpuMs,
        cpuCoreEquivalent: cpuMs / elapsedMs,
        serviceMs: distribution(observations.map((s) => s.serviceMs)),
        scheduledResponseMs: scheduled,
        producerLatenessMs: distribution(observations.map((s) => s.latenessMs)),
        sql: distribution(observations.map((s) => s.sql)),
        localTargets: {
          lessThanOneCpuCore: cpuMs < elapsedMs,
          scheduledP95Below50Ms: scheduled.p95 !== undefined && scheduled.p95 < 50,
        },
        memoryAfterFullGc: { before, after },
        observations,
        oracle:
          "Every result matches full canonical evaluation; each independent database passes SQLite integrity_check.",
        note: "Paced round-robin native calls in one process, one outstanding call. Delayed arrivals remain in scheduledResponseMs; no warmup or slow sample is discarded. Distinct tenant/object identities; same financial fixture. Not HTTP, R2, concurrent-client queue, long-term capacity or cloud billing certification.",
      });
      for (const f of owners) f.close();
      console.error(`Profiled paced-books-100: ${received.length} fresh saves`);
    }
    for (const books of [1, 16, 64]) {
      if (!selected(`books-${books}`)) continue;
      const populationInitial = chartGenesis(populationAccounts);
      const owners = Array.from({ length: books }, () => owner(populationInitial));
      for (const f of owners) await f.ledger.provision(f.initial, activation());
      const samples: Sample[] = [];
      Bun.gc(true);
      const before = memory();
      for (let round = 0; round < (quick ? 2 : 20); round++) {
        const commands = owners.map(() => posting(`parallel-${round}`, BigInt(round + 1)));
        const rows = await sample(samples, "batch", () =>
          Promise.all(
            owners.map((f, i) => {
              const command = commands[i];
              assert.ok(command);
              return f.ledger.execute(command);
            }),
          ),
        );
        assert.ok(rows.every((r) => r.value.result.disposition === "committed"));
      }
      Bun.gc(true);
      const after = memory();
      record(`books-${books}`, samples, {
        operationsPerBatch: books,
        accountsPerBook: populationAccounts,
        memoryAfterFullGc: { before, after },
        note: "One Bun process/event loop, separate databases. CPU is aggregate per batch, NOT per overlapping request.",
      });
      for (const f of owners) f.close();
    }
    for (const offered of [16, 32]) {
      if (!selected(`same-book-${offered}`)) continue;
      const f = owner();
      await f.ledger.provision(f.initial, activation());
      const samples: Sample[] = [];
      const commands = Array.from({ length: offered }, (_, i) =>
        posting(`contended-${i}`, BigInt(i + 1)),
      );
      const rows = await sample(samples, "batch", () =>
        Promise.allSettled(commands.map((command) => f.ledger.execute(command))),
      );
      const committed = rows.filter((r) => r.status === "fulfilled");
      for (const row of committed)
        if (row.status === "fulfilled")
          assert.equal(row.value.value.result.disposition, "committed");
      for (const row of rows)
        if (row.status === "rejected") assert.equal(row.reason.code, "native_ledger_overloaded");
      assert.equal(committed.length, Math.min(offered, 16));
      record(`same-book-${offered}`, samples, {
        offered,
        committed: committed.length,
        overloaded: offered - committed.length,
      });
      f.close();
    }
    assert.ok(results.length > 0, `Unknown profiling case: ${selectedCase}`);
    assert.equal(fingerprint(), sourceHash, "Sources changed during measurement");
    console.log(
      JSON.stringify(
        {
          schema: "rastrata-local-resource-profile-v1",
          recordedAt: new Date().toISOString(),
          sourceHash,
          runtime: Bun.version,
          cpu: cpus()[0]?.model,
          directory,
          quick,
          selectedCase: selectedCase ?? null,
          scope:
            "Local SQLite WAL/FULL; no remote durability, cloud billing, fleet capacity, R2 delivery or OKE prediction. Instrumentation and profilers add overhead.",
          timing:
            "Fixture preparation, provisioning, GC snapshots, canonical oracle and integrity checks excluded from measured operations; SQL commitMs is transaction tail after callback returns. CPU is process-wide user+system. Raw samples retained; first eight ordinary operations reported separately, business workflows include cold owners.",
          memory:
            "RSS includes SQLite/runtime allocators and the campaign retains earlier result samples; GC snapshots measure retained managed heap, not per-book memory, allocation rate or a leak proof. No database page-cache tuning.",
          results,
        },
        null,
        2,
      ),
    );
  } finally {
    for (const db of opened) db.close();
  }
}
if (import.meta.main) await campaign();
