import { createHash } from "node:crypto";
import type {
  IngestBatch,
  IngestLine,
  IngestPort,
  IngestReport,
  LineDisposition,
  RawRef,
} from "../../src/ingest-types.ts";

/** A stand-in for the ingestion pipeline's `IngestPort`, faithful to what the contract says and to
 * what the ingest lane has told the Stripe lane: identity is (provider, accountKey, providerId); a
 * repeat is a duplicate, also in a later overlapping batch; the same identity with different date,
 * amount, currency or legs is `invalid` and never overwrites; the rest of the batch still applies;
 * the batch's cursor is stored with the batch. Used until the real port lands, and kept afterwards
 * as a fast fixture for the connector's own tests. */

interface Held {
  readonly line: IngestLine;
  readonly batch: string;
}

export interface FakePort extends IngestPort {
  readonly items: Map<string, Held>;
  readonly archived: Map<string, { bytes: Uint8Array; mediaType: string; name?: string }>;
  readonly submissions: { batch: IngestBatch; report: IngestReport }[];
  /** The cursor stored with the most recent applied batch that had one. */
  cursor: string | null;
  /** Make the next `submit` throw, as a crash before commit would. */
  failNextSubmit(error?: Error): void;
}

const identity = (line: IngestLine): string | null =>
  line.providerId === undefined ? null : `${line.provider}|${line.accountKey}|${line.providerId}`;

const content = (line: IngestLine): string =>
  JSON.stringify(
    line.kind === "event"
      ? {
          on: line.eventOn,
          currency: line.currency,
          legs: line.legs.map((l) => [l.role, l.amount]),
        }
      : { on: line.postedOn, currency: line.currency, amount: line.amount },
  );

export function fakePort(): FakePort {
  const items = new Map<string, Held>();
  const archived = new Map<string, { bytes: Uint8Array; mediaType: string; name?: string }>();
  const submissions: { batch: IngestBatch; report: IngestReport }[] = [];
  let failure: Error | null = null;

  const analyse = (batch: IngestBatch, write: boolean): IngestReport => {
    const dispositions: LineDisposition[] = [];
    const seenInBatch = new Set<string>();
    let newCount = 0;
    let duplicateCount = 0;
    let invalidCount = 0;
    for (const line of batch.lines) {
      const key = identity(line);
      if (key === null) {
        dispositions.push({ rawIndex: line.rawIndex, status: "invalid", reason: "no identifier" });
        invalidCount++;
        continue;
      }
      const existing = items.get(key);
      if (existing || seenInBatch.has(key)) {
        if (existing && content(existing.line) !== content(line)) {
          dispositions.push({
            rawIndex: line.rawIndex,
            status: "invalid",
            reason: "This identifier was already imported with different figures.",
          });
          invalidCount++;
        } else {
          // A repeat that names the payout covering it adds the link and nothing else.
          const incoming = (line as { coveredBy?: string }).coveredBy;
          if (write && existing && incoming && !(existing.line as { coveredBy?: string }).coveredBy)
            items.set(key, {
              ...existing,
              line: { ...existing.line, coveredBy: incoming } as IngestLine,
            });
          dispositions.push({ rawIndex: line.rawIndex, status: "duplicate" });
          duplicateCount++;
        }
        continue;
      }
      seenInBatch.add(key);
      dispositions.push({
        rawIndex: line.rawIndex,
        status: "new",
        itemId: `item-${items.size + newCount + 1}`,
      });
      newCount++;
      if (write) items.set(key, { line, batch: batch.raw.sha256 });
    }
    return { dispositions, newCount, duplicateCount, overlapCount: 0, invalidCount };
  };

  const port: FakePort = {
    items,
    archived,
    submissions,
    cursor: null,
    failNextSubmit(error = new Error("The database stopped before the batch was applied")) {
      failure = error;
    },
    archive(bytes, mediaType, name): RawRef {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (!archived.has(sha256))
        archived.set(sha256, {
          bytes: new Uint8Array(bytes),
          mediaType,
          ...(name ? { name } : {}),
        });
      return { sha256, size: bytes.byteLength, mediaType, ...(name ? { name } : {}) };
    },
    readArchive(sha256) {
      return archived.get(sha256) ?? null;
    },
    preview(batch) {
      return analyse(batch, false);
    },
    submit(batch) {
      if (failure) {
        const error = failure;
        failure = null;
        throw error;
      }
      const report = analyse(batch, true);
      submissions.push({ batch, report });
      if (batch.cursor !== undefined) port.cursor = batch.cursor;
      return { ...report, batchId: `batch-${submissions.length}` };
    },
    async checkBalances() {
      return [];
    },
  };
  return port;
}
