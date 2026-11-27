import { describe, expect, test } from "bun:test";
import {
  decodeDurableBook,
  canonicalBookEffectValue,
  commandId,
  encodeDurableBook,
  createBookState,
  dimensionId,
  executeBookCommand,
  hashBookState,
  hashCanonical,
  instant,
  sealCommand,
  semanticVersion,
  validateBookState,
  DURABLE_BOOK_CODEC_VERSION,
  type BookState,
} from "../src/index.ts";
import { IDS, closePackageId, freshState, journal, reportHash, reportPolicyHash, resolved } from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";

describe("durable book codec (ACC-021, ACC-034, ACC-038)", () => {
  test("round-trips exact values and validates the restored canonical aggregate", () => {
    const fresh = freshState();
    const committed = executeBookCommand(fresh.state, fresh.protocol, activationCommand());
    const posted = executeBookCommand(committed.state, committed.protocol, sealCommand({
      id: commandId("codec-post"), type: "postJournal", protocolVersion: semanticVersion("1.0.0"),
      bookId: IDS.book, expectedBookRevision: committed.state.bookRevision,
      issuedAt: instant("2026-01-15T14:00:00Z"), completedAt: instant("2026-01-15T14:00:01Z"), committedAt: instant("2026-01-15T14:00:02Z"),
      actorId: IDS.actor, resolved: resolved(journal("codec-journal")),
    }));
    const closed = executeBookCommand(posted.state, posted.protocol, sealCommand({
      id: commandId("codec-close"), type: "closePeriod", protocolVersion: semanticVersion("1.0.0"),
      bookId: IDS.book, expectedBookRevision: posted.state.bookRevision,
      issuedAt: instant("2026-02-01T14:00:00Z"), completedAt: instant("2026-02-01T14:00:01Z"), committedAt: instant("2026-02-01T14:00:02Z"),
      actorId: IDS.actor, periodId: IDS.period1, closePackageId: closePackageId("codec-close-package"),
      reason: "Monthly close", reportPopulationHash: reportHash, reportingPolicySnapshotHash: reportPolicyHash,
    }));
    const encoded = encodeDurableBook({ state: closed.state, protocol: closed.protocol });
    expect(encoded).toContain("rastrata-book-aggregate-v1");
    const decoded = decodeDurableBook(encoded);
    expect(decoded.disposition).toBe("decoded");
    if (decoded.disposition === "decoded") {
      expect(decoded.aggregate.state.contentHash.digest).toBe(closed.state.contentHash.digest);
      expect(decoded.aggregate.state.bookRevision).toBe(3n);
      expect(Object.isFrozen(decoded.aggregate.state)).toBeTrue();
    }
  });

  test("round-trips a strict dynamic per-posting dimension policy map", () => {
    const fresh = freshState();
    const state = createBookState(
      fresh.state.identity,
      fresh.state.periods,
      { ...fresh.state.admissionSnapshot, requiredDimensionIdsByPosting: { "future-posting": [dimensionId("future-axis")] } },
      fresh.state.policies,
      fresh.state.quantizationPolicies,
      fresh.state.accountingPolicySnapshot.policies,
      instant("2020-01-01T00:00:00Z"),
    );
    const decoded = decodeDurableBook(encodeDurableBook({ state, protocol: fresh.protocol }));
    expect(decoded.disposition).toBe("decoded");
    if (decoded.disposition === "decoded") {
      expect(decoded.aggregate.state.admissionSnapshot.requiredDimensionIdsByPosting?.["future-posting"]).toHaveLength(1);
    }
  });

  function envelope(body: unknown): string {
    const payload = JSON.stringify(body);
    const checksum = hashCanonical({ type: DURABLE_BOOK_CODEC_VERSION, payload });
    return JSON.stringify({ version: DURABLE_BOOK_CODEC_VERSION, checksum, body });
  }

  test("rejects every malformed tagged node and exercises every durable scalar", () => {
    const bodies: unknown[] = [
      ["n"], ["b", true], ["s", "value"], ["i", "12"], ["x", "0a"],
      ["d", "12", "2"], ["r", "1", "3"], ["a", []], ["o", []],
      ["x", "0g"], {}, ["q"], ["i", "01"], ["a", "wrong"], ["o", "wrong"],
      ["o", [["duplicate", ["n"]], ["duplicate", ["n"]]]],
    ];
    for (const body of bodies) expect(decodeDurableBook(envelope(body)).disposition).toBe("rejected");
    const validBytesAtWrongRoot = decodeDurableBook(envelope(["x", "0a"]));
    expect(validBytesAtWrongRoot.disposition).toBe("rejected");
    if (validBytesAtWrongRoot.disposition === "rejected") expect(validBytesAtWrongRoot.message).toContain("aggregate");
  });

  test("bounds unsupported, cyclic, deep, oversized, and non-record encode input", () => {
    const fresh = freshState();
    expect(() => encodeDurableBook({ state: { ...fresh.state, probe: 1 } as unknown as BookState, protocol: fresh.protocol })).toThrow();
    expect(() => encodeDurableBook({ state: { ...fresh.state, probe: new Date() } as unknown as BookState, protocol: fresh.protocol })).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => encodeDurableBook({ state: cyclic as unknown as BookState, protocol: fresh.protocol })).toThrow();
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 130; index += 1) deep = { child: deep };
    expect(() => encodeDurableBook({ state: deep as unknown as BookState, protocol: fresh.protocol })).toThrow();
    expect(() => encodeDurableBook({ state: { ...fresh.state, probe: new Uint8Array([10, 255]) } as unknown as BookState, protocol: fresh.protocol })).not.toThrow();
    expect(() => encodeDurableBook({ state: { ...fresh.state, probe: Array.from({ length: 10_001 }) } as unknown as BookState, protocol: fresh.protocol })).toThrow();
    const enormous = "x".repeat(17 * 1024 * 1024);
    expect(() => encodeDurableBook({ state: { ...fresh.state, probe: enormous } as unknown as BookState, protocol: fresh.protocol })).toThrow();
    expect(decodeDurableBook(enormous).disposition).toBe("rejected");

    let exactDepth: unknown = null;
    for (let index = 0; index < 128; index += 1) exactDepth = [exactDepth];
    const exactDepthEncoded = encodeDurableBook(exactDepth as never);
    const exactDepthDecoded = decodeDurableBook(exactDepthEncoded);
    expect(exactDepthDecoded.disposition).toBe("rejected");
    if (exactDepthDecoded.disposition === "rejected") expect(exactDepthDecoded.message).toContain("aggregate");

    const exactArrayEncoded = encodeDurableBook(Array.from({ length: 10_000 }, () => null) as never);
    const exactArrayDecoded = decodeDurableBook(exactArrayEncoded);
    expect(exactArrayDecoded.disposition).toBe("rejected");
    if (exactArrayDecoded.disposition === "rejected") expect(exactArrayDecoded.message).toContain("aggregate");
    const exactRecord = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`k${String(index).padStart(5, "0")}`, null]));
    const exactRecordEncoded = encodeDurableBook(exactRecord as never);
    const exactRecordDecoded = decodeDurableBook(exactRecordEncoded);
    expect(exactRecordDecoded.disposition).toBe("rejected");
    if (exactRecordDecoded.disposition === "rejected") expect(exactRecordDecoded.message).toContain("aggregate");

    const maximumBytes = 16 * 1024 * 1024;
    const emptyProbe = encodeDurableBook({ state: "", protocol: null } as never);
    const exactProbe = encodeDurableBook({ state: "x".repeat(maximumBytes - new TextEncoder().encode(emptyProbe).byteLength), protocol: null } as never);
    expect(new TextEncoder().encode(exactProbe).byteLength).toBe(maximumBytes);
    const exactByteDecoded = decodeDurableBook(exactProbe);
    expect(exactByteDecoded.disposition).toBe("rejected");
    if (exactByteDecoded.disposition === "rejected") expect(exactByteDecoded.message).toContain("state");
  });

  test("rejects a retained command whose complete input no longer matches", () => {
    const fresh = freshState();
    const committed = executeBookCommand(fresh.state, fresh.protocol, activationCommand("codec-retained"));
    const retained = committed.protocol.retainedResults[0]!;
    const protocol = { retainedResults: [{ ...retained, inputHash: hashCanonical({ wrong: true }) }] };
    const decoded = decodeDurableBook(encodeDurableBook({ state: committed.state, protocol }));
    expect(decoded.disposition).toBe("rejected");
  });

  test("rejects self-consistent materialization and retained-protocol divergence", () => {
    const fresh = freshState();
    const active = executeBookCommand(fresh.state, fresh.protocol, activationCommand("codec-protocol"));
    expect(decodeDurableBook(encodeDurableBook({ state: active.state, protocol: { retainedResults: [] } })).disposition).toBe("rejected");
    const retained = active.protocol.retainedResults[0]!;
    const { commitIntentHash: _intentHash, ...withoutIntent } = retained;
    const changedOutcome = { ...withoutIntent, outcome: "rejected" as const };
    expect(decodeDurableBook(encodeDurableBook({ state: active.state, protocol: { retainedResults: [changedOutcome] } })).disposition).toBe("rejected");

    const posted = executeBookCommand(active.state, active.protocol, sealCommand({
      id: commandId("codec-materialized-post"), type: "postJournal", protocolVersion: semanticVersion("1.0.0"),
      bookId: IDS.book, expectedBookRevision: active.state.bookRevision,
      issuedAt: instant("2026-01-15T14:00:00Z"), completedAt: instant("2026-01-15T14:00:01Z"), committedAt: instant("2026-01-15T14:00:02Z"),
      actorId: IDS.actor, resolved: resolved(journal("codec-materialized-journal")),
    }));
    const sequenceDivergence = {
      ...posted.state,
      revisions: posted.state.revisions.map((revision) => revision.bookRevision === 2n
        ? { ...revision, effects: revision.effects.map((effect) => effect.type === "journal" ? { ...effect, booked: { ...effect.booked, postingSequence: 9n } } : effect) }
        : revision),
    } as BookState;
    expect(validateBookState(sequenceDivergence).some((item) => item.message.includes("global posting sequence"))).toBeTrue();
    const { contentHash: _hash, ...hashable } = { ...posted.state, latestPostingSequence: 2n, journals: [posted.state.journals[0]!, posted.state.journals[0]!] };
    const divergentState = { ...hashable, contentHash: hashBookState(hashable) } as BookState;
    expect(decodeDurableBook(encodeDurableBook({ state: divergentState, protocol: posted.protocol })).disposition).toBe("rejected");

    const mutatedAdmission = { ...active.state.admissionSnapshot, accounts: active.state.admissionSnapshot.accounts.map((account, index) => index === 0 ? { ...account, name: "Mutated after activation" } : account) };
    const { contentHash: _configurationHash, ...configurationHashable } = { ...active.state, admissionSnapshot: mutatedAdmission };
    const configurationDivergence = { ...configurationHashable, contentHash: hashBookState(configurationHashable) } as BookState;
    expect(decodeDurableBook(encodeDurableBook({ state: configurationDivergence, protocol: active.protocol })).disposition).toBe("rejected");

    const activationRevision = active.state.revisions[0]!;
    const badHash = hashCanonical({ damaged: "lot-state-effect" });
    const lotEffectDivergence = {
      ...active.state,
      revisions: [{ ...activationRevision, effects: [...activationRevision.effects, { type: "lotState" as const, lotState: { lots: [], holdings: [], allocations: [], contentHash: badHash } }] }],
    } as BookState;
    expect(decodeDurableBook(encodeDurableBook({ state: lotEffectDivergence, protocol: active.protocol })).disposition).toBe("rejected");

    const configurationEffect = {
      type: "configuration" as const,
      expectedConfigurationRevision: active.state.configurationRevision,
      nextConfigurationRevision: active.state.configurationRevision + 1n,
      previousConfigurationHash: active.state.configurationHash,
      effectiveOn: active.state.periods[0]!.startsOn,
      periods: active.state.periods,
      admissionSnapshot: active.state.admissionSnapshot,
      policies: active.state.policies,
      quantizationPolicies: active.state.quantizationPolicies,
      accountingPolicySnapshot: active.state.accountingPolicySnapshot,
      previousConfigurationSnapshot: active.state.activeConfigurationSnapshot,
      resultingConfigurationSnapshot: active.state.activeConfigurationSnapshot,
      contentHash: active.state.activeConfigurationSnapshot.contentHash,
    };
    const forgedEffects = [...activationRevision.effects, configurationEffect];
    const effectsHash = hashCanonical({ type: "RevisionEffects", effects: forgedEffects.map(canonicalBookEffectValue) });
    const chainHash = hashCanonical({
      type: "RevisionChain", bookId: IDS.book, revision: 1n, previousHash: null,
      effectsHash: { algorithm: effectsHash.algorithm, canonicalizationVersion: effectsHash.canonicalizationVersion, digest: effectsHash.digest },
    });
    const forgedRevision = { ...activationRevision, effects: forgedEffects, effectsHash, chainHash };
    const { contentHash: _forgedHash, ...forgedHashable } = { ...active.state, revisions: [forgedRevision] };
    const selfConsistentWrongTopology = { ...forgedHashable, contentHash: hashBookState(forgedHashable) } as BookState;
    expect(validateBookState(selfConsistentWrongTopology).some((item) => item.path === "intent.effects")).toBeTrue();
  });

  test("rejects damaged, unsupported, and malformed durable input", () => {
    const fresh = freshState();
    const encoded = encodeDurableBook({ state: fresh.state, protocol: fresh.protocol });
    const damaged = encoded.replace("rastrata-book-aggregate-v1", "rastrata-book-aggregate-v0");
    expect(decodeDurableBook(damaged).disposition).toBe("rejected");
    expect(decodeDurableBook("not-json").disposition).toBe("rejected");
    expect(decodeDurableBook(encodeDurableBook({
      state: { ...fresh.state, contentHash: hashCanonical({ damaged: "state" }) },
      protocol: fresh.protocol,
    })).disposition).toBe("rejected");
    expect(decodeDurableBook(encodeDurableBook({
      state: { ...fresh.state, unknownProductionField: true } as unknown as BookState,
      protocol: fresh.protocol,
    })).disposition).toBe("rejected");
    expect(decodeDurableBook(encodeDurableBook({
      state: { ...fresh.state, status: { disguised: "record" } } as unknown as BookState,
      protocol: fresh.protocol,
    })).disposition).toBe("rejected");
    const malformedScalars: BookState[] = [
      { ...fresh.state, status: "impossible" } as unknown as BookState,
      { ...fresh.state, bookRevision: "0" } as unknown as BookState,
      { ...fresh.state, identity: { ...fresh.state.identity, bookId: " padded " } } as BookState,
      { ...fresh.state, periods: [{ ...fresh.state.periods[0]!, startsOn: "2026-02-30" }, ...fresh.state.periods.slice(1)] } as BookState,
      { ...fresh.state, admissionSnapshot: { ...fresh.state.admissionSnapshot, accounts: [{ ...fresh.state.admissionSnapshot.accounts[0]!, postingAllowed: "yes" }, ...fresh.state.admissionSnapshot.accounts.slice(1)] } } as unknown as BookState,
      { ...fresh.state, financialIdentityHash: { ...fresh.state.financialIdentityHash, algorithm: "sha1" } } as unknown as BookState,
    ];
    for (const state of malformedScalars) {
      expect(decodeDurableBook(encodeDurableBook({ state, protocol: fresh.protocol })).disposition).toBe("rejected");
    }
  });
});
