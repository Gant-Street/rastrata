// Local workerd harness only: no public authorization or deployed bindings.
import { canonicalAccountingValue, canonicalEncode, encodeDurableBook } from "@rastrata/kernel";
import { IndexedLedgerOwner } from "../src/indexed-ledger-owner.ts";
import type { SqliteStorage } from "../src/sqlite.ts";
import { OutcomeOutbox } from "../src/outcome-outbox.ts";
import { R2ArchiveObjectStore, type ArchiveR2Bucket } from "../src/r2-archive-store.ts";
import { BOOK, activation, genesis, posting } from "./fixtures.ts";

interface Environment {
  ARCHIVE?: ArchiveR2Bucket;
  BOOKS: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
}
export class IndexedOwnerObject {
  private readonly owner: IndexedLedgerOwner;
  private publication = false;
  private rollback = false;
  private loseReply = false;
  private syncFailures = 0;
  private pending = false;
  private maintainAfterRoot = false;
  private maintainAfterSync = false;
  private readonly outbox: OutcomeOutbox | undefined;
  constructor(
    private readonly ctx: {
      id: { toString(): string };
      storage: SqliteStorage & {
        setAlarm(time: number): Promise<void>;
        getAlarm(): Promise<number | null>;
      };
    },
    env: Environment,
  ) {
    const storage: SqliteStorage = {
      sql: {
        exec: (sql, ...bindings) => {
          if (sql.startsWith("INSERT INTO ledger_indexed_records")) this.publication = true;
          const rows = Array.from(ctx.storage.sql.exec(sql, ...bindings));
          if (
            this.publication &&
            this.maintainAfterRoot &&
            sql.startsWith("UPDATE ledger_index_control")
          ) {
            this.maintainAfterRoot = false;
            this.maintainAfterSync = true;
          }
          if (
            this.publication &&
            this.rollback &&
            sql.startsWith("UPDATE ledger_indexed_canonical")
          ) {
            this.rollback = false;
            throw new Error("injected workerd canonical rollback");
          }
          if (this.publication && this.loseReply && sql.startsWith("UPDATE ledger_index_control")) {
            this.loseReply = false;
            this.syncFailures++;
          }
          return rows;
        },
      },
      transactionSync: (operation) => {
        try {
          return ctx.storage.transactionSync(operation);
        } finally {
          this.publication = false;
        }
      },
      sync: async () => {
        await ctx.storage.sync();
        if (this.maintainAfterSync) {
          this.maintainAfterSync = false;
          this.pending = true;
        }
        if (this.syncFailures) {
          this.syncFailures--;
          throw new Error("injected workerd lost durability reply");
        }
      },
    };
    const scope = {
      tenantId: "indexed-owner-runtime",
      bookId: BOOK,
      objectId: ctx.id.toString(),
      namespaceId: "indexed-owner-runtime",
      generation: "0",
    };
    // Fixed test authority and clock, NOT a persistent production control plane.
    this.owner = new IndexedLedgerOwner(
      storage,
      scope,
      scope.objectId,
      () => ({ fence: "0", pending: this.pending }),
      () => 10n,
      60000n,
      undefined,
      env.ARCHIVE ? () => this.scheduleArchive() : undefined,
    );
    this.outbox = env.ARCHIVE
      ? new OutcomeOutbox(this.owner, new R2ArchiveObjectStore(env.ARCHIVE, scope, scope.objectId))
      : undefined;
  }
  private async scheduleArchive(): Promise<void> {
    const deadline = Date.now() + 60000;
    const scheduled = await this.ctx.storage.getAlarm();
    // Continuous saves must not keep pushing an existing backup deadline back.
    if (scheduled === null || scheduled > deadline) await this.ctx.storage.setAlarm(deadline);
  }
  async alarm(): Promise<void> {
    if (!this.outbox) return;
    try {
      const progress = await this.outbox.drain(2);
      if (progress.pending > 0n || progress.disposition === "conflict")
        await this.scheduleArchive();
    } catch (error) {
      // Persist another opportunity even after native alarm retries are exhausted.
      await this.scheduleArchive();
      throw error;
    }
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/outbox/arm") {
        await this.ctx.storage.setAlarm(Date.now());
        return Response.json({ armed: true });
      }
      if (url.pathname === "/outbox/alarm")
        return Response.json({ scheduledAt: await this.ctx.storage.getAlarm() });
      if (url.pathname === "/outbox/inspect" && this.outbox) {
        const value = await this.outbox.inspect();
        return Response.json({ ...value, through: value.through.toString() });
      }
      if (url.pathname === "/audit") {
        const result = await this.owner.audit();
        return Response.json({ head: result.head });
      }
      if (url.pathname === "/provision") {
        await this.owner.provision(genesis());
        return Response.json({ provisioned: true });
      }
      if (url.pathname === "/read") {
        const snapshot = await this.owner.read();
        return Response.json({
          snapshot: encodeDurableBook(snapshot.aggregate),
          sequence: snapshot.head.sequence,
          headHash: snapshot.head.contentHash,
        });
      }
      if (url.pathname === "/damage-source") {
        this.ctx.storage.sql.exec("DELETE FROM ledger_indexed_source_origins");
        await this.ctx.storage.sync();
        return Response.json({ damaged: true });
      }
      if (url.pathname === "/resume-maintenance") {
        this.pending = false;
        return Response.json({ resumed: true });
      }
      if (url.pathname === "/raw-count")
        return Response.json({
          count: Array.from(
            this.ctx.storage.sql.exec("SELECT count(*) AS count FROM ledger_indexed_records"),
          )[0]?.count,
        });
      if (!["/activate", "/post", "/rollback", "/lost", "/maintained"].includes(url.pathname))
        return new Response("Unknown fixture operation", { status: 404 });
      const command =
        url.pathname === "/activate"
          ? activation()
          : posting(
              url.searchParams.get("id") ?? "sale",
              BigInt(url.searchParams.get("revision") ?? "1"),
            );
      this.rollback = url.pathname === "/rollback";
      this.loseReply = url.pathname === "/lost";
      this.maintainAfterRoot = url.pathname === "/maintained";
      const receipt = await this.owner.execute(command);
      return Response.json({
        disposition: receipt.result.disposition,
        sequence: receipt.head.sequence,
        outcomeSequence: receipt.outcomeSequence?.toString() ?? null,
        original:
          receipt.originalResult === null
            ? null
            : new TextDecoder().decode(
                canonicalEncode(canonicalAccountingValue(receipt.originalResult)),
              ),
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  }
}
export default {
  fetch(request: Request, env: Environment) {
    return env.BOOKS.get(env.BOOKS.idFromName("indexed-owner-runtime-book")).fetch(request);
  },
};
