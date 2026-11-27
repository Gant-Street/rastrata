import { createHash } from "node:crypto";
import { ApplicationError } from "../../src/errors.ts";
import type {
  BalanceCheckResult,
  BankLine,
  IngestBatch,
  IngestLine,
  IngestPort,
  IngestReport,
  LineDisposition,
  RawRef,
} from "../../src/ingest-types.ts";
import { addMoney, subtractMoney } from "../../src/money.ts";

interface Archived {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly name?: string;
}

/** A small stand-in for the ingest lane's pipeline, faithful where the statements lane depends on
 * it: a content-addressed archive; identity by provider id; overlap by counting identical lines
 * per source; the cutover date and catch-up as recorded exclusions; an atomic, idempotent submit;
 * and a source that stays mapped to one chart account. The real pipeline replaces it in the
 * application's own wiring; the statements lane only relies on the `IngestPort` contract. */
export class FakeIngest implements IngestPort {
  readonly blobs = new Map<string, Archived>();
  readonly submitted: { batchId: string; batch: IngestBatch }[] = [];
  /** Ledger balances by chart account, for the balance check. */
  readonly ledgerBalances = new Map<string, string>();
  archiveCalls = 0;
  previewCalls = 0;
  submitCalls = 0;
  /** Make the next submit throw this, once, to rehearse a crash. */
  failNextSubmit: Error | null = null;
  private readonly seenIds = new Set<string>();
  private readonly seenCounts = new Map<string, number>();
  private readonly sources = new Map<string, string>();
  private readonly starts = new Map<string, string>();
  private readonly idempotent = new Map<string, IngestReport & { readonly batchId: string }>();

  archive(bytes: Uint8Array, mediaType: string, name?: string): RawRef {
    this.archiveCalls++;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (!this.blobs.has(sha256))
      this.blobs.set(sha256, {
        bytes: new Uint8Array(bytes),
        mediaType,
        ...(name !== undefined ? { name } : {}),
      });
    const stored = this.blobs.get(sha256) as Archived;
    return {
      sha256,
      size: bytes.byteLength,
      mediaType: stored.mediaType,
      ...(stored.name !== undefined ? { name: stored.name } : {}),
    };
  }

  readArchive(sha256: string): Archived | null {
    return this.blobs.get(sha256) ?? null;
  }

  private lineKey(line: IngestLine): string {
    return line.kind === "bankLine"
      ? `${line.accountKey}|${line.postedOn}|${line.amount}|${line.description}`
      : `${line.accountKey}|${line.providerId}`;
  }

  private analyse(batch: IngestBatch): {
    report: IngestReport;
    fresh: IngestLine[];
  } {
    const mapped = this.sources.get(batch.sourceKey);
    if (batch.ledgerAccountId && mapped !== undefined && mapped !== batch.ledgerAccountId)
      throw new ApplicationError(
        "source_account_conflict",
        `${batch.sourceKey} is already mapped to account ${mapped}, not ${batch.ledgerAccountId}`,
        409,
      );
    const start = this.starts.get(batch.sourceKey);
    if (batch.startOn && start !== undefined && start !== batch.startOn)
      throw new ApplicationError(
        "source_start_conflict",
        `${batch.sourceKey} already starts on ${start}`,
        409,
      );
    const within = new Map<string, number>();
    const dispositions: LineDisposition[] = [];
    const fresh: IngestLine[] = [];
    const cutover = batch.startOn ?? start;
    for (const line of batch.lines) {
      const key = this.lineKey(line);
      const earlier =
        line.providerId !== undefined
          ? this.seenIds.has(`${line.provider}|${line.accountKey}|${line.providerId}`)
          : (this.seenCounts.get(key) ?? 0) >= (within.get(key) ?? 0) + 1;
      within.set(key, (within.get(key) ?? 0) + 1);
      if (earlier) {
        dispositions.push({
          rawIndex: line.rawIndex,
          status: line.providerId !== undefined ? "duplicate" : "overlap",
          reason: "Already imported",
        });
        continue;
      }
      fresh.push(line);
      if (batch.catchUp || (cutover && line.kind === "bankLine" && line.postedOn < cutover))
        dispositions.push({
          rawIndex: line.rawIndex,
          status: "excluded",
          reason: batch.catchUp ? "caught up" : "before the cutover date",
        });
      else dispositions.push({ rawIndex: line.rawIndex, status: "new" });
    }
    const count = (status: LineDisposition["status"]) =>
      dispositions.filter((item) => item.status === status).length;
    return {
      fresh,
      report: {
        dispositions,
        newCount: count("new"),
        duplicateCount: count("duplicate"),
        overlapCount: count("overlap"),
        invalidCount: count("invalid"),
        excludedCount: count("excluded"),
      },
    };
  }

  preview(batch: IngestBatch): IngestReport {
    this.previewCalls++;
    return this.analyse(batch).report;
  }

  submit(batch: IngestBatch): IngestReport & { readonly batchId: string } {
    this.submitCalls++;
    if (this.failNextSubmit) {
      const failure = this.failNextSubmit;
      this.failNextSubmit = null;
      throw failure;
    }
    const identity = createHash("sha256").update(JSON.stringify(batch)).digest("hex");
    const repeated = this.idempotent.get(identity);
    if (repeated) return repeated;
    const { report, fresh } = this.analyse(batch);
    const batchId = `batch-${this.submitted.length + 1}`;
    if (batch.ledgerAccountId) this.sources.set(batch.sourceKey, batch.ledgerAccountId);
    if (batch.startOn) this.starts.set(batch.sourceKey, batch.startOn);
    for (const line of fresh) {
      if (line.providerId !== undefined)
        this.seenIds.add(`${line.provider}|${line.accountKey}|${line.providerId}`);
      else {
        const key = this.lineKey(line);
        this.seenCounts.set(key, (this.seenCounts.get(key) ?? 0) + 1);
      }
    }
    this.submitted.push({ batchId, batch });
    const result = { ...report, batchId };
    this.idempotent.set(identity, result);
    return result;
  }

  async checkBalances(batch: IngestBatch): Promise<readonly BalanceCheckResult[]> {
    const { fresh } = this.analyse(batch);
    const account = batch.ledgerAccountId ?? this.sources.get(batch.sourceKey) ?? null;
    return batch.balances.map((check) => {
      if (account === null)
        return {
          accountKey: check.accountKey,
          asOf: check.asOf,
          reported: check.balance,
          ledger: null,
          waiting: null,
          excluded: null,
          difference: null,
        };
      const ledger = this.ledgerBalances.get(account) ?? "0.00";
      let waiting = "0.00";
      for (const line of fresh)
        if (line.kind === "bankLine" && line.postedOn <= check.asOf)
          waiting = addMoney(waiting, line.amount);
      return {
        accountKey: check.accountKey,
        asOf: check.asOf,
        reported: check.balance,
        ledger,
        waiting,
        excluded: "0.00",
        difference: subtractMoney(check.balance, addMoney(ledger, waiting)),
      };
    });
  }

  /** The lines this fake has accepted, in the order they arrived. */
  acceptedLines(): BankLine[] {
    return this.submitted.flatMap(({ batch }) =>
      batch.lines.filter((line): line is BankLine => line.kind === "bankLine"),
    );
  }
}
