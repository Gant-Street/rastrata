import { counter, histogram, span, type SizeBucket } from "@rastrata/telemetry";
import { systemClock, type Clock } from "./clock.ts";
import { EntryError, sha256 } from "./entry.ts";
import type { BookKeys, ObjectStore } from "./objectstore.ts";
import { encodeSegment, verifySegment } from "./segment.ts";
import { SegmentConflictError, writeSegmentVerified } from "./segment-store.ts";
import type { LogTier, SealResult, TailEntry } from "./tier.ts";

export { SegmentConflictError };

/** What asked for a seal: the window after an entry that carries a write, the age limit of entries that
 * carry only a read's effects, the process stopping, a process finding a previous holder's entries
 * unsealed, or a caller asking. */
export type SealReason = "window" | "age" | "close" | "handover" | "manual";

export type SealOutcome =
  | { readonly status: "nothing" }
  | {
      readonly status: "sealed";
      readonly from: number;
      readonly to: number;
      readonly key: string;
      readonly bytes: number;
      readonly trimmed: number;
      /** The segment was already in the bulk store (an earlier attempt or another sealer wrote it). */
      readonly reused: boolean;
    }
  | { readonly status: "deferred"; readonly reason: string };

export interface SealerOptions {
  readonly tier: LogTier;
  readonly bulk: ObjectStore;
  readonly keys: BookKeys;
  readonly clock?: Clock;
  /** Tries per bulk-store operation before a seal is put off to the next round (default 4). */
  readonly attempts?: number;
  readonly backoffMs?: number;
  /** Most entries in one segment (default 5,000). */
  readonly maxEntries?: number;
}

/** Moves entries from the tail into the bulk store and then forgets them in the tail, in the only
 * order that cannot lose one: write the segment create-only, read it back and compare, record the
 * sealed-through sequence, and only then (the tier does it with the record) trim.
 *
 * Every step can be repeated, so a crash anywhere, a lost answer, a second sealer or an R2 outage is
 * the same thing: the next round finds the tail untrimmed, finds the segment already there or not,
 * and carries on. While the bulk store is down the tail simply grows and commits are unaffected. */
export class Sealer {
  readonly #tier: LogTier;
  readonly #bulk: ObjectStore;
  readonly #keys: BookKeys;
  readonly #clock: Clock;
  readonly #attempts: number;
  readonly #backoff: number;
  readonly #max: number;
  readonly stats = { segments: 0, reused: 0, deferred: 0, bytes: 0, trimmed: 0 };

  constructor(options: SealerOptions) {
    this.#tier = options.tier;
    this.#bulk = options.bulk;
    this.#keys = options.keys;
    this.#clock = options.clock ?? systemClock;
    this.#attempts = options.attempts ?? 4;
    this.#backoff = options.backoffMs ?? 100;
    this.#max = options.maxEntries ?? 5000;
  }

  /** One round. `sizeBucket` is only a label on the counter; `reason` is for the caller's own books. */
  sealOnce(
    options: {
      readonly reason?: SealReason;
      readonly sizeBucket?: Exclude<SizeBucket, "unknown">;
    } = {},
  ): Promise<SealOutcome> {
    const labels = { size_bucket: options.sizeBucket ?? "xs" } as const;
    return span("seal.run", { "book.id": this.#keys.bookId }, async (s) => {
      const outcome = await this.#round();
      s.setAttribute("outcome", outcome.status);
      if (outcome.status === "sealed") {
        s.setAttributes({ from_seq: outcome.from, to_seq: outcome.to, bytes: outcome.bytes });
        counter("seal.operations").add(1, { outcome: "ok", ...labels });
        histogram("seal.segment.bytes").record(outcome.bytes);
        histogram("seal.segment.entries").record(outcome.to - outcome.from + 1);
      } else if (outcome.status === "deferred") {
        counter("seal.operations").add(1, { outcome: "server_error", ...labels });
      }
      return outcome;
    });
  }

  async #round(): Promise<SealOutcome> {
    const book = this.#keys.bookId;
    let page: Awaited<ReturnType<LogTier["readFrom"]>>;
    try {
      const head = await this.#tier.head(book);
      if (head.seq <= head.sealedThrough) return { status: "nothing" };
      page = await this.#tier.readFrom(book, head.sealedThrough + 1, this.#max);
    } catch (error) {
      return this.#defer(`the tail could not be read: ${describe(error)}`);
    }
    const entries = page.entries;
    if (entries.length === 0) return { status: "nothing" };
    const first = entries[0] as TailEntry;
    if (first.seq !== page.head.sealedThrough + 1)
      // Someone sealed in the meantime; start again next round.
      return { status: "nothing" };
    const last = entries[entries.length - 1] as TailEntry;
    const bytes = encodeSegment(entries.map((entry) => entry.body));
    // The chain is checked before anything is written: a segment is only ever made of entries that
    // link to each other and to the anchor the tail holds.
    verifySegment(
      bytes,
      book,
      first.seq === 1 ? null : { seq: first.seq - 1, hash: page.head.sealedHash },
    );
    const key = this.#keys.sealed(first.seq, last.seq);

    let stored: { reused: boolean } | null;
    try {
      stored = await writeSegmentVerified(
        {
          bulk: this.#bulk,
          clock: this.#clock,
          attempts: this.#attempts,
          backoffMs: this.#backoff,
          metadata: { from: String(first.seq), to: String(last.seq), last: last.hash },
        },
        key,
        bytes,
      );
    } catch (error) {
      if (error instanceof SegmentConflictError) throw error;
      return this.#defer(`the segment could not be written: ${describe(error)}`);
    }
    if (!stored) return this.#defer("the bulk store did not confirm the segment");

    let sealed: SealResult;
    try {
      sealed = await this.#recordSeal(last.seq, {
        from: first.seq,
        to: last.seq,
        key,
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
        lastHash: last.hash,
      });
    } catch (error) {
      return this.#defer(`the seal could not be recorded: ${describe(error)}`);
    }
    if (!sealed.ok) throw new EntryError("sequence", "The tail has fewer entries than were sealed");
    // How long the oldest of these entries waited in the tail, by the tail's own clock.
    histogram("seal.lag").record(Math.max(0, page.head.now - first.writtenAt) / 1000);
    this.stats.segments += 1;
    if (stored.reused) this.stats.reused += 1;
    this.stats.bytes += bytes.byteLength;
    this.stats.trimmed += sealed.trimmed;
    return {
      status: "sealed",
      from: first.seq,
      to: last.seq,
      key,
      bytes: bytes.byteLength,
      trimmed: sealed.trimmed,
      reused: stored.reused,
    };
  }

  #defer(reason: string): SealOutcome {
    this.stats.deferred += 1;
    return { status: "deferred", reason };
  }

  async #recordSeal(
    upTo: number,
    manifest: Parameters<LogTier["seal"]>[1]["manifest"],
  ): Promise<SealResult> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#attempts; attempt += 1) {
      try {
        return await this.#tier.seal(this.#keys.bookId, { upTo, manifest });
      } catch (error) {
        lastError = error;
        if (attempt < this.#attempts) await this.#clock.sleep(this.#backoff * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
