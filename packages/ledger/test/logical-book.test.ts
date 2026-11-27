import { expect, test } from "bun:test";
import {
  decodeDurableBook,
  encodeDurableBook,
  executeBookCommand,
  hashCanonical,
  type DurableBookAggregate,
} from "@rastrata/kernel";
import {
  LOGICAL_ACCOUNTING_FIELDS,
  LOGICAL_STATE_FIELDS,
  projectLegacyLogicalBook,
} from "../src/logical-book.ts";
import { auditLogicalMap, lookupLogicalValue, prepareLogicalChange } from "../src/logical-map.ts";
import { rebuildLogicalMap } from "./logical-map-oracle.ts";
import { activation, genesis, posting } from "./fixtures.ts";
import { allocationAndTaxWorkflow } from "./accounting-workflows.ts";

test("genesis projection has a closed complete catalog, including every empty accounting family", async () => {
  const source = genesis();
  const encoded = encodeDurableBook(source);
  const projection = await projectLegacyLogicalBook(encoded);
  expect(Object.keys(LOGICAL_STATE_FIELDS).sort()).toEqual(
    [...Object.keys(source.state), "openingBoundary", "inventoryOwnershipEffects"].sort(),
  );
  expect(
    Object.entries(LOGICAL_STATE_FIELDS)
      .filter(([, disposition]) => disposition === "revisionAlias")
      .map(([field]) => field),
  ).toEqual(["inventoryOwnershipEffects"]);
  expect(Object.hasOwn(source.state, "inventoryOwnershipEffects")).toBe(false);
  expect(Object.keys(LOGICAL_ACCOUNTING_FIELDS).sort()).toEqual(
    Object.keys(source.state.accountingState).sort(),
  );
  expect(projection.collections.length).toBe(24);
  expect(new Set(projection.collections.map((c) => c.name)).size).toBe(24);
  for (const collection of projection.collections) {
    expect(collection.rows.length).toBe(collection.name === "state.configurationSnapshots" ? 1 : 0);
    const oracle = rebuildLogicalMap(
      collection.domain,
      new Map(collection.rows.map((row) => [row.key, row.contentHash])),
    );
    expect(collection.encodedRoot).toBe(oracle.encodedRoot);
    const audit = await auditLogicalMap(
      collection.encodedRoot,
      collection.rootHash,
      collection.domain,
      projection.readNode,
    );
    expect(audit.population).toBe(BigInt(collection.rows.length));
  }
  expect(projection.legacyStateHash).toEqual(source.state.contentHash);
  expect(projection.stateRoot).not.toBe(source.state.contentHash.digest);
  expect(encodeDurableBook(source)).toBe(encoded);
  expect(Object.isFrozen(projection)).toBe(true);
  expect(Object.isFrozen(projection.collections)).toBe(true);
});

test("a retained rejection changes protocol commitment without changing financial projection", async () => {
  const initial = genesis();
  const activated = executeBookCommand(initial.state, initial.protocol, activation());
  const before = await projectLegacyLogicalBook(
    encodeDurableBook({ state: activated.state, protocol: activated.protocol }),
  );
  const rejected = executeBookCommand(
    activated.state,
    activated.protocol,
    posting("projection-reject", 0n),
  );
  expect(rejected.result.disposition).toBe("rejected");
  const after = await projectLegacyLogicalBook(
    encodeDurableBook({ state: rejected.state, protocol: rejected.protocol }),
  );
  expect(after.stateRoot).toBe(before.stateRoot);
  expect(after.headerHash).toBe(before.headerHash);
  expect(after.protocolRoot).not.toBe(before.protocolRoot);
  expect(after.sourceAggregateHash).not.toBe(before.sourceAggregateHash);
  const rows = after.collections.find((c) => c.name === "protocol.retainedResults")?.rows;
  expect(rows?.length).toBe(2);
  expect(rows?.[1]?.encoded).toContain('["s","rejected"]');
  expect(after.collections.find((c) => c.name === "state.revisions")?.rows.length).toBe(1);
});

test("real cumulative-allocation and tax history preserves exact tagged rows and collection order", async () => {
  const scenario = allocationAndTaxWorkflow("1.1.0");
  let aggregate: DurableBookAggregate = scenario.initial;
  for (const command of scenario.commands) {
    const result = executeBookCommand(aggregate.state, aggregate.protocol, command);
    expect(result.result.disposition).toBe("committed");
    aggregate = { state: result.state, protocol: result.protocol };
  }
  const encoded = encodeDurableBook(aggregate);
  const projection = await projectLegacyLogicalBook(encoded);
  // Independent access to the existing canonical tagged wire, not projector helpers.
  const object = (node: [string, [string, unknown][]]) => new Map(node[1]);
  const body = object(JSON.parse(encoded).body);
  const state = object(body.get("state") as [string, [string, unknown][]]);
  const accounting = object(state.get("accountingState") as [string, [string, unknown][]]);
  const sourceCollections = new Map<string, unknown[]>();
  for (const name of [
    "configurationSnapshots",
    "lots",
    "lotHoldings",
    "lotAllocations",
    "journals",
    "corrections",
    "periodTransitions",
    "closePackages",
    "revisions",
  ])
    sourceCollections.set(`state.${name}`, (state.get(name) as [string, unknown[]])[1]);
  sourceCollections.set(
    "state.openingBoundary",
    state.has("openingBoundary") ? [state.get("openingBoundary")] : [],
  );
  for (const [name, value] of accounting)
    sourceCollections.set(`state.accountingState.${name}`, (value as [string, unknown[]])[1]);
  const protocol = object(body.get("protocol") as [string, [string, unknown][]]);
  sourceCollections.set(
    "protocol.retainedResults",
    (protocol.get("retainedResults") as [string, unknown[]])[1],
  );
  expect(projection.collections.map((c) => c.name).sort()).toEqual(
    [...sourceCollections.keys()].sort(),
  );
  const roots: { name: string; rootHash: string; population: bigint }[] = [];
  for (const [name, sourceRows] of sourceCollections) {
    const collection = projection.collections.find((c) => c.name === name);
    if (!collection) throw new Error("Missing source collection");
    expect(collection.rows.map((row) => row.encoded)).toEqual(
      sourceRows.map((row) => JSON.stringify(row)),
    );
    const expected = rebuildLogicalMap(
      collection.domain,
      new Map(collection.rows.map((row) => [row.key, row.contentHash])),
    );
    expect(collection.rootHash).toBe(expected.rootHash);
    roots.push({ name, rootHash: expected.rootHash, population: BigInt(sourceRows.length) });
    for (const row of collection.rows) {
      expect(row.contentHash).toBe(
        hashCanonical({ domain: collection.domain, ordinal: row.ordinal, encoded: row.encoded })
          .digest,
      );
      expect(
        (
          await lookupLogicalValue(
            collection.encodedRoot,
            collection.rootHash,
            collection.domain,
            row.key,
            projection.readNode,
          )
        ).value,
      ).toBe(row.contentHash);
    }
  }
  const header = Object.fromEntries(
    [
      "identity",
      "financialIdentityHash",
      "status",
      "bookRevision",
      "latestPostingSequence",
      "configurationRevision",
      "configurationHash",
    ].map((name) => [name, JSON.stringify(state.get(name))]),
  );
  const aliases = Object.fromEntries(
    [
      "activeConfigurationSnapshot",
      "periods",
      "admissionSnapshot",
      "policies",
      "quantizationPolicies",
      "accountingPolicySnapshot",
    ].map((name) => [
      name,
      hashCanonical({
        profile: projection.profile,
        alias: name,
        encoded: JSON.stringify(state.get(name)),
      }).digest,
    ]),
  );
  const headerHash = hashCanonical({
    profile: projection.profile,
    sourceCodec: JSON.parse(encoded).version,
    header,
    aliases,
  }).digest;
  expect(projection.headerHash).toBe(headerHash);
  roots.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  expect(projection.stateRoot).toBe(
    hashCanonical({
      profile: projection.profile,
      financialIdentity: JSON.stringify(state.get("financialIdentityHash")),
      headerHash,
      collections: roots.filter((c) => c.name.startsWith("state.")),
    }).digest,
  );
  expect(projection.protocolRoot).toBe(
    hashCanonical({
      profile: projection.profile,
      financialIdentity: JSON.stringify(state.get("financialIdentityHash")),
      collections: roots.filter((c) => c.name.startsWith("protocol.")),
    }).digest,
  );
  expect(
    projection.collections.find((c) => c.name === "state.accountingState.allocationRecognitions")
      ?.rows.length,
  ).toBeGreaterThan(0);
  expect(
    projection.collections.find((c) => c.name === "state.accountingState.taxDeterminations")?.rows
      .length,
  ).toBeGreaterThan(0);
  expect(
    projection.collections.flatMap((c) => c.rows).some((row) => row.encoded.includes('["r",')),
  ).toBe(true);
  expect(
    projection.collections.flatMap((c) => c.rows).some((row) => row.encoded.includes('["d",')),
  ).toBe(true);
  expect(encodeDurableBook(aggregate)).toBe(encoded);
});

test("conditional logical updates match complete projection after every real workflow outcome", async () => {
  const scenario = allocationAndTaxWorkflow("1.1.0");
  let aggregate: DurableBookAggregate = scenario.initial;
  let before = await projectLegacyLogicalBook(encodeDurableBook(aggregate));
  for (const command of [...scenario.commands, posting("projection-stale-tail", 0n)]) {
    const outcome = executeBookCommand(aggregate.state, aggregate.protocol, command);
    aggregate = { state: outcome.state, protocol: outcome.protocol };
    const after = await projectLegacyLogicalBook(encodeDurableBook(aggregate));
    expect(after.collections.map((c) => c.name)).toEqual(before.collections.map((c) => c.name));
    let changedRows = 0;
    for (const prior of before.collections) {
      const next = after.collections.find((c) => c.name === prior.name);
      if (!next) throw new Error("Omitted projection collection");
      expect(next.domain).toBe(prior.domain);
      let root = prior.encodedRoot;
      let rootHash = prior.rootHash;
      const proposedNodes = new Map<string, string>();
      const read = async (digest: string) =>
        proposedNodes.get(digest) ?? (await before.readNode(digest));
      for (let index = 0; index < Math.max(prior.rows.length, next.rows.length); index++) {
        const oldRow = prior.rows[index];
        const newRow = next.rows[index];
        if (oldRow?.contentHash === newRow?.contentHash) continue;
        const key = oldRow?.key ?? newRow?.key;
        if (!key) throw new Error("Missing changed row key");
        const delta = await prepareLogicalChange(
          root,
          rootHash,
          prior.domain,
          key,
          oldRow?.contentHash ?? null,
          newRow?.contentHash ?? null,
          read,
        );
        for (const node of delta.nodes) proposedNodes.set(node.digest, node.encoded);
        root = delta.encodedRoot;
        rootHash = delta.rootHash;
        changedRows++;
      }
      expect(root).toBe(next.encodedRoot);
      expect(rootHash).toBe(next.rootHash);
      const observed = new Map<string, string>();
      await auditLogicalMap(root, rootHash, next.domain, read, (key, value) => {
        observed.set(key, value);
      });
      expect(observed).toEqual(new Map(next.rows.map((row) => [row.key, row.contentHash])));
    }
    expect(changedRows).toBeGreaterThan(0);
    if (outcome.result.disposition === "rejected") {
      expect(changedRows).toBe(1); // Only the new retained rejection, no financial row.
      expect(after.stateRoot).toBe(before.stateRoot);
    }
    before = after;
  }
});

for (const file of [
  "allocation-rounding-legacy.json",
  "../../kernel/test/data/inventory-adjustment-legacy.json",
]) {
  test(`unchanged historical ${file} projects deterministically without repairing old outcomes`, async () => {
    const path = file.startsWith("../")
      ? new URL(file, import.meta.url)
      : new URL(`./data/${file}`, import.meta.url);
    const encoded = (await Bun.file(path).text()).trim();
    const decoded = decodeDurableBook(encoded);
    if (decoded.disposition !== "decoded") throw new Error(decoded.message);
    const first = await projectLegacyLogicalBook(encoded);
    const second = await projectLegacyLogicalBook(encodeDurableBook(decoded.aggregate));
    expect(first.stateRoot).toBe(second.stateRoot);
    expect(first.protocolRoot).toBe(second.protocolRoot);
    expect(first.sourceAggregateHash).toBe(second.sourceAggregateHash);
    expect(first.legacyStateHash).toEqual(decoded.aggregate.state.contentHash);
    expect(encodeDurableBook(decoded.aggregate)).toBe(encoded);
  });
}

test("malformed and semantically corrupted sources cannot create projection evidence", async () => {
  const initial = genesis();
  await expect(projectLegacyLogicalBook(`${encodeDurableBook(initial)} `)).rejects.toThrow(
    "logical_book_source_noncanonical",
  );
  await expect(
    projectLegacyLogicalBook(
      encodeDurableBook({ ...initial, state: { ...initial.state, status: "archived" } }),
    ),
  ).rejects.toThrow("logical_book_source_invalid");
  await expect(
    projectLegacyLogicalBook(
      encodeDurableBook({
        ...initial,
        state: { ...initial.state, overlooked: [] },
      } as unknown as DurableBookAggregate),
    ),
  ).rejects.toThrow("logical_book_source_invalid");
  await expect(projectLegacyLogicalBook("{}")).rejects.toThrow("logical_book_source_invalid");
});
