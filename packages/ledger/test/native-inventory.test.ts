import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  ExactRational,
  commandId,
  sealCommand,
  localDate,
  instant,
  identifier,
  lotId,
  lotHoldingId,
  lotAllocationId,
  type BookCommand,
  encodeDurableBook,
  decodeDurableBook,
} from "@rastrata/kernel";
import { SqliteLedgerRepository } from "../src/sqlite-ledger-repository.ts";
import { NativeLedger } from "../src/native-ledger.ts";
import { verifyNativeLedgerCopy } from "../src/native-ledger-copy.ts";
import { evaluateOutcomePayload } from "../src/outcome-payload.ts";
import type { SqliteStorage } from "../src/sqlite.ts";
import { nativeInventoryWorkflow, freeInventoryCycle } from "./native-inventory-workflow.ts";
import {
  configuration,
  posting,
  openItemRecognition,
  correction,
  closing,
  reopening,
} from "./fixtures.ts";

function database(book: string, objectId = "inventory") {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const faults = { statement: "", lostReply: false, failSync: false, sql: [] as string[] };
  const storage: SqliteStorage = {
    sql: {
      exec(sql, ...bindings) {
        faults.sql.push(sql);
        const rows = db
          .query(sql)
          .all(
            ...bindings.map((value) =>
              value instanceof ArrayBuffer ? new Uint8Array(value) : value,
            ),
          ) as Record<string, unknown>[];
        if (faults.statement && sql.startsWith(faults.statement)) {
          faults.statement = "";
          throw new Error("injected inventory rollback");
        }
        if (faults.lostReply && sql.startsWith("UPDATE ledger_native_book")) {
          faults.lostReply = false;
          faults.failSync = true;
        }
        return rows;
      },
    },
    transactionSync: (work) => db.transaction(work)(),
    sync: async () => {
      if (faults.failSync) {
        faults.failSync = false;
        throw new Error("injected durability loss");
      }
    },
  };
  const scope = {
    bookId: book,
    tenantId: "native-inventory",
    namespaceId: "native",
    generation: "0",
    objectId,
  };
  return {
    db,
    faults,
    open: () =>
      new SqliteLedgerRepository(storage, scope, objectId, () => ({ pending: false, fence: "0" })),
  };
}

test("native owned inventory matches the full kernel, survives restart and verifies every copied projection", async () => {
  const workflow = await nativeInventoryWorkflow();
  let expected = workflow.initial;
  const source = database(expected.state.identity.bookId),
    target = database(expected.state.identity.bookId, "staging");
  const [activation, ...commands] = workflow.commands;
  if (!activation) throw new Error("Missing activation");
  try {
    const activated = evaluateOutcomePayload(expected, activation);
    await new NativeLedger(source.open()).provision(expected, activation);
    expected = { state: activated.transition.state, protocol: activated.transition.protocol };
    for (const command of commands) {
      const oracle = evaluateOutcomePayload(expected, command);
      expect(oracle.transition.result.disposition).toBe("committed");
      source.faults.sql = [];
      const result = await new NativeLedger(source.open()).execute(command);
      expect(result.value.result).toEqual(oracle.transition.result);
      const sql = source.faults.sql.length;
      expect(sql).toBeLessThan(25);
      expect(source.faults.sql.some((query) => query.includes("ORDER BY f.source_sequence"))).toBe(
        false,
      );
      const retained = await source
        .open()
        .transact((view) => ({ write: false, value: view.outcome(command.id) }));
      if (oracle.encoded === null) throw new Error("Expected retained oracle outcome");
      expect(retained.value?.encoded).toBe(oracle.encoded);
      expected = { state: oracle.transition.state, protocol: oracle.transition.protocol };
      const retry = await new NativeLedger(source.open()).execute(command);
      expect(retry.value.originalResult).toEqual(oracle.transition.result);
      expect(retry.value.outcomeSequence).toBe(result.value.outcomeSequence);
    }
    expect(
      expected.state.lotHoldings.map((holding) => holding.remainingQuantity.toString()),
    ).toEqual(["0/1", "0/1", "0/1"]);
    const total = expected.state.journals
      .flatMap((journal) => journal.journal.postings)
      .filter((posting) => posting.accountId === "cash")
      .reduce(
        (sum, posting) => sum.add(posting.bookValue.amount.toRational()),
        ExactRational.zero(),
      );
    expect(total.toString()).toBe("0/1");
    const head = (await source.open().transact((view) => ({ write: false, value: view.head })))
      .value;
    const copied = await verifyNativeLedgerCopy(source.open(), target.open(), head);
    expect(copied.sourceHead.bookRevision).toBe(expected.state.bookRevision.toString());
  } finally {
    source.db.close();
    target.db.close();
  }
});

test("native quantity-only acquisition, transfer and issue preserve dates, identities and zero journals", async () => {
  const workflow = await nativeInventoryWorkflow();
  let expected = workflow.initial;
  const source = database(expected.state.identity.bookId),
    target = database(expected.state.identity.bookId, "free-copy");
  const activation = workflow.commands[0];
  if (!activation) throw new Error("Missing activation");
  const [acquire, issue] = freeInventoryCycle(workflow.commands, "free", 1n);
  const operation = acquire.request.operations[0],
    issueOperation = issue.request.operations[0];
  if (operation?.kind !== "acquisition" || issueOperation?.kind !== "issue")
    throw new Error("Expected free operations");
  const transfer = sealCommand({
    ...acquire,
    id: commandId("transfer"),
    expectedBookRevision: 2n,
    request: {
      ...acquire.request,
      operations: [
        {
          kind: "transfer" as const,
          ordinal: 0n,
          id: identifier<"InventoryOperation">("transfer"),
          coordinate: operation.coordinate,
          destinationCoordinate: operation.coordinate,
          inventoryPolicy: operation.inventoryPolicy,
          destinationInventoryPolicy: operation.inventoryPolicy,
          derivation: operation.derivation,
          quantity: ExactRational.of(3n, 1n),
          entries: operation.entries.map((entry, index) => ({
            holdingId: entry.holding.id,
            allocationId: lotAllocationId(`transfer-allocation-${index}`),
            transferOutMovementId: identifier<"InventoryPostedMovement">(`transfer-out-${index}`),
            destinationAnchorId: identifier<"InventoryPostedAnchor">(`destination-anchor-${index}`),
            destinationMovementId: identifier<"InventoryPostedMovement">(`destination-in-${index}`),
            destinationHoldingId: lotHoldingId(`destination-holding-${index}`),
            destinationLotId: lotId(`destination-lot-${index}`),
            evidence: entry.evidence,
          })),
        },
      ],
    },
  });
  const dispose = sealCommand({
    ...issue,
    expectedBookRevision: 3n,
    request: {
      ...issue.request,
      operations: [
        {
          ...issueOperation,
          identities: issueOperation.identities.map((entry, index) => ({
            ...entry,
            holdingId: lotHoldingId(`destination-holding-${index}`),
          })),
        },
      ],
    },
  });
  try {
    await new NativeLedger(source.open()).provision(expected, activation);
    const active = evaluateOutcomePayload(expected, activation);
    expected = { state: active.transition.state, protocol: active.transition.protocol };
    const run = async (command: BookCommand) => {
      const oracle = evaluateOutcomePayload(expected, command);
      const result = await new NativeLedger(source.open()).execute(command);
      expect(result.value.result).toEqual(oracle.transition.result);
      expected = { state: oracle.transition.state, protocol: oracle.transition.protocol };
      return result;
    };
    for (const command of [acquire, transfer, dispose])
      expect((await run(command)).value.result.disposition).toBe("committed");
    expect(expected.state.latestPostingSequence).toBe(0n);
    expect(expected.state.journals).toHaveLength(0);
    expect(
      expected.state.lotHoldings.map((holding) => holding.remainingQuantity.toString()),
    ).toEqual(Array(6).fill("0/1"));
    const generic = posting("managed-bypass", 4n);
    expect((await run(generic)).value.result.disposition).toBe("rejected");
    const config = configuration(expected.state);
    if (config.type !== "replaceConfiguration") throw new Error("Expected configuration");
    const tooEarly = sealCommand({ ...config, effectiveOn: localDate("2026-01-15") });
    const rejected = await run(tooEarly);
    expect(rejected.value.result.diagnostics[0]?.code).toBe("fiscal_period_admission");
    const reused = sealCommand({
      ...acquire,
      id: commandId("reuse-depleted"),
      expectedBookRevision: 4n,
    });
    expect((await run(reused)).value.result.disposition).toBe("rejected");
    const validConfig = sealCommand({ ...config, id: commandId("later-configuration") });
    expect((await run(validConfig)).value.result.disposition).toBe("committed");
    expect((await run(closing("free-close", 5n))).value.result.disposition).toBe("committed");
    const [nextAcquisition] = freeInventoryCycle(workflow.commands, "after-close", 6n);
    const closedAcquisition = sealCommand({
      ...nextAcquisition,
      issuedAt: instant("2026-02-01T12:00:00Z"),
      completedAt: instant("2026-02-01T12:00:01Z"),
      committedAt: instant("2026-02-01T12:00:02Z"),
    });
    const refused = await run(closedAcquisition);
    expect(refused.value.result.diagnostics[0]?.code).toBe("fiscal_period_admission");
    expect((await run(reopening("free-reopen", 6n))).value.result.disposition).toBe("committed");
    const retry = await new NativeLedger(source.open()).execute(closedAcquisition);
    expect(retry.value.originalResult).toEqual(refused.value.result);
    const changed = await run(
      sealCommand({
        ...closedAcquisition,
        id: commandId("after-reopen"),
        expectedBookRevision: 7n,
      }),
    );
    expect(changed.value.result.disposition).toBe("committed");
    expect(decodeDurableBook(encodeDurableBook(expected)).disposition).toBe("decoded");
    const copied = await verifyNativeLedgerCopy(source.open(), target.open(), changed.head);
    expect(copied.sourceHead.bookRevision).toBe("8");
  } finally {
    source.db.close();
    target.db.close();
  }
});

test("native inventory has atomic rollback and exact retry after uncertain durability", async () => {
  const workflow = await nativeInventoryWorkflow();
  const [activation, acquisition, issue] = workflow.commands;
  if (!activation || !acquisition || !issue) throw new Error("Expected inventory commands");
  for (const point of [
    "INSERT INTO ledger_native_outcomes",
    "INSERT INTO ledger_native_facts",
    "UPDATE ledger_native_book",
    "lost",
  ]) {
    const source = database(workflow.initial.state.identity.bookId, point);
    try {
      const ledger = new NativeLedger(source.open());
      await ledger.provision(workflow.initial, activation);
      await ledger.execute(acquisition);
      const before = source.db.query("SELECT * FROM ledger_native_facts ORDER BY identity").all();
      if (point === "lost") source.faults.lostReply = true;
      else source.faults.statement = point;
      await expect(ledger.execute(issue)).rejects.toThrow();
      if (point !== "lost")
        expect(
          source.db.query("SELECT * FROM ledger_native_facts ORDER BY identity").all(),
        ).toEqual(before);
      const next = await new NativeLedger(source.open()).execute(issue);
      expect(next.value.result.disposition).toBe(point === "lost" ? "replayed" : "committed");
      expect(next.value.outcomeSequence).toBe("3");
    } finally {
      source.db.close();
    }
  }
});

test("native inventory cannot reuse another accounting family's posting-reference identity", async () => {
  const workflow = await nativeInventoryWorkflow(),
    activation = workflow.commands[0],
    acquisition = workflow.commands[1];
  if (!activation || acquisition?.type !== "postOwnedInventoryTransaction")
    throw new Error("Missing inventory fixture");
  const source = database(workflow.initial.state.identity.bookId);
  let expected = workflow.initial;
  try {
    await new NativeLedger(source.open()).provision(expected, activation);
    const activated = evaluateOutcomePayload(expected, activation);
    expected = { state: activated.transition.state, protocol: activated.transition.protocol };
    const run = async (command: BookCommand) => {
      const oracle = evaluateOutcomePayload(expected, command);
      const result = await new NativeLedger(source.open()).execute(command);
      expect(result.value.result).toEqual(oracle.transition.result);
      expected = { state: oracle.transition.state, protocol: oracle.transition.protocol };
      return result;
    };
    const invoice = openItemRecognition("inventory-reference-owner", 1n);
    const invoiceSource = invoice.request.value.recognitionSource;
    if (!invoiceSource) throw new Error("Expected invoice source reference");
    expect((await run(invoice)).value.result.disposition).toBe("committed");
    const original = expected.state.journals[0];
    if (!original) throw new Error("Missing journal");
    expect((await run(correction(original, "clear-opening", 2n))).value.result.disposition).toBe(
      "committed",
    );
    const op = acquisition.request.operations[0];
    if (!op?.postingLink) throw new Error("Expected acquisition posting");
    const laterAcquisition = sealCommand({
      ...acquisition,
      issuedAt: instant("2026-01-15T18:00:00Z"),
      completedAt: instant("2026-01-15T18:00:01Z"),
      committedAt: instant("2026-01-15T18:00:02Z"),
    });
    const conflict = sealCommand({
      ...laterAcquisition,
      expectedBookRevision: 3n,
      request: {
        ...acquisition.request,
        operations: [
          {
            ...op,
            postingLink: {
              ...op.postingLink,
              referenceId: invoiceSource.id,
            },
          },
        ],
      },
    });
    const rejected = await run(conflict);
    expect(rejected.value.result.disposition).toBe("rejected");
    expect(rejected.value.result.diagnostics[0]?.path).toBe("ownedInventory.postingLink");
    const accepted = await run(
      sealCommand({
        ...laterAcquisition,
        id: commandId("new-reference"),
        expectedBookRevision: 3n,
      }),
    );
    expect(accepted.value.result.disposition).toBe("committed");
    const owned = expected.state.journals.at(-1);
    if (!owned) throw new Error("Missing owned journal");
    const reversal = correction(owned, "owned-correction-bypass", 4n);
    if (reversal.type !== "correctJournal") throw new Error("Expected correction");
    const forbidden = await run(
      sealCommand({
        ...reversal,
        resolved: {
          ...reversal.resolved,
          journal: {
            ...reversal.resolved.journal,
            postings: reversal.resolved.journal.postings.map((posting) => ({
              ...posting,
              ...(posting.costBasis === undefined
                ? {}
                : {
                    costBasis: {
                      ...posting.costBasis,
                      totalBasis: posting.costBasis.totalBasis.negate(),
                    },
                  }),
            })),
          },
        },
        issuedAt: instant("2026-01-15T19:00:00Z"),
        completedAt: instant("2026-01-15T19:00:01Z"),
        committedAt: instant("2026-01-15T19:00:02Z"),
      }),
    );
    expect(forbidden.value.result.disposition).toBe("rejected");
    expect(forbidden.value.result.diagnostics[0]?.path).toBe("command.inventoryOwnership");
  } finally {
    source.db.close();
  }
});

test("native inventory refuses missing pool members, identities, counts, origins and index", async () => {
  const workflow = await nativeInventoryWorkflow();
  const [activation, acquisition, issue] = workflow.commands;
  if (!activation || !acquisition || !issue) throw new Error("Expected inventory commands");
  for (const collection of [
    "inventoryPositions",
    "inventoryHoldingIds",
    "inventoryPoolCounts",
    "inventoryAnchors",
    "inventoryMovements",
    "lots",
    "index",
  ]) {
    const source = database(workflow.initial.state.identity.bookId, collection);
    try {
      const ledger = new NativeLedger(source.open());
      await ledger.provision(workflow.initial, activation);
      await ledger.execute(acquisition);
      if (collection === "index") source.db.exec("DROP INDEX ledger_native_inventory_active");
      else
        source.db
          .query(
            "DELETE FROM ledger_native_facts WHERE identity = (SELECT identity FROM ledger_native_facts WHERE json_extract(identity,'$[0]')=? LIMIT 1)",
          )
          .run(collection);
      await expect(new NativeLedger(source.open()).execute(issue)).rejects.toThrow();
      expect(
        (await source.open().transact((view) => ({ write: false, value: view.outcome(issue.id) })))
          .value,
      ).toBeNull();
    } finally {
      source.db.close();
    }
  }
});

test("native owned save SQL is independent of depleted retained history", async () => {
  const workflow = await nativeInventoryWorkflow(),
    activation = workflow.commands[0];
  if (!activation) throw new Error("Expected activation");
  const source = database(workflow.initial.state.identity.bookId),
    samples: number[][] = [],
    latency: number[][] = [[], []];
  try {
    const ledger = new NativeLedger(source.open());
    await ledger.provision(workflow.initial, activation);
    for (let cycle = 0; cycle < 40; cycle++) {
      const counts: number[] = [];
      for (const [index, command] of freeInventoryCycle(
        workflow.commands,
        `cycle-${cycle}`,
        BigInt(cycle * 2 + 1),
      ).entries()) {
        source.faults.sql = [];
        const start = performance.now();
        const result = await ledger.execute(command);
        const elapsed = performance.now() - start;
        const timings = latency[index];
        if (cycle > 0 && timings) timings.push(elapsed);
        expect(result.value.result.disposition).toBe("committed");
        counts.push(source.faults.sql.length);
      }
      if (cycle === 1 || cycle === 39) samples.push(counts);
    }
    expect(samples[0]).toEqual(samples[1]);
    expect(
      source.db
        .query(
          "SELECT count(*) AS n FROM ledger_native_facts WHERE json_extract(identity,'$[0]')='inventoryPositions'",
        )
        .get(),
    ).toEqual({ n: 120 });
    const plan = source.db
      .query(
        "EXPLAIN QUERY PLAN SELECT identity FROM ledger_native_facts INDEXED BY ledger_native_inventory_active WHERE json_extract(identity,'$[0]')='inventoryPositions' AND mutable=1 AND json_extract(body,'$.active')=1 AND json_extract(body,'$.accountId')=? AND json_extract(body,'$.commodityId')=?",
      )
      .all("cash", "USD");
    expect(JSON.stringify(plan)).toContain(
      "SEARCH ledger_native_facts USING INDEX ledger_native_inventory_active",
    );
    console.log(
      JSON.stringify({
        scope: "native owned inventory, local SQLite",
        cycles: 40,
        depletedHoldings: 120,
        sqlPerAcquisitionAndIssue: samples[1],
        warmLocalP95Ms: latency.map(
          (values) => values.sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1],
        ),
        warmFreshSamplesPerCommand: 39,
      }),
    );
  } finally {
    source.db.close();
  }
});

test("native inventory staging replay detects a rehashed false active-pool counter", async () => {
  const workflow = await nativeInventoryWorkflow(),
    activation = workflow.commands[0],
    acquisition = workflow.commands[1];
  if (!activation || !acquisition) throw new Error("Missing inventory fixture");
  const source = database(workflow.initial.state.identity.bookId),
    target = database(workflow.initial.state.identity.bookId, "corrupt-copy");
  try {
    const ledger = new NativeLedger(source.open());
    await ledger.provision(workflow.initial, activation);
    const result = await ledger.execute(acquisition);
    source.db
      .query(
        "UPDATE ledger_native_facts SET body=?,digest=? WHERE json_extract(identity,'$[0]')='inventoryPoolCounts'",
      )
      .run("99", createHash("sha256").update("99").digest("hex"));
    await expect(verifyNativeLedgerCopy(source.open(), target.open(), result.head)).rejects.toThrow(
      "native_copy_projection_mismatch",
    );
  } finally {
    source.db.close();
    target.db.close();
  }
});
