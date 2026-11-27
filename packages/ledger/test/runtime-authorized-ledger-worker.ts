// Local-only test harness: fixtures and fault switches are never deployed.
import { canonicalAccountingValue, canonicalEncode, encodeDurableBook } from "@rastrata/kernel";
import { AuthorizedNativeLedger } from "../src/authorized-native-ledger.ts";
import { NativeLedgerHttp } from "../src/native-ledger-http.ts";
import { NativeLedgerCatalog, type NativeCatalogSnapshot } from "../src/native-ledger-catalog.ts";
import { NativeOutcomeOutbox } from "../src/native-outcome-outbox.ts";
import { NativeLedgerRestore } from "../src/native-ledger-restore.ts";
import { R2ArchiveObjectStore, type ArchiveR2Bucket } from "../src/r2-archive-store.ts";
import type { NativeAlarmStorage } from "../src/native-archive-alarm.ts";
import { SqliteLedgerRepository } from "../src/sqlite-ledger-repository.ts";
import { BookAuthorizer, type BookAuthorizationConfiguration } from "../src/book-authorization.ts";
import type { SqliteStorage } from "../src/sqlite.ts";
import { genesis, activation, posting, BOOK } from "./fixtures.ts";

interface Environment {
  AUTH_CONFIGURATION: BookAuthorizationConfiguration;
  WRITER_FENCE?: string;
  ARCHIVE?: ArchiveR2Bucket;
  BOOKS: {
    idFromName(name: string): { toString(): string };
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
  CATALOGS?: Environment["BOOKS"];
}

export class AuthorizedLedgerObject {
  private readonly ledger: AuthorizedNativeLedger;
  private readonly http: NativeLedgerHttp;
  private readonly archive?: NativeOutcomeOutbox;
  private archiveUnavailable = false;
  private loseAcknowledgement = false;
  private loseRetirementReply = false;
  private failSync = false;
  private loseRestoreReply = false;
  private readonly storage: SqliteStorage;
  private readonly scope;
  private readonly store: R2ArchiveObjectStore | undefined;
  constructor(
    private readonly ctx: {
      id: { toString(): string };
      storage: SqliteStorage & NativeAlarmStorage & { deleteAll(): Promise<void> };
    },
    private readonly env: Environment,
  ) {
    const storage: SqliteStorage = {
      sql: {
        exec: (query, ...bindings) => {
          const result = ctx.storage.sql.exec(query, ...bindings);
          if (this.loseRestoreReply && query.startsWith("INSERT INTO ledger_native_outcomes")) {
            this.loseRestoreReply = false;
            this.failSync = true;
          }
          if (
            this.loseAcknowledgement &&
            query.startsWith("INSERT INTO ledger_native_access_events")
          ) {
            this.loseAcknowledgement = false;
            this.failSync = true;
          }
          if (
            this.loseRetirementReply &&
            query.startsWith("UPDATE ledger_native_access SET writer_fence")
          ) {
            this.loseRetirementReply = false;
            this.failSync = true;
          }
          return result;
        },
      },
      transactionSync: (operation) => ctx.storage.transactionSync(operation),
      sync: async () => {
        await ctx.storage.sync();
        if (this.failSync) {
          this.failSync = false;
          throw new Error("injected authorization lost acknowledgement");
        }
      },
    };
    this.storage = storage;
    const scope = {
      tenantId: "tenant-A",
      bookId: BOOK,
      namespaceId: "ledger-test",
      generation: "0",
      objectId: ctx.id.toString(),
    };
    const bucket = env.ARCHIVE;
    this.scope = scope;
    const store = bucket
      ? new R2ArchiveObjectStore(
          {
            get: (key) => {
              if (this.archiveUnavailable) return Promise.reject(new Error("injected R2 outage"));
              return bucket.get(key);
            },
            put: (...args) => {
              if (this.archiveUnavailable) return Promise.reject(new Error("injected R2 outage"));
              return bucket.put(...args);
            },
          },
          scope,
          scope.objectId,
        )
      : undefined;
    this.store = store;
    this.ledger = new AuthorizedNativeLedger(
      storage,
      scope,
      scope.objectId,
      () => ({ fence: env.WRITER_FENCE ?? "0", pending: false }),
      new BookAuthorizer(env.AUTH_CONFIGURATION),
      store ? { store, alarms: ctx.storage } : undefined,
    );
    // Explicit test-only reservation/inspection port, not a second command owner.
    if (store)
      this.archive = new NativeOutcomeOutbox(
        new SqliteLedgerRepository(storage, scope, scope.objectId, () => ({
          fence: env.WRITER_FENCE ?? "0",
          pending: false,
        })),
        store,
        () => ({ fence: env.WRITER_FENCE ?? "0", pending: false }),
      );
    this.http = new NativeLedgerHttp(this.ledger);
  }
  async alarm(): Promise<void> {
    await this.ledger.handleArchiveAlarm();
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url),
      token = request.headers.get("authorization");
    if (url.pathname.startsWith("/api/")) {
      url.pathname = url.pathname.slice(4);
      return this.http.fetch(new Request(url.toString(), request));
    }
    try {
      if (url.pathname.startsWith("/restore/")) {
        // Destructive data-loss simulation exists ONLY in this local test Worker.
        const authorizer = new BookAuthorizer(this.env.AUTH_CONFIGURATION);
        authorizer.assert(await authorizer.verify(token), this.scope, "maintain");
        const catalogs = this.env.CATALOGS,
          store = this.store;
        if (!catalogs || !store) throw new Error("Missing recovery test bindings");
        const readCatalog = async () => {
          const response = await catalogs.get(catalogs.idFromName("native-catalog")).fetch(
            new Request("http://catalog.test/control/read", {
              method: "POST",
              headers: { authorization: token ?? "" },
            }),
          );
          if (!response.ok) throw new Error(await response.text());
          return response.json() as Promise<NativeCatalogSnapshot>;
        };
        const approval = await readCatalog();
        if (
          (approval.status !== "maintenance" && approval.status !== "active") ||
          approval.restore === null
        )
          throw new Error("Missing test restore approval");
        const installer = new NativeLedgerRestore(this.storage, this.scope, store, readCatalog);
        if (url.pathname === "/restore/prepare") {
          const input = (await request.json()) as { approvalHash: string };
          return Response.json(await installer.prepareWriter(input.approvalHash));
        }
        if (url.pathname === "/restore/activate")
          return Response.json(await installer.activateWriter());
        if (url.pathname === "/restore/evidence") {
          const repo = new SqliteLedgerRepository(
            this.storage,
            this.scope,
            this.scope.objectId,
            () => ({ fence: approval.fence, pending: false }),
          );
          const page = await repo.outcomePage();
          const facts = [];
          let cursor: string | null = null;
          for (;;) {
            const part = await repo.factPage(cursor, 1);
            facts.push(...part.facts);
            if (!part.facts.length) break;
            cursor = part.nextIdentity;
          }
          return Response.json({
            head: page.observedTip,
            outcomes: page.outcomes.map((x) => x.encoded),
            facts,
          });
        }
        if (url.pathname === "/restore/loss") await this.ctx.storage.deleteAll();
        this.loseRestoreReply = url.searchParams.get("lost") === "1";
        return Response.json(
          await new NativeLedgerRestore(this.storage, this.scope, store, readCatalog).step(),
        );
      }
      if (url.pathname.startsWith("/archive/")) {
        await this.ledger.checkRequestAuthorization(token, "maintain");
        if (!this.archive) throw new Error("Missing test archive binding");
        if (url.pathname === "/archive/initialize") {
          await this.archive.initialize();
          return Response.json({ initialized: true });
        }
        if (url.pathname === "/archive/arm") {
          await this.ctx.storage.setAlarm(Date.now());
          return Response.json({ armed: true });
        }
        if (url.pathname === "/archive/alarm")
          return Response.json({ scheduledAt: await this.ctx.storage.getAlarm() });
        if (url.pathname === "/archive/fail") {
          this.archiveUnavailable = true;
          return Response.json({ unavailable: true });
        }
        if (url.pathname === "/archive/recover") {
          this.archiveUnavailable = false;
          return Response.json({ unavailable: false });
        }
        if (url.pathname === "/archive/inspect") {
          let through = "0",
            count = 0;
          for await (const batch of this.archive.inspect()) {
            if (BigInt(batch.through.sequence) > BigInt(through)) through = batch.through.sequence;
            count += batch.outcomes.length;
          }
          return Response.json({ through, count });
        }
      }
      if (url.pathname === "/provision") {
        await this.ledger.provision(token, genesis(), activation());
        return Response.json({ provisioned: true });
      }
      if (url.pathname === "/catalog/inspect")
        return Response.json(await this.ledger.inspectProvisioned(token));
      if (url.pathname === "/catalog/projection") {
        const input = (await request.json()) as { fence: string };
        return Response.json(await this.ledger.inspectRetiredProjection(token, input.fence));
      }
      if (url.pathname === "/catalog/retire") {
        const input = (await request.json()) as { requestId: string; fence: string };
        this.loseRetirementReply = url.searchParams.get("lost") === "1";
        return Response.json(await this.ledger.retireWriter(token, input.requestId, input.fence));
      }
      if (url.pathname === "/post" || url.pathname === "/post-next") {
        const result = await this.ledger.execute(
          token,
          url.pathname === "/post" ? posting("one") : posting("two", 2n),
        );
        return Response.json({
          disposition: result.value.result.disposition,
          original: new TextDecoder().decode(
            canonicalEncode(canonicalAccountingValue(result.value.originalResult)),
          ),
          sequence: result.head.sequence,
        });
      }
      if (url.pathname === "/revoke") {
        this.loseAcknowledgement = url.searchParams.get("lost") === "1";
        return Response.json(await this.ledger.advanceAuthorization(token, "revoke", "0"));
      }
      if (url.pathname === "/retire") {
        this.loseRetirementReply = url.searchParams.get("lost") === "1";
        return Response.json(await this.ledger.retireWriter(token, "retire-generation", "0"));
      }
      if (url.pathname === "/read") {
        const page = await this.ledger.outcomes(token);
        return Response.json({ count: page.outcomes.length, sequence: page.observedTip.sequence });
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      return new Response(error instanceof Error ? error.message : "failure", {
        status: code === "ledger_unauthorized" ? 401 : code === "ledger_forbidden" ? 403 : 500,
      });
    }
  }
}

/** Local-only coordinator harness. It exercises separate physical object storage
 * and signed book RPCs, not production tenant routing or maintenance approval. */
export class NativeCatalogObject {
  private failCommitReply = false;
  private failSync = false;
  constructor(
    private readonly ctx: { id: { toString(): string }; storage: SqliteStorage },
    private readonly env: Environment,
  ) {}
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url),
        token = request.headers.get("authorization");
      if (token === null) throw new Error("Missing catalog test authorization");
      const bookId = this.env.BOOKS.idFromName("authorized-book");
      const scope = {
        tenantId: "tenant-A",
        bookId: BOOK,
        namespaceId: "ledger-test",
        generation: "0",
        objectId: bookId.toString(),
      };
      const authorizer = new BookAuthorizer(this.env.AUTH_CONFIGURATION);
      authorizer.assert(await authorizer.verify(token), scope, "maintain");
      const rpc = async <T>(path: string, body?: unknown): Promise<T> => {
        const response = await this.env.BOOKS.get(bookId).fetch(
          new Request(`http://book.test${path}`, {
            method: "POST",
            headers: { authorization: token, "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
        if (!response.ok) throw new Error(await response.text());
        return response.json() as Promise<T>;
      };
      const storage: SqliteStorage = {
        sql: {
          exec: (query, ...bindings) => {
            const result = this.ctx.storage.sql.exec(query, ...bindings);
            if (this.failCommitReply && query.startsWith("UPDATE ledger_native_catalog")) {
              this.failCommitReply = false;
              this.failSync = true;
            }
            return result;
          },
        },
        transactionSync: (work) => this.ctx.storage.transactionSync(work),
        sync: async () => {
          await this.ctx.storage.sync();
          if (this.failSync) {
            this.failSync = false;
            throw new Error("lost catalog commit reply");
          }
        },
      };
      const catalog = new NativeLedgerCatalog(
        storage,
        this.ctx.id.toString(),
        scope,
        {
          inspectProvisioned: () => rpc("/catalog/inspect"),
          inspectRetiredProjection: (_, fence) => rpc("/catalog/projection", { fence }),
          prepareRestoredWriter: (_, approvalHash) => rpc("/restore/prepare", { approvalHash }),
          retireWriter: (_, requestId, fence) =>
            rpc(`/catalog/retire${url.searchParams.get("sourceLost") === "1" ? "?lost=1" : ""}`, {
              requestId,
              fence,
            }),
        },
        this.env.ARCHIVE
          ? new R2ArchiveObjectStore(this.env.ARCHIVE, scope, scope.objectId)
          : undefined,
      );
      if (url.pathname === "/control/reserve")
        return Response.json(await catalog.reserve(encodeDurableBook(genesis()), "reserve-book"));
      if (url.pathname === "/control/read") return Response.json(await catalog.read());
      const input = (await request.json()) as {
        expected: NativeCatalogSnapshot;
        operationId: string;
      };
      this.failCommitReply = url.searchParams.get("lost") === "1";
      if (url.pathname === "/control/activate")
        return Response.json(await catalog.activate(input.expected, input.operationId));
      if (url.pathname === "/control/quiesce")
        return Response.json(await catalog.beginMaintenance(input.expected, input.operationId));
      if (url.pathname === "/control/retire")
        return Response.json(await catalog.retireWriter(input.expected, input.operationId));
      if (url.pathname === "/control/seal")
        return Response.json(await catalog.sealArchive(input.expected, input.operationId));
      if (url.pathname === "/control/restore")
        return Response.json(
          await catalog.approveRestore(
            input.expected,
            input.operationId,
            (await authorizer.verify(token)).actorId,
          ),
        );
      if (url.pathname === "/control/resume")
        return Response.json(await catalog.finishRestore(input.expected, input.operationId));
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return new Response(error instanceof Error ? error.message : "failed", { status: 500 });
    }
  }
}
export default {
  fetch(request: Request, env: Environment) {
    const path = new URL(request.url).pathname;
    if (env.CATALOGS && (path.startsWith("/control/") || path === "/test-catalog-id")) {
      const catalogId = env.CATALOGS.idFromName("native-catalog");
      if (path === "/test-catalog-id") return new Response(catalogId.toString());
      return env.CATALOGS.get(catalogId).fetch(request);
    }
    const id = env.BOOKS.idFromName("authorized-book");
    // Public physical identifier is exposed only to construct signed test inputs.
    if (new URL(request.url).pathname === "/test-object-id") return new Response(id.toString());
    return env.BOOKS.get(id).fetch(request);
  },
};
