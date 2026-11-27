import { expect, test } from "bun:test";
import { encodeDurableBook, commandId } from "@rastrata/kernel";
import {
  prepareIndexedOutcomeIdentityDelta,
  type IndexedPriorIdentityEvidence,
} from "../src/outcome-identities.ts";
import { identityIndexKey } from "../src/index-pages.ts";
import {
  projectVerifiedIdentityPopulation,
  type CanonicalIdentity,
} from "../src/identity-audit.ts";
import { compactGenesisHead, compactOutcomeRecord } from "../src/compact-records.ts";
import { COMPACT_LEDGER_FORMAT } from "../src/records.ts";
import { createIndexedOwnerFixture } from "./indexed-owner-fixture.ts";
import { commercialWorkflow } from "./commercial-workflow.ts";
import {
  lotIdentityWorkflow,
  allocationAndTaxWorkflow,
  admissionFxWorkflow,
  workflowValue,
} from "./accounting-workflows.ts";
import { activation, genesis, posting } from "./fixtures.ts";

type Fixture = Awaited<ReturnType<typeof createIndexedOwnerFixture>>;
type Plan = Awaited<ReturnType<Fixture["prepare"]>>;
const evidence = (plan: Plan): IndexedPriorIdentityEvidence => ({
  sequence: BigInt(plan.record.after.sequence),
  encoded: plan.encoded,
  authority: plan.authority,
});
const fixture = (initial = genesis()) => createIndexedOwnerFixture(initial, "", true);

test("indexed identity candidates match the independent full-history identity oracle for actual workflows", async () => {
  const fx = admissionFxWorkflow(false);
  for (const scenario of [
    commercialWorkflow(),
    lotIdentityWorkflow(),
    allocationAndTaxWorkflow("1.1.0"),
    { initial: fx.initial, commands: [...fx.commands, fx.reverse(fx.firstMeasurement, 5n)] },
  ]) {
    const f = await fixture(scenario.initial);
    let legacyHead = compactGenesisHead(f.scope, encodeDurableBook(scenario.initial));
    const current = new Map<string, CanonicalIdentity>(),
      originals = new Map<string, IndexedPriorIdentityEvidence>();
    try {
      for (const command of scenario.commands) {
        const plan = await f.prepare(command),
          before = f.dump();
        const delta = await prepareIndexedOutcomeIdentityDelta(
          f.catalog,
          plan.prepared,
          plan.encoded,
          {
            confirm: f.ports.confirm,
            lookup: async (key) => originals.get(key) ?? null,
          },
        );
        expect(f.dump()).toEqual(before);
        expect(Object.isFrozen(delta) && delta.every(Object.isFrozen)).toBe(true);
        for (const entry of delta) {
          expect(current.has(identityIndexKey(entry))).toBe(false);
          current.set(identityIndexKey(entry), entry);
          originals.set(identityIndexKey(entry), evidence(plan));
        }
        f.select(plan);
        // Genuine legacy oracle framing, not a fabricated legacy head over new hashes.
        legacyHead = compactOutcomeRecord(
          f.scope,
          legacyHead,
          f.aggregate,
          plan.record.payload,
        ).after;
        const expected = projectVerifiedIdentityPopulation(
          f.aggregate,
          legacyHead,
          f.scope,
          COMPACT_LEDGER_FORMAT,
        ).entries;
        const sorted = (entries: readonly CanonicalIdentity[]) =>
          [...entries].sort((a, b) => identityIndexKey(a).localeCompare(identityIndexKey(b)));
        expect(sorted([...current.values()])).toEqual(sorted(expected));
      }
      expect(f.faults.syncs).toBe(0);
    } finally {
      f.close();
    }
  }
});

test("indexed identity checks retain first lot locators while rejected commands consume independent Oseq identities", async () => {
  const scenario = lotIdentityWorkflow(),
    f = await fixture(scenario.initial);
  const originals = new Map<string, IndexedPriorIdentityEvidence>();
  try {
    for (const command of [
      posting("identity-rejected-before-activation", 0n),
      ...scenario.commands,
      posting("identity-stale-after-lots", 0n),
    ]) {
      const plan = await f.prepare(command);
      const delta = await prepareIndexedOutcomeIdentityDelta(
        f.catalog,
        plan.prepared,
        plan.encoded,
        {
          confirm: f.ports.confirm,
          lookup: async (key) => originals.get(key) ?? null,
        },
      );
      for (const entry of delta) originals.set(identityIndexKey(entry), evidence(plan));
      const result = plan.afterAggregate.protocol.retainedResults.at(-1);
      if (result?.outcome === "rejected")
        expect(delta).toEqual([
          {
            bookId: f.scope.bookId,
            family: "command",
            id: command.id,
            outcomeSequence: BigInt(plan.record.after.sequence),
          },
        ]);
      f.select(plan);
    }
    for (const family of ["lot", "lotHolding"] as const) {
      const key = identityIndexKey({ bookId: f.scope.bookId, family, id: "lot-first" });
      expect(originals.get(key)?.sequence).toBe(3n); // One rejection, activation, then acquisition.
    }
    expect(f.aggregate.state.lotHoldings[0]?.remainingQuantity.isZero()).toBe(true);
  } finally {
    f.close();
  }
});

test("indexed identity projection rejects another valid candidate, forged handles and publication races", async () => {
  const f = await fixture();
  try {
    await f.publish(activation());
    const a = await f.prepare(posting("identity-a", 1n)),
      b = await f.prepare(posting("identity-b", 1n));
    let lookups = 0;
    const ports = {
      confirm: f.ports.confirm,
      lookup: async () => {
        lookups++;
        return null;
      },
    };
    await expect(
      prepareIndexedOutcomeIdentityDelta(f.catalog, a.prepared, b.encoded, ports),
    ).rejects.toThrow("index_identity_candidate_mismatch");
    await expect(
      prepareIndexedOutcomeIdentityDelta(
        f.catalog,
        { digest: a.prepared.digest },
        a.encoded,
        ports,
      ),
    ).rejects.toThrow("indexed_source_unprepared");
    expect(lookups).toBe(0);
    await expect(
      prepareIndexedOutcomeIdentityDelta(f.catalog, a.prepared, a.encoded, {
        confirm: f.ports.confirm,
        lookup: async () => {
          f.select(b);
          return null;
        },
      }),
    ).rejects.toThrow();
    expect(f.aggregate.protocol.retainedResults.at(-1)?.commandId).toBe(commandId("identity-b"));
  } finally {
    f.close();
  }
});

test("indexed historical identity evidence binds the complete scope, locator and record hash", async () => {
  const scenario = lotIdentityWorkflow(),
    f = await fixture(scenario.initial);
  try {
    await f.publish(workflowValue(scenario.commands[0]));
    const first = await f.publish(workflowValue(scenario.commands[1]));
    const plan = await f.prepare(workflowValue(scenario.commands[2])),
      original = evidence(first),
      before = f.dump();
    const lotKey = identityIndexKey({ bookId: f.scope.bookId, family: "lot", id: "lot-first" });
    const wrong: IndexedPriorIdentityEvidence[] = [
      { ...original, sequence: 0n },
      { ...original, sequence: 3n },
      { ...original, encoded: "{}" },
      { ...original, authority: { ...original.authority, recordHash: "0".repeat(64) } },
      { ...original, authority: { ...original.authority, actualObjectId: "wrong-object" } },
      ...(["tenantId", "bookId", "objectId", "namespaceId", "generation"] as const).map(
        (field) => ({
          ...original,
          authority: {
            ...original.authority,
            scope: { ...original.authority.scope, [field]: field === "generation" ? "1" : "wrong" },
          },
        }),
      ),
      {
        ...original,
        authority: {
          ...original.authority,
          beforeHead: plan.authority.beforeHead,
          beforeState: plan.authority.beforeState,
        },
      },
    ];
    for (const value of wrong)
      await expect(
        prepareIndexedOutcomeIdentityDelta(f.catalog, plan.prepared, plan.encoded, {
          confirm: f.ports.confirm,
          lookup: async (key) => (key === lotKey ? value : null),
        }),
      ).rejects.toThrow();
    // Valid earlier source at the wrong raw identity is not an ID collision hit.
    await expect(
      prepareIndexedOutcomeIdentityDelta(f.catalog, plan.prepared, plan.encoded, {
        confirm: f.ports.confirm,
        lookup: async () => original,
      }),
    ).rejects.toThrow("index_identity_source_mismatch");
    expect(f.dump()).toEqual(before);
  } finally {
    f.close();
  }
});

test("indexed identity checks distinguish absent keys from unavailable evidence and revoked authority", async () => {
  const f = await fixture();
  try {
    await f.publish(activation());
    const plan = await f.prepare(posting("identity-errors", 1n)),
      before = f.dump();
    let getters = 0;
    const accessor = {
      get sequence() {
        getters++;
        return 1n;
      },
      encoded: "{}",
      authority: {},
    };
    for (const value of [
      undefined,
      false,
      {},
      accessor,
      { sequence: 1n, encoded: "{}", authority: {}, extra: true },
    ]) {
      await expect(
        prepareIndexedOutcomeIdentityDelta(f.catalog, plan.prepared, plan.encoded, {
          confirm: f.ports.confirm,
          lookup: async () => value as unknown as IndexedPriorIdentityEvidence,
        }),
      ).rejects.toThrow("index_identity_evidence_invalid");
    }
    expect(getters).toBe(0);
    await expect(
      prepareIndexedOutcomeIdentityDelta(f.catalog, plan.prepared, plan.encoded, {
        confirm: f.ports.confirm,
        lookup: async () => {
          throw new Error("identity storage unavailable");
        },
      }),
    ).rejects.toThrow("identity storage unavailable");
    let confirmations = 0;
    await expect(
      prepareIndexedOutcomeIdentityDelta(f.catalog, plan.prepared, plan.encoded, {
        confirm: async () => {
          if (++confirmations === 3) throw new Error("pin revoked");
        },
        lookup: async () => null,
      }),
    ).rejects.toThrow("pin revoked");
    expect(f.dump()).toEqual(before);
    const result = await prepareIndexedOutcomeIdentityDelta(
      f.catalog,
      plan.prepared,
      plan.encoded,
      { confirm: f.ports.confirm, lookup: async () => null },
    );
    expect(workflowValue(result[0]).family).toBe("command");
  } finally {
    f.close();
  }
});

test("indexed identity evidence is copied before owner confirmation can mutate the returned object", async () => {
  const scenario = lotIdentityWorkflow(),
    f = await fixture(scenario.initial);
  try {
    await f.publish(workflowValue(scenario.commands[0]));
    const original = evidence(await f.publish(workflowValue(scenario.commands[1])));
    const plan = await f.prepare(workflowValue(scenario.commands[2]));
    const keys = new Set(
      (["lot", "lotHolding"] as const).map((family) =>
        identityIndexKey({ bookId: f.scope.bookId, family, id: "lot-first" }),
      ),
    );
    let invalidate: (() => void) | undefined,
      changed = 0;
    const delta = await prepareIndexedOutcomeIdentityDelta(f.catalog, plan.prepared, plan.encoded, {
      confirm: async () => {
        const run = invalidate;
        invalidate = undefined;
        run?.();
        await f.ports.confirm();
      },
      lookup: async (key) => {
        if (!keys.has(key)) return null;
        const returned = { ...original, authority: { ...original.authority } };
        invalidate = () => {
          returned.encoded = "{}";
          returned.authority.recordHash = "0".repeat(64);
          changed++;
        };
        return returned;
      },
    });
    expect(changed).toBe(2);
    expect(delta.some((entry) => keys.has(identityIndexKey(entry)))).toBe(false);
  } finally {
    f.close();
  }
});

test("indexed identity projection requires a retained outcome, not an uninstalled genesis candidate", async () => {
  const f = await createIndexedOwnerFixture(genesis(), "defer installation");
  try {
    const prepared = await f.catalog.prepareGenesis(encodeDurableBook(genesis()));
    await expect(
      prepareIndexedOutcomeIdentityDelta(f.catalog, prepared, "{}", {
        confirm: f.ports.confirm,
        lookup: async () => null,
      }),
    ).rejects.toThrow("index_identity_outcome_required");
  } finally {
    f.close();
  }
});
