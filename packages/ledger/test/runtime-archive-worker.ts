import {
  R2ArchiveObjectStore,
  type ArchiveR2Bucket,
  type ArchivePayloadReference,
} from "../src/r2-archive-store.ts";
import { SqliteArchiveSelection } from "../src/archive-selection.ts";
import { SqliteBookStorage, type SqliteStorage } from "../src/sqlite.ts";
import { payloadDigest, COMPACT_LEDGER_FORMAT } from "../src/records.ts";
import type { ArchiveCatalogAuthority } from "../src/archive-authority.ts";
import { encodeDurableBook, type DurableBookAggregate } from "@rastrata/kernel";
import {
  ARCHIVE_RECORD_VERSION,
  createArchiveDurabilityPolicy,
  encodeArchiveAnchor,
  encodeArchiveManifest,
  prepareArchiveCommit,
  prepareArchiveGenesis,
  recoverArchiveChain,
  type ArchiveAnchor,
  type ArchiveManifest,
} from "../src/archive-records.ts";
import { COMPACT_FORMAT_IDENTITY } from "../src/compact-records.ts";
import { evaluateOutcomePayload } from "../src/outcome-payload.ts";
import { BOOK, activation, genesis, posting } from "./fixtures.ts";

async function history(request: Request, bucket: ArchiveR2Bucket): Promise<Response> {
  const scope = {
    tenantId: "tenant",
    bookId: BOOK,
    objectId: "object",
    namespaceId: "runtime-history",
    generation: "0",
  };
  const store = new R2ArchiveObjectStore(bucket, scope, "object");
  const policy = createArchiveDurabilityPolicy(true);
  if (new URL(request.url).pathname === "/history-read") {
    const anchor = (await request.json()) as ArchiveAnchor;
    const recovered = await recoverArchiveChain(store, anchor, policy);
    return Response.json({
      aggregate: encodeDurableBook(recovered.aggregate),
      sequence: recovered.head.sequence,
      bookRevision: recovered.head.bookRevision,
      outcomes: recovered.aggregate.protocol.retainedResults.map((entry) => entry.outcome),
    });
  }
  const bytes = (value: string) => new TextEncoder().encode(value);
  let aggregate: DurableBookAggregate = genesis();
  const encoded = encodeDurableBook(aggregate);
  let manifest: ArchiveManifest = prepareArchiveGenesis(
    scope,
    policy,
    encoded,
    await store.putImmutable(bytes(encoded)),
  );
  let reference = await store.putImmutable(bytes(encodeArchiveManifest(manifest)));
  for (const command of [
    activation(),
    posting("archive-sale", 1n),
    posting("archive-rejection", 2n, false),
  ]) {
    const evaluated = evaluateOutcomePayload(aggregate, command);
    if (evaluated.encoded === null) throw new Error("Expected retained history fixture");
    const prepared = prepareArchiveCommit(
      manifest,
      reference,
      aggregate,
      evaluated.encoded,
      await store.putImmutable(bytes(evaluated.encoded)),
      command.id,
      "3",
    );
    aggregate = prepared.aggregate;
    manifest = prepared.manifest;
    reference = await store.putImmutable(bytes(encodeArchiveManifest(manifest)));
  }
  const anchor: ArchiveAnchor = {
    version: ARCHIVE_RECORD_VERSION,
    kind: "anchor",
    identity: scope,
    format: COMPACT_FORMAT_IDENTITY,
    head: manifest.kind === "genesis" ? manifest.initialHead : manifest.resulting,
    manifest: reference,
    manifestHash: manifest.contentHash,
    fenceGeneration: "3",
  };
  // Fixture assembly only: the production selected-SQL publication protocol is not enabled.
  if (
    (await store.compareAndSwapControl(null, encodeArchiveAnchor(anchor))).disposition !== "written"
  )
    throw new Error("History already initialized");
  return Response.json({ anchor, expected: encodeDurableBook(aggregate) });
}

// Local-only integration fixture. Not an application route or deployed binding.
interface SelectionEnvironment {
  ARCHIVE: ArchiveR2Bucket;
  SELECTIONS?: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
}

// Local SQLite + R2 integration fixture only. Its synthetic genesis anchor
// initialization is not the production catalog/initialization protocol.
export class ArchiveSelectionObject {
  constructor(
    private readonly ctx: { id: { toString(): string }; storage: SqliteStorage },
    private readonly env: SelectionEnvironment,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const scope = {
      tenantId: "tenant",
      bookId: BOOK,
      objectId: this.ctx.id.toString(),
      namespaceId: "runtime-selection",
      generation: "0",
    };
    const owner = new SqliteArchiveSelection(scope.objectId, this.ctx.storage, scope);
    const store = new R2ArchiveObjectStore(this.env.ARCHIVE, scope, scope.objectId);
    const url = new URL(request.url);
    // Fixed external-authority test vector, not a production catalog service.
    const authority: ArchiveCatalogAuthority = {
      async readEntry() {
        return {
          version: "rastrata-archive-catalog-v1",
          identity: scope,
          format: COMPACT_FORMAT_IDENTITY,
          durabilityPolicy: createArchiveDurabilityPolicy(true),
          genesisHash: payloadDigest(encodeDurableBook(genesis()), COMPACT_LEDGER_FORMAT),
          status: "active",
          fenceGeneration: "2",
        };
      },
    };
    if (url.pathname === "/selection-publish")
      return Response.json(await owner.publishPending(store, authority));
    if (url.pathname === "/selection-reconcile")
      return Response.json(await owner.reconcilePublished(store, authority));
    if (url.pathname === "/selection-init") {
      const encoded = encodeDurableBook(genesis());
      await owner.reserveBook(encoded);
      const manifest = prepareArchiveGenesis(
        scope,
        createArchiveDurabilityPolicy(true),
        encoded,
        await store.putImmutable(new TextEncoder().encode(encoded)),
      );
      const reference = await store.putImmutable(
        new TextEncoder().encode(encodeArchiveManifest(manifest)),
      );
      const anchor: ArchiveAnchor = {
        version: ARCHIVE_RECORD_VERSION,
        kind: "anchor",
        identity: manifest.identity,
        format: manifest.format,
        head: manifest.initialHead,
        manifest: reference,
        manifestHash: manifest.contentHash,
        fenceGeneration: "2",
      };
      const publication = await store.compareAndSwapControl(null, encodeArchiveAnchor(anchor));
      if (publication.disposition !== "written") throw new Error("Fixture initialization conflict");
      const evaluated = evaluateOutcomePayload(
        genesis(),
        url.searchParams.has("rejected") ? posting("not-active", 0n) : activation(),
      );
      if (evaluated.encoded === null) throw new Error("Fixture requires retained outcome");
      return Response.json(
        await owner.select(store, anchor, evaluated.encoded, "runtime-candidate"),
      );
    }
    const pending = await owner.readPending();
    let ordinaryOwner = "unexpectedly-admitted";
    try {
      new SqliteBookStorage(scope.objectId, this.ctx.storage).load(scope);
    } catch (error) {
      ordinaryOwner = error instanceof Error ? error.message : String(error);
    }
    return Response.json({
      pending,
      ordinaryOwner,
      canonical: [...this.ctx.storage.sql.exec("SELECT head FROM ledger_metadata")],
      outcomes: [...this.ctx.storage.sql.exec("SELECT count(*) AS count FROM ledger_outcomes")],
      control: await store.readControl(),
    });
  }
}

export default {
  async fetch(request: Request, env: SelectionEnvironment): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/selection-")) {
      if (!env.SELECTIONS) throw new Error("Missing local test binding");
      const id = env.SELECTIONS.idFromName(
        new URL(request.url).searchParams.has("rejected") ? "rejected" : "committed",
      );
      return env.SELECTIONS.get(id).fetch(request);
    }
    if (["/history-init", "/history-read"].includes(new URL(request.url).pathname))
      return history(request, env.ARCHIVE);
    const store = new R2ArchiveObjectStore(
      env.ARCHIVE,
      {
        tenantId: "tenant",
        bookId: "book",
        objectId: "object",
        namespaceId: "runtime",
        generation: "0",
      },
      "object",
    );
    if (new URL(request.url).pathname === "/read") {
      const reference = (await request.json()) as ArchivePayloadReference;
      return Response.json({
        data: [...(await store.readImmutable(reference))],
        control: await store.readControl(),
      });
    }
    const data = new Uint8Array([0, 255, 128, 1, 13, 10]);
    const reference = await store.putImmutable(data);
    const original = await store.readControl();
    const created = await store.compareAndSwapControl(original, "first");
    if (created.disposition !== "written") throw new Error("Initial CAS conflict");
    const candidates = await Promise.all(
      ["second", "third"].map((body) => store.compareAndSwapControl(created.version, body)),
    );
    const winner = candidates.find((candidate) => candidate.disposition === "written");
    if (winner?.disposition !== "written") throw new Error("Missing CAS winner");
    const returned = await store.compareAndSwapControl(winner.version, "first");
    const late = await store.compareAndSwapControl(created.version, "late");
    return Response.json({
      data: [...(await store.readImmutable(reference))],
      winners: candidates.filter((candidate) => candidate.disposition === "written").length,
      returned: returned.disposition,
      late: late.disposition,
      head: (await store.readControl())?.body,
      reference,
      control: await store.readControl(),
    });
  },
};
