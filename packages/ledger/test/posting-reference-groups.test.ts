import { expect, test } from "bun:test";
import { hashCanonical } from "@rastrata/kernel";
import { allocationAndTaxWorkflow } from "./accounting-workflows.ts";
import { createIndexedOwnerFixture } from "./indexed-owner-fixture.ts";
import { INDEXED_REFERENCE_GROUP_CATALOG_FORMAT } from "../src/group-catalog.ts";
import { prepareLogicalChange, logicalMapHash } from "../src/logical-map.ts";

test("rehashing an omitted canonical reference group cannot pass the complete source audit", async () => {
  const scenario = allocationAndTaxWorkflow("1.1.0");
  const f = await createIndexedOwnerFixture(
    scenario.initial,
    "",
    true,
    INDEXED_REFERENCE_GROUP_CATALOG_FORMAT,
  );
  try {
    for (const command of scenario.commands.slice(0, 3)) await f.publish(command);
    expect(f.aggregate.state.accountingState.allocationSchedules).toHaveLength(1);
    await f.groups.verifyIndexed(f.catalog, f.readAnchor(), f.digest, f.groupDigest, f.ports);
    const original = f.db.query("SELECT body, digest FROM ledger_indexed_group_catalog").get() as {
      body: string;
      digest: string;
    };
    const metadata = JSON.parse(original.body);
    const descriptors = f.db
      .query("SELECT body, digest FROM ledger_indexed_group_descriptors")
      .all() as { body: string; digest: string }[];
    const selected = descriptors.find(({ body }) => {
      const key = JSON.parse(body).key;
      return (
        key.kind === "postingReferenceRevisionsById" &&
        key.values[0] === "workflow-source-reference"
      );
    });
    if (!selected) throw new Error("Expected real allocation reference group");
    const changed = await prepareLogicalChange(
      metadata.root,
      metadata.rootHash,
      metadata.domain,
      JSON.parse(selected.body).memberDomain,
      selected.digest,
      null,
      async (digest) =>
        (
          f.db
            .query("SELECT body FROM ledger_indexed_group_nodes WHERE digest = ?")
            .get(digest) as { body: string } | null
        )?.body,
    );
    const body = JSON.stringify({
      ...metadata,
      root: changed.encodedRoot,
      rootHash: logicalMapHash(changed.encodedRoot, metadata.domain),
      population: String(BigInt(metadata.population) - 1n),
    });
    const digest = hashCanonical({
      profile: INDEXED_REFERENCE_GROUP_CATALOG_FORMAT,
      kind: "catalog",
      body,
    }).digest;
    f.db.transaction(() => {
      for (const node of changed.nodes)
        f.db
          .query("INSERT OR IGNORE INTO ledger_indexed_group_nodes VALUES (?, ?)")
          .run(node.digest, node.encoded);
      f.db.query("UPDATE ledger_indexed_group_catalog SET body = ?, digest = ?").run(body, digest);
    })();
    f.restart();
    await expect(
      f.groups.verifyIndexed(f.catalog, f.readAnchor(), f.digest, digest, f.ports),
    ).rejects.toThrow("group_catalog_member_missing");
    f.db
      .query("UPDATE ledger_indexed_group_catalog SET body = ?, digest = ?")
      .run(original.body, original.digest);
    f.restart();
    await f.groups.verifyIndexed(f.catalog, f.readAnchor(), f.digest, f.groupDigest, f.ports);
  } finally {
    f.close();
  }
}, 180000);
