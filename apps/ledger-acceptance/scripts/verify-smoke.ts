import assert from "node:assert/strict";
import { encodeDurableBook, executeBookCommand, hashCanonical } from "@rastrata/kernel";
import { activation, genesis, posting } from "../src/scenario.ts";

export type Transport = (
  path: string,
  method?: string,
  authorized?: boolean,
) => Promise<Pick<Response, "status" | "json">>;

interface WireReceipt {
  result: { disposition: string };
  originalResult: unknown;
  outcomeSequence: string;
}
interface SmokeResult {
  activated: WireReceipt;
  accepted: WireReceipt;
  rejected: WireReceipt;
  acceptedRetry: WireReceipt;
  rejectedRetry: WireReceipt;
  head: { sequence: string; bookRevision: string };
  aggregateHash: unknown;
}

function wire(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item)),
  );
}

export async function verifySmoke(call: Transport) {
  assert.equal((await call("/state", "GET", false)).status, 401);
  assert.equal((await call("/smoke", "GET")).status, 405);
  assert.equal((await call("/smoke?book=customer", "POST")).status, 400);
  assert.equal((await call("/unknown")).status, 404);
  assert.equal((await call("/health")).status, 200);

  const response = await call("/smoke", "POST");
  assert.equal(response.status, 200, "Synthetic scenario must succeed");
  const actual = (await response.json()) as SmokeResult;
  let expected = executeBookCommand(genesis().state, genesis().protocol, activation());
  const active = expected.result;
  expected = executeBookCommand(expected.state, expected.protocol, posting(true));
  const committed = expected.result;
  expected = executeBookCommand(expected.state, expected.protocol, posting(false));
  const rejected = expected.result;
  assert.equal(active.disposition, "committed");
  assert.equal(committed.disposition, "committed");
  assert.equal(rejected.disposition, "rejected");
  for (const [name, result, sequence] of [
    ["activated", active, "1"],
    ["accepted", committed, "2"],
    ["rejected", rejected, "3"],
  ] as const) {
    assert.deepEqual(actual[name].originalResult, wire(result), `${name}: exact original result`);
    assert.equal(actual[name].outcomeSequence, sequence);
    assert.ok([result.disposition, "replayed"].includes(actual[name].result.disposition));
  }
  assert.equal(actual.acceptedRetry.result.disposition, "replayed");
  assert.equal(actual.rejectedRetry.result.disposition, "replayed");
  assert.equal(actual.acceptedRetry.outcomeSequence, "2");
  assert.equal(actual.rejectedRetry.outcomeSequence, "3");
  assert.deepEqual(actual.acceptedRetry.originalResult, wire(committed));
  assert.deepEqual(actual.rejectedRetry.originalResult, wire(rejected));
  assert.equal(actual.head.sequence, "3");
  assert.equal(actual.head.bookRevision, "2");
  assert.deepEqual(
    actual.aggregateHash,
    hashCanonical(encodeDurableBook({ state: expected.state, protocol: expected.protocol })),
  );
  const stateResponse = await call("/state");
  assert.equal(stateResponse.status, 200);
  assert.deepEqual(await stateResponse.json(), {
    head: actual.head,
    aggregateHash: actual.aggregateHash,
  });
  return { head: actual.head, aggregateHash: actual.aggregateHash };
}
