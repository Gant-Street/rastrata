import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { encodeBookOutcome, encodeDurableBook, executeBookCommand } from "@rastrata/kernel";
import { BOOK, TENANT, activation, genesis, posting, nativeSave } from "../src/scenario.ts";
import type { Transport } from "./verify-smoke.ts";

/** Checks actual retained bytes against the full kernel, not response booleans.
 * Fixed bounded remote exercise, not a load test or production certificate. */
export async function verifyNativeSmoke(
  call: Transport,
  observe?: (sample: {
    readonly httpRoundTripMs: number;
    readonly dispositions: readonly string[];
  }) => void,
) {
  assert.equal((await call("/native/state", "GET", false)).status, 401);
  assert.equal((await call("/native/smoke", "GET")).status, 405);
  assert.equal((await call("/native/smoke?book=customer", "POST")).status, 400);
  const started = performance.now();
  const response = await call("/native/smoke", "POST");
  assert.equal(response.status, 200, "Native synthetic scenario must succeed");
  const actual = (await response.json()) as {
    profile: string;
    scope: {
      tenantId: string;
      bookId: string;
      objectId: string;
      namespaceId: string;
      generation: string;
    };
    genesis: string;
    head: { sequence: string; bookRevision: string; chainHash: string };
    outcomes: {
      head: { sequence: string; bookRevision: string; chainHash: string };
      encoded: string;
    }[];
    dispositions: string[];
  };
  const httpRoundTripMs = performance.now() - started;
  assert.equal(actual.profile, "native-book-commands-v1");
  assert.ok(["3", "4"].includes(actual.head.sequence));
  assert.equal(actual.head.bookRevision, actual.head.sequence === "3" ? "2" : "3");
  assert.match(actual.head.chainHash, /^[a-f0-9]{64}$/);
  assert.equal(actual.outcomes.length, Number(actual.head.sequence));
  let expected = genesis();
  assert.equal(actual.genesis, encodeDurableBook(expected));
  assert.deepEqual(Object.keys(actual.scope), [
    "tenantId",
    "bookId",
    "objectId",
    "namespaceId",
    "generation",
  ]);
  assert.equal(actual.scope.tenantId, TENANT);
  assert.equal(actual.scope.bookId, BOOK);
  assert.equal(actual.scope.namespaceId, "rastrata-ledger-dev_SyntheticNativeBook");
  assert.equal(actual.scope.generation, "0");
  assert.match(actual.scope.objectId, /^[a-f0-9]{64}$/);
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const scopeHash = hash(JSON.stringify(actual.scope));
  const format = "rastrata-native-sql-ledger-v1";
  let chain = hash(JSON.stringify([format, scopeHash, hash(actual.genesis)]));
  const commands = [
    activation(),
    posting(true),
    posting(false),
    ...(actual.head.sequence === "4" ? [nativeSave()] : []),
  ];
  for (const [index, command] of commands.entries()) {
    const next = executeBookCommand(expected.state, expected.protocol, command);
    assert.ok(next.result.disposition === "committed" || next.result.disposition === "rejected");
    const retained = next.protocol.retainedResults.at(-1);
    assert.ok(retained?.commandId === command.id, "The oracle must retain exactly this command");
    const row = actual.outcomes[index];
    assert.ok(row);
    assert.equal(row.head.sequence, String(index + 1));
    assert.equal(row.head.bookRevision, String(next.state.bookRevision));
    chain = hash(
      JSON.stringify([
        format,
        scopeHash,
        row.head.sequence,
        row.head.bookRevision,
        chain,
        hash(row.encoded),
      ]),
    );
    assert.equal(
      row.head.chainHash,
      chain,
      "Every scoped chain edge must match its actual outcome bytes",
    );
    assert.equal(
      row.encoded,
      encodeBookOutcome({
        command: retained.command,
        originalResult: { ...next.result, disposition: next.result.disposition },
        revision:
          next.result.disposition === "committed" ? (next.state.revisions.at(-1) ?? null) : null,
      }),
    );
    expected = { state: next.state, protocol: next.protocol };
  }
  assert.deepEqual(actual.outcomes.at(-1)?.head, actual.head);
  assert.equal(actual.dispositions.length, 4);
  assert.ok(["committed", "replayed"].includes(actual.dispositions[0] ?? ""));
  assert.ok(["rejected", "replayed"].includes(actual.dispositions[1] ?? ""));
  assert.deepEqual(actual.dispositions.slice(2), ["replayed", "replayed"]);
  const snapshot = {
    profile: actual.profile,
    scope: actual.scope,
    genesis: actual.genesis,
    head: actual.head,
    outcomes: actual.outcomes,
  };
  const state = await call("/native/state");
  assert.equal(state.status, 200);
  assert.deepEqual(await state.json(), snapshot);
  observe?.({ httpRoundTripMs, dispositions: actual.dispositions });
  return snapshot;
}

export async function verifyNativeSave(call: Transport) {
  assert.equal((await call("/native/save", "POST", false)).status, 401);
  assert.equal((await call("/native/save", "GET")).status, 405);
  assert.equal((await call("/native/save?command=customer", "POST")).status, 400);
  const started = performance.now();
  const response = await call("/native/save", "POST");
  assert.equal(response.status, 200, "Fixed native save must succeed");
  const saved = (await response.json()) as {
    head: { sequence: string; bookRevision: string };
    outcomeSequence: string;
    result: { disposition: string };
    originalResult: unknown;
  };
  const httpRoundTripMs = performance.now() - started;
  assert.equal(saved.head.sequence, "4");
  assert.equal(saved.head.bookRevision, "3");
  assert.equal(saved.outcomeSequence, "4");
  assert.ok(["committed", "replayed"].includes(saved.result.disposition));
  let expected = genesis();
  const followup = nativeSave();
  for (const command of [activation(), posting(true), posting(false), followup]) {
    const next = executeBookCommand(expected.state, expected.protocol, command);
    if (command.id === followup.id) {
      assert.equal(next.result.disposition, "committed");
      assert.deepEqual(
        saved.originalResult,
        JSON.parse(
          JSON.stringify(next.result, (_key, value) =>
            typeof value === "bigint" ? value.toString() : value,
          ),
        ),
      );
    }
    expected = { state: next.state, protocol: next.protocol };
  }
  const snapshot = await verifyNativeSmoke(call);
  assert.deepEqual(saved.head, snapshot.head);
  assert.equal(snapshot.outcomes.length, 4);
  return { snapshot, httpRoundTripMs, disposition: saved.result.disposition };
}
