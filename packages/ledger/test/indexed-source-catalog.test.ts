import { expect, test } from "bun:test";
import {
  encodeDurableBook,
  commandId,
  closePackageId,
  localDate,
  instant,
  sealCommand,
  hashCanonical,
  type BookCommand,
} from "@rastrata/kernel";
import type { IndexedOutcomeInput } from "../src/indexed-book-change.ts";
import { evaluateOutcomePayload } from "../src/outcome-payload.ts";
import { projectLegacyIndexedBook } from "../src/indexed-book-state.ts";
import { prepareIndexedOutcomeRecord } from "../src/indexed-outcome-record.ts";
import { SqliteIndexedSourceCatalog } from "../src/indexed-source-catalog.ts";
import { atomicSqlite, type SqliteTransaction } from "../src/sqlite-transaction.ts";
import { activation, genesis, posting } from "./fixtures.ts";
import {
  allocationAndTaxWorkflow,
  lotIdentityWorkflow,
  admissionFxWorkflow,
} from "./accounting-workflows.ts";
import { commercialWorkflow } from "./commercial-workflow.ts";
import { createIndexedOwnerFixture as fixture } from "./indexed-owner-fixture.ts";

function admitted(
  f: Awaited<ReturnType<typeof fixture>>,
  command: BookCommand,
): IndexedOutcomeInput {
  const result = evaluateOutcomePayload(f.aggregate, command);
  if (result.encoded === null) throw new Error("Expected new admitted outcome");
  const retained = result.transition.protocol.retainedResults.at(-1);
  if (!retained) throw new Error("Missing retained result");
  return result.transition.intent === undefined
    ? { kind: "rejection", retained }
    : {
        kind: "commit",
        intent: result.transition.intent,
        previousRevision: f.aggregate.state.revisions.at(-1) ?? null,
      };
}

test("indexed catalog publishes exact row sources for real commercial, inventory, allocation and FX commands", async () => {
  const fx = admissionFxWorkflow(false);
  for (const scenario of [
    commercialWorkflow(),
    lotIdentityWorkflow(),
    allocationAndTaxWorkflow("1.1.0"),
    { initial: fx.initial, commands: [...fx.commands, fx.reverse(fx.firstMeasurement, 5n)] },
  ]) {
    const f = await fixture(scenario.initial);
    try {
      await f.verifyRows();
      for (const command of scenario.commands) {
        const plan = await f.prepare(command);
        const prepared = await f.catalog.prepareAdmittedOutcome(
          admitted(f, command),
          f.digest,
          f.ports.confirm,
        );
        expect(JSON.stringify(prepared.record)).toBe(plan.encoded);
        expect(prepared.prepared.digest).toBe(plan.prepared.digest);
        expect(f.catalog.describePrepared(prepared.prepared)).toEqual(
          f.catalog.describePrepared(plan.prepared),
        );
        // Publish the conditional producer's handle, not the full-projection oracle.
        f.select({ ...plan, prepared: prepared.prepared });
        expect(plan.afterAggregate.protocol.retainedResults.at(-1)?.outcome).toBe("committed");
        await f.verifyRows();
      }
      const before = f.dump();
      f.restart();
      await f.verifyRows();
      expect(f.dump()).toEqual(before);
      expect(f.faults.syncs).toBe(0); // This component cannot confer durable acknowledgement.
    } finally {
      f.close();
    }
  }
});

test("conditional publication preserves rejected outcomes and snapshots the complete decision before callbacks", async () => {
  const f = await fixture();
  try {
    for (const command of [
      posting("delta-before-activation", 0n),
      activation(),
      posting("delta-stale", 99n),
    ]) {
      const reference = await f.prepare(command);
      const before = f.dump();
      const result = await f.catalog.prepareAdmittedOutcome(
        admitted(f, command),
        f.digest,
        f.ports.confirm,
      );
      expect(JSON.stringify(result.record)).toBe(reference.encoded);
      expect(result.prepared.digest).toBe(reference.prepared.digest);
      expect(f.dump()).toEqual(before);
      f.select({ ...reference, prepared: result.prepared });
    }
    const command = posting("delta-snapshot", 1n),
      reference = await f.prepare(command),
      input = admitted(f, command);
    if (input.kind !== "commit" || input.previousRevision === null)
      throw new Error("Expected committed predecessor");
    const supplied = {
      ...input,
      intent: { ...input.intent, command: { ...input.intent.command } },
      previousRevision: {
        ...input.previousRevision,
        chainHash: { ...input.previousRevision.chainHash },
      },
    };
    const before = f.dump();
    const pending = f.catalog.prepareAdmittedOutcome(supplied, f.digest, f.ports.confirm);
    supplied.intent.command.id = commandId("mutated-after-await");
    supplied.previousRevision.chainHash.digest = "0".repeat(64);
    const result = await pending;
    expect(JSON.stringify(result.record)).toBe(reference.encoded);
    expect(result.prepared.digest).toBe(reference.prepared.digest);
    expect(f.dump()).toEqual(before);
    f.select({ ...reference, prepared: result.prepared });
    await f.verifyRows();
  } finally {
    f.close();
  }
});

test("conditional publication refuses missing nodes, stale catalogs and authority loss without exposing or writing an outcome", async () => {
  const f = await fixture();
  try {
    await f.publish(activation());
    await f.publish(posting("delta-source"));
    const input = admitted(f, posting("delta-next", 2n));
    const before = f.dump();
    await expect(
      f.catalog.prepareAdmittedOutcome(input, "0".repeat(64), f.ports.confirm),
    ).rejects.toThrow("indexed_source_conflict");
    await expect(
      f.catalog.prepareAdmittedOutcome(input, f.digest, async () => {
        throw new Error("lost authority");
      }),
    ).rejects.toThrow("lost authority");
    let count = 0;
    const baseline = await f.catalog.prepareAdmittedOutcome(input, f.digest, async () => {
      count++;
    });
    expect(baseline.metrics.sourceReads).toBeGreaterThan(0);
    expect(count).toBeGreaterThan(1);
    let calls = 0;
    await expect(
      f.catalog.prepareAdmittedOutcome(input, f.digest, async () => {
        if (++calls === count) throw new Error("lost final authority");
      }),
    ).rejects.toThrow("lost final authority");
    const exec = f.storage.sql.exec.bind(f.storage.sql);
    let missing = 0;
    f.storage.sql.exec = (sql, ...bindings) => {
      if (sql.includes("FROM ledger_indexed_source_nodes") && missing++ === 0) return [];
      return exec(sql, ...bindings);
    };
    await expect(
      f.catalog.prepareAdmittedOutcome(input, f.digest, f.ports.confirm),
    ).rejects.toThrow();
    expect(missing).toBeGreaterThan(0);
    f.storage.sql.exec = exec;
    expect(f.dump()).toEqual(before);
    let raced = false;
    await expect(
      f.catalog.prepareAdmittedOutcome(input, f.digest, async () => {
        if (!raced) {
          raced = true;
          await f.publish(posting("racing-delta", 99n));
        }
      }),
    ).rejects.toThrow("indexed_source_conflict");
    expect(f.aggregate.state.bookRevision).toBe(2n);
    expect(f.aggregate.protocol.retainedResults.map((r) => r.commandId)).toEqual([
      activation().id,
      commandId("delta-source"),
      commandId("racing-delta"),
    ]);
    await f.verifyRows();
  } finally {
    f.close();
  }
});

test("conditional publication detects body substitution even with the original digest or head commitment", async () => {
  for (const kind of ["catalog", "anchor"] as const) {
    const f = await fixture();
    try {
      await f.publish(activation());
      const input = admitted(f, posting(`substitution-${kind}`));
      const table = kind === "catalog" ? "ledger_indexed_source_catalog" : "test_canonical";
      const { body } = f.db.query(`SELECT body FROM ${table}`).get() as { body: string };
      const changed =
        kind === "catalog" ? `${body} ` : JSON.stringify({ ...JSON.parse(body), unexpected: true });
      let confirmations = 0;
      try {
        await expect(
          f.catalog.prepareAdmittedOutcome(input, f.digest, async () => {
            confirmations++;
            // Restoration at a later check cannot excuse observing invalid evidence
            // now. Neither the catalog digest nor the full-head hash field changes.
            if (confirmations <= 2)
              f.db.query(`UPDATE ${table} SET body = ?`).run(confirmations === 1 ? changed : body);
          }),
        ).rejects.toThrow(
          kind === "catalog" ? "indexed_source_conflict" : "indexed_source_head_mismatch",
        );
        expect(confirmations).toBe(1);
      } finally {
        f.db.query(`UPDATE ${table} SET body = ?`).run(body);
      }
      expect(f.aggregate.protocol.retainedResults).toHaveLength(1);
      await f.verifyRows();
    } finally {
      f.close();
    }
  }
});

test("conditional publication changes three rows instead of rebuilding retained book populations", async () => {
  const f = await fixture();
  const samples: object[] = [];
  try {
    await f.publish(activation());
    for (let count = 1; count <= 64; count++) {
      await f.publish(posting(`delta-growth-${count}`, BigInt(count)));
      // Include both sides of binary boundaries; measuring only powers of two
      // understates the varying right-edge path cost of the logical map.
      if (![8, 16, 31, 32, 63, 64].includes(count)) continue;
      const command = posting(`delta-growth-probe-${count}`, BigInt(count + 1));
      const evaluated = evaluateOutcomePayload(f.aggregate, command);
      if (!evaluated.transition.intent || !evaluated.encoded)
        throw new Error("Expected admitted posting");
      const encodedOutcome = evaluated.encoded;
      const input: IndexedOutcomeInput = {
        kind: "commit",
        intent: evaluated.transition.intent,
        previousRevision: f.aggregate.state.revisions.at(-1) ?? null,
      };
      const before = f.readAnchor(),
        snapshot = f.dump(),
        oldTimes: number[] = [],
        newTimes: number[] = [];
      let sample: object | undefined;
      // Same already-admitted decision and store for both producers. Timing is
      // descriptive only; admission, recovery, publication and sync are excluded.
      for (let trial = 0; trial < 3; trial++) {
        const legacy = async () => {
          const start = performance.now();
          const encodedBook = encodeDurableBook({
            state: evaluated.transition.state,
            protocol: evaluated.transition.protocol,
          });
          const projection = await projectLegacyIndexedBook(encodedBook);
          const record = prepareIndexedOutcomeRecord(
            f.scope,
            f.scope.objectId,
            before.state,
            before.head,
            projection.state,
            encodedOutcome,
          );
          const prepared = await f.catalog.prepareOutcome(
            JSON.stringify(record),
            f.digest,
            input.previousRevision,
          );
          oldTimes.push(performance.now() - start);
          return { record, prepared, bookBytes: new TextEncoder().encode(encodedBook).length };
        };
        const incremental = async () => {
          const start = performance.now();
          const result = await f.catalog.prepareAdmittedOutcome(input, f.digest, f.ports.confirm);
          newTimes.push(performance.now() - start);
          return result;
        };
        const [old, next] =
          trial % 2 === 0
            ? [await legacy(), await incremental()]
            : await (async () => {
                const next = await incremental();
                return [await legacy(), next] as const;
              })();
        expect(next.record).toEqual(old.record);
        expect(next.prepared.digest).toBe(old.prepared.digest);
        expect(next.metrics.changedRows).toBe(3);
        expect(next.metrics.sourceReads).toBeLessThanOrEqual(192);
        const after = JSON.parse(next.record.state);
        for (const prior of before.state.collections)
          if (
            !["state.journals", "state.revisions", "protocol.retainedResults"].includes(
              prior.collection,
            )
          )
            expect(
              after.collections.find(
                (row: { collection: string }) => row.collection === prior.collection,
              ),
            ).toEqual(prior);
        sample = {
          priorPostings: count,
          retainedOutcomes: before.head.sequence,
          wholeProjectionRows: after.collections.reduce(
            (sum: number, row: { population: string }) => sum + Number(row.population),
            0,
          ),
          wholeBookBytes: old.bookBytes,
          ...next.metrics,
        };
      }
      expect(f.dump()).toEqual(snapshot);
      oldTimes.sort((a, b) => a - b);
      newTimes.sort((a, b) => a - b);
      samples.push({
        ...sample,
        legacyProducerMedianMs: oldTimes[1],
        conditionalProducerMedianMs: newTimes[1],
      });
    }
    if (process.env.RASTRATA_REPORT_DELTA_PUBLICATION === "1")
      console.log(
        JSON.stringify({
          scope:
            "local conditional publication producer only; not end-to-end owner latency, recovery or capacity acceptance",
          trialsPerSize: 3,
          samples,
        }),
      );
  } finally {
    f.close();
  }
}, 180000);

test("retained rejections keep financial row origins, and unchanged lot definitions keep their original source", async () => {
  const f = await fixture();
  try {
    await f.publish(posting("not-active", 0n));
    await f.publish(activation());
    await f.publish(posting("stale-source", 0n));
    await f.verifyRows();
    const capture = f.catalog.capture(f.digest);
    f.reads.length = 0;
    await f.catalog.read(capture, "state.openingBoundary", 1n, f.ports);
    expect(f.reads).toEqual(["2"]);
    f.reads.length = 0;
    await f.catalog.read(capture, "protocol.retainedResults", 1n, f.ports);
    expect(f.reads).toEqual(["1"]);
  } finally {
    f.close();
  }
  const lots = lotIdentityWorkflow(),
    g = await fixture(lots.initial);
  try {
    for (const command of lots.commands) await g.publish(command);
    const capture = g.catalog.capture(g.digest);
    g.reads.length = 0;
    await g.catalog.read(capture, "state.lots", 1n, g.ports);
    expect(g.reads).toEqual(["2"]);
    g.reads.length = 0;
    await g.catalog.read(capture, "state.lotHoldings", 1n, g.ports);
    expect(g.reads).not.toEqual(["2"]);
    await g.verifyRows();
  } finally {
    g.close();
  }
});

test("configuration history, close packages and close/reopen transitions keep distinct immutable sources", async () => {
  const initial = genesis(),
    f = await fixture(initial),
    base = posting();
  const periodId = initial.state.periods[0]?.id;
  if (!periodId) throw new Error("Missing period");
  const core = {
    bookId: base.bookId,
    actorId: base.actorId,
    protocolVersion: base.protocolVersion,
    issuedAt: instant("2026-02-01T00:00:00Z"),
    completedAt: instant("2026-02-01T00:00:01Z"),
    committedAt: instant("2026-02-01T00:00:02Z"),
  };
  try {
    const commands = [
      activation(),
      posting("catalog-core-post", 1n),
      sealCommand({
        ...core,
        id: commandId("catalog-configuration"),
        type: "replaceConfiguration",
        expectedBookRevision: 2n,
        expectedConfigurationRevision: 0n,
        effectiveOn: localDate("2026-01-20"),
        periods: initial.state.periods,
        admissionSnapshot: initial.state.admissionSnapshot,
        policies: initial.state.policies,
        quantizationPolicies: initial.state.quantizationPolicies,
        accountingPolicies: initial.state.accountingPolicySnapshot.policies,
      }),
      sealCommand({
        ...core,
        id: commandId("catalog-close"),
        type: "closePeriod",
        expectedBookRevision: 3n,
        periodId,
        closePackageId: closePackageId("catalog-close"),
        reason: "Close catalog test",
        reportPopulationHash: hashCanonical("report"),
        reportingPolicySnapshotHash: hashCanonical("report-policy"),
      }),
      sealCommand({
        ...core,
        id: commandId("catalog-reopen"),
        type: "reopenPeriod",
        expectedBookRevision: 4n,
        periodId,
        reason: "Reopen catalog test",
      }),
    ];
    for (const command of commands) {
      const plan = await f.publish(command);
      expect(plan.afterAggregate.protocol.retainedResults.at(-1)?.outcome).toBe("committed");
      await f.verifyRows();
    }
    const capture = f.catalog.capture(f.digest);
    for (const [collection, ordinal, source] of [
      ["state.configurationSnapshots", 1n, "genesis"],
      ["state.configurationSnapshots", 2n, "3"],
      ["state.closePackages", 1n, "4"],
      ["state.periodTransitions", 1n, "4"],
      ["state.periodTransitions", 2n, "5"],
    ] as const) {
      f.reads.length = 0;
      await f.catalog.read(capture, collection, ordinal, f.ports);
      expect(f.reads).toEqual([source]);
    }
  } finally {
    f.close();
  }
});

test("preparation is read-only and refuses historical genesis, stale catalogs, and missing financial predecessors", async () => {
  const f = await fixture();
  try {
    await f.publish(activation());
    const before = f.dump();
    f.faults.statements.length = 0;
    const plan = await f.prepare(posting("read-only-preparation", 1n));
    expect(f.dump()).toEqual(before);
    expect(f.faults.statements.every((sql) => sql.startsWith("SELECT "))).toBe(true);
    await expect(f.catalog.prepareGenesis(encodeDurableBook(f.aggregate))).rejects.toThrow(
      "indexed_source_genesis_required",
    );
    await expect(
      f.catalog.prepareOutcome(
        plan.encoded,
        "0".repeat(64),
        f.aggregate.state.revisions[0] ?? null,
      ),
    ).rejects.toThrow("indexed_source_conflict");
    await expect(f.catalog.prepareOutcome(plan.encoded, f.digest, null)).rejects.toThrow();
    expect(f.dump()).toEqual(before);
    const revisions = f
      .readAnchor()
      .state.collections.find((c) => c.collection === "state.revisions");
    if (!revisions) throw new Error("Missing revision catalog");
    const missing = JSON.parse(revisions.encodedRoot).tree.digest;
    f.db.query("DELETE FROM ledger_indexed_source_nodes WHERE digest = ?").run(missing);
    const corruptBefore = f.dump();
    await expect(
      f.catalog.prepareOutcome(plan.encoded, f.digest, f.aggregate.state.revisions[0] ?? null),
    ).rejects.toThrow();
    expect(f.dump()).toEqual(corruptBefore);
  } finally {
    f.close();
  }
});

test("faults after each publication write roll back canonical records, head, nodes, origins and catalog together", async () => {
  for (const fault of [
    "INSERT INTO test_outcome",
    "UPDATE test_canonical",
    "INSERT INTO ledger_indexed_source_nodes",
    "INSERT INTO ledger_indexed_source_origins",
    "UPDATE ledger_indexed_source_catalog",
    "after-catalog",
  ]) {
    const f = await fixture();
    try {
      await f.publish(activation());
      const plan = await f.prepare(posting("rollback-source", 1n));
      const before = f.dump();
      f.faults.afterSql = fault === "after-catalog" ? "" : fault;
      expect(() =>
        f.select(plan, () => {
          if (fault === "after-catalog") throw new Error("post-catalog failure");
        }),
      ).toThrow();
      expect(f.dump()).toEqual(before);
      f.faults.afterSql = "";
      f.select(plan);
      await f.verifyRows();
      expect(() => f.select(plan)).toThrow("canonical CAS conflict");
    } finally {
      f.close();
    }
  }
});

test("failed genesis publication leaves no partial source catalog and the same prepared genesis can retry", async () => {
  for (const fault of [
    "INSERT INTO test_canonical",
    "CREATE TABLE ledger_indexed_source_catalog",
    "CREATE TABLE ledger_indexed_source_nodes",
    "CREATE TABLE ledger_indexed_source_origins",
    "INSERT INTO ledger_indexed_source_nodes",
    "INSERT INTO ledger_indexed_source_origins",
    "INSERT INTO ledger_indexed_source_catalog",
  ]) {
    const f = await fixture(genesis(), fault);
    try {
      const before = f.dump();
      expect(() => f.installGenesis()).toThrow("injected SQL failure");
      expect(f.dump()).toEqual(before);
      f.faults.afterSql = "";
      f.installGenesis();
      await f.verifyRows();
      expect(() => f.installGenesis()).toThrow();
    } finally {
      f.close();
    }
  }
});

test("post-write catalog or canonical-head substitution rolls the entire transaction back", async () => {
  for (const kind of ["catalog", "head"] as const) {
    const f = await fixture();
    try {
      await f.publish(activation());
      const plan = await f.prepare(posting("post-write-substitution", 1n));
      f.db.exec(
        kind === "catalog"
          ? "CREATE TRIGGER test_substitute AFTER UPDATE ON ledger_indexed_source_catalog BEGIN UPDATE ledger_indexed_source_catalog SET body = OLD.body, digest = OLD.digest; END"
          : "CREATE TRIGGER test_substitute AFTER UPDATE ON ledger_indexed_source_catalog BEGIN UPDATE test_canonical SET body = '{}'; END",
      );
      const before = f.dump();
      expect(() => f.select(plan)).toThrow();
      expect(f.dump()).toEqual(before);
      f.db.exec("DROP TRIGGER test_substitute");
      f.select(plan);
      await f.verifyRows();
    } finally {
      f.close();
    }
  }
});

test("publication requires an instance-local prepared handle and same-port active transaction; stale owners cannot overwrite", async () => {
  const f = await fixture(),
    other = await fixture();
  try {
    const plan = await f.prepare(activation());
    expect(() => f.catalog.publishInTransaction({} as SqliteTransaction, plan.prepared)).toThrow(
      "sqlite_transaction_not_active",
    );
    expect(() =>
      atomicSqlite(other.storage, (tx) => f.catalog.publishInTransaction(tx, plan.prepared)),
    ).toThrow("sqlite_transaction_not_active");
    expect(() =>
      atomicSqlite(f.storage, (tx) => f.catalog.publishInTransaction(tx, { ...plan.prepared })),
    ).toThrow("indexed_source_unprepared");
    const replacement = new SqliteIndexedSourceCatalog(
      f.storage,
      f.scope,
      f.scope.objectId,
      f.readAnchor,
    );
    expect(() =>
      atomicSqlite(f.storage, (tx) => replacement.publishInTransaction(tx, plan.prepared)),
    ).toThrow("indexed_source_unprepared");
    expect(() =>
      atomicSqlite(f.storage, (tx) => f.catalog.publishInTransaction(tx, plan.prepared)),
    ).toThrow("indexed_source_head_mismatch");
    f.select(plan);
    const [a, b] = await Promise.all([
      f.prepare(posting("race-a", 1n)),
      f.prepare(posting("race-b", 1n)),
    ]);
    f.select(a);
    const before = f.dump();
    expect(() => f.select(b)).toThrow("canonical CAS conflict");
    expect(f.dump()).toEqual(before);
    // Exercise the catalog CAS independently: even a misordered owner update
    // cannot install the stale catalog, and its head update must roll back.
    expect(() =>
      atomicSqlite(f.storage, (tx) => {
        f.storage.sql.exec(
          "UPDATE test_canonical SET body = ? WHERE singleton = 1",
          JSON.stringify({
            genesisHash: f.readAnchor().genesisHash,
            state: JSON.parse(b.record.state),
            head: b.record.after,
          }),
        );
        f.catalog.publishInTransaction(tx, b.prepared);
      }),
    ).toThrow("indexed_source_conflict");
    expect(f.dump()).toEqual(before);
    await f.verifyRows();
  } finally {
    f.close();
    other.close();
  }
});

test("missing financial/locator nodes, origin bodies or canonical source bytes fail closed and retire captures", async () => {
  for (const kind of [
    "financial",
    "locator",
    "origin",
    "source",
    "row-corruption",
    "owner-revocation",
  ] as const) {
    const f = await fixture();
    try {
      await f.publish(activation());
      await f.publish(posting("damage-source", 1n));
      const capture = f.catalog.capture(f.digest);
      const stored = f.db.query("SELECT body FROM ledger_indexed_source_catalog").get() as {
        body: string;
      };
      const value = JSON.parse(stored.body);
      if (kind === "financial" || kind === "locator") {
        const group = (kind === "financial" ? value.state.collections : value.locators).find(
          (c: { collection: string }) => c.collection === "state.journals",
        );
        f.db
          .query("DELETE FROM ledger_indexed_source_nodes WHERE digest = ?")
          .run(JSON.parse(group.encodedRoot).tree.digest);
      } else if (kind === "origin")
        f.db
          .query("DELETE FROM ledger_indexed_source_origins WHERE body LIKE ?")
          .run('%"sequence":"2"%');
      else if (kind === "source") f.db.query("DELETE FROM test_outcome WHERE sequence = '2'").run();
      else if (kind === "row-corruption")
        f.db.query("UPDATE test_outcome SET body = body || ' ' WHERE sequence = '2'").run();
      else f.faults.deny = true;
      await expect(f.catalog.read(capture, "state.journals", 1n, f.ports)).rejects.toThrow();
      f.faults.deny = false;
      await expect(f.catalog.read(capture, "state.journals", 1n, f.ports)).rejects.toThrow(
        "indexed_source_capture_invalid",
      );
    } finally {
      f.close();
    }
  }
});

test("scope and head changes invalidate reads even after source resolution; absence is distinct from unavailable", async () => {
  const f = await fixture();
  try {
    await f.publish(activation());
    await f.publish(posting("before-read-race", 1n));
    for (const field of ["tenantId", "bookId", "objectId", "namespaceId", "generation"] as const) {
      const scope = { ...f.scope, [field]: field === "generation" ? "1" : "foreign" };
      const foreign = new SqliteIndexedSourceCatalog(
        f.storage,
        scope,
        scope.objectId,
        f.readAnchor,
      );
      expect(() => foreign.capture(f.digest)).toThrow();
    }
    const capture = f.catalog.capture(f.digest);
    await expect(
      f.catalog.read(capture, "state.journals", 1n, {
        ...f.ports,
        async outcome(sequence, hash) {
          const source = await f.ports.outcome(sequence, hash);
          await f.publish(posting("during-read-race", 2n));
          return source;
        },
      }),
    ).rejects.toThrow("indexed_source_conflict");
    const fresh = f.catalog.capture(f.digest);
    f.reads.length = 0;
    expect((await f.catalog.read(fresh, "state.journals", 3n, f.ports)).disposition).toBe("absent");
    expect(f.reads).toEqual([]);
    f.catalog.release(fresh);
    await expect(f.catalog.read(fresh, "state.journals", 1n, f.ports)).rejects.toThrow(
      "indexed_source_capture_invalid",
    );
  } finally {
    f.close();
  }
});
