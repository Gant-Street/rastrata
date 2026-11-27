import { expect, test } from "bun:test";
import {
  encodeBookRow,
  encodeDurableBook,
  executeBookCommand,
  ExactRational,
  hashCanonical,
} from "@rastrata/kernel";
import {
  projectSemanticGroupMemberships,
  semanticGroupDeltas,
  semanticGroupDigest,
  semanticGroupKey,
  type SemanticGroupKey,
  type SemanticGroupCollection,
} from "../src/semantic-groups.ts";
import {
  emptyLogicalMap,
  logicalMapHash,
  prepareLogicalChange,
  readLogicalRangePage,
} from "../src/logical-map.ts";
import { projectLegacyLogicalBook } from "../src/logical-book.ts";
import { rebuildLogicalMap } from "./logical-map-oracle.ts";
import {
  allocationAndTaxWorkflow,
  lotIdentityWorkflow,
  workflowValue,
} from "./accounting-workflows.ts";

const hex = (n: bigint) => n.toString(16).padStart(64, "0");

test("group membership deltas agree with independent full-state queries and group-tree rebuilds", async () => {
  for (const scenario of [lotIdentityWorkflow(), allocationAndTaxWorkflow("1.1.0")]) {
    let aggregate = scenario.initial;
    let previous = await projectLegacyLogicalBook(encodeDurableBook(aggregate));
    const groups = new Map<
      string,
      {
        query: SemanticGroupKey;
        collection: SemanticGroupCollection;
        domain: string;
        root: string;
        nodes: Map<string, string>;
      }
    >();
    let removed = 0;
    for (const command of scenario.commands) {
      const applied = executeBookCommand(aggregate.state, aggregate.protocol, command);
      expect(applied.result.disposition).toBe("committed");
      aggregate = { state: applied.state, protocol: applied.protocol };
      const next = await projectLegacyLogicalBook(encodeDurableBook(aggregate));
      for (const collection of [
        "state.lotHoldings",
        "state.accountingState.allocationRecognitions",
      ] as const) {
        const before = workflowValue(previous.collections.find((c) => c.name === collection));
        const after = workflowValue(next.collections.find((c) => c.name === collection));
        for (let i = 0; i < Math.max(before.rows.length, after.rows.length); i++) {
          const oldRow = before.rows[i],
            newRow = after.rows[i];
          const changes = semanticGroupDeltas(
            collection,
            BigInt(i) + 1n,
            oldRow ? { encoded: oldRow.encoded, rowHash: oldRow.contentHash } : null,
            newRow ? { encoded: newRow.encoded, rowHash: newRow.contentHash } : null,
          );
          for (const change of changes) {
            if (change.after === null) removed++;
            const id = JSON.stringify(change.group);
            const domain = semanticGroupDigest(after.domain, change.group);
            const group = groups.get(id) ?? {
              query: change.group,
              collection,
              domain,
              root: emptyLogicalMap(domain),
              nodes: new Map<string, string>(),
            };
            const prepared = await prepareLogicalChange(
              group.root,
              logicalMapHash(group.root, domain),
              domain,
              hex(change.ordinal),
              change.before,
              change.after,
              async (d) => group.nodes.get(d),
            );
            for (const node of prepared.nodes) group.nodes.set(node.digest, node.encoded);
            group.root = prepared.encodedRoot;
            groups.set(id, group);
          }
        }
      }
      // Independent oracle reads the materialized kernel state directly and uses
      // its own predicates, not the grouping/delta projection under test.
      for (const group of groups.values()) {
        const collection = workflowValue(next.collections.find((c) => c.name === group.collection));
        const expected = new Map<string, string>();
        const { kind, values } = group.query;
        if (kind === "recognitionsBySchedule") {
          aggregate.state.accountingState.allocationRecognitions.forEach((r, i) => {
            if (r.scheduleId === values[0])
              expected.set(hex(BigInt(i) + 1n), workflowValue(collection.rows[i]).contentHash);
          });
        } else {
          aggregate.state.lotHoldings.forEach((h, i) => {
            const member =
              kind === "holdingsByLot"
                ? h.lotId === values[0]
                : kind === "holdingsByAccount"
                  ? h.accountId === values[0]
                  : h.accountId === values[0] &&
                    h.commodityId === values[1] &&
                    h.remainingQuantity.numerator !== 0n;
            if (member)
              expected.set(hex(BigInt(i) + 1n), workflowValue(collection.rows[i]).contentHash);
          });
        }
        const rebuilt = rebuildLogicalMap(group.domain, expected);
        expect(logicalMapHash(group.root, group.domain)).toBe(rebuilt.rootHash);
        const actual = new Map<string, string>();
        let from: string | null = null;
        while (true) {
          const page = await readLogicalRangePage(
            group.root,
            rebuilt.rootHash,
            group.domain,
            from,
            null,
            1,
            async (d) => group.nodes.get(d),
          );
          for (const entry of page.entries) actual.set(entry.key, entry.value);
          if (page.complete) break;
          if (page.nextFromInclusive === null) throw new Error("Missing continuation");
          from = page.nextFromInclusive;
        }
        expect(actual).toEqual(expected);
      }
      previous = next;
    }
    if ("source" in scenario)
      expect(removed).toBe(1); // Fully depleted original exits ONLY the nonzero group.
    else expect(groups.size).toBe(2); // Original and successor recognition populations remain separate.
  }
});

test("nonzero holdings use the exact kernel predicate while all-holding groups preserve depleted rows", () => {
  const scenario = lotIdentityWorkflow();
  let aggregate = scenario.initial;
  for (const command of scenario.commands) {
    const next = executeBookCommand(aggregate.state, aggregate.protocol, command);
    aggregate = { state: next.state, protocol: next.protocol };
  }
  const holding = workflowValue(aggregate.state.lotHoldings[0]);
  const row = encodeBookRow("state.lotHoldings", holding);
  expect(
    projectSemanticGroupMemberships("state.lotHoldings", row, 1n).map((m) => m.group.kind),
  ).toEqual(["holdingsByLot", "holdingsByAccount"]);
  // Structurally decodable negative quantity is not a new admission rule here;
  // this projection must mirror !isZero rather than silently imposing > 0.
  const negative = encodeBookRow("state.lotHoldings", {
    ...holding,
    remainingQuantity: ExactRational.of(-1n, 1n),
  });
  const memberships = projectSemanticGroupMemberships("state.lotHoldings", negative, 1n);
  expect(memberships.map((m) => m.group.kind)).toEqual([
    "holdingsByLot",
    "holdingsByAccount",
    "nonzeroHoldingsByAccountCommodity",
  ]);
  expect(Object.isFrozen(memberships)).toBe(true);
  expect(Object.isFrozen(memberships[0]?.group.values)).toBe(true);
  const before = { encoded: negative, rowHash: hashCanonical({ source: "before" }).digest };
  const after = { encoded: row, rowHash: hashCanonical({ source: "after" }).digest };
  const deltas = semanticGroupDeltas("state.lotHoldings", 1n, before, after);
  expect(deltas.map((d) => [d.group.kind, d.before, d.after])).toEqual([
    ["holdingsByLot", before.rowHash, after.rowHash],
    ["holdingsByAccount", before.rowHash, after.rowHash],
    ["nonzeroHoldingsByAccountCommodity", before.rowHash, null],
  ]);
  expect(semanticGroupDeltas("state.lotHoldings", 1n, after, after)).toEqual([]);
  expect(() =>
    semanticGroupDeltas("state.lotHoldings", 1n, before, { ...after, rowHash: before.rowHash }),
  ).toThrow("semantic_group_hash_incoherent");
  expect(() =>
    semanticGroupDeltas("state.lotHoldings", 1n, after, { ...after, rowHash: before.rowHash }),
  ).toThrow("semantic_group_hash_incoherent");
});

test("group keys are typed raw tuples with financial collection separation and immutable copying", () => {
  const values = ["cash:α", "USD"];
  const key = semanticGroupKey("nonzeroHoldingsByAccountCommodity", values);
  values[0] = "changed";
  expect(key.values).toEqual(["cash:α", "USD"]);
  const domain = hashCanonical({ collection: "book-a-holdings" }).digest;
  const digest = semanticGroupDigest(domain, key);
  expect(digest).not.toBe(
    semanticGroupDigest(hashCanonical({ collection: "book-b-holdings" }).digest, key),
  );
  expect(
    semanticGroupDigest(
      domain,
      semanticGroupKey("nonzeroHoldingsByAccountCommodity", ["a:b", "c"]),
    ),
  ).not.toBe(
    semanticGroupDigest(
      domain,
      semanticGroupKey("nonzeroHoldingsByAccountCommodity", ["a", "b:c"]),
    ),
  );
  expect(semanticGroupDigest(domain, semanticGroupKey("holdingsByLot", ["same"]))).not.toBe(
    semanticGroupDigest(domain, semanticGroupKey("holdingsByAccount", ["same"])),
  );
  for (const values of [[], ["x", "y"], [""], [" leading"], ["e\u0301"]])
    expect(() => semanticGroupKey("holdingsByLot", values)).toThrow();
  expect(() => semanticGroupKey("constructor" as "holdingsByLot", ["x"])).toThrow(
    "semantic_group_kind_invalid",
  );
  expect(() => semanticGroupDigest("bad", key)).toThrow("semantic_group_domain_invalid");
});

test("group projections reject unknown collections and invalid ordinals even for empty changes", () => {
  for (const ordinal of [0n, -1n, 1n << 256n]) {
    expect(() => semanticGroupDeltas("state.lotHoldings", ordinal, null, null)).toThrow(
      "semantic_group_ordinal_invalid",
    );
    expect(() => projectSemanticGroupMemberships("state.lotHoldings", "{}", ordinal)).toThrow(
      "semantic_group_ordinal_invalid",
    );
  }
  expect(() =>
    semanticGroupDeltas("state.unknown" as SemanticGroupCollection, 1n, null, null),
  ).toThrow("semantic_group_collection_invalid");
  expect(() => projectSemanticGroupMemberships("state.lotHoldings", "{}", 1n)).toThrow(
    "semantic_group_row_invalid",
  );
  expect(() =>
    semanticGroupDeltas("state.lotHoldings", 1n, { encoded: "{}", rowHash: "bad" }, null),
  ).toThrow("semantic_group_hash_invalid");
  expect(semanticGroupDeltas("state.lotHoldings", 1n, null, null)).toEqual([]);
});
