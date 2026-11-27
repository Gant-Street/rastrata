import {
  type BookCommand,
  type BookCommandResult,
  type DurableBookAggregate,
  encodeDurableBook,
  executeBookCommand,
} from "@rastrata/kernel";
import {
  LEDGER_FORMAT,
  COMPACT_LEDGER_FORMAT,
  LEDGER_LIMITS,
  LedgerError,
  type BookScope,
  type LedgerHead,
  type StoredBook,
  type LedgerFormat,
  type CompleteBookScope,
  verifiedOutcomeRecordHash,
  decodeAggregate,
  genesisHead,
  outcomeRecord,
  payloadDigest,
  requireLedger,
  same,
  validateScope,
  snapshotCommand,
} from "./records.ts";
import type { BookStorageAdapter } from "./sqlite.ts";
import { compactGenesisHead, compactOutcomeRecord, completeScope } from "./compact-records.ts";
import { evaluateOutcomePayload, replayOutcomePayload } from "./outcome-payload.ts";
import {
  auditRecoveredInventoryPostings,
  type InventoryPostedAudit,
} from "./inventory-posted-audit.ts";
import { decodeInventoryPostedWitness } from "./inventory-posted-witness.ts";

export interface LedgerReceipt {
  readonly outcomeSequence: bigint | null;
  readonly result: BookCommandResult;
  readonly originalResult: BookCommandResult | null;
  readonly head: LedgerHead;
}
export interface LedgerSnapshot {
  readonly format: LedgerFormat;
  readonly aggregate: DurableBookAggregate;
  readonly head: LedgerHead;
  readonly scope: Readonly<BookScope | CompleteBookScope>;
}

interface Recovered {
  readonly aggregate: DurableBookAggregate;
  readonly head: LedgerHead;
  readonly originals: ReadonlyMap<string, { sequence: bigint; result: BookCommandResult }>;
  readonly latestAggregate: DurableBookAggregate;
  readonly replay: VerifiedReplay;
}

interface VerifiedReplay {
  readonly genesisDigest: string;
  readonly outcomeDigests: readonly string[];
  readonly aggregate: DurableBookAggregate;
  readonly head: LedgerHead;
  readonly originals: ReadonlyMap<string, { sequence: bigint; result: BookCommandResult }>;
}

/** Trusted, in-process API. A public command decoder and authorization gateway are separate. */
export class ProductionLedger {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly scope: BookScope | CompleteBookScope;
  private replayCache: VerifiedReplay | undefined;

  /** Read-only evidence at the returned verified head; never activates a policy
   * or changes old postings. Caller authentication is the same as for read(). */
  async auditInventoryPostedBalances(encodedWitness?: string): Promise<InventoryPostedAudit> {
    const witness =
      encodedWitness === undefined ? undefined : decodeInventoryPostedWitness(encodedWitness);
    const snapshot = await this.read();
    return auditRecoveredInventoryPostings(snapshot.aggregate.state, snapshot, witness);
  }

  constructor(
    private readonly storage: BookStorageAdapter,
    scope: BookScope | CompleteBookScope,
    private readonly format: LedgerFormat = LEDGER_FORMAT,
  ) {
    requireLedger(
      format === LEDGER_FORMAT || format === COMPACT_LEDGER_FORMAT,
      "ledger_format_unsupported",
    );
    if (format === COMPACT_LEDGER_FORMAT)
      this.scope = completeScope(scope as CompleteBookScope, storage.objectId);
    else {
      validateScope(scope, storage.objectId);
      this.scope = Object.freeze({
        tenantId: scope.tenantId,
        bookId: scope.bookId,
        objectId: scope.objectId,
      });
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {
      this.replayCache = undefined;
    });
    return result;
  }

  private recover(book: StoredBook, cutoff?: bigint): Recovered {
    requireLedger(book.format === this.format, "ledger_format_unsupported");
    if (this.format === COMPACT_LEDGER_FORMAT)
      completeScope(book.scope as CompleteBookScope, this.storage.objectId);
    else validateScope(book.scope, this.storage.objectId);
    requireLedger(same(book.scope, this.scope), "ledger_identity_mismatch");
    requireLedger(
      book.genesisDigest === payloadDigest(book.genesis, this.format),
      "recovery_record_corrupt",
    );
    requireLedger(book.outcomes.length <= LEDGER_LIMITS.outcomes, "recovery_record_corrupt");
    const outcomeDigests = Object.freeze(book.outcomes.map(verifiedOutcomeRecordHash));
    const cached = this.replayCache;
    if (cached) {
      // Even historical reads must detect alterations to a previously verified
      // prefix. This is an in-process check, not an external rollback witness.
      requireLedger(cached.genesisDigest === book.genesisDigest, "recovery_record_corrupt");
      requireLedger(
        outcomeDigests.length >= cached.outcomeDigests.length,
        "recovery_segment_gap_detected",
      );
      requireLedger(
        cached.outcomeDigests.every((digest, index) => digest === outcomeDigests[index]),
        "recovery_record_corrupt",
      );
    }
    // Cold startup and historical snapshots still execute the complete replay.
    const prefix = cutoff === undefined ? cached : undefined;
    let aggregate = prefix?.aggregate ?? decodeAggregate(book.genesis);
    requireLedger(
      aggregate.state.identity.bookId === this.scope.bookId,
      "ledger_identity_mismatch",
    );
    requireLedger(
      prefix !== undefined ||
        (aggregate.state.bookRevision === 0n && aggregate.protocol.retainedResults.length === 0),
      "recovery_record_corrupt",
    );
    let head = prefix?.head ?? this.genesisHead(book.genesis);
    const originals = new Map(prefix?.originals);
    let selected: Pick<Recovered, "aggregate" | "head" | "originals"> | undefined =
      cutoff === 0n ? { aggregate, head, originals: new Map() } : undefined;
    for (const stored of book.outcomes.slice(prefix?.outcomeDigests.length ?? 0)) {
      requireLedger(same(stored.before, head), "recovery_segment_gap_detected");
      const next =
        this.format === COMPACT_LEDGER_FORMAT
          ? replayOutcomePayload(aggregate, stored.body)
          : (() => {
              const snapshot = decodeAggregate(stored.body);
              const retained = snapshot.protocol.retainedResults.at(-1);
              requireLedger(retained, "recovery_record_corrupt");
              return executeBookCommand(aggregate.state, aggregate.protocol, retained.command);
            })();
      const retained = next.protocol.retainedResults.at(-1);
      requireLedger(retained && !originals.has(retained.commandId), "recovery_record_corrupt");
      requireLedger(
        next.protocol.retainedResults.length === aggregate.protocol.retainedResults.length + 1,
        "recovery_record_corrupt",
      );
      const expected =
        this.format === COMPACT_LEDGER_FORMAT
          ? compactOutcomeRecord(this.scope as CompleteBookScope, head, next, stored.body)
          : outcomeRecord(this.scope, head, next, next.result, retained.commandId);
      requireLedger(same(expected, stored), "recovery_record_corrupt");
      aggregate = Object.freeze({ state: next.state, protocol: next.protocol });
      head = expected.after;
      originals.set(retained.commandId, { sequence: BigInt(head.sequence), result: next.result });
      if (cutoff === BigInt(head.sequence))
        selected = { aggregate, head, originals: new Map(originals) };
    }
    requireLedger(same(head, book.head), "recovery_head_mismatch");
    const replay: VerifiedReplay = Object.freeze({
      genesisDigest: book.genesisDigest,
      outcomeDigests,
      aggregate,
      head: Object.freeze({ ...head }),
      originals,
    });
    if (cutoff !== undefined) {
      requireLedger(selected, "ledger_cutoff_unavailable");
      return { ...selected, latestAggregate: aggregate, replay };
    }
    return { aggregate, head: replay.head, originals, latestAggregate: aggregate, replay };
  }

  private genesisHead(body: string): LedgerHead {
    return this.format === COMPACT_LEDGER_FORMAT
      ? compactGenesisHead(this.scope as CompleteBookScope, body)
      : genesisHead(this.scope, body);
  }

  provision(genesis: DurableBookAggregate): Promise<LedgerHead> {
    // Snapshot mutable caller-owned data before entering the asynchronous queue.
    const body = encodeDurableBook(genesis);
    const head = this.genesisHead(body);
    const proposed: StoredBook = {
      format: this.format,
      scope: this.scope,
      genesis: body,
      genesisDigest: payloadDigest(body, this.format),
      head,
      outcomes: [],
    };
    return this.serial(async () => {
      await this.storage.sync();
      const acknowledgeExisting = async (existing: StoredBook) => {
        const recovered = this.recover(existing);
        requireLedger(existing.genesis === body, "ledger_genesis_mismatch");
        await this.storage.validateRecovered?.(existing, recovered.latestAggregate);
        await this.storage.sync();
        this.replayCache = recovered.replay;
        return recovered.head;
      };
      const existing = this.storage.load(this.scope);
      if (existing) {
        return acknowledgeExisting(existing);
      }
      requireLedger(this.replayCache === undefined, "recovery_segment_gap_detected");
      const initial = this.recover(proposed);
      try {
        await this.storage.provision(proposed);
      } catch (error) {
        if (!(error instanceof LedgerError) || error.code !== "ledger_head_conflict") throw error;
        await this.storage.sync();
        const winner = this.storage.load(this.scope);
        if (!winner) throw error;
        return acknowledgeExisting(winner);
      }
      await this.storage.sync();
      await this.storage.validateRecovered?.(proposed, initial.latestAggregate);
      this.replayCache = initial.replay;
      return head;
    });
  }

  read(): Promise<LedgerSnapshot> {
    return this.readSnapshot();
  }

  /** Exact retained-outcome cutoff, including retained rejections. The bounded
   * prototype STILL verifies all retained history before serving an older snapshot;
   * this does not introduce lazy/unverified recovery or a scalable reconstruction. */
  readAt(outcomeSequence: bigint): Promise<LedgerSnapshot> {
    requireLedger(
      typeof outcomeSequence === "bigint" && outcomeSequence >= 0n,
      "ledger_cutoff_invalid",
    );
    return this.readSnapshot(outcomeSequence);
  }

  private readSnapshot(cutoff?: bigint): Promise<LedgerSnapshot> {
    return this.serial(async () => {
      // Resolve any uncertain prior write before allowing reads or new writes.
      await this.storage.sync();
      const stored = this.storage.load(this.scope);
      requireLedger(stored, "ledger_not_provisioned");
      const recovered = this.recover(stored, cutoff);
      await this.storage.validateRecovered?.(stored, recovered.latestAggregate);
      await this.storage.sync();
      this.replayCache = recovered.replay;
      return {
        aggregate: recovered.aggregate,
        head: recovered.head,
        scope: this.scope,
        format: this.format,
      };
    });
  }

  execute(command: BookCommand): Promise<LedgerReceipt> {
    command = snapshotCommand(command);
    requireLedger(command.bookId === this.scope.bookId, "ledger_identity_mismatch");
    // Every operation rereads all durable bytes before reusing verified replay.
    return this.serial(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await this.storage.sync();
        const stored = this.storage.load(this.scope);
        requireLedger(stored, "ledger_not_provisioned");
        const current = this.recover(stored);
        try {
          await this.storage.validateRecovered?.(stored, current.latestAggregate);
        } catch (error) {
          if (error instanceof LedgerError && error.code === "ledger_head_conflict") {
            this.replayCache = undefined;
            continue;
          }
          throw error;
        }
        const evaluated =
          this.format === COMPACT_LEDGER_FORMAT
            ? evaluateOutcomePayload(current.aggregate, command)
            : null;
        const next =
          evaluated?.transition ??
          executeBookCommand(current.aggregate.state, current.aggregate.protocol, command);
        if (
          next.protocol.retainedResults.length === current.aggregate.protocol.retainedResults.length
        ) {
          const original =
            next.result.disposition === "replayed" ? current.originals.get(command.id) : undefined;
          await this.storage.sync();
          this.replayCache = current.replay;
          return {
            head: current.head,
            result: next.result,
            outcomeSequence: original?.sequence ?? null,
            originalResult: original?.result ?? null,
          };
        }
        requireLedger(stored.outcomes.length < LEDGER_LIMITS.outcomes, "ledger_capacity_exceeded");
        const record = evaluated
          ? (() => {
              requireLedger(evaluated.encoded !== null, "ledger_outcome_invalid");
              return compactOutcomeRecord(
                this.scope as CompleteBookScope,
                current.head,
                next,
                evaluated.encoded,
              );
            })()
          : outcomeRecord(this.scope, current.head, next, next.result, command.id);
        // Capture candidate evidence before the adapter can yield. It becomes
        // reusable only after the complete atomic write and durability barrier.
        const originals = new Map(current.originals);
        originals.set(command.id, { sequence: BigInt(record.after.sequence), result: next.result });
        const candidate: VerifiedReplay = Object.freeze({
          genesisDigest: current.replay.genesisDigest,
          outcomeDigests: Object.freeze([
            ...current.replay.outcomeDigests,
            verifiedOutcomeRecordHash(record),
          ]),
          aggregate: Object.freeze({ state: next.state, protocol: next.protocol }),
          head: Object.freeze({ ...record.after }),
          originals,
        });
        try {
          await this.storage.commitTransition(current.head, record);
        } catch (error) {
          if (error instanceof LedgerError && error.code === "ledger_head_conflict") {
            this.replayCache = undefined;
            continue;
          }
          throw error;
        }
        await this.storage.sync();
        this.replayCache = candidate;
        return {
          head: record.after,
          result: next.result,
          outcomeSequence: BigInt(record.after.sequence),
          originalResult: next.result,
        };
      }
      throw new LedgerError("ledger_contention_exceeded");
    });
  }
}
