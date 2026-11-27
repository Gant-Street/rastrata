import { expect, test } from "bun:test";
import {
  decodeBookRow, decodeDurableBook, encodeDurableBook, executeBookCommand,
  validateBookState, sealCommand, resolveJournal, ExactRational,
  type DurableBookAggregate, type ResolvedTransaction,
} from "../src/index.ts";
import evidence from "./data/lot-posting-defect-legacy.json";

function unpack(record: { aggregateGzipBase64: string; sha256: string }): string {
  const text = new TextDecoder().decode(Bun.gunzipSync(Buffer.from(record.aggregateGzipBase64, "base64")));
  expect(new Bun.CryptoHasher("sha256").update(text).digest("hex")).toBe(record.sha256);
  return text;
}
function field(node: unknown, name: string): unknown {
  if (!Array.isArray(node) || node[0] !== "o") throw new Error("Expected frozen object node");
  const found = (node[1] as [string, unknown][]).find(([key]) => key === name);
  if (found === undefined) throw new Error("Missing frozen field");
  return found[1];
}
function fixture(index: number) {
  const stored = evidence.cases[index]!;
  const encoded = unpack(stored);
  const rawRows = field(field(JSON.parse(encoded).body, "protocol"), "retainedResults");
  if (!Array.isArray(rawRows) || rawRows[0] !== "a") throw new Error("Expected retained rows");
  const rows = (rawRows[1] as unknown[]).map((node) => {
    const result = decodeBookRow("protocol.retainedResults", JSON.stringify(node));
    if (result.disposition !== "decoded") throw new Error(result.message);
    return result.row;
  });
  const initial = decodeDurableBook(unpack(evidence.initial));
  if (initial.disposition !== "decoded") throw new Error(initial.message);
  let aggregate: DurableBookAggregate = initial.aggregate;
  for (const row of rows.slice(0, -1)) {
    const result = executeBookCommand(aggregate.state, aggregate.protocol, row.command);
    expect(result.result.disposition).toBe("committed");
    aggregate = { state: result.state, protocol: result.protocol };
  }
  return { aggregate, encoded, stored, original: rows.at(-1)! };
}

test("lot operations reject mismatched posting coordinates, basis and multiply consumed postings", () => {
  for (let index = 0; index < evidence.cases.length; index++) {
    const { aggregate, original } = fixture(index);
    const result = executeBookCommand(aggregate.state, aggregate.protocol, original.command);
    expect(result.result.disposition).toBe("rejected");
    expect(result.result.diagnostics[0]?.code).toBe("lot_overallocation");
    expect(result.state).toBe(aggregate.state);
    expect(validateBookState(result.state)).toEqual([]);
    const restored = decodeDurableBook(encodeDurableBook({ state: result.state, protocol: result.protocol }));
    if (restored.disposition !== "decoded") throw new Error(restored.message);
    const retry = executeBookCommand(restored.aggregate.state, restored.aggregate.protocol, original.command);
    expect(retry.result.disposition).toBe("replayed");
    expect(retry.result.resultHash).toEqual(result.result.resultHash);
    expect(retry.result.diagnostics).toEqual(result.result.diagnostics);
  }
});

test("frozen pre-fix lot/posting discrepancies are not admitted or silently rewritten during recovery", () => {
  for (let index = 0; index < evidence.cases.length; index++) {
    const { encoded, original, stored } = fixture(index);
    expect(original.outcome).toBe("committed");
    expect(original.diagnostics).toEqual([]);
    const restored = decodeDurableBook(encoded);
    expect(restored.disposition).toBe("rejected");
    if (restored.disposition !== "rejected") throw new Error("Defective history was admitted");
    expect(restored.message).toContain("Revision effects do not match the command's canonical effect topology");
    expect(new Bun.CryptoHasher("sha256").update(encoded).digest("hex")).toBe(stored.sha256);
  }
});

test("transfer basis annotations are optional but any supplied source and destination basis must match", () => {
  const { aggregate, original } = fixture(2);
  const template = original.command;
  if (template.type !== "postJournal") throw new Error("Expected transfer");
  for (const mode of ["absent", "exact", "bad-source-sign", "bad-destination", "bad-destination-sign"] as const) {
    const journal = { ...template.resolved.journal, postings: template.resolved.journal.postings.map((posting, index) => {
      const { costBasis: _basis, ...rest } = posting;
      const amount = index === 0 ? (mode === "bad-source-sign" ? 3n : -3n) : mode === "bad-destination" ? 99n : mode === "bad-destination-sign" ? -3n : 3n;
      return mode === "absent" ? rest : { ...rest, costBasis: { basisCommodityId: aggregate.state.identity.functionalCommodityId, totalBasis: ExactRational.of(amount, 1n) } };
    }) };
    const resolved = resolveJournal(journal, aggregate.state.policies, aggregate.state.identity.ownerId, aggregate.state.quantizationPolicies[0]!, journal.postings.map((posting) => posting.bookValue.amount.toRational()));
    if (Array.isArray(resolved)) throw new Error("Expected resolved transfer");
    const command = sealCommand({ ...template, resolved: resolved as ResolvedTransaction });
    const result = executeBookCommand(aggregate.state, aggregate.protocol, command);
    if (mode === "absent" || mode === "exact") {
      expect(result.result.disposition).toBe("committed");
      expect(result.state.lotHoldings.map((h) => [h.id, h.remainingQuantity.toString(), h.remainingTotalBasis.toString()])).toEqual([["lot-first", "7/1", "7/1"], ["lot-second", "7/1", "7/1"], ["lot-destination", "3/1", "3/1"]]);
      expect(validateBookState(result.state)).toEqual([]);
    } else {
      expect(result.result.disposition).toBe("rejected");
      expect(result.result.diagnostics[0]?.code).toBe("lot_overallocation");
      expect(result.state).toBe(aggregate.state);
    }
  }
});
