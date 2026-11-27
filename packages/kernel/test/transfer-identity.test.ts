import { expect, test } from "bun:test";
import {
  decodeDurableBook, decodeBookRow, encodeDurableBook, executeBookCommand,
  validateBookState, transferLots, sealCommand, lotHoldingId, ExactRational,
  type BookCommand, type DurableBookAggregate, resolveJournal, type ResolvedTransaction,
  lotId, postingId, commandId, lotAllocationId, journalId,
} from "../src/index.ts";
import evidence from "./data/transfer-defect-legacy.json";

function unpack(encoded: string, sha256: string): string {
  const text = new TextDecoder().decode(Bun.gunzipSync(Buffer.from(encoded, "base64")));
  expect(new Bun.CryptoHasher("sha256").update(text).digest("hex")).toBe(sha256);
  return text;
}
function field(node: unknown, name: string): unknown {
  if (!Array.isArray(node) || node[0] !== "o") throw new Error("Expected frozen object node");
  const found = (node[1] as [string, unknown][]).find(([key]) => key === name);
  if (found === undefined) throw new Error("Missing frozen field");
  return found[1];
}
function array(node: unknown): unknown[] {
  if (!Array.isArray(node) || node[0] !== "a") throw new Error("Expected frozen array node");
  return node[1] as unknown[];
}
function fixture(index: number) {
  const stored = evidence.cases[index]!;
  const encoded = unpack(stored.aggregateGzipBase64, stored.sha256);
  const body: unknown = JSON.parse(encoded).body;
  // Row decoding establishes structure only. The old aggregate must FAIL the
  // accounting validation below; these rows are not an admitted book snapshot.
  const rows = array(field(field(body, "protocol"), "retainedResults")).map((node) => {
    const result = decodeBookRow("protocol.retainedResults", JSON.stringify(node));
    if (result.disposition !== "decoded") throw new Error(result.message);
    return result.row;
  });
  const initial = decodeDurableBook(unpack(evidence.initialGzipBase64, evidence.initialSha256));
  if (initial.disposition !== "decoded") throw new Error(initial.message);
  let aggregate: DurableBookAggregate = initial.aggregate;
  for (const row of rows.slice(0, -1)) {
    const result = executeBookCommand(aggregate.state, aggregate.protocol, row.command);
    expect(result.result.disposition).toBe("committed");
    aggregate = { state: result.state, protocol: result.protocol };
  }
  return { encoded, stored, aggregate, original: rows.at(-1)!, body, rows };
}

test("transfer ID collisions and same-account continuity reject without changing quantities or basis", () => {
  for (let index = 0; index < evidence.cases.length; index++) {
    const { aggregate, original, stored } = fixture(index);
    const before = aggregate.state;
    const result = executeBookCommand(before, aggregate.protocol, original.command);
    expect(result.result.disposition).toBe("rejected");
    expect(result.result.diagnostics[0]?.code).toBe(stored.name === "same-account" ? "lot_overallocation" : "canonical_identity_conflict");
    expect(result.state).toBe(before);
    expect(result.state.lotHoldings.reduce((sum, h) => sum.add(h.remainingQuantity), ExactRational.zero()).toString()).toBe("17/1");
    expect(result.state.lotHoldings.reduce((sum, h) => sum.add(h.remainingTotalBasis), ExactRational.zero()).toString()).toBe("17/1");
    expect(result.protocol.retainedResults.length).toBe(aggregate.protocol.retainedResults.length + 1);
    expect(validateBookState(result.state)).toEqual([]);
    const restored = decodeDurableBook(encodeDurableBook({ state: result.state, protocol: result.protocol }));
    if (restored.disposition !== "decoded") throw new Error(restored.message);
    const retry = executeBookCommand(restored.aggregate.state, restored.aggregate.protocol, original.command);
    expect(retry.result.disposition).toBe("replayed");
    expect(retry.result.resultHash).toEqual(result.result.resultHash);
    expect(retry.result.diagnostics).toEqual(result.result.diagnostics);
  }
});

test("transfer destination identity includes depleted holdings and same-command acquisitions", () => {
  for (const mode of ["depleted", "pending"] as const) {
    const { aggregate, original, rows } = fixture(0);
    const template = original.command;
    const acquisition = rows[2]!.command;
    if (template.type !== "postJournal" || acquisition.type !== "postJournal") throw new Error("Expected journals");
    const transfer = template.lotOperations?.[0];
    const acquire = acquisition.lotOperations?.[0];
    if (transfer?.type !== "transfer" || acquire?.type !== "acquire") throw new Error("Expected lot operations");
    const occupiedId = lotHoldingId(mode === "depleted" ? "lot-second" : "pending-holding");
    let before = aggregate;
    if (mode === "depleted") {
      const postings = acquisition.resolved.journal.postings.map((p) => ({
        ...p, units: { ...p.units, canonicalNumber: p.units.canonicalNumber.negate() },
        bookValue: { ...p.bookValue, amount: p.bookValue.amount.negate() },
        ...(p.costBasis === undefined ? {} : { costBasis: { ...p.costBasis, totalBasis: p.costBasis.totalBasis.negate() } }),
      }));
      const journal = { ...template.resolved.journal, postings };
      // Fresh financial IDs: only the holding identity is deliberately retained.
      journal.postings = journal.postings.map((p, index) => ({ ...p, id: postingId(`drain-${index}`) }));
      const resolved = resolveJournal(journal, before.state.policies, before.state.identity.ownerId, before.state.quantizationPolicies[0]!, journal.postings.map((p) => p.bookValue.amount.toRational()));
      if (Array.isArray(resolved)) throw new Error("Drain must resolve");
      const result = executeBookCommand(before.state, before.protocol, sealCommand({ ...template, id: commandId("drain-second"), resolved: resolved as ResolvedTransaction, lotOperations: [{ type: "dispose", holdingIds: [occupiedId], requestedQuantity: ExactRational.of(7n, 1n), selection: { method: "specificIdentification", allocations: [{ holdingId: occupiedId, quantity: ExactRational.of(7n, 1n) }] }, derivation: transfer.derivation, identities: [{ holdingId: occupiedId, allocationId: lotAllocationId("drain-allocation") }], journalPostingId: journal.postings[0]!.id }] }));
      expect(result.result.disposition).toBe("committed");
      before = { state: result.state, protocol: result.protocol };
      expect(before.state.lotHoldings.find((h) => h.id === occupiedId)?.remainingQuantity.toString()).toBe("0/1");
    }
    const pendingPostingId = postingId("pending-acquisition");
    const pendingPostings = mode === "pending" ? acquisition.resolved.journal.postings.map((p, index) => ({ ...p, id: index === 0 ? pendingPostingId : postingId("pending-offset") })) : [];
    const journal = { ...acquisition.resolved.journal, id: template.resolved.journal.id, postings: [...template.resolved.journal.postings, ...pendingPostings].map((posting, index) => ({ ...posting, ordinal: BigInt(index) })) };
    journal.id = journalId(`${template.resolved.journal.id}-${mode}`);
    const resolved = resolveJournal(journal, before.state.policies, before.state.identity.ownerId, before.state.quantizationPolicies[0]!, journal.postings.map((p) => p.bookValue.amount.toRational()));
    if (Array.isArray(resolved)) throw new Error("Transfer must resolve");
    const pending = { ...acquire, journalPostingId: pendingPostingId, lot: { ...acquire.lot, id: lotId("pending-lot") }, holding: { ...acquire.holding, id: occupiedId, lotId: lotId("pending-lot") } };
    const command = sealCommand({ ...template, expectedBookRevision: before.state.bookRevision, resolved: resolved as ResolvedTransaction, lotOperations: [...(mode === "pending" ? [pending] : []), { ...transfer, destinationIdentities: transfer.destinationIdentities.map((id) => ({ ...id, destinationHoldingId: occupiedId })) }] });
    const result = executeBookCommand(before.state, before.protocol, command);
    expect(result.result.disposition).toBe("rejected");
    expect(result.result.diagnostics[0]?.code).toBe("canonical_identity_conflict");
    expect(result.result.diagnostics[0]?.path).toBe(`lotOperations[${mode === "pending" ? 1 : 0}].destinationIdentities`);
    expect(result.state).toBe(before.state);
  }
});

test("frozen defective histories retain their original bytes and committed outcomes but fail recovery", () => {
  for (let index = 0; index < evidence.cases.length; index++) {
    const { encoded, original, stored, body } = fixture(index);
    expect(original.outcome).toBe("committed");
    expect(original.diagnostics).toEqual([]);
    const quantities = array(field(field(body, "state"), "lotHoldings")).map((node) => {
      const result = decodeBookRow("state.lotHoldings", JSON.stringify(node));
      if (result.disposition !== "decoded") throw new Error(result.message);
      return result.row.remainingQuantity;
    });
    expect(quantities.reduce((sum, q) => sum.add(q), ExactRational.zero()).toString()).toBe(stored.name === "same-account" ? "20/1" : "10/1");
    const restored = decodeDurableBook(encoded);
    expect(restored.disposition).toBe("rejected");
    if (restored.disposition !== "rejected") throw new Error("Defective history was admitted");
    expect(restored.message).toContain("Revision effects do not match the command's canonical effect topology");
    expect(new Bun.CryptoHasher("sha256").update(encoded).digest("hex")).toBe(stored.sha256);
  }
});

test("lot calculator rejects source/destination ID aliasing while fresh destination identity conserves value", () => {
  const { aggregate, original } = fixture(0);
  const command = original.command;
  if (command.type !== "postJournal") throw new Error("Expected transfer command");
  const operation = command.lotOperations?.[0];
  if (operation?.type !== "transfer") throw new Error("Expected transfer operation");
  const source = aggregate.state.lotHoldings.filter((holding) => operation.sourceHoldingIds.includes(holding.id));
  const duplicateDestination = source.map((holding) => ({ ...holding, accountId: operation.destinationAccountId }));
  const invalid = transferLots(source, duplicateDestination, aggregate.state.lots, operation.requestedQuantity, operation.selection, operation.policies, operation.governedAt, operation.destinationAccountId, operation.derivation, operation.allocationIdentities, operation.destinationIdentities);
  expect(invalid.disposition).toBe("rejected");
  if (invalid.disposition !== "rejected") throw new Error("Aliased populations admitted");
  expect(invalid.diagnostics[0]?.code).toBe("canonical_identity_conflict");
  const valid: BookCommand = sealCommand({ ...command, lotOperations: [{ ...operation, destinationIdentities: operation.destinationIdentities.map((id) => ({ ...id, destinationHoldingId: lotHoldingId("fresh-destination") })) }] });
  const result = executeBookCommand(aggregate.state, aggregate.protocol, valid);
  expect(result.result.disposition).toBe("committed");
  expect(result.state.lotHoldings.map((h) => [h.id, h.remainingQuantity.toString(), h.remainingTotalBasis.toString()])).toEqual([["lot-first", "7/1", "7/1"], ["lot-second", "7/1", "7/1"], ["fresh-destination", "3/1", "3/1"]]);
  expect(validateBookState(result.state)).toEqual([]);
});
