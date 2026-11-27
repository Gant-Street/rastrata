import { expect, test } from "bun:test";
import {
  decodeBookOutcome,
  decodeBookRow,
  encodeBookOutcome,
  encodeDurableBook,
  decodeDurableBook,
  createBookState,
  createBookProtocolState,
  hashCanonical,
  sealCommand,
  bookId,
  type DurableBookAggregate,
} from "@rastrata/kernel";
import { evaluateOutcomePayload, replayOutcomePayload } from "../src/outcome-payload.ts";
import { probeOutcomePayloads } from "../scripts/outcome-payload-probe.ts";
import { activation, genesis, posting } from "./fixtures.ts";
import { workflowValue } from "./accounting-workflows.ts";

type FrozenAggregate = { aggregateGzipBase64: string; sha256: string };
function unpackFrozenAggregate(record: FrozenAggregate): string {
  const text = new TextDecoder().decode(
    Bun.gunzipSync(Buffer.from(record.aggregateGzipBase64, "base64")),
  );
  expect(new Bun.CryptoHasher("sha256").update(text).digest("hex")).toBe(record.sha256);
  return text;
}
function frozenField(node: unknown, name: string): unknown {
  if (!Array.isArray(node) || node[0] !== "o") throw new Error("Expected frozen object node");
  const found = (node[1] as [string, unknown][]).find(([key]) => key === name);
  if (found === undefined) throw new Error("Missing frozen field");
  return found[1];
}
function frozenArray(node: unknown): unknown[] {
  if (!Array.isArray(node) || node[0] !== "a") throw new Error("Expected frozen array node");
  return node[1] as unknown[];
}

test("compact recovery refuses all preserved corrupt lot outcomes without replacing committed history", async () => {
  // Shared immutable JSON evidence, not a dependency on private kernel test code.
  for (const name of [
    "transfer-defect-legacy",
    "lot-posting-defect-legacy",
    "inventory-carrying-defect-legacy",
    "inventory-posted-admission-defect-legacy",
  ]) {
    const evidence: {
      initial?: FrozenAggregate;
      initialGzipBase64?: string;
      initialSha256?: string;
      cases: (Partial<FrozenAggregate> & {
        name: string;
        initial?: FrozenAggregate;
        aggregate?: FrozenAggregate;
      })[];
    } = await Bun.file(new URL(`../../kernel/test/data/${name}.json`, import.meta.url)).json();
    for (const stored of evidence.cases) {
      const initial = decodeDurableBook(
        unpackFrozenAggregate(
          stored.initial ??
            evidence.initial ?? {
              aggregateGzipBase64: workflowValue(evidence.initialGzipBase64),
              sha256: workflowValue(evidence.initialSha256),
            },
        ),
      );
      if (initial.disposition !== "decoded") throw new Error(initial.message);
      const captured = stored.aggregate ?? {
        aggregateGzipBase64: workflowValue(stored.aggregateGzipBase64),
        sha256: workflowValue(stored.sha256),
      };
      const frozen = unpackFrozenAggregate(captured);
      const body: unknown = JSON.parse(frozen).body;
      const retained = frozenArray(
        frozenField(frozenField(body, "protocol"), "retainedResults"),
      ).map((node) => {
        const decoded = decodeBookRow("protocol.retainedResults", JSON.stringify(node));
        if (decoded.disposition !== "decoded") throw new Error(decoded.message);
        return decoded.row;
      });
      const revisions = frozenArray(frozenField(frozenField(body, "state"), "revisions")).map(
        (node) => {
          const decoded = decodeBookRow("state.revisions", JSON.stringify(node));
          if (decoded.disposition !== "decoded") throw new Error(decoded.message);
          return decoded.row;
        },
      );
      let before: DurableBookAggregate = initial.aggregate;
      for (const row of retained.slice(initial.aggregate.protocol.retainedResults.length, -1)) {
        const evaluated = evaluateOutcomePayload(before, row.command);
        expect(evaluated.transition.result.disposition).toBe("committed");
        // Exercise the production replay path for the genuine prefix too.
        if (evaluated.encoded === null) throw new Error("Missing retained prefix outcome");
        const replayed = replayOutcomePayload(before, evaluated.encoded);
        before = { state: replayed.state, protocol: replayed.protocol };
      }
      const original = workflowValue(retained.at(-1));
      expect(original.outcome).toBe("committed");
      const revision = workflowValue(revisions.at(-1));
      const encoded = encodeBookOutcome({
        command: original.command,
        originalResult: {
          disposition: "committed",
          observedBookRevision: original.observedBookRevision,
          resultHash: original.resultHash,
          diagnostics: original.diagnostics,
          completedAt: original.completedAt,
          committedAt: original.command.committedAt,
        },
        revision,
      });
      // This is a structurally valid transport of the actual old command/result/
      // revision, not random corruption that fails before accounting replay.
      expect(decodeBookOutcome(encoded).disposition).toBe("decoded");
      const beforeBytes = encodeDurableBook(before);
      const payloadHash = new Bun.CryptoHasher("sha256").update(encoded).digest("hex");
      expect(() => replayOutcomePayload(before, encoded)).toThrow("recovery_outcome_mismatch");
      expect(encodeDurableBook(before)).toBe(beforeBytes);
      expect(new Bun.CryptoHasher("sha256").update(encoded).digest("hex")).toBe(payloadHash);
      expect(new Bun.CryptoHasher("sha256").update(frozen).digest("hex")).toBe(captured.sha256);
    }
  }
});

test("only newly retained commands produce payloads; replay verifies the entire original result", () => {
  const before = genesis();
  const first = evaluateOutcomePayload(before, activation());
  if (!first.encoded) throw new Error("Missing activation payload");
  const replay = replayOutcomePayload(before, first.encoded);
  expect(encodeDurableBook({ state: replay.state, protocol: replay.protocol })).toBe(
    encodeDurableBook({ state: first.transition.state, protocol: first.transition.protocol }),
  );
  const rejected = evaluateOutcomePayload(replay, posting("bad", 1n, false));
  if (!rejected.encoded) throw new Error("Missing rejection payload");
  expect(rejected.payload?.revision).toBeNull();
  expect(replayOutcomePayload(replay, rejected.encoded).result).toEqual(rejected.transition.result);
  const retry = evaluateOutcomePayload(rejected.transition, posting("bad", 1n, false));
  expect(retry.transition.result.disposition).toBe("replayed");
  expect(retry.encoded).toBeNull();
  const rejectedBytes = rejected.encoded;
  expect(() => replayOutcomePayload(rejected.transition, rejectedBytes)).toThrow(
    "recovery_outcome_mismatch",
  );
  const foreign = evaluateOutcomePayload(
    before,
    sealCommand({ ...activation(), bookId: bookId("other") }),
  );
  expect(foreign.payload).toBeNull();
  expect(foreign.transition.result.disposition).toBe("rejected");
  expect(foreign.transition.result.diagnostics.map((item) => item.code)).toEqual([
    "book_isolation_violation",
  ]);
  expect(foreign.transition.protocol.retainedResults.length).toBe(0);
  const conflict = evaluateOutcomePayload(
    replay,
    sealCommand({ ...activation(), bookId: bookId("other") }),
  );
  expect(conflict.encoded).toBeNull();
  expect(conflict.transition.result.diagnostics.map((item) => item.code)).toEqual([
    "command_identity_conflict",
  ]);
  expect(conflict.transition.protocol.retainedResults.length).toBe(1);
  expect(() => replayOutcomePayload(before, "{broken")).toThrow("recovery_outcome_invalid");
});

test("successful structural decoding and valid envelope hashes do not prove accounting truth", () => {
  const before = genesis();
  const evaluated = evaluateOutcomePayload(before, activation());
  if (!evaluated.encoded) throw new Error("Missing payload");
  const decoded = decodeBookOutcome(evaluated.encoded);
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  const forged = encodeBookOutcome({
    ...decoded.payload,
    originalResult: {
      ...decoded.payload.originalResult,
      resultHash: hashCanonical("forged result"),
    },
  });
  expect(decodeBookOutcome(forged).disposition).toBe("decoded");
  const bytes = encodeDurableBook(before);
  expect(() => replayOutcomePayload(before, forged)).toThrow("recovery_outcome_mismatch");
  expect(encodeDurableBook(before)).toBe(bytes);
  const revision = decoded.payload.revision;
  if (!revision) throw new Error("Missing revision");
  const forgedEffectHash = encodeBookOutcome({
    ...decoded.payload,
    revision: { ...revision, effectsHash: hashCanonical("forged effects") },
  });
  expect(() => replayOutcomePayload(before, forgedEffectHash)).toThrow("recovery_outcome_mismatch");
});

test("single-outcome replay preserves the pre-repair inventory book and exact rejected receipt", async () => {
  const raw = (
    await Bun.file(
      new URL("../../kernel/test/data/inventory-adjustment-legacy.json", import.meta.url),
    ).text()
  ).trim();
  const decoded = decodeDurableBook(raw);
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  const config = decoded.aggregate.state.configurationSnapshots[0];
  if (!config) throw new Error("Missing configuration");
  let current: DurableBookAggregate = {
    state: createBookState(
      decoded.aggregate.state.identity,
      config.periods,
      config.admissionSnapshot,
      config.policies,
      config.quantizationPolicies,
      config.accountingPolicySnapshot.policies,
      config.effectiveAt,
    ),
    protocol: createBookProtocolState(),
  };
  for (const original of decoded.aggregate.protocol.retainedResults) {
    const evaluated = evaluateOutcomePayload(current, original.command);
    if (!evaluated.encoded) throw new Error("Missing historical outcome");
    const next = replayOutcomePayload(current, evaluated.encoded);
    expect(next.result.resultHash).toEqual(original.resultHash);
    current = { state: next.state, protocol: next.protocol };
  }
  expect(encodeDurableBook(current)).toBe(raw);
});

test("payload representation avoids repeated journal history for an ordinary posting stream", () => {
  const result = probeOutcomePayloads(10);
  expect(result.status).toBe("complete");
  if (result.status !== "complete") throw new Error(result.error);
  expect(result.outcomes).toBe(11);
  expect(result.exactFinalSnapshotReplay).toBe(true);
  expect(result.cashBalance).toBe("1000/1");
  expect(result.totalOutcomeBytes).toBeLessThan(result.totalSnapshotBytes);
  expect(() => probeOutcomePayloads(0)).toThrow("probe sales budget");
});
