import { describe, expect, test } from "bun:test";
import {
  BOOK_OUTCOME_CODEC_VERSION,
  decodeBookOutcome,
  decodeStoredBookOutcome,
  encodeBookOutcome,
  executeBookCommand,
  hashCanonical,
  semanticVersion,
  sealCommand,
  type AtomicBookCommit,
  type BookOutcomePayload,
  type ContentHash,
} from "../src/index.ts";
import { freshState } from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";

function payload(commit: AtomicBookCommit): BookOutcomePayload {
  const retained = commit.protocol.retainedResults.at(-1);
  if (!retained || commit.result.disposition === "replayed") throw new Error("Missing retained outcome");
  return {
    command: retained.command,
    originalResult: { ...commit.result, disposition: commit.result.disposition },
    revision: commit.result.disposition === "committed" ? (commit.state.revisions.at(-1) ?? null) : null,
  };
}

function sample() {
  const fresh = freshState();
  const accepted = executeBookCommand(fresh.state, fresh.protocol, activationCommand());
  const rejected = executeBookCommand(accepted.state, accepted.protocol, activationCommand("rejected-activation", 1n));
  const unsupported = executeBookCommand(fresh.state, fresh.protocol, sealCommand({ ...activationCommand(), protocolVersion: semanticVersion("9.0.0") }));
  return { accepted: payload(accepted), rejected: payload(rejected), unsupported: payload(unsupported) };
}

type Node = [string, ...unknown[]];
type Envelope = { version: string; checksum: ContentHash; body: Node };
const pairs = (node: Node) => node[1] as [string, Node][];
function field(node: Node, key: string): Node {
  const value = pairs(node).find(([name]) => name === key)?.[1];
  if (!value) throw new Error(`Missing fixture field ${key}`);
  return value;
}
/** The envelope after `change`, with a checksum that is right for the changed body. */
function rewrite(encoded: string, change: (envelope: Envelope) => void) {
  const envelope = JSON.parse(encoded) as Envelope;
  change(envelope);
  envelope.checksum = hashCanonical({ type: envelope.version, payload: JSON.stringify(envelope.body) });
  return JSON.stringify(envelope);
}

describe("decoding an outcome a ledger stored", () => {
  const s = sample();
  const encodings = Object.entries(s).map(([name, value]) => [name, encodeBookOutcome(value)] as const);

  test("gives the payload the canonical decode gives, immutable, and one that encodes back to the text", () => {
    for (const [name, encoded] of encodings) {
      const canonical = decodeBookOutcome(encoded);
      const stored = decodeStoredBookOutcome(encoded);
      if (canonical.disposition !== "decoded" || stored.disposition !== "decoded") throw new Error(name);
      expect(stored.payload, name).toEqual(canonical.payload);
      expect(encodeBookOutcome(stored.payload), name).toBe(encoded);
      expect(Object.isFrozen(stored), name).toBe(true);
      expect(Object.isFrozen(stored.payload), name).toBe(true);
      expect(Object.isFrozen(stored.payload.command), name).toBe(true);
      expect(Object.keys(stored.payload).sort(), name).toEqual(["command", "originalResult", "revision"]);
    }
    expect(s.accepted.revision).not.toBeNull();
    expect(s.rejected.revision).toBeNull();
  });

  test("accepts a text that decodes but is not the canonical encoding, which the canonical decode refuses", () => {
    const encoded = encodeBookOutcome(s.accepted);
    const envelope = JSON.parse(encoded) as Envelope;
    const texts = {
      "indented": JSON.stringify(envelope, null, 2),
      "trailing space": `${encoded} `,
      "members in another order": JSON.stringify({ body: envelope.body, checksum: envelope.checksum, version: envelope.version }),
      "a repeated member": encoded.replace('{"version":', `{"version":"${BOOK_OUTCOME_CODEC_VERSION}","version":`),
      "a number written another way": rewrite(encoded, (envelope) => { field(field(envelope.body, "command"), "expectedBookRevision")[1] = "-0"; }),
    };
    for (const [name, text] of Object.entries(texts)) {
      expect(decodeBookOutcome(text), name).toEqual({ disposition: "rejected", message: "Book outcome encoding is not canonical" });
      const stored = decodeStoredBookOutcome(text);
      if (stored.disposition !== "decoded") throw new Error(`${name}: ${stored.message}`);
      expect(encodeBookOutcome(stored.payload), name).toBe(encoded);
    }
  });

  test("refuses what the canonical decode refuses of the text itself: framing, version, hashes and schema", () => {
    const encoded = encodeBookOutcome(s.accepted);
    const damaged: Record<string, string> = {
      "null": "null",
      "broken json": "{broken",
      "another version": rewrite(encoded, (envelope) => { envelope.version = "other"; }),
      "another hash algorithm": encoded.replace('"algorithm":"sha256"', '"algorithm":"sha1"'),
      "a digest that is not one": encoded.replace('"digest":"', '"digest":"0'),
      "a disposition that is not stored": rewrite(encoded, (envelope) => { field(field(envelope.body, "originalResult"), "disposition")[1] = "replayed"; }),
      "an unadmitted member": rewrite(encoded, (envelope) => { pairs(envelope.body).push(["extra", ["s", "unadmitted"]]); }),
      "an inherited member name": rewrite(encoded, (envelope) => { pairs(envelope.body).push(["constructor", ["s", "unadmitted"]]); }),
    };
    const wrongChecksum = JSON.parse(encoded) as Envelope;
    wrongChecksum.checksum = hashCanonical("different");
    damaged["a checksum of other content"] = JSON.stringify(wrongChecksum);
    for (const [name, text] of Object.entries(damaged)) {
      expect(decodeBookOutcome(text).disposition, name).toBe("rejected");
      const stored = decodeStoredBookOutcome(text);
      expect(stored.disposition, name).toBe("rejected");
    }
    const mismatch = decodeStoredBookOutcome(JSON.stringify(wrongChecksum));
    expect(mismatch).toEqual({ disposition: "rejected", message: "Book outcome checksum does not match its content" });
    const throwingInput = { get length() { throw "non-error fixture failure"; } } as unknown as string;
    expect(decodeStoredBookOutcome(throwingInput)).toEqual({ disposition: "rejected", message: "Unknown outcome decode failure" });
    expect(Object.isFrozen(decodeStoredBookOutcome("null"))).toBe(true);
  });

  test("checks the envelope on its own: its version and its members, not only the checksum that depends on them", () => {
    const encoded = encodeBookOutcome(s.accepted);
    const envelope = JSON.parse(encoded) as Envelope;
    // The checksum is made for the right codec version, so only the envelope's own schema can object.
    const checksum = hashCanonical({ type: BOOK_OUTCOME_CODEC_VERSION, payload: JSON.stringify(envelope.body) });
    const texts = {
      "another version": JSON.stringify({ ...envelope, version: "other", checksum }),
      "an unadmitted member": JSON.stringify({ ...envelope, extra: 1 }),
      "no body": JSON.stringify({ version: envelope.version, checksum: envelope.checksum }),
    };
    for (const [name, text] of Object.entries(texts)) {
      expect(decodeBookOutcome(text).disposition, name).toBe("rejected");
      expect(decodeStoredBookOutcome(text).disposition, name).toBe("rejected");
    }
  });

  test("still refuses an outcome whose command, result and revision do not agree", () => {
    const encoded = encodeBookOutcome(s.accepted);
    const changes: Record<string, (envelope: Envelope) => void> = {
      "a revision of another number": (envelope) => { field(field(envelope.body, "revision"), "bookRevision")[1] = "9"; },
      "a result that observes another revision": (envelope) => { field(field(envelope.body, "originalResult"), "observedBookRevision")[1] = "9"; },
      "a revision of another command": (envelope) => { field(field(field(envelope.body, "revision"), "command"), "id")[1] = "another-command"; },
    };
    for (const [name, change] of Object.entries(changes)) {
      const text = rewrite(encoded, change);
      expect(decodeBookOutcome(text).disposition, name).toBe("rejected");
      expect(decodeStoredBookOutcome(text).disposition, name).toBe("rejected");
    }
    // A rejection that carries a revision, and a commit that carries none.
    const rejected = rewrite(encodeBookOutcome(s.rejected), (envelope) => { field(envelope.body, "revision")[0] = "o"; field(envelope.body, "revision")[1] = []; });
    expect(decodeStoredBookOutcome(rejected).disposition).toBe("rejected");
    const withoutRevision = rewrite(encoded, (envelope) => { field(envelope.body, "revision")[0] = "n"; delete (field(envelope.body, "revision") as unknown[])[1]; });
    expect(decodeStoredBookOutcome(withoutRevision).disposition).toBe("rejected");
  });

  test("keeps the byte bound of the canonical decode", () => {
    expect(decodeStoredBookOutcome(" ".repeat(1_048_577)).disposition).toBe("rejected");
    expect(decodeStoredBookOutcome("€".repeat(400_000)).disposition).toBe("rejected");
    // Valid in every other way, under the bound in characters and over it in bytes.
    const wide = rewrite(encodeBookOutcome(s.rejected), (envelope) => {
      const diagnostics = field(field(envelope.body, "originalResult"), "diagnostics")[1] as Node[];
      field(diagnostics[0] as Node, "message")[1] = "é".repeat(540_000);
    });
    expect(wide.length).toBeLessThan(1_048_576);
    expect(new TextEncoder().encode(wide).length).toBeGreaterThan(1_048_576);
    expect(decodeStoredBookOutcome(wide)).toEqual({ disposition: "rejected", message: "Book outcome exceeds the byte limit" });
    const diagnostic = s.rejected.originalResult.diagnostics[0];
    if (!diagnostic) throw new Error("Missing rejection diagnostic");
    const sized = (message: string): BookOutcomePayload => ({
      ...s.rejected,
      originalResult: { ...s.rejected.originalResult, diagnostics: [{ ...diagnostic, message }] },
    });
    const overhead = new TextEncoder().encode(encodeBookOutcome(sized(""))).length;
    const boundary = encodeBookOutcome(sized("x".repeat(1_048_576 - overhead)));
    expect(new TextEncoder().encode(boundary).length).toBe(1_048_576);
    expect(decodeStoredBookOutcome(boundary).disposition).toBe("decoded");
  });
});
