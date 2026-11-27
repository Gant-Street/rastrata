import { expect, test } from "bun:test";
import {
  BOOK_OUTCOME_CODEC_VERSION, decodeBookOutcome, encodeBookOutcome, decodeDurableBook,
  encodeDurableBook, executeBookCommand, hashCanonical, commandId, sealCommand,
  assertBookCommandShape, bookId, semanticVersion, type AtomicBookCommit, type BookOutcomePayload, type ContentHash,
} from "../src/index.ts";
import { freshState } from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";

function payload(commit: AtomicBookCommit): BookOutcomePayload {
  const retained = commit.protocol.retainedResults.at(-1);
  if (!retained || commit.result.disposition === "replayed") throw new Error("Missing retained outcome");
  return { command: retained.command, originalResult: { ...commit.result, disposition: commit.result.disposition },
    revision: commit.result.disposition === "committed" ? commit.state.revisions.at(-1) ?? null : null };
}
function sample() {
  const fresh = freshState();
  const accepted = executeBookCommand(fresh.state, fresh.protocol, activationCommand());
  const rejected = executeBookCommand(accepted.state, accepted.protocol, activationCommand("rejected-activation", 1n));
  return { fresh, accepted: payload(accepted), rejected: payload(rejected), acceptedState: accepted };
}

test("invalid hash and foreign-book requests cannot poison a durable protocol or claim an ID", () => {
  const fresh = freshState();
  const command = activationCommand();
  const invalidCommands = [
    { ...command, inputHash: hashCanonical("incorrect input") },
    sealCommand({ ...command, bookId: bookId("another-book") }),
    sealCommand({ ...command, bookId: bookId("another-book"), protocolVersion: semanticVersion("9.0.0") }),
  ];
  for (const invalid of invalidCommands) {
    const next = executeBookCommand(fresh.state, fresh.protocol, invalid);
    expect(next.result.disposition).toBe("rejected");
    expect(next.result.diagnostics[0]?.code).toBe(invalid.bookId === command.bookId ? "command_identity_conflict" : "book_isolation_violation");
    expect(next.state).toBe(fresh.state);
    expect(next.protocol).toBe(fresh.protocol);
    const aggregate = { state: next.state, protocol: next.protocol };
    expect(encodeDurableBook(aggregate)).toBe(encodeDurableBook(fresh));
    expect(decodeDurableBook(encodeDurableBook(aggregate)).disposition).toBe("decoded");
    const corrected = executeBookCommand(next.state, next.protocol, command);
    expect(corrected.result.disposition).toBe("committed");
    expect(corrected.protocol.retainedResults.length).toBe(1);
  }
  const unsupported = sealCommand({ ...command, protocolVersion: semanticVersion("9.0.0") });
  const rejected = executeBookCommand(fresh.state, fresh.protocol, unsupported);
  expect(rejected.result.disposition).toBe("rejected");
  expect(rejected.protocol.retainedResults.length).toBe(1);
  expect(decodeDurableBook(encodeDurableBook({ state: rejected.state, protocol: rejected.protocol })).disposition).toBe("decoded");
  const retry = executeBookCommand(rejected.state, rejected.protocol, unsupported);
  expect(retry.result.disposition).toBe("replayed");
  expect(retry.result.resultHash).toEqual(rejected.result.resultHash);
  const inconsistentState = { ...fresh.state, admissionSnapshot: { ...fresh.state.admissionSnapshot, bookId: bookId("another-book") } };
  const inconsistent = executeBookCommand(inconsistentState, fresh.protocol, command);
  expect(inconsistent.result.disposition).toBe("rejected");
  expect(inconsistent.result.diagnostics[0]?.code).toBe("book_isolation_violation");
  expect(inconsistent.state).toBe(inconsistentState);
});

test("standalone command schema uses the same exact durable field admission", () => {
  const command = activationCommand();
  expect(() => assertBookCommandShape(command)).not.toThrow();
  const extraField = { ...command, extra: "unknown" };
  expect(() => assertBookCommandShape(extraField)).toThrow("command.extra is not admitted");
  expect(() => assertBookCommandShape({ ...command, inputHash: { ...command.inputHash, digest: "invalid" } })).toThrow();
});
type Node = [string, ...unknown[]];
type Envelope = { version: string; checksum: ContentHash; body: Node };
function pairs(node: Node) { return node[1] as [string, Node][]; }
function field(node: Node, key: string): Node {
  const value = pairs(node).find(([name]) => name === key)?.[1];
  if (!value) throw new Error(`Missing fixture field ${key}`);
  return value;
}
function add(node: Node, key: string, value: Node) {
  pairs(node).push([key, value]);
  pairs(node).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}
function rewrite(encoded: string, change: (envelope: Envelope) => void) {
  const envelope = JSON.parse(encoded) as Envelope;
  change(envelope);
  envelope.checksum = hashCanonical({ type: envelope.version, payload: JSON.stringify(envelope.body) });
  return JSON.stringify(envelope);
}

test("single-outcome codec preserves committed and rejected payloads without an aggregate", () => {
  const s = sample();
  for (const source of [s.accepted, s.rejected]) {
    const encoded = encodeBookOutcome(source);
    const decoded = decodeBookOutcome(encoded);
    expect(decoded.disposition).toBe("decoded");
    if (decoded.disposition !== "decoded") throw new Error(decoded.message);
    expect(encodeBookOutcome(decoded.payload)).toBe(encoded);
    expect(decoded.payload.originalResult).toEqual(source.originalResult);
    expect(decoded.payload.revision?.chainHash ?? null).toEqual(source.revision?.chainHash ?? null);
    expect(Object.keys(decoded.payload).sort()).toEqual(["command", "originalResult", "revision"]);
    expect(Object.isFrozen(decoded.payload.command)).toBe(true);
  }
  const ordinaryName = sealCommand({ ...activationCommand(), id: commandId("constructor") });
  expect(decodeBookOutcome(encodeBookOutcome(payload(executeBookCommand(s.fresh.state, s.fresh.protocol, ordinaryName)))).disposition).toBe("decoded");
  const genesisRejected = executeBookCommand(s.fresh.state, s.fresh.protocol, sealCommand({ ...activationCommand(), protocolVersion: semanticVersion("9.0.0") }));
  expect(decodeBookOutcome(encodeBookOutcome(payload(genesisRejected))).disposition).toBe("decoded");
});

test("fixed schemas reject inherited property names without rejecting ordinary string IDs", () => {
  const s = sample();
  for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    for (const path of [[], ["command"], ["originalResult"], ["revision"]]) {
      const damaged = rewrite(encodeBookOutcome(s.accepted), (envelope) => {
        let node = envelope.body;
        for (const name of path) node = field(node, name);
        add(node, key, ["s", "unadmitted"]);
      });
      expect(decodeBookOutcome(damaged).disposition).toBe("rejected");
    }
    const aggregate = rewrite(encodeDurableBook({ state: s.acceptedState.state, protocol: s.acceptedState.protocol }), (envelope) => add(envelope.body, key, ["s", "unadmitted"]));
    expect(decodeDurableBook(aggregate).disposition).toBe("rejected");
  }
  const badVariant = rewrite(encodeBookOutcome(s.accepted), (envelope) => { field(field(envelope.body, "command"), "type")[1] = "constructor"; });
  expect(decodeBookOutcome(badVariant).disposition).toBe("rejected");
});

test("outcome shape and exact framing reject altered versions, hashes, duplicate keys and noncanonical numbers", () => {
  const encoded = encodeBookOutcome(sample().accepted);
  for (const source of [
    "null", "{broken", encoded + " ",
    encoded.replace('{"version":', `{"version":"${BOOK_OUTCOME_CODEC_VERSION}","version":`),
    rewrite(encoded, (envelope) => { envelope.version = "other"; }),
    encoded.replace('"algorithm":"sha256"', '"algorithm":"sha1"'),
    encoded.replace('"digest":"', '"digest":"0'),
    rewrite(encoded, (envelope) => { field(field(envelope.body, "command"), "expectedBookRevision")[1] = "-0"; }),
    rewrite(encoded, (envelope) => { field(field(envelope.body, "originalResult"), "disposition")[1] = "replayed"; }),
  ]) expect(decodeBookOutcome(source).disposition).toBe("rejected");
  const checksumMismatch = JSON.parse(encoded) as Envelope;
  checksumMismatch.checksum = hashCanonical("different");
  expect(decodeBookOutcome(JSON.stringify(checksumMismatch)).disposition).toBe("rejected");
  const throwingInput = { get length() { throw "non-error fixture failure"; } } as unknown as string;
  expect(decodeBookOutcome(throwingInput)).toEqual({ disposition: "rejected", message: "Unknown outcome decode failure" });
});

test("outcome cross-fields distinguish financial revisions from retained rejections", () => {
  const s = sample();
  const revision = s.accepted.revision;
  if (!revision) throw new Error("Missing revision");
  const invalid: unknown[] = [
    { ...s.accepted, revision: null },
    { ...s.accepted, originalResult: { ...s.accepted.originalResult, observedBookRevision: -1n } },
    { ...s.accepted, originalResult: { ...s.accepted.originalResult, completedAt: "2026-01-02T00:00:00Z" } },
    { ...s.accepted, revision: { ...revision, bookId: "other" } },
    { ...s.accepted, revision: { ...revision, bookRevision: revision.bookRevision + 1n } },
    { ...s.accepted, revision: { ...revision, committedAt: "2026-01-02T00:00:00Z" } },
    { ...s.accepted, originalResult: { ...s.accepted.originalResult, committedAt: "2026-01-02T00:00:00Z" } },
    { ...s.accepted, revision: { ...revision, command: { ...revision.command, id: "other" } } },
    { ...s.rejected, revision },
    { ...s.rejected, originalResult: { ...s.rejected.originalResult, committedAt: s.rejected.command.committedAt } },
  ];
  for (const value of invalid) expect(() => encodeBookOutcome(value as BookOutcomePayload)).toThrow();
});

test("outcome codec enforces its byte bound for trusted encoding and untrusted decoding", () => {
  const s = sample();
  const diagnostic = s.rejected.originalResult.diagnostics[0];
  if (!diagnostic) throw new Error("Missing rejection diagnostic");
  const oversized = { ...s.rejected, originalResult: { ...s.rejected.originalResult, diagnostics: [{ ...diagnostic, message: "x".repeat(1_048_576) }] } };
  expect(() => encodeBookOutcome(oversized)).toThrow("Book outcome exceeds the byte limit");
  expect(decodeBookOutcome(" ".repeat(1_048_577)).disposition).toBe("rejected");
  expect(decodeBookOutcome("€".repeat(400_000)).disposition).toBe("rejected");
  const sized = (message: string): BookOutcomePayload => ({ ...s.rejected, originalResult: {
    ...s.rejected.originalResult, diagnostics: [{ ...diagnostic, message }],
  } });
  const overhead = new TextEncoder().encode(encodeBookOutcome(sized(""))).length;
  const boundary = encodeBookOutcome(sized("x".repeat(1_048_576 - overhead)));
  expect(new TextEncoder().encode(boundary).length).toBe(1_048_576);
  expect(decodeBookOutcome(boundary).disposition).toBe("decoded");
  expect(() => encodeBookOutcome(sized("x".repeat(1_048_577 - overhead)))).toThrow("Book outcome exceeds the byte limit");
});
