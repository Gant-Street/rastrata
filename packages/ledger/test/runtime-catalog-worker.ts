// Local integration harness only; no deployed control-plane or public API.
import { encodeDurableBook } from "@rastrata/kernel";
import { SqliteArchiveCatalog } from "../src/archive-catalog.ts";
import { SqliteArchiveSelection } from "../src/archive-selection.ts";
import { ArchiveLedger } from "../src/archive-ledger.ts";
import { prepareArchiveRestoreImage } from "../src/archive-restore.ts";
import type { SqliteStorage } from "../src/sqlite.ts";
import type { ArchiveBookHeadEvidence, ArchiveCatalogAuthority } from "../src/archive-authority.ts";
import { R2ArchiveObjectStore, type ArchiveR2Bucket } from "../src/r2-archive-store.ts";
import {
  ARCHIVE_RECORD_VERSION,
  createArchiveDurabilityPolicy,
  prepareArchiveGenesis,
  encodeArchiveManifest,
  encodeArchiveAnchor,
  decodeArchiveAnchor,
  type ArchiveAnchor,
} from "../src/archive-records.ts";
import { evaluateOutcomePayload } from "../src/outcome-payload.ts";
import { BOOK, genesis, activation, posting } from "./fixtures.ts";

interface Namespace {
  idFromName(name: string): { toString(): string };
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
interface Environment {
  BOOKS: Namespace;
  CATALOGS: Namespace;
  ARCHIVE: ArchiveR2Bucket;
}
interface Context {
  id: { toString(): string };
  storage: SqliteStorage;
}
const scopeFor = (objectId: string) => ({
  tenantId: "tenant",
  bookId: BOOK,
  objectId,
  namespaceId: "runtime-catalog",
  generation: "0",
});
async function call(
  env: Environment,
  namespace: "BOOKS" | "CATALOGS",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const ns = env[namespace];
  const response = await ns
    .get(ns.idFromName(namespace === "BOOKS" ? "book" : "catalog"))
    .fetch(
      new Request(
        `http://internal.test${path}`,
        body === undefined ? {} : { method: "POST", body: JSON.stringify(body) },
      ),
    );
  const text = await response.text();
  if (!response.ok) throw new Error(text);
  return JSON.parse(text);
}

export class CatalogBookObject {
  constructor(
    private readonly ctx: Context,
    private readonly env: Environment,
  ) {}
  async fetch(request: Request): Promise<Response> {
    const scope = scopeFor(this.ctx.id.toString());
    const owner = new SqliteArchiveSelection(scope.objectId, this.ctx.storage, scope);
    const store = new R2ArchiveObjectStore(this.env.ARCHIVE, scope, scope.objectId);
    const authority: ArchiveCatalogAuthority = {
      readEntry: async () => call(this.env, "CATALOGS", "/entry"),
    };
    switch (new URL(request.url).pathname) {
      case "/coordinator-read": {
        const ledger = new ArchiveLedger(scope.objectId, this.ctx.storage, scope, store, authority);
        const snapshot = await ledger.read();
        return Response.json({
          head: snapshot.head,
          manifestHash: snapshot.manifestHash,
          durabilityPolicy: snapshot.durabilityPolicy,
        });
      }
      case "/coordinator-execute": {
        const ledger = new ArchiveLedger(scope.objectId, this.ctx.storage, scope, store, authority);
        // Closed synthetic commands only; this is not a public command decoder.
        const command =
          new URL(request.url).searchParams.get("kind") === "rejection"
            ? posting("coordinator-rejection", 0n)
            : activation();
        const receipt = await ledger.execute(command);
        return Response.json({
          disposition: receipt.result.disposition,
          outcomeSequence: receipt.outcomeSequence?.toString() ?? null,
          originalDisposition: receipt.originalResult?.disposition ?? null,
          originalResultHash: receipt.originalResult?.resultHash ?? null,
          head: receipt.head,
          manifestHash: receipt.manifestHash,
          durabilityPolicy: receipt.durabilityPolicy,
        });
      }
      case "/reserve":
        await owner.reserveBook(encodeDurableBook(genesis()));
        return Response.json({ reserved: true });
      case "/verify":
        return Response.json(
          await owner.verifyArchiveHead(store, (await request.json()) as ArchiveAnchor),
        );
      case "/select": {
        const control = await store.readControl();
        if (!control) throw new Error("Missing archive");
        const outcome = evaluateOutcomePayload(genesis(), activation());
        if (!outcome.encoded) throw new Error("Missing fixture outcome");
        return Response.json(
          await owner.select(
            store,
            decodeArchiveAnchor(control.body),
            outcome.encoded,
            "activation",
          ),
        );
      }
      case "/publish":
        return Response.json(await owner.publishPending(store, authority));
      case "/prepare-restore": {
        const params = new URL(request.url).searchParams;
        return Response.json(
          await prepareArchiveRestoreImage(
            store,
            {
              catalogObjectId: this.env.CATALOGS.idFromName("catalog").toString(),
              read: () => call(this.env, "CATALOGS", "/catalog"),
            },
            scope,
            scope.objectId,
            params.get("catalogHash") ?? "",
            params.get("permitHash") ?? "",
          ),
        );
      }
      case "/install-restore": {
        const params = new URL(request.url).searchParams;
        return Response.json(
          await owner.restoreFromArchive(
            store,
            {
              catalogObjectId: this.env.CATALOGS.idFromName("catalog").toString(),
              read: () => call(this.env, "CATALOGS", "/catalog"),
            },
            params.get("catalogHash") ?? "",
            params.get("permitHash") ?? "",
          ),
        );
      }
      case "/post-after-restore": {
        const control = await store.readControl();
        if (!control) throw new Error("Missing fixture archive");
        const anchor = decodeArchiveAnchor(control.body);
        const initial = genesis();
        const activated = evaluateOutcomePayload(initial, activation());
        const next =
          anchor.head.sequence === "0"
            ? activated
            : evaluateOutcomePayload(
                { state: activated.transition.state, protocol: activated.transition.protocol },
                posting("after-restore"),
              );
        if (!next.encoded) throw new Error("Missing fixture outcome");
        return Response.json(await owner.select(store, anchor, next.encoded, "after-restore"));
      }
      case "/reconcile":
        return Response.json(await owner.reconcilePublished(store, authority));
      case "/abandon": {
        const params = new URL(request.url).searchParams;
        return Response.json(
          await owner.abandonUnpublished(
            store,
            {
              catalogObjectId: this.env.CATALOGS.idFromName("catalog").toString(),
              read: () => call(this.env, "CATALOGS", "/catalog"),
            },
            params.get("selectionHash") ?? "",
            params.get("catalogHash") ?? "",
          ),
        );
      }
      case "/state":
        return Response.json({
          pending: await owner.readPending(),
          outcomes: [...this.ctx.storage.sql.exec("SELECT count(*) AS count FROM ledger_outcomes")],
          head: [...this.ctx.storage.sql.exec("SELECT head FROM ledger_metadata")],
          objectId: scope.objectId,
        });
      default:
        return new Response("Unknown local book operation", { status: 404 });
    }
  }
}

export class ArchiveCatalogObject {
  constructor(
    private readonly ctx: Context,
    private readonly env: Environment,
  ) {}
  async fetch(request: Request): Promise<Response> {
    const scope = scopeFor(this.env.BOOKS.idFromName("book").toString());
    const catalog = new SqliteArchiveCatalog(this.ctx.id.toString(), this.ctx.storage, scope);
    const store = new R2ArchiveObjectStore(this.env.ARCHIVE, scope, scope.objectId);
    const verifier = {
      verifyHead: async (anchor: ArchiveAnchor) =>
        (await call(this.env, "BOOKS", "/verify", anchor)) as ArchiveBookHeadEvidence,
    };
    switch (new URL(request.url).pathname) {
      case "/init": {
        const encoded = encodeDurableBook(genesis());
        const reserved = await catalog.reserve(encoded, "reserve");
        await call(this.env, "BOOKS", "/reserve");
        // Synthetic initialization setup; real catalog activation below verifies
        // both this exact R2 genesis and the other object's durable SQL state.
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
          identity: scope,
          format: manifest.format,
          head: manifest.initialHead,
          manifest: reference,
          manifestHash: manifest.contentHash,
          fenceGeneration: "0",
        };
        if (
          (await store.compareAndSwapControl(null, encodeArchiveAnchor(anchor))).disposition !==
          "written"
        )
          throw new Error("Fixture initialization conflict");
        return Response.json(await catalog.activate(reserved, "activate", store, verifier));
      }
      case "/entry":
        return Response.json(await catalog.readEntry(scope));
      case "/catalog":
        return Response.json(await catalog.read());
      case "/begin":
        return Response.json(await catalog.beginMaintenance(await catalog.read(), "maintenance"));
      case "/seal":
        return Response.json(await catalog.sealFence(await catalog.read(), "seal", store));
      case "/authorize-restore":
        return Response.json(
          await catalog.authorizeRestore(
            await catalog.read(),
            "restore",
            "fixture-operator",
            store,
          ),
        );
      case "/finish":
        return Response.json(
          await catalog.finishMaintenance(await catalog.read(), "finish", store, verifier),
        );
      default:
        return new Response("Unknown local catalog operation", { status: 404 });
    }
  }
}

export default {
  async fetch(request: Request, env: Environment) {
    const path = new URL(request.url).pathname;
    const namespace = [
      "/select",
      "/publish",
      "/reconcile",
      "/state",
      "/abandon",
      "/prepare-restore",
      "/install-restore",
      "/post-after-restore",
      "/coordinator-read",
      "/coordinator-execute",
    ].includes(path)
      ? "BOOKS"
      : "CATALOGS";
    try {
      return Response.json(await call(env, namespace, `${path}${new URL(request.url).search}`));
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 409 });
    }
  },
};
