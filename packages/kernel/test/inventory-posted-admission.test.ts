import { expect, test } from "bun:test";
import { decodeBookRow, decodeDurableBook, encodeDurableBook, executeBookCommand, validateBookState, resolveJournal, sealCommand, ExactDecimal, ExactRational, postingId, accountId, type DurableBookAggregate, type ResolvedTransaction } from "../src/index.ts";
import evidence from "./data/inventory-posted-admission-defect-legacy.json";

function unpack(record: { aggregateGzipBase64: string; sha256: string }): string {
  const raw = new TextDecoder().decode(Bun.gunzipSync(Buffer.from(record.aggregateGzipBase64, "base64")));
  expect(new Bun.CryptoHasher("sha256").update(raw).digest("hex")).toBe(record.sha256);
  return raw;
}
function field(node: unknown, key: string): unknown {
  if (!Array.isArray(node) || node[0] !== "o") throw new Error("Expected frozen object");
  const found = (node[1] as [string, unknown][]).find(([name]) => name === key);
  if (found === undefined) throw new Error("Missing frozen field");
  return found[1];
}
function fixture(index: number) {
  const encoded = unpack(evidence.cases[index]!);
  const array = field(field(JSON.parse(encoded).body, "protocol"), "retainedResults");
  if (!Array.isArray(array) || array[0] !== "a") throw new Error("Expected retained rows");
  const rows = (array[1] as unknown[]).map((node) => {
    const decoded = decodeBookRow("protocol.retainedResults", JSON.stringify(node));
    if (decoded.disposition !== "decoded") throw new Error(decoded.message);
    return decoded.row;
  });
  const initial = decodeDurableBook(unpack(evidence.initial));
  if (initial.disposition !== "decoded") throw new Error(initial.message);
  let aggregate: DurableBookAggregate = initial.aggregate;
  for (const row of rows.slice(0, -1)) {
    const result = executeBookCommand(aggregate.state, aggregate.protocol, row.command);
    expect(result.result.disposition).toBe("committed");
    expect(result.result.resultHash).toEqual(row.resultHash);
    aggregate = { state: result.state, protocol: result.protocol };
  }
  const original = rows.at(-1)!;
  if (original.command.type !== "postJournal") throw new Error("Expected captured journal");
  return { aggregate, encoded, command: original.command };
}

test("ordinary lot admission rejects reversed posted signs and unearned continuity transfer value atomically", () => {
  for (let index = 0; index < evidence.cases.length; index++) {
    const { aggregate, command } = fixture(index);
    const before = encodeDurableBook(aggregate);
    const result = executeBookCommand(aggregate.state, aggregate.protocol, command);
    expect(result.result.disposition).toBe("rejected");
    expect(result.result.diagnostics[0]?.code).toBe(index === 0 ? "canonical_identity_conflict" : "lot_overallocation");
    expect(result.state).toBe(aggregate.state);
    expect(encodeDurableBook(aggregate)).toBe(before);
    expect(result.protocol.retainedResults.length).toBe(aggregate.protocol.retainedResults.length + 1);
    const decoded = decodeDurableBook(encodeDurableBook({ state: result.state, protocol: result.protocol }));
    if (decoded.disposition !== "decoded") throw new Error(decoded.message);
    const retried = executeBookCommand(decoded.aggregate.state, decoded.aggregate.protocol, command);
    expect(retried.result.disposition).toBe("replayed");
    expect(retried.result.resultHash).toEqual(result.result.resultHash);
    expect(retried.state).toBe(decoded.aggregate.state);
  }
});

test("frozen formerly committed posted-value defects fail semantic aggregate recovery without rewriting them", () => {
  expect(evidence.sourceBookSha256).toBe("55f7ec407a3d913fdf4c0fcfd5898264b8a724df9c6c9ca2e130324cc1504680");
  for (let index = 0; index < evidence.cases.length; index++) {
    const { encoded } = fixture(index);
    const result = decodeDurableBook(encoded);
    expect(result.disposition).toBe("rejected");
    if (result.disposition === "decoded") throw new Error("Accepted historical corruption");
    expect(result.message).toBe("Revision effects do not match the command's canonical effect topology");
    expect(new Bun.CryptoHasher("sha256").update(encoded).digest("hex")).toBe(evidence.cases[index]!.sha256);
  }
});

test("posted-value checks preserve existing lot-validation diagnostic precedence", () => {
  const acquisition = fixture(0);
  const operation = acquisition.command.lotOperations![0]!;
  const duplicate = sealCommand({ ...acquisition.command, lotOperations: [operation, operation] });
  const rejected = executeBookCommand(acquisition.aggregate.state, acquisition.aggregate.protocol, duplicate);
  expect(rejected.result.disposition).toBe("rejected");
  expect(rejected.result.diagnostics[0]?.code).toBe("lot_overallocation");
  expect(rejected.result.diagnostics[0]?.message).toBe("Each lot-operation posting must be linked exactly once within a journal");
  expect(rejected.result.diagnostics[0]?.path).toBe("lotOperations[1]");
  expect(rejected.state).toBe(acquisition.aggregate.state);
  const transfer = fixture(2);
  const transferOperation = transfer.command.lotOperations![0]!;
  if (transferOperation.type !== "transfer") throw new Error("Expected transfer");
  for (const replacement of [{ ...transferOperation, policies: [] }, { ...transferOperation, sourceHoldingIds: [] }]) {
    const invalid = executeBookCommand(transfer.aggregate.state, transfer.aggregate.protocol, sealCommand({ ...transfer.command, lotOperations: [replacement] }));
    expect(invalid.result.disposition).toBe("rejected");
    expect(invalid.result.diagnostics[0]?.code).toBe(replacement.policies.length === 0 ? "transfer_policy_missing" : "lot_overallocation");
    expect(invalid.result.diagnostics[0]?.message).not.toContain("posted values");
    expect(invalid.state).toBe(transfer.aggregate.state);
  }
});

test("legacy zero-posting prohibition remains explicit and each continuity direction is independently enforced", () => {
  for (const index of [0, 1, 2]) {
    const { aggregate, command } = fixture(index);
    const journal = { ...command.resolved.journal, postings: command.resolved.journal.postings.map((posting) => ({ ...posting, bookValue: { ...posting.bookValue, amount: ExactDecimal.parse("0.00") } })) };
    const resolved = resolveJournal(journal, aggregate.state.policies, aggregate.state.identity.ownerId, aggregate.state.quantizationPolicies[0]!, journal.postings.map(() => ExactRational.zero()));
    if (Array.isArray(resolved)) throw new Error("Expected zero-value journal");
    const accepted = executeBookCommand(aggregate.state, aggregate.protocol, sealCommand({ ...command, resolved: resolved as ResolvedTransaction }));
    expect(accepted.result.disposition).toBe("rejected");
    expect(accepted.result.diagnostics[0]?.code).toBe("invalid_journal_structure");
    expect(accepted.state).toBe(aggregate.state);
    expect(validateBookState(accepted.state)).toEqual([]);
    const restored = decodeDurableBook(encodeDurableBook({ state: accepted.state, protocol: accepted.protocol }));
    expect(restored.disposition).toBe("decoded");
  }
  const { aggregate, command } = fixture(2);
  for (const sourcePositive of [false, true]) {
    const amount = ExactDecimal.parse(sourcePositive ? "3.00" : "-3.00");
    const postings = command.resolved.journal.postings.map((posting) => ({ ...posting, bookValue: { ...posting.bookValue, amount } }));
    const offset = postings[0]!;
    postings.push({ ...offset, id: postingId("offset-bad-direction"), ordinal: 2n, accountId: accountId("income"), units: { ...offset.units, canonicalNumber: ExactRational.of(sourcePositive ? -6n : 6n, 1n) }, bookValue: { ...offset.bookValue, amount: ExactDecimal.parse(sourcePositive ? "-6.00" : "6.00") } });
    const journal = { ...command.resolved.journal, postings };
    const resolved = resolveJournal(journal, aggregate.state.policies, aggregate.state.identity.ownerId, aggregate.state.quantizationPolicies[0]!, postings.map((posting) => posting.bookValue.amount.toRational()));
    if (Array.isArray(resolved)) throw new Error("Expected balanced hostile journal");
    const rejected = executeBookCommand(aggregate.state, aggregate.protocol, sealCommand({ ...command, resolved: resolved as ResolvedTransaction }));
    expect(rejected.result.disposition).toBe("rejected");
    expect(rejected.result.diagnostics[0]?.code).toBe("lot_overallocation");
    expect(rejected.state).toBe(aggregate.state);
  }
});
