import { expect, test } from "bun:test";
import {
  ExactRational as R,
  ExactDecimal as D,
  accountId,
  bookId,
  commodityId,
  identifier,
  hashCanonical,
  encodeBookRow,
  executeBookCommand,
  sealCommand,
  resolveJournal,
  type ResolvedTransaction,
} from "@rastrata/kernel";
import { activation, BOOK, CASH, genesis, posting } from "./fixtures.ts";
import { workflowValue } from "./accounting-workflows.ts";
import { createIndexedOwnerFixture } from "./indexed-owner-fixture.ts";
import { INDEXED_MONEY_GROUP_CATALOG_FORMAT } from "../src/group-catalog.ts";
import { indexedCollectionDomain } from "../src/indexed-book-state.ts";
import { prepareLogicalChange, logicalMapHash } from "../src/logical-map.ts";
import {
  journalMoneyScopeTotals,
  moneyScopeValues,
  snapshotMoneyScope,
  semanticGroupKey,
  semanticGroupDigest,
  projectSemanticGroupMemberships,
} from "../src/semantic-groups.ts";

const scope = {
  bookId: BOOK,
  accountId: CASH,
  functionalCommodityId: commodityId("USD"),
  dimensionMemberIds: [],
};
const scopeKey = semanticGroupKey("journalsByMoneyScope", moneyScopeValues(scope));

test("money scopes snapshot exact raw coordinates, normalize dimension order and never invoke input accessors", () => {
  const dimensions = [identifier<"DimensionMember">("z"), identifier<"DimensionMember">("a")];
  const input = { ...scope, dimensionMemberIds: dimensions };
  const copied = snapshotMoneyScope(input);
  dimensions[0] = identifier<"DimensionMember">("changed");
  expect(copied.dimensionMemberIds).toEqual([
    identifier<"DimensionMember">("a"),
    identifier<"DimensionMember">("z"),
  ]);
  expect(Object.isFrozen(copied.dimensionMemberIds)).toBe(true);
  expect(() =>
    snapshotMoneyScope({
      ...scope,
      dimensionMemberIds: [identifier<"DimensionMember">("a"), identifier<"DimensionMember">("a")],
    }),
  ).toThrow("semantic_group_key_invalid");
  expect(() =>
    semanticGroupKey("journalsByMoneyScope", ["book", "account", "USD", "z", "a"]),
  ).toThrow("semantic_group_key_invalid");
  let invoked = 0;
  const accessor = {
    ...scope,
    get accountId() {
      invoked++;
      return CASH;
    },
  };
  expect(() => snapshotMoneyScope(accessor)).toThrow("money_scope_input_invalid");
  const arrayAccessor = [...copied.dimensionMemberIds];
  Object.defineProperty(arrayAccessor, "0", {
    enumerable: true,
    get() {
      invoked++;
      return "a";
    },
  });
  expect(() => snapshotMoneyScope({ ...scope, dimensionMemberIds: arrayAccessor })).toThrow(
    "money_scope_input_invalid",
  );
  expect(invoked).toBe(0);
  expect(() =>
    snapshotMoneyScope({
      ...scope,
      dimensionMemberIds: [identifier<"DimensionMember">("é".repeat(524289))],
    }),
  ).toThrow("semantic_group_key_too_large");
  expect(() => snapshotMoneyScope({ ...scope, extra: true } as typeof scope)).toThrow(
    "money_scope_input_invalid",
  );
  const domain = "a".repeat(64);
  const first = semanticGroupKey(
    "journalsByMoneyScope",
    moneyScopeValues({ ...scope, bookId: bookId("a:b"), accountId: accountId("c") }),
  );
  const second = semanticGroupKey(
    "journalsByMoneyScope",
    moneyScopeValues({ ...scope, bookId: bookId("a"), accountId: accountId("b:c") }),
  );
  expect(semanticGroupDigest(domain, first)).not.toBe(semanticGroupDigest(domain, second));
});

test("journal scope projection totals actual posted money across units and dimension order, retaining zero-sum membership", () => {
  const initial = genesis();
  const opened = executeBookCommand(initial.state, initial.protocol, activation());
  const posted = executeBookCommand(opened.state, opened.protocol, posting());
  expect(posted.result.disposition).toBe("committed");
  const booked = workflowValue(posted.state.journals[0]);
  const source = workflowValue(booked.journal.postings[0]);
  // Row-projection contract case, not admission of invented analytic members.
  const row = {
    ...booked,
    journal: {
      ...booked.journal,
      postings: [
        {
          ...source,
          dimensionMemberIds: [
            identifier<"DimensionMember">("z"),
            identifier<"DimensionMember">("a"),
          ],
          bookValue: { ...source.bookValue, amount: D.of(1n, 2n) },
        },
        {
          ...source,
          id: identifier<"Posting">("second"),
          ordinal: 1n,
          units: {
            canonicalNumber: R.of(37n, 1n),
            commodityId: commodityId("different-stock-unit"),
          },
          dimensionMemberIds: [
            identifier<"DimensionMember">("a"),
            identifier<"DimensionMember">("z"),
          ],
          bookValue: { ...source.bookValue, amount: D.of(-10n, 3n) },
        },
        {
          ...source,
          id: identifier<"Posting">("third"),
          ordinal: 2n,
          dimensionMemberIds: [],
          bookValue: { ...source.bookValue, amount: D.of(99n, 2n) },
        },
      ],
    },
  };
  const totals = [...journalMoneyScopeTotals(row).values()];
  expect(totals.map((entry) => entry.amount.toString())).toEqual(["0/1", "99/100"]);
  expect(totals[0]?.key.values).toEqual([BOOK, CASH, "USD", "a", "z"]);
  const groups = projectSemanticGroupMemberships(
    "state.journals",
    encodeBookRow("state.journals", row),
    1n,
  );
  expect(groups).toHaveLength(2); // Two same-scope postings do not duplicate the journal member.
  expect(groups.map((member) => member.group)).toEqual(totals.map((entry) => entry.key));
});

test("posted summaries equal independent canonical sums and read no historical source rows after audit", async () => {
  const nodeReadCounts: number[] = [];
  const f = await createIndexedOwnerFixture(
    genesis(),
    "",
    true,
    INDEXED_MONEY_GROUP_CATALOG_FORMAT,
  );
  try {
    await f.publish(activation());
    for (let i = 0; i < 16; i++) {
      await f.publish(posting(`money-${i}`, BigInt(i + 1)));
      if (i !== 0 && i !== 3 && i !== 15) continue;
      await f.groups.verifyIndexed(f.catalog, f.readAnchor(), f.digest, f.groupDigest, f.ports);
      f.restart();
      const capture = f.groups.capture(f.readAnchor().head.contentHash, f.groupDigest);
      try {
        const count = f.reads.length;
        const statementCount = f.faults.statements.length;
        for (const account of [CASH, accountId("income"), accountId("missing")]) {
          const key = semanticGroupKey(
            "journalsByMoneyScope",
            moneyScopeValues({ ...scope, accountId: account }),
          );
          const read = await f.groups.readPostedBalance(
            capture,
            indexedCollectionDomain(f.aggregate.state.financialIdentityHash, "state.journals"),
            key,
            f.ports.confirm,
          );
          const expected = f.aggregate.state.journals
            .flatMap((journal) => journal.journal.postings)
            .filter((posting) => posting.accountId === account)
            .reduce((sum, posting) => sum.add(posting.bookValue.amount.toRational()), R.zero());
          expect(read.postedBalance).toEqual(expected);
          expect(read.population).toBe(account === "missing" ? 0n : BigInt(i + 1));
          expect(read.descriptorHash === null).toBe(account === "missing");
        }
        expect(f.reads.length).toBe(count); // Summary lookups never fetch genesis/outcome source payloads.
        const nodeReads = f.faults.statements
          .slice(statementCount)
          .filter((sql) => sql.includes("FROM ledger_indexed_group_nodes ")).length;
        nodeReadCounts.push(nodeReads);
        expect(nodeReads).toBeGreaterThan(0);
        expect(nodeReads).toBeLessThanOrEqual(6); // Three queries in a fixed two-scope directory.
        const stale = capture;
        f.faults.deny = true;
        await expect(
          f.groups.readPostedBalance(
            stale,
            indexedCollectionDomain(f.aggregate.state.financialIdentityHash, "state.journals"),
            scopeKey,
            f.ports.confirm,
          ),
        ).rejects.toThrow("owner pin revoked");
        f.faults.deny = false;
      } finally {
        f.groups.release(capture);
      }
    }
    expect(nodeReadCounts).toHaveLength(3);
    expect(new Set(nodeReadCounts).size).toBe(1); // 1, 4 and 16 journals: unchanged read work.
  } finally {
    f.close();
  }
}, 180000);

test("zero-sum canonical journal retains a nonempty money scope and exact zero balance", async () => {
  const initial = genesis();
  const f = await createIndexedOwnerFixture(initial, "", true, INDEXED_MONEY_GROUP_CATALOG_FORMAT);
  try {
    await f.publish(activation());
    const template = posting("zero-sum");
    if (template.type !== "postJournal") throw new Error("Expected journal command");
    const journal = {
      ...template.resolved.journal,
      postings: template.resolved.journal.postings.map((p) => ({ ...p, accountId: CASH })),
    };
    const resolved = resolveJournal(
      journal,
      initial.state.policies,
      initial.state.identity.ownerId,
      workflowValue(initial.state.quantizationPolicies[0]),
      journal.postings.map((p) => p.bookValue.amount.toRational()),
    );
    if (Array.isArray(resolved)) throw new Error("Zero journal did not resolve");
    await f.publish(sealCommand({ ...template, resolved: resolved as ResolvedTransaction }));
    expect(f.aggregate.state.journals).toHaveLength(1);
    await f.groups.verifyIndexed(f.catalog, f.readAnchor(), f.digest, f.groupDigest, f.ports);
    const capture = f.groups.capture(f.readAnchor().head.contentHash, f.groupDigest);
    try {
      const balance = await f.groups.readPostedBalance(
        capture,
        indexedCollectionDomain(f.aggregate.state.financialIdentityHash, "state.journals"),
        scopeKey,
        f.ports.confirm,
      );
      expect(balance.postedBalance.toString()).toBe("0/1");
      expect(balance.population).toBe(1n);
      expect(balance.memberHash).not.toBeNull();
    } finally {
      f.groups.release(capture);
    }
  } finally {
    f.close();
  }
});

test("rehashed wrong summary cannot pass complete canonical source audit", async () => {
  const f = await createIndexedOwnerFixture(
    genesis(),
    "",
    true,
    INDEXED_MONEY_GROUP_CATALOG_FORMAT,
  );
  try {
    await f.publish(activation());
    await f.publish(posting());
    await f.groups.verifyIndexed(f.catalog, f.readAnchor(), f.digest, f.groupDigest, f.ports);
    const original = f.db.query("SELECT body, digest FROM ledger_indexed_group_catalog").get() as {
      body: string;
      digest: string;
    };
    const metadata = JSON.parse(original.body);
    const descriptors = f.db
      .query("SELECT body, digest FROM ledger_indexed_group_descriptors")
      .all() as { body: string; digest: string }[];
    const selected = descriptors.find(
      (row) => JSON.stringify(JSON.parse(row.body).key) === JSON.stringify(scopeKey),
    );
    if (!selected) throw new Error("Missing authentic money descriptor");
    const descriptor = JSON.parse(selected.body);
    const readNode = async (digest: string) =>
      (
        f.db.query("SELECT body FROM ledger_indexed_group_nodes WHERE digest = ?").get(digest) as {
          body: string;
        } | null
      )?.body;
    for (const [value, code] of [
      ["0/1", "group_balance_source_mismatch"],
      ["0/2", "group_balance_invalid"],
    ] as const) {
      const body = JSON.stringify({ ...descriptor, postedBalance: value });
      const digest = hashCanonical({
        profile: INDEXED_MONEY_GROUP_CATALOG_FORMAT,
        kind: "descriptor",
        body,
      }).digest;
      const changed = await prepareLogicalChange(
        metadata.root,
        metadata.rootHash,
        metadata.domain,
        descriptor.memberDomain,
        selected.digest,
        digest,
        readNode,
      );
      const newBody = JSON.stringify({
        ...metadata,
        root: changed.encodedRoot,
        rootHash: logicalMapHash(changed.encodedRoot, metadata.domain),
      });
      const newDigest = hashCanonical({
        profile: INDEXED_MONEY_GROUP_CATALOG_FORMAT,
        kind: "catalog",
        body: newBody,
      }).digest;
      f.db.transaction(() => {
        for (const node of changed.nodes)
          f.db
            .query("INSERT OR IGNORE INTO ledger_indexed_group_nodes VALUES (?, ?)")
            .run(node.digest, node.encoded);
        f.db
          .query("INSERT OR IGNORE INTO ledger_indexed_group_descriptors VALUES (?, ?)")
          .run(digest, body);
        f.db
          .query("UPDATE ledger_indexed_group_catalog SET body = ?, digest = ?")
          .run(newBody, newDigest);
      })();
      f.restart();
      await expect(
        f.groups.verifyIndexed(f.catalog, f.readAnchor(), f.digest, newDigest, f.ports),
      ).rejects.toThrow(code);
      f.db
        .query("UPDATE ledger_indexed_group_catalog SET body = ?, digest = ?")
        .run(original.body, original.digest);
      f.restart();
      await f.groups.verifyIndexed(f.catalog, f.readAnchor(), f.digest, f.groupDigest, f.ports);
    }
  } finally {
    f.close();
  }
});
