// Local integration harness only. This is not an authorized public ledger gateway.
import { canonicalEncode, encodeDurableBook, hashCanonical } from "@rastrata/kernel";
import {
  ProductionLedger,
  COMPACT_LEDGER_FORMAT,
  LEDGER_FORMAT,
  SqliteBookStorage,
  SqliteIndexedBookStorage,
  bookObjectName,
  type SqliteStorage,
  type LedgerFormat,
} from "../src/index.ts";
import { BOOK, activation, genesis, posting } from "./fixtures.ts";
import { readCanonicalIdentityPopulation } from "../src/identity-audit.ts";
import { SqliteIndexPageStore } from "../src/index-page-store.ts";
import { SqliteIndexControl } from "../src/index-control.ts";
import { evaluateOutcomePayload, replayOutcomePayload } from "../src/outcome-payload.ts";
import {
  auditStoredIdentityIndex,
  createIndexRoot,
  encodeIndexPage,
  identityIndexKey,
  lookupIndexEntry,
  scanIndexRange,
  INDEX_KEY_SCHEMA,
} from "../src/index-pages.ts";

interface Environment {
  INDEXED_BOOKS: Environment["BOOKS"];
  COMPACT_BOOKS: Environment["BOOKS"];
  PIN_FIXTURES: {
    idFromName(name: string): { toString(): string };
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
  BOOKS: {
    idFromName(name: string): { toString(): string };
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
}

// Separate SQL/runtime fixture. The fixed genesis anchor and clock are test vectors,
// not the real accounting adapter or a gateway-controlled authority implementation.
export class PinFixtureObject {
  private readonly registry: SqliteIndexControl;
  private readonly pages: SqliteIndexPageStore;
  constructor(ctx: { storage: SqliteStorage }) {
    this.pages = new SqliteIndexPageStore(
      ctx.storage,
      hashCanonical("pin-runtime-identity").digest,
    );
    this.registry = new SqliteIndexControl(
      ctx.storage,
      () => ({
        identityHash: hashCanonical("pin-runtime-identity").digest,
        headHash: hashCanonical("pin-runtime-genesis").digest,
        sequence: "0",
        fence: "0",
        provisioning: true,
        pending: false,
      }),
      () => 10n,
    );
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/pins/allocation/provision") {
        const current = await this.registry.initialize(INDEX_KEY_SCHEMA);
        await this.pages.initialize("allocated");
        return Response.json(await this.registry.pinCurrent(current.view, "construction", "100"));
      }
      if (url.pathname === "/pins/provision")
        return Response.json(await this.registry.initialize("pin-runtime-schema"));
      const current = await this.registry.readMetadata();
      if (url.pathname.startsWith("/pins/allocation/")) {
        const pin = {
          id: url.searchParams.get("pin") ?? "",
          kind: "construction" as const,
          view: current.view,
          expiresAt: "100",
        };
        if (url.pathname === "/pins/allocation/reserve")
          return Response.json(await this.pages.reserve(this.registry, pin, 2));
        if (url.pathname === "/pins/allocation/tracking") {
          const batches = [];
          for await (const batch of this.pages.constructionBatches(this.registry, pin, 2))
            batches.push(batch);
          return Response.json(batches);
        }
        if (url.pathname === "/pins/allocation/cleanup") {
          await this.pages.recover();
          return Response.json(await this.pages.cleanupConstructions(this.registry, 2));
        }
        if (url.pathname === "/pins/allocation/store") {
          const page = encodeIndexPage(url.searchParams.get("location") ?? "", [
            { key: hashCanonical("allocated-runtime-key").digest, sequence: 7n },
          ]);
          await this.pages.putReserved(this.registry, pin, page.descriptor.page, page.bytes);
          const root = createIndexRoot(1n, page.descriptor.page);
          return Response.json(await this.pages.retainRoot(root, root.contentHash));
        }
        if (url.pathname === "/pins/allocation/read") {
          await this.registry.readPinned(pin);
          const digest = url.searchParams.get("root") ?? "";
          const root = await this.pages.readRootDescriptor(digest);
          if (!root) throw new Error("Missing allocated fixture root");
          const result = await lookupIndexEntry(
            root,
            digest,
            hashCanonical("allocated-runtime-key").digest,
            (id) => this.pages.read(id),
          );
          return Response.json({
            root,
            sequence: result.sequence?.toString(),
            pagesRead: result.pagesRead,
          });
        }
        if (url.pathname === "/pins/allocation/abandon")
          return Response.json(
            await this.pages.abandon(this.registry, pin, [url.searchParams.get("location") ?? ""]),
          );
        if (url.pathname === "/pins/allocation/release") {
          await this.registry.releasePin(pin);
          return Response.json({ released: true });
        }
      }
      if (url.pathname === "/pins/create")
        return Response.json(await this.registry.pinCurrent(current.view, "reader", "100"));
      const expected = {
        id: url.searchParams.get("id") ?? "",
        kind: "reader" as const,
        view: current.view,
        expiresAt: "100",
      };
      if (url.pathname === "/pins/read")
        return Response.json(await this.registry.readPinned(expected));
      if (url.pathname === "/pins/release") {
        await this.registry.releasePin(expected);
        return Response.json({ released: true });
      }
      return new Response("Unknown fixture operation", { status: 404 });
    } catch (error) {
      return new Response(String(error), { status: 409 });
    }
  }
}

export class BookObject {
  private readonly ledger: ProductionLedger;
  private readonly pages: SqliteIndexPageStore;

  constructor(
    ctx: { storage: SqliteStorage; id: { toString(): string } },
    _env?: unknown,
    format: LedgerFormat = LEDGER_FORMAT,
    private readonly indexed = false,
  ) {
    const objectId = ctx.id.toString();
    // Harness-only identity commitment; production control-plane mapping remains separate.
    this.pages = new SqliteIndexPageStore(
      ctx.storage,
      hashCanonical({
        domain: "runtime-page-store-fixture",
        tenantId: "tenant",
        bookId: BOOK,
        objectId,
        generation: "0",
      }).digest,
    );
    const scope = {
      tenantId: "tenant",
      bookId: BOOK,
      objectId,
    };
    this.ledger = new ProductionLedger(
      indexed
        ? new SqliteIndexedBookStorage(
            objectId,
            ctx.storage,
            { ...scope, namespaceId: "compact-runtime-fixture", generation: "0" },
            () => ({ fence: "0", pending: false }),
            () => 10n,
          )
        : new SqliteBookStorage(objectId, ctx.storage),
      format === COMPACT_LEDGER_FORMAT
        ? { ...scope, namespaceId: "compact-runtime-fixture", generation: "0" }
        : scope,
      format,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let result: unknown;
    if (url.pathname === "/provision") {
      result = await this.ledger.provision(genesis());
      if (!this.indexed) await this.pages.initialize();
    } else if (url.pathname === "/activate") result = await this.ledger.execute(activation());
    else if (url.pathname === "/post")
      result = await this.ledger.execute(
        posting(
          url.searchParams.get("id") ?? "post",
          BigInt(url.searchParams.get("revision") ?? "1"),
          url.searchParams.get("balanced") !== "false",
        ),
      );
    else if (url.pathname === "/read") {
      const sequence = url.searchParams.get("sequence");
      const read =
        sequence === null ? await this.ledger.read() : await this.ledger.readAt(BigInt(sequence));
      result = { head: read.head, encoded: encodeDurableBook(read.aggregate) };
    } else if (url.pathname === "/index-stage") {
      // Small fixture builder, not indexed posting or a production publication path.
      const source = await readCanonicalIdentityPopulation(this.ledger);
      const rows = source.entries
        .map((entry) => ({ key: identityIndexKey(entry), sequence: entry.outcomeSequence }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const children = [];
      for (let offset = 0; offset < rows.length; offset += 3) {
        const leaf = encodeIndexPage(
          `derived/${(2 + offset / 3).toString(16).padStart(64, "0")}`,
          rows.slice(offset, offset + 3),
        );
        await this.pages.put(leaf.descriptor.page, leaf.bytes);
        children.push(leaf.descriptor);
      }
      const page = encodeIndexPage(`derived/${"1".repeat(64)}`, [], children);
      const root = createIndexRoot(BigInt(rows.length), page.descriptor.page);
      await this.pages.put(page.descriptor.page, page.bytes);
      result = await this.pages.retainRoot(root, root.contentHash);
    } else if (url.pathname === "/index-audit") {
      const rootHash = url.searchParams.get("root") ?? "";
      const root = await this.pages.readRootDescriptor(rootHash);
      if (!root) throw new Error("Required test index root is missing");
      result = await auditStoredIdentityIndex(this.ledger, root, rootHash, (location) =>
        this.pages.read(location),
      );
    } else if (url.pathname === "/index-lookup") {
      // Raw codec/runtime fixture, not a public identity-admission API. The test
      // first audits this exact root against real accounting history.
      const rootHash = url.searchParams.get("root") ?? "";
      const root = await this.pages.readRootDescriptor(rootHash);
      if (!root) throw new Error("Required test index root is missing");
      result = await lookupIndexEntry(
        root,
        rootHash,
        url.searchParams.get("key") ?? "",
        (location) => this.pages.read(location),
      );
    } else if (url.pathname === "/index-range") {
      // Local codec/runtime fixture. Root was independently audited by the test;
      // this route supplies no public authorization or durable query pin.
      const rootHash = url.searchParams.get("root") ?? "";
      const root = await this.pages.readRootDescriptor(rootHash);
      if (!root) throw new Error("Required test index root is missing");
      const batches = [];
      for await (const batch of scanIndexRange(
        root,
        rootHash,
        url.searchParams.get("lower"),
        url.searchParams.get("upper"),
        (id) => this.pages.read(id),
        2,
      ))
        batches.push(batch);
      result = batches;
    } else if (url.pathname === "/outcome-codec") {
      // In-memory cross-runtime fixture only; not a public ingestion endpoint.
      const payloads: unknown = await request.json();
      if (!Array.isArray(payloads) || payloads.some((payload) => typeof payload !== "string"))
        throw new Error("Invalid fixture payload list");
      let restored = genesis();
      const encoded: string[] = [];
      for (const payload of payloads) {
        const next = replayOutcomePayload(restored, payload);
        const retained = next.protocol.retainedResults.at(-1);
        if (!retained) throw new Error("Missing fixture result");
        const roundTrip = evaluateOutcomePayload(restored, retained.command).encoded;
        if (!roundTrip) throw new Error("Missing fixture encoding");
        encoded.push(roundTrip);
        restored = { state: next.state, protocol: next.protocol };
      }
      result = { encoded, snapshot: encodeDurableBook(restored) };
    } else if (url.pathname === "/hash") {
      const value = [null, true, 9007199254740993n, "€😀", new Uint8Array([0, 255])];
      result = {
        hash: hashCanonical(value),
        bytes: Array.from(canonicalEncode(value)),
        buffered: hashCanonical([
          -BigInt("9".repeat(4_097)),
          new Uint8Array(8_193).fill(255),
          "€😀".repeat(2_341),
        ]),
      };
    } else return new Response("Unknown test operation", { status: 404 });
    return new Response(
      JSON.stringify(result, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
      { headers: { "content-type": "application/json" } },
    );
  }
}

export class CompactBookObject extends BookObject {
  constructor(ctx: ConstructorParameters<typeof BookObject>[0], env: unknown) {
    super(ctx, env, COMPACT_LEDGER_FORMAT);
  }
}

export class IndexedBookObject extends BookObject {
  constructor(ctx: ConstructorParameters<typeof BookObject>[0], env: unknown) {
    super(ctx, env, COMPACT_LEDGER_FORMAT, true);
  }
}

export default {
  fetch(request: Request, env: Environment): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/indexed/")) {
      url.pathname = url.pathname.slice("/indexed".length);
      return env.INDEXED_BOOKS.get(
        env.INDEXED_BOOKS.idFromName(bookObjectName("tenant", BOOK)),
      ).fetch(new Request(url.toString(), request));
    }
    if (url.pathname.startsWith("/compact/")) {
      url.pathname = url.pathname.slice("/compact".length);
      return env.COMPACT_BOOKS.get(
        env.COMPACT_BOOKS.idFromName(bookObjectName("tenant", BOOK)),
      ).fetch(new Request(url.toString(), request));
    }
    if (new URL(request.url).pathname.startsWith("/pins/"))
      return env.PIN_FIXTURES.get(
        env.PIN_FIXTURES.idFromName(
          url.pathname.startsWith("/pins/allocation/")
            ? "allocation-sql-fixture"
            : "pin-sql-fixture",
        ),
      ).fetch(request);
    return env.BOOKS.get(env.BOOKS.idFromName(bookObjectName("tenant", BOOK))).fetch(request);
  },
};
