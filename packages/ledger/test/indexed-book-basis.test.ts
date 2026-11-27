import { expect, test } from "bun:test";
import {
  encodeDurableBook,
  executeBookCommand,
  hashCanonical,
  type DurableBookAggregate,
  type BookRowCollection,
} from "@rastrata/kernel";
import { readPinnedIndexedBookBasis } from "../src/book-basis.ts";
import {
  projectLegacyIndexedBook,
  prepareIndexedBookHead,
  indexedRowCommitment,
} from "../src/indexed-book-state.ts";
import { projectLegacyLogicalBook } from "../src/logical-book.ts";
import { genesis, activation, posting, BOOK } from "./fixtures.ts";
import type { CapturedRow } from "../src/source-catalog.ts";

// Isolated basis boundary. The artificial chain and port below are explicitly
// test inputs, not a claim of owner/source-prefix or publication authority.
async function fixture(active: boolean) {
  let aggregate: DurableBookAggregate = genesis();
  if (active)
    for (const command of [activation(), posting("basis-sale"), posting("basis-reject", 0n)]) {
      const next = executeBookCommand(aggregate.state, aggregate.protocol, command);
      aggregate = { state: next.state, protocol: next.protocol };
    }
  const encoded = encodeDurableBook(aggregate);
  const indexed = await projectLegacyIndexedBook(encoded);
  const projection = await projectLegacyLogicalBook(encoded);
  const scope = {
    tenantId: "basis-test",
    bookId: BOOK,
    objectId: "basis-object",
    namespaceId: "basis-test",
    generation: "0",
  };
  const head = prepareIndexedBookHead(
    scope,
    scope.objectId,
    indexed.state,
    active ? hashCanonical("isolated-chain") : null,
    aggregate.state.revisions.at(-1)?.chainHash ?? null,
  );
  const catalog = "a".repeat(64);
  const reads: string[] = [];
  const raw = async (collection: string, ordinal: bigint): Promise<CapturedRow> => {
    reads.push(`${collection}/${ordinal}`);
    const row = projection.collections
      .find((c) => c.name === collection)
      ?.rows.find((r) => r.ordinal === ordinal);
    return {
      collection,
      ordinal,
      catalogDigest: catalog,
      headHash: head.contentHash,
      disposition: row ? "present" : "absent",
      encoded: row?.encoded ?? null,
      rowHash: row
        ? indexedRowCommitment(
            aggregate.state.financialIdentityHash,
            collection as BookRowCollection,
            ordinal,
            row.encoded,
          )
        : null,
    };
  };
  return { aggregate, indexed, head, catalog, raw, reads };
}

test("indexed basis uses three exact source coordinates and retains distinct state/head hash domains", async () => {
  for (const active of [false, true]) {
    const f = await fixture(active);
    const result = await readPinnedIndexedBookBasis(
      f.aggregate.state,
      f.indexed.state,
      f.head,
      f.catalog,
      f.raw,
      async () => {},
    );
    expect(f.reads).toEqual([
      "state.configurationSnapshots/1",
      "state.openingBoundary/1",
      `state.revisions/${active ? 2 : 1}`,
    ]);
    expect(result.headHash).toBe(f.head.contentHash);
    expect(result.header.contentHash).toEqual(f.aggregate.state.contentHash);
    expect(result.header.contentHash.digest).not.toBe(f.indexed.state.contentHash);
    expect(result.financialRevision?.row ?? null).toEqual(
      f.aggregate.state.revisions.at(-1) ?? null,
    );
  }
});

test("indexed basis refuses mismatched framing, coordinates, source absence and final authority", async () => {
  const f = await fixture(true);
  for (const head of [
    { ...f.head, configurationHash: hashCanonical("forged-configuration") },
    { ...f.head, stateContentHash: "0".repeat(64) },
    { ...f.head, identity: { ...f.head.identity, generation: "1" } },
  ]) {
    await expect(
      readPinnedIndexedBookBasis(
        f.aggregate.state,
        f.indexed.state,
        head,
        f.catalog,
        f.raw,
        async () => {},
      ),
    ).rejects.toThrow();
  }
  await expect(
    readPinnedIndexedBookBasis(
      { ...f.aggregate.state, status: "configuring" },
      f.indexed.state,
      f.head,
      f.catalog,
      f.raw,
      async () => {},
    ),
  ).rejects.toThrow("book_basis_header_mismatch");
  for (const field of [
    "headHash",
    "catalogDigest",
    "ordinal",
    "collection",
    "encoded",
    "absent",
  ] as const) {
    await expect(
      readPinnedIndexedBookBasis(
        f.aggregate.state,
        f.indexed.state,
        f.head,
        f.catalog,
        async (c, n) => {
          const row = await f.raw(c, n);
          if (field === "absent")
            return { ...row, disposition: "absent", encoded: null, rowHash: null };
          if (field === "ordinal") return { ...row, ordinal: n + 1n };
          return { ...row, [field]: "wrong" };
        },
        async () => {},
      ),
    ).rejects.toThrow("book_basis_source_mismatch");
  }
  let revoked = false;
  await expect(
    readPinnedIndexedBookBasis(
      f.aggregate.state,
      f.indexed.state,
      f.head,
      f.catalog,
      async (c, n) => {
        const row = await f.raw(c, n);
        if (c === "state.revisions") revoked = true;
        return row;
      },
      async () => {
        if (revoked) throw new Error("revoked at final confirmation");
      },
    ),
  ).rejects.toThrow("revoked at final confirmation");
});
