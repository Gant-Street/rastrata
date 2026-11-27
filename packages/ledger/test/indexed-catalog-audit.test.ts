import { expect, test } from "bun:test";
import {
  encodeDurableBook,
  hashCanonical,
  commandId,
  closePackageId,
  instant,
  sealCommand,
} from "@rastrata/kernel";
import { INDEXED_GROUP_CATALOG_FORMAT } from "../src/group-catalog.ts";
import {
  auditLogicalMap,
  emptyLogicalMap,
  logicalMapHash,
  prepareLogicalChange,
} from "../src/logical-map.ts";
import { indexedCollectionDomain } from "../src/indexed-book-state.ts";
import {
  SEMANTIC_GROUP_VERSION,
  semanticGroupDigest,
  type SemanticGroupKey,
} from "../src/semantic-groups.ts";
import { createIndexedOwnerFixture } from "./indexed-owner-fixture.ts";
import {
  admissionFxWorkflow,
  allocationAndTaxWorkflow,
  lotIdentityWorkflow,
  workflowValue,
} from "./accounting-workflows.ts";
import { commercialWorkflow } from "./commercial-workflow.ts";
import { activation, genesis, posting } from "./fixtures.ts";

type Fixture = Awaited<ReturnType<typeof createIndexedOwnerFixture>>;
const fixture = (initial = genesis()) => createIndexedOwnerFixture(initial, "", true);
const hex = (ordinal: bigint) => ordinal.toString(16).padStart(64, "0");
function currentGroup(f: Fixture) {
  const stored = f.db.query("SELECT body, digest FROM ledger_indexed_group_catalog").get() as {
    body: string;
    digest: string;
  };
  return { ...stored, value: JSON.parse(stored.body) };
}
const verify = (f: Fixture) =>
  f.groups.verifyIndexed(f.catalog, f.readAnchor(), f.digest, currentGroup(f).digest, f.ports);

/** Deliberately forge a self-consistent DERIVED group. Every node, descriptor and
 * metadata digest is recomputed, while canonical financial/source bytes stay
 * untouched. A structural hash walk alone must not accept these catalogs. */
async function rewriteGroup(
  f: Fixture,
  key: SemanticGroupKey,
  entries: readonly { ordinal: bigint; hash: string }[],
  domain?: string,
) {
  const prior = currentGroup(f);
  const collectionDomain =
    domain ?? indexedCollectionDomain(f.aggregate.state.financialIdentityHash, "state.lotHoldings");
  const id = semanticGroupDigest(collectionDomain, key);
  const nodes = new Map<string, string>();
  const read = async (hash: string) =>
    nodes.get(hash) ??
    (
      f.db.query("SELECT body FROM ledger_indexed_group_nodes WHERE digest = ?").get(hash) as {
        body: string;
      } | null
    )?.body;
  let previous: string | null = null;
  await auditLogicalMap(
    prior.value.root,
    prior.value.rootHash,
    prior.value.domain,
    read,
    (group, hash) => {
      if (group === id) previous = hash;
    },
  );
  let root = emptyLogicalMap(id);
  for (const entry of entries) {
    const changed = await prepareLogicalChange(
      root,
      logicalMapHash(root, id),
      id,
      hex(entry.ordinal),
      null,
      entry.hash,
      read,
    );
    for (const node of changed.nodes) nodes.set(node.digest, node.encoded);
    root = changed.encodedRoot;
  }
  let descriptorHash: string | null = null;
  if (entries.length) {
    const body = JSON.stringify({
      format: SEMANTIC_GROUP_VERSION,
      key,
      collectionDomain,
      memberDomain: id,
      memberRoot: root,
      memberHash: logicalMapHash(root, id),
      population: String(entries.length),
    });
    descriptorHash = hashCanonical({
      profile: INDEXED_GROUP_CATALOG_FORMAT,
      kind: "descriptor",
      body,
    }).digest;
    f.db
      .query("INSERT OR REPLACE INTO ledger_indexed_group_descriptors VALUES (?, ?)")
      .run(descriptorHash, body);
  }
  const directory = await prepareLogicalChange(
    prior.value.root,
    prior.value.rootHash,
    prior.value.domain,
    id,
    previous,
    descriptorHash,
    read,
  );
  for (const node of directory.nodes) nodes.set(node.digest, node.encoded);
  for (const [hash, body] of nodes)
    f.db.query("INSERT OR REPLACE INTO ledger_indexed_group_nodes VALUES (?, ?)").run(hash, body);
  const body = JSON.stringify({
    ...prior.value,
    root: directory.encodedRoot,
    rootHash: logicalMapHash(directory.encodedRoot, prior.value.domain),
    population: JSON.parse(directory.encodedRoot).tree?.count ?? "0",
  });
  f.db
    .query("UPDATE ledger_indexed_group_catalog SET body = ?, digest = ?")
    .run(
      body,
      hashCanonical({ profile: INDEXED_GROUP_CATALOG_FORMAT, kind: "catalog", body }).digest,
    );
}

test("complete indexed catalog audits stream exact canonical rows and groups across actual workflows", async () => {
  const fx = admissionFxWorkflow(false);
  for (const scenario of [
    commercialWorkflow(),
    lotIdentityWorkflow(),
    allocationAndTaxWorkflow("1.1.0"),
    { initial: fx.initial, commands: [...fx.commands, fx.reverse(fx.firstMeasurement, 5n)] },
  ]) {
    const f = await fixture(scenario.initial);
    try {
      for (const command of scenario.commands) await f.publish(command);
      const before = f.dump(),
        expected = f.readAnchor();
      const encoded = JSON.parse(encodeDurableBook(f.aggregate));
      const actual = new Map<string, string[]>();
      const result = await f.catalog.audit(expected, f.digest, f.ports, (row) => {
        expect(row.disposition).toBe("present");
        const rows = actual.get(row.collection) ?? [];
        expect(row.ordinal).toBe(BigInt(rows.length) + 1n);
        rows.push(workflowValue(row.encoded ?? undefined));
        actual.set(row.collection, rows);
      });
      let population = 0n;
      for (const collection of expected.state.collections) {
        let node = encoded.body;
        for (const part of collection.collection.split("."))
          node = node?.[1].find(([name]: [string]) => name === part)?.[1];
        const rows =
          node === undefined
            ? []
            : collection.collection === "state.openingBoundary"
              ? [node]
              : node[1];
        expect(actual.get(collection.collection) ?? []).toEqual(
          rows.map((row: unknown) => JSON.stringify(row)),
        );
        population += BigInt(rows.length);
      }
      expect(result).toEqual({
        catalogDigest: f.digest,
        headHash: expected.head.contentHash,
        rows: population,
      });
      const groups = await verify(f);
      expect(groups.sourceRows).toBe(population);
      expect(groups.groupCatalogDigest).toBe(f.groupDigest);
      expect(groups.sourceCatalogDigest).toBe(f.digest);
      expect(groups.headHash).toBe(expected.head.contentHash);
      // Independent predicates, not the production membership projector.
      const state = f.aggregate.state;
      const memberCount =
        state.lotHoldings.length * 2 +
        state.lotHoldings.filter((row) => !row.remainingQuantity.isZero()).length +
        state.accountingState.allocationRecognitions.length +
        state.periodTransitions.length +
        state.accountingState.remeasurementResults.filter((row) => row.kind === "unrealized")
          .length +
        state.accountingState.remeasurementReversals.length;
      expect(groups.members).toBe(BigInt(memberCount));
      f.restart();
      expect(await verify(f)).toEqual(groups);
      expect(f.dump()).toEqual(before);
      expect(f.faults.syncs).toBe(0);
    } finally {
      f.close();
    }
  }
});

test("indexed audit checks empty groups, new-book genesis and retained rejections without financial changes", async () => {
  const f = await fixture();
  try {
    const initial = await verify(f);
    expect(initial.sourceRows).toBe(1n);
    expect(initial.groups).toBe(0n);
    expect(initial.members).toBe(0n);
    await f.publish(posting("audit-not-active", 0n));
    expect((await verify(f)).sourceRows).toBe(2n);
    await f.publish(activation());
    expect((await verify(f)).sourceRows).toBe(5n);
    await f.publish(posting("audit-stale", 0n));
    expect((await verify(f)).sourceRows).toBe(6n);
  } finally {
    f.close();
  }
});

test("indexed audit includes complete close and reopen period membership", async () => {
  const f = await fixture(),
    base = posting();
  const core = {
    bookId: base.bookId,
    actorId: base.actorId,
    protocolVersion: base.protocolVersion,
    issuedAt: instant("2026-02-01T00:00:00Z"),
    completedAt: instant("2026-02-01T00:00:01Z"),
    committedAt: instant("2026-02-01T00:00:02Z"),
  };
  try {
    await f.publish(activation());
    const periodId = workflowValue(f.aggregate.state.periods[0]).id;
    await f.publish(
      sealCommand({
        ...core,
        id: commandId("audit-close"),
        type: "closePeriod",
        expectedBookRevision: 1n,
        periodId,
        closePackageId: closePackageId("audit-close"),
        reason: "Audit close",
        reportPopulationHash: hashCanonical("report"),
        reportingPolicySnapshotHash: hashCanonical("policy"),
      }),
    );
    expect(f.aggregate.protocol.retainedResults.at(-1)?.outcome).toBe("committed");
    expect((await verify(f)).members).toBe(1n);
    await f.publish(
      sealCommand({
        ...core,
        id: commandId("audit-reopen"),
        type: "reopenPeriod",
        expectedBookRevision: 2n,
        periodId,
        reason: "Audit reopen",
      }),
    );
    expect(f.aggregate.protocol.retainedResults.at(-1)?.outcome).toBe("committed");
    const result = await verify(f);
    expect(result.members).toBe(2n);
    expect(result.groups).toBe(1n);
  } finally {
    f.close();
  }
});

test("indexed audit rejects self-consistently rehashed missing, stale and extraneous memberships", async () => {
  const scenario = lotIdentityWorkflow();
  for (const defect of [
    "missing-group",
    "missing-member",
    "stale-hash",
    "wrong-lot",
    "absent-row",
    "depleted-nonzero",
    "wrong-domain",
  ] as const) {
    const f = await fixture(scenario.initial);
    try {
      for (const command of scenario.commands) await f.publish(command);
      const rows = f.aggregate.state.lotHoldings;
      const source = f.catalog.capture(f.digest);
      const hashes: string[] = [];
      for (let i = 0; i < rows.length; i++)
        hashes.push(
          workflowValue(
            (await f.catalog.read(source, "state.lotHoldings", BigInt(i) + 1n, f.ports)).rowHash ??
              undefined,
          ),
        );
      f.catalog.release(source);
      const first = workflowValue(rows[0]),
        second = workflowValue(rows[1]);
      expect(first.remainingQuantity.isZero()).toBe(true);
      if (defect === "missing-group")
        await rewriteGroup(f, { kind: "holdingsByLot", values: [first.lotId] }, []);
      if (defect === "missing-member")
        await rewriteGroup(f, { kind: "holdingsByAccount", values: [first.accountId] }, [
          { ordinal: 2n, hash: workflowValue(hashes[1]) },
        ]);
      if (defect === "stale-hash")
        await rewriteGroup(f, { kind: "holdingsByLot", values: [first.lotId] }, [
          { ordinal: 1n, hash: "0".repeat(64) },
        ]);
      if (defect === "wrong-lot")
        await rewriteGroup(f, { kind: "holdingsByLot", values: ["wrong-lot"] }, [
          { ordinal: 1n, hash: workflowValue(hashes[0]) },
        ]);
      if (defect === "absent-row")
        await rewriteGroup(f, { kind: "holdingsByLot", values: ["missing-row"] }, [
          { ordinal: 99n, hash: "0".repeat(64) },
        ]);
      if (defect === "depleted-nonzero")
        await rewriteGroup(
          f,
          {
            kind: "nonzeroHoldingsByAccountCommodity",
            values: [second.accountId, second.commodityId],
          },
          [
            { ordinal: 1n, hash: workflowValue(hashes[0]) },
            { ordinal: 2n, hash: workflowValue(hashes[1]) },
          ],
        );
      if (defect === "wrong-domain")
        await rewriteGroup(
          f,
          { kind: "holdingsByLot", values: ["wrong-domain"] },
          [{ ordinal: 1n, hash: workflowValue(hashes[0]) }],
          "0".repeat(64),
        );
      const corrupted = f.dump();
      await expect(verify(f)).rejects.toThrow();
      expect(f.dump()).toEqual(corrupted); // Verification is never repair.
    } finally {
      f.close();
    }
  }
});

test("indexed audits reject untrusted anchors, cancellation, racing publication and observer failures", async () => {
  const f = await fixture();
  try {
    await f.publish(activation());
    const before = f.dump(),
      expected = f.readAnchor();
    await expect(
      f.catalog.audit({ ...expected, genesisHash: "0".repeat(64) }, f.digest, f.ports),
    ).rejects.toThrow("indexed_source_audit_anchor_mismatch");
    await expect(f.catalog.audit(expected, "0".repeat(64), f.ports)).rejects.toThrow();
    await expect(
      f.groups.verifyIndexed(f.catalog, expected, f.digest, "0".repeat(64), f.ports),
    ).rejects.toThrow();
    let visited = 0;
    await expect(
      f.catalog.audit(expected, f.digest, f.ports, () => {
        visited++;
        throw new Error("observer cancelled");
      }),
    ).rejects.toThrow("observer cancelled");
    expect(visited).toBe(1);
    let confirms = 0;
    await expect(
      f.groups.verifyIndexed(f.catalog, expected, f.digest, f.groupDigest, {
        ...f.ports,
        confirm: async () => {
          if (++confirms === 20) throw new Error("audit budget exceeded");
        },
      }),
    ).rejects.toThrow("audit budget exceeded");
    expect(f.dump()).toEqual(before);
    const plan = await f.prepare(posting("audit-race", 1n));
    await expect(
      f.catalog.audit(expected, f.digest, f.ports, () => {
        f.select(plan);
      }),
    ).rejects.toThrow();
    await verify(f);
  } finally {
    f.close();
  }
});

test("complete indexed audits visit late source rows and fail without repairing missing or damaged evidence", async () => {
  for (const defect of [
    "financial-node",
    "origin",
    "canonical-outcome",
    "canonical-bytes",
  ] as const) {
    const f = await fixture();
    try {
      await f.publish(activation());
      await f.publish(posting("audit-early", 1n));
      await f.publish(posting("audit-last-rejection", 0n));
      if (defect === "financial-node") {
        const root = workflowValue(
          f.readAnchor().state.collections.find((c) => c.collection === "protocol.retainedResults"),
        );
        f.db
          .query("UPDATE ledger_indexed_source_nodes SET body = '{}' WHERE digest = ?")
          .run(JSON.parse(root.encodedRoot).tree.digest);
      }
      if (defect === "origin")
        f.db.exec('DELETE FROM ledger_indexed_source_origins WHERE body LIKE \'%"sequence":"3"%\'');
      if (defect === "canonical-outcome")
        f.db.exec("DELETE FROM test_outcome WHERE sequence = '3'");
      if (defect === "canonical-bytes")
        f.db.exec("UPDATE test_outcome SET body = '{}' WHERE sequence = '3'");
      const corrupted = f.dump();
      await expect(verify(f)).rejects.toThrow();
      expect(f.dump()).toEqual(corrupted);
    } finally {
      f.close();
    }
  }
});

test("indexed group audit rechecks the source catalog after its source pass even for an empty directory", async () => {
  const f = await fixture();
  try {
    const original = f.catalog.audit.bind(f.catalog);
    f.catalog.audit = async (...args) => {
      const result = await original(...args);
      f.db.exec("UPDATE ledger_indexed_source_catalog SET body = '{}'");
      return result;
    };
    await expect(verify(f)).rejects.toThrow("indexed_source_corrupt");
    expect(
      (f.db.query("SELECT body FROM ledger_indexed_source_catalog").get() as { body: string }).body,
    ).toBe("{}");
  } finally {
    f.close();
  }
});

test("indexed audits ignore unreachable historical index garbage without adopting or repairing it", async () => {
  const f = await fixture();
  try {
    await f.publish(activation());
    const expected = await verify(f);
    for (const table of [
      "ledger_indexed_source_nodes",
      "ledger_indexed_source_origins",
      "ledger_indexed_group_nodes",
      "ledger_indexed_group_descriptors",
    ]) {
      f.db.query(`INSERT INTO ${table} VALUES (?, ?)`).run("0".repeat(64), "{}");
    }
    const before = f.dump();
    expect(await verify(f)).toEqual(expected);
    expect(f.dump()).toEqual(before);
  } finally {
    f.close();
  }
});
