import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  CHAIN_HEAD_STATE_COMMITMENT_PROFILE,
  createBookState,
  decodeBookRow,
  decodeDurableBook,
  encodeDurableBook,
  hashBookState,
  validateBookState,
  type BookCommand,
  type DurableBookAggregate,
} from "@rastrata/kernel";
import { SqliteLedgerRepository } from "../src/sqlite-ledger-repository.ts";
import { NativeLedger } from "../src/native-ledger.ts";
import { verifyNativeLedgerCopy } from "../src/native-ledger-copy.ts";
import { evaluateOutcomePayload } from "../src/outcome-payload.ts";
import type { SqliteStorage } from "../src/sqlite.ts";
import {
  activation,
  closing,
  configuration,
  correction,
  genesis,
  posting,
  reopening,
} from "./fixtures.ts";

function database(book: string, objectId = "state-commitment") {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const storage: SqliteStorage = {
    sql: {
      exec(sql, ...bindings) {
        return db
          .query(sql)
          .all(
            ...bindings.map((value) =>
              value instanceof ArrayBuffer ? new Uint8Array(value) : value,
            ),
          ) as Record<string, unknown>[];
      },
    },
    transactionSync: (work) => db.transaction(work)(),
    sync: async () => {},
  };
  const scope = {
    bookId: book,
    tenantId: "state-commitment",
    namespaceId: "native",
    generation: "0",
    objectId,
  };
  return {
    db,
    open: () =>
      new SqliteLedgerRepository(storage, scope, objectId, () => ({ pending: false, fence: "0" })),
  };
}

/** The standard ledger fixture book, created with or without the commitment profile. */
function book(commitment: boolean): DurableBookAggregate {
  const base = genesis();
  const state = base.state;
  return {
    protocol: base.protocol,
    state: createBookState(
      state.identity,
      state.periods,
      state.admissionSnapshot,
      state.policies,
      state.quantizationPolicies,
      state.accountingPolicySnapshot.policies,
      state.activeConfigurationSnapshot.effectiveAt,
      undefined,
      commitment ? CHAIN_HEAD_STATE_COMMITMENT_PROFILE : undefined,
    ),
  };
}

test("a book with the chain-head state commitment is provisioned, written, copied and verified by the native ledger", async () => {
  let expected = book(true);
  const source = database(expected.state.identity.bookId);
  const target = database(expected.state.identity.bookId, "state-commitment-copy");
  try {
    const opening = activation();
    const activated = evaluateOutcomePayload(expected, opening);
    await new NativeLedger(source.open()).provision(expected, opening);
    expected = { state: activated.transition.state, protocol: activated.transition.protocol };
    // Journals, a correction, a configuration change, a close, a reopen and a later journal: the
    // native write path never computes a state hash, and agrees with the full kernel on every one.
    const commands: ((state: typeof expected.state) => BookCommand)[] = [
      () => posting("one", 1n),
      () => posting("two", 2n),
      (state) => {
        const original = state.journals[0];
        if (!original) throw new Error("Missing the journal to correct");
        return correction(original, "undo-one", 3n);
      },
      (state) => configuration(state, "reconfigure"),
      () => closing("close-january", 5n),
      () => reopening("reopen-january", 6n),
      () => posting("three", 7n),
    ];
    for (const build of commands) {
      const command = build(expected.state);
      const oracle = evaluateOutcomePayload(expected, command);
      expect(oracle.transition.result.disposition, command.id).toBe("committed");
      const result = await new NativeLedger(source.open()).execute(command);
      expect(result.value.result, command.id).toEqual(oracle.transition.result);
      const retained = await source
        .open()
        .transact((view) => ({ write: false, value: view.outcome(command.id) }));
      expect(retained.value?.encoded, command.id).toBe(oracle.encoded as string);
      expected = { state: oracle.transition.state, protocol: oracle.transition.protocol };
    }
    // The configuration change went through the native path and kept the marker, in the stored row.
    expect(expected.state.configurationRevision).toBe(1n);
    expect(
      expected.state.configurationSnapshots.map((snapshot) => snapshot.stateCommitmentProfile),
    ).toEqual([CHAIN_HEAD_STATE_COMMITMENT_PROFILE, CHAIN_HEAD_STATE_COMMITMENT_PROFILE]);
    const stored = await source.open().transact((view) => ({
      write: false,
      value: view.facts([{ collection: "current", key: "configuration" }])[0],
    }));
    const row = decodeBookRow("state.configurationSnapshots", stored.value?.encoded as string);
    expect(row.disposition).toBe("decoded");
    if (row.disposition !== "decoded") throw new Error(row.message);
    expect(row.row.stateCommitmentProfile).toBe(CHAIN_HEAD_STATE_COMMITMENT_PROFILE);
    expect(row.row.revision).toBe(1n);
    // The full state the read model rebuilds from these outcomes is valid and carries the commitment.
    expect(validateBookState(expected.state)).toEqual([]);
    expect(hashBookState(expected.state)).toEqual(expected.state.contentHash);
    const aggregate = { state: expected.state, protocol: expected.protocol };
    const decoded = decodeDurableBook(encodeDurableBook(aggregate));
    expect(decoded.disposition).toBe("decoded");
    // A retry after a restart returns the original result.
    const again = await new NativeLedger(source.open()).execute(posting("three", 7n));
    expect(again.value.outcomeSequence).toBe("8");
    expect(again.value.originalResult?.disposition).toBe("committed");
    // Every original command re-executed into an empty staging ledger lands on the same projections.
    const head = (await source.open().transact((view) => ({ write: false, value: view.head })))
      .value;
    const copied = await verifyNativeLedgerCopy(source.open(), target.open(), head);
    expect(copied.sourceHead.bookRevision).toBe(expected.state.bookRevision.toString());
  } finally {
    source.db.close();
    target.db.close();
  }
});

test("a ledger provisioned with one preimage refuses the other kind of genesis", async () => {
  const profiled = book(true);
  const legacy = book(false);
  expect(profiled.state.contentHash).not.toEqual(legacy.state.contentHash);
  const source = database(profiled.state.identity.bookId);
  try {
    await new NativeLedger(source.open()).provision(profiled, activation());
    // The same book provisioned again is idempotent; the other kind of genesis is a conflict.
    await new NativeLedger(source.open()).provision(profiled, activation());
    await expect(new NativeLedger(source.open()).provision(legacy, activation())).rejects.toThrow(
      "native_ledger_genesis_conflict",
    );
  } finally {
    source.db.close();
  }
});

test("a book without the profile is unchanged by the new field: its genesis never mentions it", () => {
  const legacy = book(false);
  expect(encodeDurableBook(legacy)).not.toContain("stateCommitmentProfile");
  expect(encodeDurableBook(book(true))).toContain("stateCommitmentProfile");
});
