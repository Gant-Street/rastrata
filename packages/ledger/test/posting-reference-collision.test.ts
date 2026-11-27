import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  executeBookCommand,
  encodeDurableBook,
  decodeDurableBook,
  createBookState,
  createBookProtocolState,
  encodeBookRow,
  validateCanonicalPostingReferenceHash,
  STRUCTURAL_SOURCE_IDENTITY_PROFILE,
  sealCommand,
  commandId,
  instant,
  localDate,
  evidenceId,
  type DurableBookAggregate,
} from "@rastrata/kernel";
import { IndexedLedgerOwner } from "../src/indexed-ledger-owner.ts";
import type { SqliteStorage } from "../src/sqlite.ts";
import { postingReferenceCollision } from "./posting-reference-collision-fixture.ts";
import { workflowValue } from "./accounting-workflows.ts";

test("characterization: delimiter alias hides an authentic allocation source without a digest collision", () => {
  for (const [collision, reverseOrder, disposition] of [
    [false, false, "committed"],
    [true, false, "rejected"],
    [true, true, "committed"],
  ] as const) {
    const f = postingReferenceCollision(collision, reverseOrder);
    let aggregate: DurableBookAggregate = f.initial;
    for (const command of f.commands.slice(0, -1)) {
      const next = executeBookCommand(aggregate.state, aggregate.protocol, command);
      expect(next.result.disposition).toBe("committed");
      aggregate = { state: next.state, protocol: next.protocol };
    }
    const source = workflowValue(aggregate.state.journals.find((j) => j.journal.id === "a"));
    const other = workflowValue(aggregate.state.journals.find((j) => j.journal.id !== "a"));
    expect(source.journal.id).not.toBe(other.journal.id);
    expect(source.effectKey).not.toBe(other.effectKey);
    expect(source.journal.postings.map((p) => p.id)).not.toEqual(
      other.journal.postings.map((p) => p.id),
    );
    expect(
      `${source.journal.id}:${source.effectKey}` === `${other.journal.id}:${other.effectKey}`,
    ).toBe(collision);
    expect(validateCanonicalPostingReferenceHash(f.reference)).toBeTrue();
    const next = executeBookCommand(aggregate.state, aggregate.protocol, f.create);
    expect(next.result.disposition).toBe(disposition);
    if (disposition === "rejected") {
      expect(next.result.diagnostics).toEqual([
        {
          code: "unresolved_accounting_input",
          path: "intent.effects[0].source",
          message:
            "Allocation schedule must resolve one canonical same-book posting whose exact booked basis equals the scheduled source basis",
          requirementIds: ["ACC-011", "ACC-017", "ACC-026", "ACC-038", "ACC-044.1"],
        },
      ]);
      expect(encodeDurableBook({ state: next.state, protocol: aggregate.protocol })).toBe(
        encodeDurableBook(aggregate),
      );
    }
    expect(next.state.accountingState.allocationSchedules.length).toBe(
      disposition === "committed" ? 1 : 0,
    );
    expect(next.protocol.retainedResults.length).toBe(4);
  }
});

test("frozen alias history replays exactly and indexed identity reads still find the genuine source", async () => {
  // Captured with the pre-repair resolver. Never regenerate to make changed
  // admission/replay pass; prospective semantics require explicit governance.
  const bytes = await Bun.file(
    new URL("./data/posting-reference-collision-legacy.json", import.meta.url),
  ).text();
  expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(
    "0636ddb716c7a5c34e0542dc6b66eb01cd7991d9c6c24025f6c76a1cd28cb1e2",
  );
  const decoded = decodeDurableBook(bytes.trim());
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  const original = decoded.aggregate;
  expect(original.protocol.retainedResults).toHaveLength(4);
  expect(original.state.bookRevision).toBe(3n);
  expect(original.protocol.retainedResults.at(-1)?.outcome).toBe("rejected");
  const config = workflowValue(original.state.configurationSnapshots[0]);
  const initial = {
    state: createBookState(
      original.state.identity,
      config.periods,
      config.admissionSnapshot,
      config.policies,
      config.quantizationPolicies,
      config.accountingPolicySnapshot.policies,
      config.effectiveAt,
    ),
    protocol: createBookProtocolState(),
  };
  await assertOwnerReplay(original, initial, bytes.trim());
}, 180000);

test("explicit structural genesis survives indexed-owner restart with original committed and rejected retries", async () => {
  const f = postingReferenceCollision();
  const c = f.initial.state.activeConfigurationSnapshot;
  const initial = {
    ...f.initial,
    state: createBookState(
      f.initial.state.identity,
      c.periods,
      c.admissionSnapshot,
      c.policies,
      c.quantizationPolicies,
      c.accountingPolicySnapshot.policies,
      c.effectiveAt,
      STRUCTURAL_SOURCE_IDENTITY_PROFILE,
    ),
  };
  let original: DurableBookAggregate = initial;
  for (const command of f.commands) {
    const next = executeBookCommand(original.state, original.protocol, command);
    expect(next.result.disposition).toBe("committed");
    original = { state: next.state, protocol: next.protocol };
  }
  expect(original.state.bookRevision).toBe(4n);
  expect(original.state.journals).toHaveLength(2);
  expect(original.state.accountingState.allocationSchedules).toHaveLength(1);
  expect(original.state.accountingState.allocationSchedules[0]?.sourceBasis.toString()).toBe(
    "100/1",
  );
  const rejected = executeBookCommand(
    original.state,
    original.protocol,
    sealCommand({
      ...f.create,
      id: commandId("profile-stale-command"),
      expectedBookRevision: 3n,
    }),
  );
  expect(rejected.result.disposition).toBe("rejected");
  expect(rejected.result.diagnostics.map((d) => d.code)).toEqual(["stale_book_revision"]);
  original = { state: rejected.state, protocol: rejected.protocol };
  expect(original.protocol.retainedResults).toHaveLength(5);
  await assertOwnerReplay(original, initial, encodeDurableBook(original));
}, 180000);

test("explicit adoption preserves the frozen rejection while a fresh command resolves the old source after restart", async () => {
  const decoded = decodeDurableBook(
    (
      await Bun.file(
        new URL("./data/posting-reference-collision-legacy.json", import.meta.url),
      ).text()
    ).trim(),
  );
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  const legacy = decoded.aggregate;
  const c = workflowValue(legacy.state.configurationSnapshots[0]);
  const initial = {
    state: createBookState(
      legacy.state.identity,
      c.periods,
      c.admissionSnapshot,
      c.policies,
      c.quantizationPolicies,
      c.accountingPolicySnapshot.policies,
      c.effectiveAt,
    ),
    protocol: createBookProtocolState(),
  };
  const old = workflowValue(legacy.protocol.retainedResults.at(-1));
  expect(old.outcome).toBe("rejected");
  if (old.command.type !== "createAllocationSchedule") throw new Error("Wrong frozen command");
  const adoption = sealCommand({
    type: "replaceConfiguration" as const,
    id: commandId("adopt-structural-source-identities"),
    protocolVersion: old.command.protocolVersion,
    bookId: legacy.state.identity.bookId,
    actorId: old.command.actorId,
    expectedBookRevision: legacy.state.bookRevision,
    expectedConfigurationRevision: legacy.state.configurationRevision,
    issuedAt: instant("2026-01-16T00:00:00Z"),
    completedAt: instant("2026-01-16T00:00:01Z"),
    committedAt: instant("2026-01-16T00:00:02Z"),
    effectiveOn: localDate("2026-01-16"),
    periods: legacy.state.periods,
    admissionSnapshot: legacy.state.admissionSnapshot,
    policies: legacy.state.policies,
    quantizationPolicies: legacy.state.quantizationPolicies,
    accountingPolicies: legacy.state.accountingPolicySnapshot.policies,
    executionProfileAdoption: {
      from: "legacy",
      to: STRUCTURAL_SOURCE_IDENTITY_PROFILE,
      expectedConfigurationHash: legacy.state.configurationHash,
      reason: "Apply the reviewed identity repair to new commands only",
      evidenceIds: [evidenceId("canonical-source-identity-review")],
    },
  });
  const adopted = executeBookCommand(legacy.state, legacy.protocol, adoption);
  expect(adopted.result.disposition).toBe("committed");
  expect(adopted.state.bookRevision).toBe(4n);
  expect(adopted.state.configurationRevision).toBe(1n);
  expect(adopted.state.latestPostingSequence).toBe(2n);
  expect(adopted.protocol.retainedResults).toHaveLength(5);
  expect(adopted.state.journals).toEqual(legacy.state.journals);
  const fresh = executeBookCommand(
    adopted.state,
    adopted.protocol,
    sealCommand({
      ...old.command,
      id: commandId("fresh-allocation-after-adoption"),
      expectedBookRevision: adopted.state.bookRevision,
      issuedAt: instant("2026-01-17T00:00:00Z"),
      completedAt: instant("2026-01-17T00:00:01Z"),
      committedAt: instant("2026-01-17T00:00:02Z"),
    }),
  );
  expect(fresh.result.disposition).toBe("committed");
  expect(fresh.state.bookRevision).toBe(5n);
  expect(fresh.state.latestPostingSequence).toBe(2n);
  expect(fresh.state.accountingState.allocationSchedules).toHaveLength(1);
  expect(fresh.state.accountingState.allocationSchedules[0]?.sourceBasis.toString()).toBe("100/1");
  for (const [i, retained] of legacy.protocol.retainedResults.entries()) {
    expect(
      encodeBookRow("protocol.retainedResults", workflowValue(fresh.protocol.retainedResults[i])),
    ).toBe(encodeBookRow("protocol.retainedResults", retained));
  }
  const retry = executeBookCommand(fresh.state, fresh.protocol, old.command);
  expect(retry.result.disposition).toBe("replayed");
  expect(retry.result.resultHash).toEqual(old.resultHash);
  expect(retry.result.diagnostics).toEqual(old.diagnostics);
  const original = { state: fresh.state, protocol: fresh.protocol };
  await assertOwnerReplay(original, initial, encodeDurableBook(original));
}, 180000);

async function assertOwnerReplay(
  original: DurableBookAggregate,
  initial: DurableBookAggregate,
  expectedBytes: string,
) {
  const db = new Database(":memory:");
  db.exec(
    "PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY; PRAGMA cache_size = -64000; PRAGMA temp_store = MEMORY;",
  );
  const stmtCache = new Map<string, ReturnType<Database["query"]>>();
  const port: SqliteStorage = {
    sql: {
      exec(sql, ...bindings) {
        let stmt = stmtCache.get(sql);
        if (!stmt) {
          stmt = db.query(sql);
          stmtCache.set(sql, stmt);
        }
        const rows = stmt.all(
          ...bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)),
        ) as Record<string, unknown>[];
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          for (const key in row) {
            const value = row[key];
            if (value instanceof Uint8Array) {
              row[key] = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            }
          }
        }
        return rows;
      },
    },
    transactionSync: (work) => db.transaction(work)(),
    sync: async () => {},
  };
  const scope = {
    tenantId: "collision-test",
    bookId: original.state.identity.bookId,
    objectId: "collision-book",
    namespaceId: "collision-test",
    generation: "0",
  };
  const open = () =>
    new IndexedLedgerOwner(
      port,
      scope,
      scope.objectId,
      () => ({ fence: "0", pending: false }),
      () => 10n,
    );
  try {
    const owner = open();
    await owner.provision(initial);
    for (const retained of original.protocol.retainedResults) {
      const receipt = await owner.execute(retained.command);
      expect(receipt.result.resultHash).toEqual(retained.resultHash);
      expect(receipt.result.diagnostics).toEqual(retained.diagnostics);
    }
    expect(encodeDurableBook((await open().read()).aggregate)).toBe(expectedBytes);
    const reader = await open().openCurrentRowReader();
    try {
      for (const booked of original.state.journals) {
        const found = await reader.readJournalIdentity("journal", booked.journal.id);
        expect(found.disposition).toBe("present");
        if (found.disposition !== "present") throw new Error("Missing canonical journal");
        expect(found.journal.encoded).toBe(encodeBookRow("state.journals", booked));
      }
      const retained = workflowValue(original.protocol.retainedResults.at(-1));
      const found = await reader.readCommand(retained.commandId);
      expect(found.row).toEqual(retained);
      expect(found.ordinal).toBe(BigInt(original.protocol.retainedResults.length));
    } finally {
      await reader.close();
    }
    const retryOwner = open();
    for (const [i, retained] of original.protocol.retainedResults.entries()) {
      const retry = await retryOwner.execute(retained.command);
      expect(retry.result.disposition).toBe("replayed");
      expect(retry.outcomeSequence).toBe(BigInt(i) + 1n);
      expect(retry.result.resultHash).toEqual(retained.resultHash);
      expect(retry.result.diagnostics).toEqual(retained.diagnostics);
    }
    expect(encodeDurableBook((await open().read()).aggregate)).toBe(expectedBytes);
  } finally {
    db.close();
  }
}
