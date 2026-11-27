import {
  canonicalAccountingValue,
  hashCanonical,
  contentHashEquals,
  immutableAccountingValue,
  type BookCommand,
} from "@rastrata/kernel";
import type { ArchiveCatalogAuthority } from "./archive-authority.ts";
import { SqliteArchiveSelection } from "./archive-selection.ts";
import { createArchiveDurabilityPolicy, type ArchiveDurabilityPolicy } from "./archive-records.ts";
import { completeScope } from "./compact-records.ts";
import type { LedgerReceipt, LedgerSnapshot } from "./ledger.ts";
import { evaluateOutcomePayload } from "./outcome-payload.ts";
import type { R2ArchiveObjectStore } from "./r2-archive-store.ts";
import { requireLedger, same, snapshotCommand, type CompleteBookScope } from "./records.ts";
import type { SqliteStorage } from "./sqlite.ts";

export interface ArchiveLedgerSnapshot extends LedgerSnapshot {
  readonly durabilityPolicy: ArchiveDurabilityPolicy;
  /** Verified canonical manifest at this snapshot's complete head. */
  readonly manifestHash: string;
}
export interface ArchiveLedgerReceipt extends LedgerReceipt {
  readonly durabilityPolicy: ArchiveDurabilityPolicy;
  /** Verified canonical manifest at receipt.head, which may include later outcomes. */
  readonly manifestHash: string;
}

/** Trusted, book-scoped in-process coordinator for already provisioned archive
 * books. The application must authenticate and authorize callers before entry.
 * Dependencies are deployment configuration, never posting-request fields.
 * This does not implement a public decoder, provisioning or a scalable evaluator. */
export class ArchiveLedger {
  private readonly owner: SqliteArchiveSelection;
  private readonly scope: CompleteBookScope;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    objectId: string,
    storage: SqliteStorage,
    scope: CompleteBookScope,
    private readonly store: R2ArchiveObjectStore,
    private readonly authority: ArchiveCatalogAuthority,
  ) {
    this.scope = completeScope(scope, objectId);
    this.owner = new SqliteArchiveSelection(objectId, storage, this.scope);
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  read(): Promise<ArchiveLedgerSnapshot> {
    return this.serial(async () => {
      const current = await this.owner.readActive(this.store, this.authority);
      return immutableAccountingValue({
        ...current.snapshot,
        durabilityPolicy: createArchiveDurabilityPolicy(true),
        manifestHash: current.anchor.manifestHash,
      });
    });
  }

  execute(input: BookCommand): Promise<ArchiveLedgerReceipt> {
    const command = snapshotCommand(input);
    requireLedger(command.bookId === this.scope.bookId, "ledger_identity_mismatch");
    return this.serial(async () => {
      const before = await this.owner.resumeActive(this.store, this.authority);
      const evaluated = evaluateOutcomePayload(before.snapshot.aggregate, command);
      if (evaluated.encoded !== null) {
        await this.owner.select(this.store, before.anchor, evaluated.encoded, command.id);
        await this.owner.publishPending(this.store, this.authority);
        await this.owner.reconcilePublished(this.store, this.authority);
      }
      // Reverify current active authority, complete history and durability even
      // for replay/conflict/unretained rejection. A service failure is not a new
      // accounting rejection; uncertainty must preserve the selected candidate.
      const after = await this.owner.readActive(this.store, this.authority);
      if (evaluated.encoded === null)
        requireLedger(same(before.snapshot.head, after.snapshot.head), "ledger_head_conflict");
      const retained =
        evaluated.encoded !== null || evaluated.transition.result.disposition === "replayed";
      const original = retained
        ? after.originals.find((item) => item.commandId === command.id)
        : undefined;
      if (retained) requireLedger(original !== undefined, "archive_receipt_unproven");
      if (evaluated.encoded !== null)
        requireLedger(
          contentHashEquals(
            hashCanonical(canonicalAccountingValue(original?.result)),
            hashCanonical(canonicalAccountingValue(evaluated.transition.result)),
          ),
          "archive_receipt_unproven",
        );
      return immutableAccountingValue({
        head: after.snapshot.head,
        result: evaluated.transition.result,
        outcomeSequence: original?.sequence ?? null,
        originalResult: original?.result ?? null,
        durabilityPolicy: createArchiveDurabilityPolicy(true),
        manifestHash: after.anchor.manifestHash,
      });
    });
  }
}
