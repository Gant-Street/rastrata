import { expect, test } from "bun:test";
import {
  decodeBookRow, decodeDurableBook, encodeDurableBook, executeBookCommand,
  validateBookState, sealCommand, commandId, lotAllocationId, postingId, ExactRational as R,
  hashCanonical, DURABLE_BOOK_CODEC_VERSION,
  type DurableBookAggregate,
} from "../src/index.ts";
import evidence from "./data/inventory-carrying-defect-legacy.json";

function unpack(record: { aggregateGzipBase64: string; sha256: string }): string {
  const text = new TextDecoder().decode(Bun.gunzipSync(Buffer.from(record.aggregateGzipBase64, "base64")));
  expect(new Bun.CryptoHasher("sha256").update(text).digest("hex")).toBe(record.sha256);
  return text;
}
function field(node: unknown, name: string): unknown {
  if (!Array.isArray(node) || node[0] !== "o") throw new Error("Expected object node");
  const found = (node[1] as [string, unknown][]).find(([key]) => key === name);
  if (found === undefined) throw new Error("Missing field");
  return found[1];
}
function fixture(index: number) {
  const stored = evidence.cases[index]!;
  const captured = unpack(stored.aggregate);
  const capturedBody: unknown = JSON.parse(captured).body;
  // The probe captured AtomicBookCommit (including result/intent), not only the
  // aggregate. Frame its exact state/protocol subtrees without changing a row or
  // accounting hash, so the test reaches semantic validation rather than failing
  // on extra transport fields. The original capture remains immutable evidence.
  const body = ["o", [["protocol", field(capturedBody, "protocol")], ["state", field(capturedBody, "state")]]];
  const encoded = JSON.stringify({ version: DURABLE_BOOK_CODEC_VERSION, checksum: hashCanonical({ type: DURABLE_BOOK_CODEC_VERSION, payload: JSON.stringify(body) }), body });
  const raw = field(field(body, "protocol"), "retainedResults");
  if (!Array.isArray(raw) || raw[0] !== "a") throw new Error("Expected retained array");
  const rows = (raw[1] as unknown[]).map((node) => {
    const decoded = decodeBookRow("protocol.retainedResults", JSON.stringify(node));
    if (decoded.disposition !== "decoded") throw new Error(decoded.message);
    return decoded.row;
  });
  const initial = decodeDurableBook(unpack(stored.initial));
  if (initial.disposition !== "decoded") throw new Error(initial.message);
  let aggregate: DurableBookAggregate = initial.aggregate;
  for (const row of rows.slice(initial.aggregate.protocol.retainedResults.length, -1)) {
    const result = executeBookCommand(aggregate.state, aggregate.protocol, row.command);
    expect(result.result.disposition).toBe("committed");
    aggregate = { state: result.state, protocol: result.protocol };
  }
  return { aggregate, original: rows.at(-1)!, encoded };
}

test("acquisition rejects incoherent carrying value, negative carrying and positive allowance atomically", () => {
  for (let index = 0; index < 3; index++) {
    const { aggregate, original } = fixture(index);
    const result = executeBookCommand(aggregate.state, aggregate.protocol, original.command);
    expect(result.result.disposition).toBe("rejected");
    expect(result.result.diagnostics[0]?.code).toBe("canonical_identity_conflict");
    expect(result.state).toBe(aggregate.state);
    const restored = decodeDurableBook(encodeDurableBook({ state: result.state, protocol: result.protocol }));
    if (restored.disposition !== "decoded") throw new Error(restored.message);
    expect(executeBookCommand(restored.aggregate.state, restored.aggregate.protocol, original.command).result.resultHash).toEqual(result.result.resultHash);
  }
});

test("a written-down inventory issue expenses carrying value and preserves authoritative basis separately", () => {
  const { aggregate, original } = fixture(3);
  const result = executeBookCommand(aggregate.state, aggregate.protocol, original.command);
  expect(result.result.disposition).toBe("committed");
  const journal = result.state.journals.at(-1)!.journal;
  expect(journal.postings.map((p) => [p.accountId, p.bookValue.amount.toRational().toString()])).toEqual([["account-expense", "8/1"], ["account-inventory", "-8/1"]]);
  expect(journal.postings[1]!.costBasis?.totalBasis.toString()).toBe("-10/1");
  const allocation = result.state.lotAllocations.at(-1)!.allocation;
  expect([allocation.allocatedTotalBasis.toString(), allocation.allocatedValuationAllowance.toString(), allocation.allocatedCarryingAmount.toString()]).toEqual(["10/1", "-2/1", "8/1"]);
  const holding = result.state.lotHoldings.find((h) => h.id === "audit-lot-a")!;
  expect([holding.remainingQuantity.toString(), holding.remainingTotalBasis.toString(), holding.remainingValuationAllowance.toString(), holding.remainingCarryingAmount.toString()]).toEqual(["0/1", "0/1", "0/1", "0/1"]);
  const inventoryBalance = result.state.journals.flatMap((j) => j.journal.postings).filter((p) => p.accountId === "account-inventory").reduce((sum, p) => sum.add(p.bookValue.amount.toRational()), R.zero());
  expect(inventoryBalance.toString()).toBe("0/1");
  expect(validateBookState(result.state)).toEqual([]);
  const restored = decodeDurableBook(encodeDurableBook({ state: result.state, protocol: result.protocol }));
  if (restored.disposition !== "decoded") throw new Error(restored.message);
  expect(executeBookCommand(restored.aggregate.state, restored.aggregate.protocol, original.command).result.resultHash).toEqual(result.result.resultHash);
});

test("partial inventory issues proportionally consume valuation allowance without double-expensing the write-down", () => {
  const { aggregate, original } = fixture(3);
  const template = original.command;
  if (template.type !== "postInventoryTransaction") throw new Error("Expected inventory issue");
  let current = aggregate;
  for (const index of [1, 2]) {
    const id = `carrying-half-${index}`;
    const quantity = R.of(1n, 2n);
    const command = sealCommand({ ...template, id: commandId(id), expectedBookRevision: current.state.bookRevision,
      request: { ...template.request, quantity, layers: template.request.layers.map((l) => { const h = current.state.lotHoldings.find((h) => h.id === l.id)!; return { ...l, quantity: h.remainingQuantity, totalBasis: h.remainingTotalBasis }; }) },
      lotOperations: template.lotOperations!.map((op) => { if (op.type !== "dispose") throw new Error("Expected disposal"); return { ...op, requestedQuantity: quantity, journalPostingId: postingId(`${id}-inventory`), identities: op.identities.map((identity) => ({ ...identity, allocationId: lotAllocationId(id) })) }; }),
    });
    const result = executeBookCommand(current.state, current.protocol, command);
    expect(result.result.disposition).toBe("committed");
    expect(result.state.journals.at(-1)!.journal.postings.map((p) => p.bookValue.amount.toRational().toString())).toEqual(["4/1", "-4/1"]);
    const allocation = result.state.lotAllocations.at(-1)!.allocation;
    expect([allocation.allocatedTotalBasis.toString(), allocation.allocatedValuationAllowance.toString(), allocation.allocatedCarryingAmount.toString()]).toEqual(["5/1", "-1/1", "4/1"]);
    current = { state: result.state, protocol: result.protocol };
  }
  expect(current.state.lotHoldings.find((h) => h.id === "audit-lot-a")!.remainingCarryingAmount.toString()).toBe("0/1");
  expect(validateBookState(current.state)).toEqual([]);
});

test("preserved corrupt carrying histories fail semantic recovery without modifying old receipts", () => {
  for (let index = 0; index < evidence.cases.length; index++) {
    const { encoded, original } = fixture(index);
    expect(original.outcome).toBe("committed");
    const restored = decodeDurableBook(encoded);
    expect(restored.disposition).toBe("rejected");
    if (restored.disposition !== "rejected") throw new Error("Accepted corrupt carrying history");
    expect(restored.message).toContain("Revision effects do not match the command's canonical effect topology");
  }
});
