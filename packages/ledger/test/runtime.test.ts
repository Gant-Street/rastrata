import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { canonicalEncode, encodeDurableBook, executeBookCommand } from "@rastrata/kernel";
import { BOOK, activation, genesis, posting } from "./fixtures.ts";
import { createIndexRoot, encodeIndexPage, identityIndexKey } from "../src/index-pages.ts";
import type { IdentityFamily } from "../src/identity-audit.ts";
import { evaluateOutcomePayload } from "../src/outcome-payload.ts";

test("L02-L06/L08: real workerd SQLite survives runtime replacement and concurrent retries", async () => {
  // Preserve native node: imports for Workers compatibility; browser mode injects shims.
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "runtime-worker.ts")],
    target: "node",
    format: "esm",
    external: ["node:crypto"],
  });
  expect(build.success).toBe(true);
  const output = build.outputs[0];
  if (!output) throw new Error("Missing runtime bundle");
  const script = await output.text();
  expect(script).toContain('from "node:crypto"');
  const directory = mkdtempSync(join(tmpdir(), "rastrata-ledger-runtime-"));
  const options = {
    modules: true,
    script,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      BOOKS: { className: "BookObject", useSQLite: true },
      COMPACT_BOOKS: { className: "CompactBookObject", useSQLite: true },
      INDEXED_BOOKS: { className: "IndexedBookObject", useSQLite: true },
      PIN_FIXTURES: { className: "PinFixtureObject", useSQLite: true },
    },
    durableObjectsPersist: directory,
    cf: false,
  };
  let runtime = new Miniflare(options);
  async function call(path: string) {
    const response = await runtime.dispatchFetch(`http://ledger.test${path}`);
    const body = await response.text();
    if (!response.ok) throw new Error(body);
    return JSON.parse(body);
  }
  try {
    let codecState = genesis();
    const outcomeBytes: string[] = [];
    for (const command of [activation(), posting(), posting("rejected", 2n, false)]) {
      const evaluated = evaluateOutcomePayload(codecState, command);
      if (!evaluated.encoded) throw new Error("Missing fixture outcome");
      outcomeBytes.push(evaluated.encoded);
      codecState = { state: evaluated.transition.state, protocol: evaluated.transition.protocol };
    }
    const codecResponse = await runtime.dispatchFetch("http://ledger.test/outcome-codec", {
      method: "POST",
      body: JSON.stringify(outcomeBytes),
    });
    expect(codecResponse.status).toBe(200);
    expect(await codecResponse.json()).toEqual({
      encoded: outcomeBytes,
      snapshot: encodeDurableBook(codecState),
    });
    const vector = [null, true, 9007199254740993n, "€😀", new Uint8Array([0, 255])];
    const hash = await call("/hash");
    expect(hash.bytes).toEqual(Array.from(canonicalEncode(vector)));
    expect(hash.hash.digest).toBe(
      new Bun.CryptoHasher("sha256").update(canonicalEncode(vector)).digest("hex"),
    );
    expect(hash.buffered.digest).toBe(
      new Bun.CryptoHasher("sha256")
        .update(
          canonicalEncode([
            -BigInt("9".repeat(4_097)),
            new Uint8Array(8_193).fill(255),
            "€😀".repeat(2_341),
          ]),
        )
        .digest("hex"),
    );
    await call("/provision");
    await call("/pins/provision");
    const pin = await call("/pins/create");
    expect(pin.id).toBe("1");
    const construction = await call("/pins/allocation/provision");
    const allocation = await call(`/pins/allocation/reserve?pin=${construction.id}`);
    const allocatedLocation = (n: number) => `derived/${n.toString(16).padStart(64, "0")}`;
    expect(allocation).toEqual([allocatedLocation(1), allocatedLocation(2)]);
    const allocatedRoot = await call(
      `/pins/allocation/store?pin=${construction.id}&location=${allocation[0]}`,
    );
    expect(
      await call(`/pins/allocation/abandon?pin=${construction.id}&location=${allocation[1]}`),
    ).toBe(1);
    expect((await call("/activate")).result.disposition).toBe("committed");
    const concurrent = await Promise.all([call("/post"), call("/post")]);
    expect(concurrent.map((r) => r.result.disposition).sort()).toEqual(["committed", "replayed"]);
    const accepted = concurrent.find((r) => r.result.disposition === "committed");
    const rejected = await call("/post?id=unbalanced&revision=2&balanced=false");
    expect(rejected.result.disposition).toBe("rejected");
    const before = await call("/read");
    const identityRows: readonly [IdentityFamily, string, bigint][] = [
      ["command", "activate", 1n],
      ["openingBoundary", "opening", 1n],
      ["command", "post", 2n],
      ["journal", "post", 2n],
      ["posting", "post-0", 2n],
      ["posting", "post-1", 2n],
      ["command", "unbalanced", 3n],
    ];
    const pageRows = identityRows
      .map(([family, id, sequence]) => ({
        key: identityIndexKey({ bookId: BOOK, family, id }),
        sequence,
      }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const children = [];
    for (let offset = 0; offset < pageRows.length; offset += 3)
      children.push(
        encodeIndexPage(
          `derived/${(2 + offset / 3).toString(16).padStart(64, "0")}`,
          pageRows.slice(offset, offset + 3),
        ).descriptor,
      );
    const page = encodeIndexPage(`derived/${"1".repeat(64)}`, [], children);
    const indexRoot = createIndexRoot(7n, page.descriptor.page);
    expect(await call("/index-stage")).toEqual(indexRoot);
    const indexAudit = await call(`/index-audit?root=${indexRoot.contentHash}`);
    expect(indexAudit).toMatchObject({
      identities: "7",
      exactEntriesVerified: true,
      pageIntegrityVerified: true,
      rootHash: indexRoot.contentHash,
    });
    expect(indexAudit.head).toEqual(before.head);
    const range = await call(`/index-range?root=${indexRoot.contentHash}`);
    expect(range.flatMap((batch: { entries: unknown[] }) => batch.entries)).toEqual(
      pageRows.map((entry) => ({ ...entry, sequence: entry.sequence.toString() })),
    );
    expect(range.map((batch: { complete: boolean }) => batch.complete)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(range.at(-1).matchedThrough).toBe("7");
    const lookupKey = identityIndexKey({ bookId: BOOK, family: "command", id: "unbalanced" });
    const lookup = await call(`/index-lookup?root=${indexRoot.contentHash}&key=${lookupKey}`);
    expect(lookup.sequence).toBe("3");
    expect(lookup.pagesRead).toBe(2);
    expect(
      (await call(`/index-lookup?root=${indexRoot.contentHash}&key=${"0".repeat(64)}`)).sequence,
    ).toBeNull();
    let expected = executeBookCommand(genesis().state, genesis().protocol, activation());
    expected = executeBookCommand(expected.state, expected.protocol, posting());
    expected = executeBookCommand(
      expected.state,
      expected.protocol,
      posting("unbalanced", 2n, false),
    );
    expect(before.encoded).toBe(
      encodeDurableBook({ state: expected.state, protocol: expected.protocol }),
    );
    await call("/compact/provision");
    await call("/compact/activate");
    const compactRace = await Promise.all([call("/compact/post"), call("/compact/post")]);
    expect(compactRace.map((r) => r.result.disposition).sort()).toEqual(["committed", "replayed"]);
    const compactRejected = await call("/compact/post?id=unbalanced&revision=2&balanced=false");
    const compactBefore = await call("/compact/read");
    expect(compactBefore.encoded).toBe(before.encoded);
    expect(compactBefore.head.protocolHash).toMatch(/^[a-f0-9]{64}$/);
    expect(compactBefore.head.revisionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(compactBefore.head.chainHash).not.toBe(before.head.chainHash);
    await call("/indexed/provision");
    await call("/indexed/activate");
    const indexedRace = await Promise.all([call("/indexed/post"), call("/indexed/post")]);
    expect(indexedRace.map((r) => r.result.disposition).sort()).toEqual(["committed", "replayed"]);
    const indexedRejected = await call("/indexed/post?id=unbalanced&revision=2&balanced=false");
    const indexedBefore = await call("/indexed/read");
    expect(indexedBefore.encoded).toBe(before.encoded);
    await runtime.dispose();
    runtime = new Miniflare(options);
    expect(
      await call(`/pins/allocation/read?pin=${construction.id}&root=${allocatedRoot.contentHash}`),
    ).toEqual({ root: allocatedRoot, sequence: "7", pagesRead: 1 });
    expect(await call(`/pins/allocation/reserve?pin=${construction.id}`)).toEqual([
      allocatedLocation(3),
      allocatedLocation(4),
    ]);
    const tracking = await call(`/pins/allocation/tracking?pin=${construction.id}`);
    expect(tracking.map((batch: { locations: string[] }) => batch.locations)).toEqual([
      [allocatedLocation(1), allocatedLocation(2)],
      [allocatedLocation(3), allocatedLocation(4)],
    ]);
    expect(tracking[1].complete).toBe(true);
    expect(tracking[0].head.count).toBe("4");
    await expect(
      call(`/pins/allocation/store?pin=${construction.id}&location=${allocatedLocation(2)}`),
    ).rejects.toThrow("index_location_not_reserved");
    expect(await call(`/pins/read?id=${pin.id}`)).toEqual(pin);
    expect((await call("/pins/create")).id).toBe("2");
    await call(`/pins/release?id=${pin.id}`);
    expect(await call("/read")).toEqual(before);
    expect(await call("/compact/read")).toEqual(compactBefore);
    expect(await call("/indexed/read")).toEqual(indexedBefore);
    expect(
      (await call("/indexed/post?id=unbalanced&revision=2&balanced=false")).originalResult,
    ).toEqual(indexedRejected.result);
    expect(
      (await call("/compact/post?id=unbalanced&revision=2&balanced=false")).originalResult,
    ).toEqual(compactRejected.result);
    // No stage/build call after replacement: recover actual persisted page bytes.
    expect(await call(`/index-audit?root=${indexRoot.contentHash}`)).toEqual(indexAudit);
    expect(await call(`/index-range?root=${indexRoot.contentHash}`)).toEqual(range);
    expect(await call(`/index-lookup?root=${indexRoot.contentHash}&key=${lookupKey}`)).toEqual(
      lookup,
    );
    expect((await call("/post")).originalResult).toEqual(accepted.result);
    expect((await call("/post?id=unbalanced&revision=2&balanced=false")).originalResult).toEqual(
      rejected.result,
    );
    // Commit a new command, discard its receipt, restart, then retry it.
    await call("/post?id=lost-reply&revision=2");
    await call("/compact/post?id=lost-reply&revision=2");
    await call("/indexed/post?id=lost-reply&revision=2");
    await runtime.dispose();
    runtime = new Miniflare(options);
    // A fresh runtime reconciles the rejected fixture write, with no location reuse.
    expect(await call(`/pins/allocation/reserve?pin=${construction.id}`)).toEqual([
      allocatedLocation(5),
      allocatedLocation(6),
    ]);
    expect(
      await call(`/pins/allocation/read?pin=${construction.id}&root=${allocatedRoot.contentHash}`),
    ).toEqual({ root: allocatedRoot, sequence: "7", pagesRead: 1 });
    await call(`/pins/allocation/release?pin=${construction.id}`);
    expect(await call("/pins/allocation/cleanup")).toEqual({
      pinId: construction.id,
      removed: 2,
      completed: false,
    });
    // Resume metadata cleanup in a replacement workerd instance. This is graceful
    // local persistence/reopen evidence, not an abrupt process-kill durability drill.
    await runtime.dispose();
    runtime = new Miniflare(options);
    expect(await call("/pins/allocation/cleanup")).toEqual({
      pinId: construction.id,
      removed: 2,
      completed: false,
    });
    expect(await call("/pins/allocation/cleanup")).toEqual({
      pinId: construction.id,
      removed: 2,
      completed: true,
    });
    expect(await call("/pins/allocation/cleanup")).toEqual({
      pinId: null,
      removed: 0,
      completed: false,
    });
    await expect(call(`/pins/allocation/reserve?pin=${construction.id}`)).rejects.toThrow(
      "index_pin_not_active",
    );
    const retry = await call("/post?id=lost-reply&revision=2");
    await expect(call(`/pins/read?id=${pin.id}`)).rejects.toThrow("index_pin_not_active");
    expect((await call("/pins/create")).id).toBe("3");
    expect(retry.result.disposition).toBe("replayed");
    expect(retry.outcomeSequence).toBe("4");
    expect((await call("/read")).head.sequence).toBe("4");
    expect(await call("/read?sequence=3")).toEqual(before);
    const compactRetry = await call("/compact/post?id=lost-reply&revision=2");
    expect(compactRetry.result.disposition).toBe("replayed");
    expect(compactRetry.outcomeSequence).toBe("4");
    expect(await call("/compact/read?sequence=3")).toEqual(compactBefore);
    const indexedRetry = await call("/indexed/post?id=lost-reply&revision=2");
    expect(indexedRetry.result.disposition).toBe("replayed");
    expect(indexedRetry.outcomeSequence).toBe("4");
    expect(await call("/indexed/read?sequence=3")).toEqual(indexedBefore);
  } finally {
    await runtime.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
