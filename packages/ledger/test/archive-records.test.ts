import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import {
  decodeBookOutcome,
  encodeBookOutcome,
  encodeDurableBook,
  hashCanonical,
  type DurableBookAggregate,
} from "@rastrata/kernel";
import {
  ARCHIVE_RECORD_VERSION,
  createArchiveDurabilityPolicy,
  decodeArchiveAnchor,
  decodeArchiveManifest,
  encodeArchiveAnchor,
  encodeArchiveManifest,
  prepareArchiveCommit,
  prepareArchiveGenesis,
  recoverArchiveChain,
  type ArchiveAnchor,
  type ArchiveManifest,
  type ArchiveCommitManifest,
} from "../src/archive-records.ts";
import { COMPACT_FORMAT_IDENTITY } from "../src/compact-records.ts";
import {
  R2ArchiveObjectStore,
  referenceArchivePayload,
  type ArchivePayloadReference,
} from "../src/r2-archive-store.ts";
import { evaluateOutcomePayload } from "../src/outcome-payload.ts";
import { BOOK, activation, genesis, posting } from "./fixtures.ts";
import { withBucket, type TestR2Bucket } from "./r2-fixtures.ts";

const scope = {
  tenantId: "tenant",
  bookId: BOOK,
  objectId: "object",
  namespaceId: "archive-records",
  generation: "0",
};
const policy = createArchiveDurabilityPolicy(true);
const bytes = (value: string) => new TextEncoder().encode(value);

test("archive records recover complete original receipts inside fresh workerd before any re-upload", async () => {
  const build = await Bun.build({
    entrypoints: [new URL("./runtime-archive-worker.ts", import.meta.url).pathname],
    target: "node",
    format: "esm",
    external: ["node:crypto"],
  });
  expect(build.success).toBe(true);
  const output = build.outputs[0];
  if (output === undefined) throw new Error("Missing history worker bundle");
  const directory = mkdtempSync(join(tmpdir(), "rastrata-archive-history-"));
  const options = {
    modules: true,
    script: await output.text(),
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    r2Buckets: ["ARCHIVE"],
    r2Persist: directory,
    cf: false,
  };
  let runtime = new Miniflare(options);
  try {
    const initialized = await runtime.dispatchFetch("http://archive.test/history-init");
    const raw = await initialized.text();
    if (!initialized.ok) throw new Error(raw);
    const saved = JSON.parse(raw);
    await runtime.dispose();
    runtime = new Miniflare(options);
    const response = await runtime.dispatchFetch("http://archive.test/history-read", {
      method: "POST",
      body: JSON.stringify(saved.anchor),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(body);
    expect(JSON.parse(body)).toEqual({
      aggregate: saved.expected,
      sequence: "3",
      bookRevision: "2",
      outcomes: ["committed", "committed", "rejected"],
    });
  } finally {
    await runtime.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
function value<T>(item: T | undefined): T {
  if (item === undefined) throw new Error("Missing fixture item");
  return item;
}
type Mutable<T> = { -readonly [P in keyof T]: T[P] extends object ? Mutable<T[P]> : T[P] };
function rehash(
  manifest: ArchiveManifest,
  change: (record: Mutable<ArchiveCommitManifest>) => void,
): ArchiveManifest {
  const record = JSON.parse(encodeArchiveManifest(manifest)) as Mutable<ArchiveCommitManifest>;
  change(record);
  const { contentHash: _contentHash, ...body } = record;
  return {
    ...body,
    contentHash: hashCanonical(
      JSON.parse(
        JSON.stringify({ domain: `${ARCHIVE_RECORD_VERSION}/manifest`, body }),
        (_key, member) => (typeof member === "number" ? BigInt(member) : member),
      ),
    ).digest,
  } as ArchiveManifest;
}
async function chain(bucket: TestR2Bucket, count = 4) {
  const store = new R2ArchiveObjectStore(bucket, scope, "object");
  let aggregate: DurableBookAggregate = genesis();
  const encoded = encodeDurableBook(aggregate);
  let manifest: ArchiveManifest = prepareArchiveGenesis(
    scope,
    policy,
    encoded,
    await store.putImmutable(bytes(encoded)),
  );
  let reference = await store.putImmutable(bytes(encodeArchiveManifest(manifest)));
  const points: {
    manifest: ArchiveManifest;
    reference: ArchivePayloadReference;
    aggregate: DurableBookAggregate;
    payload: string;
  }[] = [{ manifest, reference, aggregate, payload: encoded }];
  for (const command of [
    activation(),
    posting("sale", 1n),
    posting("retained-rejection", 2n, false),
    posting("second-sale", 2n),
  ].slice(0, count)) {
    const evaluated = evaluateOutcomePayload(aggregate, command);
    if (evaluated.encoded === null) throw new Error("Expected retained fixture outcome");
    const prepared = prepareArchiveCommit(
      manifest,
      reference,
      aggregate,
      evaluated.encoded,
      await store.putImmutable(bytes(evaluated.encoded)),
      `selected-${points.length}`,
      "7",
    );
    manifest = prepared.manifest;
    aggregate = prepared.aggregate;
    reference = await store.putImmutable(bytes(encodeArchiveManifest(manifest)));
    points.push({ manifest, reference, aggregate, payload: evaluated.encoded });
  }
  const anchor: ArchiveAnchor = {
    version: ARCHIVE_RECORD_VERSION,
    kind: "anchor",
    identity: scope,
    format: COMPACT_FORMAT_IDENTITY,
    head: manifest.kind === "genesis" ? manifest.initialHead : manifest.resulting,
    manifest: reference,
    manifestHash: manifest.contentHash,
    fenceGeneration: "7",
  };
  // Synthetic fixture control publication, NOT the production selected-SQL protocol.
  expect((await store.compareAndSwapControl(null, encodeArchiveAnchor(anchor))).disposition).toBe(
    "written",
  );
  return { store, anchor, points, aggregate };
}

test("archive records replay committed and rejected outcomes exactly, ignoring unpublished orphan bytes", async () => {
  await withBucket(async (bucket) => {
    const f = await chain(bucket);
    const recovered = await recoverArchiveChain(f.store, f.anchor, policy);
    expect(encodeDurableBook(recovered.aggregate)).toBe(encodeDurableBook(f.aggregate));
    expect(recovered.head.sequence).toBe("4");
    expect(recovered.head.bookRevision).toBe("3");
    expect(recovered.aggregate.protocol.retainedResults.map((result) => result.outcome)).toEqual([
      "committed",
      "committed",
      "rejected",
      "committed",
    ]);
    const rejected = value(f.points[3]).manifest;
    if (rejected.kind !== "commit") throw new Error("Expected retained rejection manifest");
    expect(rejected.before.bookRevision).toBe(rejected.resulting.bookRevision);
    expect(rejected.before.stateHash).toBe(rejected.resulting.stateHash);
    expect(rejected.before.protocolHash).not.toBe(rejected.resulting.protocolHash);
    const last = value(f.points.at(-1));
    for (const point of [value(f.points[2]), value(f.points[3])]) {
      const decoded = decodeBookOutcome(point.payload);
      if (decoded.disposition !== "decoded") throw new Error("Missing original retry command");
      const retry = evaluateOutcomePayload(recovered.aggregate, decoded.payload.command);
      expect(retry.transition.result.disposition).toBe("replayed");
      expect(retry.encoded).toBeNull();
      expect(
        encodeDurableBook({ state: retry.transition.state, protocol: retry.transition.protocol }),
      ).toBe(encodeDurableBook(recovered.aggregate));
      expect(() =>
        prepareArchiveCommit(
          last.manifest,
          last.reference,
          recovered.aggregate,
          point.payload,
          point.manifest.payload,
          "duplicate-retention",
          "7",
        ),
      ).toThrow("recovery_outcome_mismatch");
    }
    const orphan = evaluateOutcomePayload(f.aggregate, posting("unpublished-sale", 3n));
    if (orphan.encoded === null) throw new Error("Expected valid orphan candidate");
    const orphanManifest = prepareArchiveCommit(
      last.manifest,
      last.reference,
      f.aggregate,
      orphan.encoded,
      await f.store.putImmutable(bytes(orphan.encoded)),
      "unpublished-selection",
      "7",
    ).manifest;
    await f.store.putImmutable(bytes(encodeArchiveManifest(orphanManifest)));
    const again = await recoverArchiveChain(f.store, f.anchor, policy);
    expect(again.control).toEqual(recovered.control);
    expect(encodeDurableBook(again.aggregate)).toBe(encodeDurableBook(recovered.aggregate));
    for (const point of f.points) {
      const encoded = encodeArchiveManifest(point.manifest);
      expect(encodeArchiveManifest(decodeArchiveManifest(encoded))).toBe(encoded);
      expect(Object.isFrozen(decodeArchiveManifest(encoded).payload)).toBe(true);
    }
    expect(decodeArchiveAnchor(encodeArchiveAnchor(f.anchor))).toEqual(f.anchor);
    // A future maintenance fence does not rewrite historical manifest generations.
    const fenced = { ...f.anchor, fenceGeneration: "8" };
    expect(
      (await f.store.compareAndSwapControl(recovered.control, encodeArchiveAnchor(fenced)))
        .disposition,
    ).toBe("written");
    expect(encodeDurableBook((await recoverArchiveChain(f.store, fenced, policy)).aggregate)).toBe(
      encodeDurableBook(f.aggregate),
    );
    await expect(recoverArchiveChain(f.store, f.anchor, policy)).rejects.toThrow(
      "archive_anchor_mismatch",
    );
  });
});

test("archive genesis has Oseq zero and cannot disguise an already-active book as provisioning", async () => {
  await withBucket(async (bucket) => {
    const f = await chain(bucket, 0);
    const recovered = await recoverArchiveChain(f.store, f.anchor, policy);
    expect(recovered.head.sequence).toBe("0");
    expect(recovered.aggregate.protocol.retainedResults).toEqual([]);
    const activated = evaluateOutcomePayload(f.aggregate, activation()).transition;
    const encoded = encodeDurableBook({ state: activated.state, protocol: activated.protocol });
    expect(() =>
      prepareArchiveGenesis(
        scope,
        policy,
        encoded,
        referenceArchivePayload(scope, "object", bytes(encoded)),
      ),
    ).toThrow("archive_genesis_invalid");
    expect(await f.store.readControl()).toEqual(recovered.control);
  });
});

test("archive preparation reexecutes rejection receipts and binds exact prior financial and protocol heads", async () => {
  await withBucket(async (bucket) => {
    const f = await chain(bucket);
    const previous = value(f.points[2]),
      rejected = value(f.points[3]);
    const decoded = decodeBookOutcome(rejected.payload);
    if (
      decoded.disposition !== "decoded" ||
      decoded.payload.originalResult.disposition !== "rejected"
    )
      throw new Error("Expected rejected fixture");
    expect(decoded.payload.originalResult.diagnostics.length).toBeGreaterThan(0);
    const altered = encodeBookOutcome({
      ...decoded.payload,
      originalResult: {
        ...decoded.payload.originalResult,
        diagnostics: decoded.payload.originalResult.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          message: "Forged historical explanation",
        })),
      },
    });
    expect(() =>
      prepareArchiveCommit(
        previous.manifest,
        previous.reference,
        previous.aggregate,
        altered,
        referenceArchivePayload(scope, "object", bytes(altered)),
        "forged",
        "7",
      ),
    ).toThrow("recovery_outcome_mismatch");
    expect(() =>
      prepareArchiveCommit(
        previous.manifest,
        previous.reference,
        value(f.points[1]).aggregate,
        rejected.payload,
        referenceArchivePayload(scope, "object", bytes(rejected.payload)),
        "wrong-before",
        "7",
      ),
    ).toThrow("archive_prior_head_mismatch");
    expect(() =>
      prepareArchiveCommit(
        previous.manifest,
        previous.reference,
        previous.aggregate,
        rejected.payload,
        referenceArchivePayload(scope, "object", bytes(rejected.payload)),
        "old-fence",
        "6",
      ),
    ).toThrow("archive_fence_regression");
    expect(() =>
      prepareArchiveCommit(
        previous.manifest,
        { ...previous.reference, payloadBytes: previous.reference.payloadBytes + 1 },
        previous.aggregate,
        rejected.payload,
        referenceArchivePayload(scope, "object", bytes(rejected.payload)),
        "wrong-reference",
        "7",
      ),
    ).toThrow("archive_payload_reference_mismatch");
  });
});

for (const missing of ["manifest", "payload"] as const) {
  test(`archive recovery refuses a missing middle ${missing} rather than returning a shorter prefix`, async () => {
    await withBucket(async (bucket) => {
      const f = await chain(bucket);
      const middle = value(f.points[2]);
      await bucket.delete(
        (missing === "manifest" ? middle.reference : middle.manifest.payload).objectKey,
      );
      const before = await f.store.readControl();
      await expect(recoverArchiveChain(f.store, f.anchor, policy)).rejects.toThrow(
        "archive_payload_missing",
      );
      expect(await f.store.readControl()).toEqual(before);
    });
  });
}

for (const issue of ["candidate", "financial-head", "chain", "fence"] as const) {
  test(`archive recovery rejects self-hashed ${issue} substitution against real replay`, async () => {
    await withBucket(async (bucket) => {
      const f = await chain(bucket),
        last = value(f.points.at(-1));
      const forged = rehash(last.manifest, (record) => {
        if (issue === "candidate") record.candidateHash = "f".repeat(64);
        if (issue === "financial-head") record.resulting.stateHash = "f".repeat(64);
        if (issue === "chain") record.before.chainHash = "f".repeat(64);
        if (issue === "fence") record.fenceGeneration = "8";
      });
      if (forged.kind !== "commit") throw new Error("Expected commit manifest");
      const stored = await f.store.putImmutable(bytes(encodeArchiveManifest(forged)));
      const anchor: ArchiveAnchor = {
        ...f.anchor,
        manifest: stored,
        manifestHash: forged.contentHash,
        head: forged.resulting,
      };
      const prior = await f.store.readControl();
      if (prior === null) throw new Error("Missing prior control");
      expect(
        (await f.store.compareAndSwapControl(prior, encodeArchiveAnchor(anchor))).disposition,
      ).toBe("written");
      await expect(recoverArchiveChain(f.store, anchor, policy)).rejects.toThrow(
        issue === "chain"
          ? "archive_chain_mismatch"
          : issue === "fence"
            ? "archive_fence_regression"
            : "archive_outcome_mismatch",
      );
    });
  });
}

test("archive codecs reject ambiguous bytes, policy downgrade, format substitution and unbounded claims", async () => {
  await withBucket(async (bucket) => {
    const f = await chain(bucket, 1),
      manifest = value(f.points.at(-1)).manifest;
    const encoded = encodeArchiveManifest(manifest);
    for (const malformed of [
      `${encoded} `,
      encoded.replace("{", '{"unknown":1,'),
      JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(encoded)).reverse())),
      encoded.replace('"kind":"commit"', '"kind":"genesis","kind":"commit"'),
    ])
      expect(() => decodeArchiveManifest(malformed)).toThrow();
    expect(() =>
      encodeArchiveManifest(
        rehash(manifest, (record) => {
          record.format.kernelSemanticVersion = "unsupported" as never;
        }),
      ),
    ).toThrow("archive_format_unsupported");
    expect(() =>
      encodeArchiveManifest(
        rehash(manifest, (record) => {
          record.durabilityPolicy.archiveRequired = false;
        }),
      ),
    ).toThrow("archive_policy_mismatch");
    expect(() =>
      encodeArchiveManifest(
        rehash(manifest, (record) => {
          delete record.resulting.protocolHash;
        }),
      ),
    ).toThrow("archive_record_invalid");
    await expect(
      recoverArchiveChain(f.store, f.anchor, createArchiveDurabilityPolicy(false)),
    ).rejects.toThrow("archive_identity_policy_mismatch");
    await expect(
      recoverArchiveChain(
        f.store,
        { ...f.anchor, head: { ...f.anchor.head, sequence: "1001" } },
        policy,
      ),
    ).rejects.toThrow("archive_record_capacity_exceeded");
    let getterRead = false;
    expect(() =>
      encodeArchiveAnchor({
        ...f.anchor,
        get fenceGeneration() {
          getterRead = true;
          return "7";
        },
      }),
    ).toThrow("archive_record_invalid");
    expect(getterRead).toBe(false);
  });
});
