import { createHash } from "node:crypto";
import { decodeBookOutcome } from "@rastrata/kernel";
import { NativeLedger } from "./native-ledger.ts";
import { completeScope } from "./compact-records.ts";
import type { NativeCatalogSnapshot } from "./native-ledger-catalog.ts";
import {
  normalizeNativeArchiveSeal,
  readNativeArchiveBatch,
  readNativeArchiveOutcomes,
  readResumedNativeArchive,
} from "./native-outcome-outbox.ts";
import type { ArchivePayloadReference, R2ArchiveObjectStore } from "./r2-archive-store.ts";
import { decodeAggregate, requireLedger, type CompleteBookScope } from "./records.ts";
import { SerialLedgerQueue } from "./serial-ledger-queue.ts";
import { SqliteLedgerRepository, type NativeLedgerHead } from "./sqlite-ledger-repository.ts";
import { atomicSqlite } from "./sqlite-transaction.ts";
import type { SqlBinding, SqliteStorage } from "./sqlite.ts";
import { auditNativeProjection } from "./native-projection-audit.ts";
import {
  prepareNativeRestoredAccess,
  activateNativeRestoredAccess,
  assertNativeRestoredAccess,
  assertNativeSnapshotAccess,
} from "./authorized-native-ledger.ts";

const VERSION = "rastrata-native-restore-v1";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const encoder = new TextEncoder();

interface Progress {
  readonly version: typeof VERSION;
  readonly approvalHash: string;
  readonly phase: "scan" | "replay" | "replayed" | "verified" | "prepared" | "active";
  readonly next: ArchivePayloadReference | null;
  readonly expected: NativeLedgerHead;
  readonly through: NativeLedgerHead | null;
  /** Native snapshots are authenticated in place; archive recovery replays into empty storage. */
  readonly snapshot?: true;
}

export interface NativeRestoreProgress {
  readonly phase: Progress["phase"];
  readonly through: NativeLedgerHead | null;
  readonly expectedHead: NativeLedgerHead;
}

/** Maintenance-only, same-identity recovery: archive replay into empty storage,
 * or explicit verification of a native snapshot against the approved exact tip.
 * The configured catalog RPC supplies durable approval, never a request payload.
 * Keep public reads/writes unavailable throughout. One call scans one manifest
 * or reads/replays at most sixteen outcomes/one MiB. Durable manifest references permit
 * restart without spooling a second copy of outcome bodies. This does not grant
 * activation: the owner/catalog must separately authorize the replacement writer.
 * Existing canonical data is never deleted or implicitly adopted. */
export class NativeLedgerRestore {
  private readonly queue = new SerialLedgerQueue();
  private readonly scope: CompleteBookScope;
  constructor(
    private readonly storage: SqliteStorage,
    scope: CompleteBookScope,
    private readonly archive: R2ArchiveObjectStore,
    private readonly readCatalog: () => Promise<NativeCatalogSnapshot>,
  ) {
    this.scope = completeScope(scope, scope.objectId);
    archive.assertScope(this.scope, this.scope.objectId);
  }
  private rows(query: string, ...bindings: SqlBinding[]) {
    return Array.from(this.storage.sql.exec(query, ...bindings));
  }
  private async approval(checkSeal = true) {
    const selection = await this.readCatalog();
    requireLedger(
      selection.status === "maintenance" &&
        selection.mutation.kind === "restore" &&
        selection.restore !== null &&
        selection.sealed !== null &&
        selection.retirement !== null &&
        same(selection.identity, this.scope) &&
        selection.catalogObjectId !== this.scope.objectId &&
        selection.fence === selection.retirement.fence &&
        selection.fence !== "0",
      "native_restore_not_approved",
    );
    const seal = normalizeNativeArchiveSeal(selection.sealed, this.scope);
    requireLedger(
      same(seal.head, selection.retirement.head) &&
        seal.fence === selection.fence &&
        seal.genesisHash === selection.genesisHash &&
        BigInt(seal.head.sequence) >= 1n,
      "native_restore_not_approved",
    );
    if (checkSeal)
      requireLedger(
        same(await this.archive.readControl(), seal.control),
        "native_archive_seal_changed",
      );
    return { selection, seal };
  }
  private load(): Progress | null {
    const tables = this.rows(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ledger_native_restore','ledger_native_restore_batches')",
    );
    if (!tables.length) return null;
    requireLedger(tables.length === 2, "native_restore_state_corrupt");
    const rows = this.rows(
      "SELECT CASE WHEN length(CAST(body AS BLOB))<=16384 THEN body END AS body, digest FROM ledger_native_restore WHERE singleton=1",
    );
    const row = rows[0];
    requireLedger(
      rows.length === 1 && typeof row?.body === "string" && sha(row.body) === row.digest,
      "native_restore_state_corrupt",
    );
    const value = JSON.parse(row.body) as Progress;
    requireLedger(
      value !== null &&
        Object.keys(value).sort().join(",") ===
          (value.snapshot === true
            ? "approvalHash,expected,next,phase,snapshot,through,version"
            : "approvalHash,expected,next,phase,through,version") &&
        value.version === VERSION &&
        /^[a-f0-9]{64}$/.test(value.approvalHash) &&
        ["scan", "replay", "replayed", "verified", "prepared", "active"].includes(value.phase),
      "native_restore_state_corrupt",
    );
    return value;
  }
  private save(before: Progress, next: Progress): void {
    const body = JSON.stringify(next);
    requireLedger(encoder.encode(body).length <= 16384, "native_restore_state_corrupt");
    const changed = this.rows(
      "UPDATE ledger_native_restore SET body=?, digest=? WHERE singleton=1 AND body=? RETURNING singleton",
      body,
      sha(body),
      JSON.stringify(before),
    );
    requireLedger(changed.length === 1, "native_restore_progress_conflict");
  }
  private initialize(approval: NativeCatalogSnapshot, snapshot: boolean): Progress {
    return atomicSqlite(this.storage, (transaction) => {
      const existing = this.load();
      if (
        existing !== null &&
        !(snapshot && existing.phase === "active" && existing.approvalHash !== approval.contentHash)
      ) {
        requireLedger(
          existing.approvalHash === approval.contentHash &&
            (existing.snapshot === true) === snapshot,
          "native_restore_approval_changed",
        );
        return existing;
      }
      if (snapshot) {
        requireLedger(
          approval.restore !== null && approval.retirement !== null,
          "native_restore_not_approved",
        );
        assertNativeSnapshotAccess(
          this.storage,
          this.scope,
          approval.restore.authorizationRevision,
          approval.retirement,
          transaction,
        );
      } else
        requireLedger(
          this.rows(
            "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'ledger_*' LIMIT 1",
          ).length === 0,
          "native_restore_target_not_empty",
        );
      requireLedger(approval.sealed !== null, "native_restore_not_approved");
      const state: Progress = {
        version: VERSION,
        approvalHash: approval.contentHash,
        phase: "scan",
        next: null,
        expected: approval.sealed.head,
        through: null,
        ...(snapshot ? { snapshot: true as const } : {}),
      };
      this.rows(
        "CREATE TABLE IF NOT EXISTS ledger_native_restore (singleton INTEGER PRIMARY KEY CHECK(singleton=1), body TEXT NOT NULL, digest TEXT NOT NULL)",
      );
      this.rows(
        "CREATE TABLE IF NOT EXISTS ledger_native_restore_batches (through_sequence INTEGER PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL)",
      );
      const body = JSON.stringify(state);
      if (existing) this.save(existing, state);
      else this.rows("INSERT INTO ledger_native_restore VALUES (1,?,?)", body, sha(body));
      return state;
    });
  }
  /** Exactly one bounded unit. The DO alarm/operator schedules the next call;
   * never loop to completion inside a single request. */
  step(source: "archive" | "snapshot" = "archive"): Promise<NativeRestoreProgress> {
    return this.queue.run(async () => {
      requireLedger(source === "archive" || source === "snapshot", "native_restore_source_invalid");
      await this.storage.sync();
      const { selection, seal } = await this.approval();
      const state = this.initialize(selection, source === "snapshot");
      requireLedger(
        state.phase !== "prepared" && state.phase !== "active",
        "native_restore_already_prepared",
      );
      await this.storage.sync();
      const stillApproved = async () => {
        requireLedger(
          (await this.approval()).selection.contentHash === state.approvalHash,
          "native_restore_approval_changed",
        );
      };
      const admit = () =>
        requireLedger(same(this.load(), state), "native_restore_progress_conflict");
      if (state.phase === "scan" && state.snapshot !== true) {
        const item = await readNativeArchiveBatch(this.archive, seal, state.next ?? undefined);
        requireLedger(same(item.batch.through, state.expected), "recovery_segment_gap_detected");
        await stillApproved();
        const next: Progress = {
          ...state,
          next: item.batch.previous,
          expected: item.batch.from,
          phase: item.batch.previous === null ? "replay" : "scan",
        };
        atomicSqlite(this.storage, () => {
          admit();
          const body = JSON.stringify({
            reference: item.reference,
            from: item.batch.from,
            through: item.batch.through,
          });
          this.rows(
            "INSERT INTO ledger_native_restore_batches VALUES (?,?,?)",
            item.batch.through.sequence,
            body,
            sha(body),
          );
          this.save(state, next);
        });
        await this.storage.sync();
        return { phase: next.phase, through: next.through, expectedHead: seal.head };
      }
      const repository = new SqliteLedgerRepository(
        this.storage,
        this.scope,
        this.scope.objectId,
        () => ({ fence: selection.fence, pending: false }),
      );
      if (state.phase === "scan" && state.snapshot === true) {
        const page = await repository.outcomePage(state.through, 16, admit);
        requireLedger(
          sha(page.genesis) === selection.genesisHash && same(page.observedTip, seal.head),
          "native_restore_target_changed",
        );
        await stillApproved();
        const next: Progress = {
          ...state,
          through: page.through,
          phase: same(page.through, seal.head) ? "replayed" : "scan",
        };
        atomicSqlite(this.storage, () => {
          admit();
          this.save(state, next);
        });
        await this.storage.sync();
        return { phase: next.phase, through: next.through, expectedHead: seal.head };
      }
      if (state.phase === "replayed" || state.phase === "verified") {
        requireLedger(
          state.through !== null && same(state.through, seal.head),
          "native_restore_state_corrupt",
        );
        const page = await repository.outcomePage(seal.head, 1, admit);
        requireLedger(
          same(page.observedTip, seal.head) && page.outcomes.length === 0,
          "native_restore_target_changed",
        );
        await stillApproved();
        const proof = await auditNativeProjection(
          this.storage,
          repository,
          seal.head,
          state.approvalHash,
          admit,
        );
        await stillApproved();
        if (!proof.complete)
          return { phase: "replayed", through: state.through, expectedHead: seal.head };
        requireLedger(
          proof.count === selection.restore?.projection.count &&
            proof.digest === selection.restore.projection.digest,
          "native_restore_projection_mismatch",
        );
        if (state.phase !== "verified") {
          atomicSqlite(this.storage, () => this.save(state, { ...state, phase: "verified" }));
          await this.storage.sync();
        }
        return { phase: "verified", through: state.through, expectedHead: seal.head };
      }
      const row = this.rows(
        "SELECT CASE WHEN length(CAST(body AS BLOB))<=16384 THEN body END AS body, digest FROM ledger_native_restore_batches WHERE through_sequence>? ORDER BY through_sequence LIMIT 1",
        state.through?.sequence ?? "-1",
      )[0];
      requireLedger(
        row && typeof row.body === "string" && sha(row.body) === row.digest,
        "native_restore_state_corrupt",
      );
      const stored = JSON.parse(row.body);
      const item = await readNativeArchiveOutcomes(this.archive, seal, stored.reference);
      requireLedger(
        same(item.batch.from, stored.from) &&
          same(item.batch.through, stored.through) &&
          (state.through === null
            ? item.batch.previous === null
            : same(item.batch.from, state.through)),
        "recovery_segment_gap_detected",
      );
      const ledger = new NativeLedger(repository);
      if (item.genesis !== null) {
        // Validate accounting genesis before creating canonical tables.
        decodeAggregate(item.genesis);
        await stillApproved();
        const initial = await repository.provision(item.genesis, admit);
        requireLedger(same(initial, item.batch.initial), "native_restore_target_changed");
      } else {
        const before = await repository.outcomePage(item.batch.from, 1, admit);
        requireLedger(
          BigInt(before.observedTip.sequence) <= BigInt(item.batch.through.sequence),
          "native_restore_target_changed",
        );
        let cursor = item.batch.from;
        for (const outcome of item.outcomes) {
          const decoded = decodeBookOutcome(outcome.encoded);
          requireLedger(decoded.disposition === "decoded", "native_archive_outcome_corrupt");
          await stillApproved();
          if (outcome.head.sequence === "1")
            await ledger.provision(decodeAggregate(before.genesis), decoded.payload.command, admit);
          else await ledger.execute(decoded.payload.command, admit);
          const actual = (await repository.outcomePage(cursor, 1, admit)).outcomes[0];
          requireLedger(
            actual &&
              actual.encoded === outcome.encoded &&
              same(actual.head, outcome.head) &&
              actual.previousHash === outcome.previousHash,
            "native_restore_accounting_mismatch",
          );
          cursor = actual.head;
        }
      }
      const page = await repository.outcomePage(item.batch.through, 1, admit);
      requireLedger(
        same(page.observedTip, item.batch.through) && page.outcomes.length === 0,
        "native_restore_target_changed",
      );
      await stillApproved();
      const next: Progress = {
        ...state,
        through: item.batch.through,
        phase: same(item.batch.through, seal.head) ? "replayed" : "replay",
      };
      atomicSqlite(this.storage, () => this.save(state, next));
      await this.storage.sync();
      return { phase: next.phase, through: next.through, expectedHead: seal.head };
    });
  }

  /** Trusted catalog RPC. Produces actual local evidence, never a caller's ready
   * flag. Prepared access rejects every public request even if routing is stale. */
  prepareWriter(approvalHash: string) {
    return this.queue.run(async () => {
      await this.storage.sync();
      const { selection, seal } = await this.approval(false);
      const state = this.load();
      requireLedger(
        state !== null &&
          state.approvalHash === approvalHash &&
          selection.contentHash === approvalHash &&
          (state.phase === "verified" || state.phase === "prepared") &&
          same(state.through, seal.head),
        "native_restore_not_verified",
      );
      const grant = selection.restore;
      requireLedger(grant !== null, "native_restore_not_approved");
      // First preparation requires the original seal. A prepared retry also
      // allows its exact resumed frontier after an uncertain coordinator reply.
      if (same(await this.archive.readControl(), seal.control) === false) {
        requireLedger(state.phase === "prepared", "native_archive_seal_changed");
        await readResumedNativeArchive(this.archive, seal);
      }
      const admit = () =>
        requireLedger(same(this.load(), state), "native_restore_progress_conflict");
      const repository = new SqliteLedgerRepository(
        this.storage,
        this.scope,
        this.scope.objectId,
        () => ({ fence: selection.fence, pending: false }),
      );
      const current = await repository.outcomePage(seal.head, 1, admit);
      requireLedger(
        same(current.observedTip, seal.head) && current.outcomes.length === 0,
        "native_restore_target_changed",
      );
      // Validate the persisted completed scan, not only the phase label.
      const proof = await auditNativeProjection(
        this.storage,
        repository,
        seal.head,
        approvalHash,
        admit,
      );
      requireLedger(
        proof.complete &&
          proof.count === grant.projection.count &&
          proof.digest === grant.projection.digest,
        "native_restore_projection_mismatch",
      );
      requireLedger(
        (await this.approval(false)).selection.contentHash === approvalHash,
        "native_restore_approval_changed",
      );
      atomicSqlite(this.storage, (transaction) => {
        admit();
        if (state.phase === "prepared")
          assertNativeRestoredAccess(
            this.storage,
            this.scope,
            selection.fence,
            grant.authorizationRevision,
            "prepared",
            transaction,
          );
        else {
          prepareNativeRestoredAccess(
            this.storage,
            this.scope,
            selection.fence,
            grant.authorizationRevision,
            transaction,
            state.snapshot ? (selection.retirement ?? undefined) : undefined,
          );
          this.save(state, { ...state, phase: "prepared" });
        }
      });
      await this.storage.sync();
      return Object.freeze({
        scope: this.scope,
        approvalHash,
        head: seal.head,
        writerFence: selection.fence,
        authorizationRevision: grant.authorizationRevision,
        projection: grant.projection,
      });
    });
  }

  /** Observe actual durable catalog activation before opening local access.
   * The owner must retain one queue and refresh routing authority on restart.
   * Repeated activation returns the historical cutoff without rewriting history. */
  activateWriter() {
    return this.queue.run(async () => {
      await this.storage.sync();
      const catalog = await this.readCatalog(),
        state = this.load();
      requireLedger(
        catalog.status === "active" &&
          catalog.mutation.kind === "resume" &&
          state !== null &&
          catalog.mutation.expectedHash === state.approvalHash &&
          catalog.restore !== null &&
          catalog.sealed !== null &&
          same(catalog.identity, this.scope) &&
          (state.phase === "prepared" || state.phase === "active"),
        "native_restore_catalog_not_active",
      );
      const grant = catalog.restore,
        seal = normalizeNativeArchiveSeal(catalog.sealed, this.scope);
      requireLedger(
        catalog.fence === seal.fence && same(state.through, seal.head),
        "native_restore_catalog_not_active",
      );
      if (state.phase === "active") return { head: seal.head, writerFence: catalog.fence };
      await readResumedNativeArchive(this.archive, seal);
      const repository = new SqliteLedgerRepository(
        this.storage,
        this.scope,
        this.scope.objectId,
        () => ({ fence: catalog.fence, pending: false }),
      );
      const current = await repository.outcomePage(seal.head, 1);
      requireLedger(
        same(current.observedTip, seal.head) && current.outcomes.length === 0,
        "native_restore_target_changed",
      );
      requireLedger(
        (await this.readCatalog()).contentHash === catalog.contentHash,
        "native_restore_approval_changed",
      );
      atomicSqlite(this.storage, (transaction) => {
        requireLedger(same(this.load(), state), "native_restore_progress_conflict");
        activateNativeRestoredAccess(
          this.storage,
          this.scope,
          catalog.fence,
          grant.authorizationRevision,
          transaction,
        );
        this.save(state, { ...state, phase: "active" });
      });
      await this.storage.sync();
      return { head: seal.head, writerFence: catalog.fence };
    });
  }
}
