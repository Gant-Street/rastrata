import { systemClock, type Clock } from "./clock.ts";
import { BookKeys, MAX_LIST, type ObjectStore } from "./objectstore.ts";
import {
  GENESIS_HASH,
  type AcquireResult,
  type AppendInput,
  type AppendResult,
  type LogTier,
  type RenewResult,
  type SealManifest,
  type SealResult,
  type TailEntry,
  type TierCapabilities,
  type TierHead,
  type TierPage,
} from "./tier.ts";

/** The degenerate tail: every entry is a create-only object, `log/<seq>`, in the bulk store itself.
 * The create-only write is the commit point (exactly one writer wins a sequence number), but there
 * is no lease, so a reader can never know its cache is current without asking: `head()` is a HEAD
 * of the next key, and a commit costs a write to the object store, which is the slow path this tail
 * exists to measure against. The entry's hash, previous hash and fence travel as object metadata so
 * the head can be learned without downloading a body. */
export class ObjectStoreLogTier implements LogTier {
  readonly capabilities: TierCapabilities = { name: "object-store", leases: false };
  readonly #store: ObjectStore;
  readonly #prefix: string;
  readonly #clock: Clock;
  readonly #known = new Map<string, { seq: number; hash: string }>();

  constructor(
    store: ObjectStore,
    options: { readonly prefix?: string; readonly clock?: Clock } = {},
  ) {
    this.#store = store;
    this.#prefix = options.prefix ?? "";
    this.#clock = options.clock ?? systemClock;
  }

  #keys(book: string): BookKeys {
    return new BookKeys(this.#prefix, book);
  }

  #headOf(book: string): TierHead {
    const known = this.#known.get(book) ?? { seq: 0, hash: GENESIS_HASH };
    return {
      seq: known.seq,
      hash: known.hash,
      sealedThrough: 0,
      sealedHash: GENESIS_HASH,
      fence: 0,
      leaseHolder: null,
      leaseExpiresAt: null,
      now: this.#clock.now(),
    };
  }

  /** Walk forward from what is known to the newest entry and remember it. */
  async #refresh(book: string): Promise<void> {
    const keys = this.#keys(book);
    const known = this.#known.get(book) ?? { seq: 0, hash: GENESIS_HASH };
    // The common case, a book nobody else has written: one HEAD of the next key says so.
    if (known.seq > 0 && (await this.#store.head(keys.log(known.seq + 1))) === null) return;
    let last = known.seq;
    let after = known.seq > 0 ? keys.log(known.seq) : undefined;
    for (;;) {
      const page = await this.#store.list(keys.logPrefix, after, MAX_LIST);
      for (const item of page.objects) {
        const seq = keys.seqOfLog(item.key);
        if (seq !== null && seq > last) last = seq;
      }
      if (!page.truncated) break;
      after = page.objects[page.objects.length - 1]?.key;
    }
    if (last === known.seq) return;
    const newest = await this.#store.head(keys.log(last));
    if (!newest) return;
    this.#known.set(book, { seq: last, hash: newest.metadata.hash ?? GENESIS_HASH });
  }

  async head(book: string): Promise<TierHead> {
    await this.#refresh(book);
    return this.#headOf(book);
  }

  async readFrom(book: string, seq: number, limit?: number): Promise<TierPage> {
    const keys = this.#keys(book);
    const bound = Math.max(1, limit ?? Number.MAX_SAFE_INTEGER);
    const entries: TailEntry[] = [];
    let after = seq > 1 ? keys.log(seq - 1) : undefined;
    for (;;) {
      const page = await this.#store.list(
        keys.logPrefix,
        after,
        Math.min(MAX_LIST, bound - entries.length),
      );
      const wanted = page.objects.slice(0, bound - entries.length);
      // A few at a time: the bulk store answers in parallel, and a long tail should not take
      // one round trip per entry.
      for (let index = 0; index < wanted.length; index += 8) {
        const batch = await Promise.all(
          wanted.slice(index, index + 8).map(async (item) => {
            const object = await this.#store.get(item.key);
            if (!object) throw new Error(`The entry ${item.key} was listed and then not found`);
            const number = keys.seqOfLog(item.key) as number;
            return {
              seq: number,
              prevHash: object.metadata.prev ?? "",
              hash: object.metadata.hash ?? "",
              fence: Number(object.metadata.fence ?? "0"),
              body: object.body,
              writtenAt: Number(object.metadata.at ?? "0"),
            } satisfies TailEntry;
          }),
        );
        entries.push(...batch);
      }
      if (!page.truncated || entries.length >= bound) break;
      after = page.objects[page.objects.length - 1]?.key;
    }
    await this.#refresh(book);
    return { entries, head: this.#headOf(book) };
  }

  async append(book: string, input: AppendInput): Promise<AppendResult> {
    const keys = this.#keys(book);
    // A create-only object cannot say "the next one" by itself, so the writer's view is checked
    // first: it must be the very next sequence, chained to the head this tier last saw. Asking the
    // store (one HEAD) is only needed when the view is not already the next sequence.
    let known = this.#known.get(book) ?? { seq: 0, hash: GENESIS_HASH };
    if (input.seq !== known.seq + 1) {
      await this.#refresh(book);
      known = this.#known.get(book) ?? { seq: 0, hash: GENESIS_HASH };
      if (input.seq === known.seq && input.hash === known.hash)
        return { ok: true, duplicate: true, head: this.#headOf(book) };
      if (input.seq !== known.seq + 1)
        return { ok: false, reason: "seq", head: this.#headOf(book) };
    }
    if (input.prevHash !== known.hash)
      return { ok: false, reason: "prev", head: this.#headOf(book) };
    const result = await this.#store.putIfAbsent(keys.log(input.seq), input.body, {
      metadata: {
        hash: input.hash,
        prev: input.prevHash,
        fence: String(input.fence),
        at: String(this.#clock.now()),
      },
    });
    if (result.created) {
      const known = this.#known.get(book);
      if (!known || known.seq < input.seq)
        this.#known.set(book, { seq: input.seq, hash: input.hash });
      return { ok: true, duplicate: false, head: this.#headOf(book) };
    }
    // Someone created this sequence. If it is this very entry, an earlier attempt landed.
    const existing = await this.#store.head(keys.log(input.seq));
    await this.#refresh(book);
    if (existing && existing.metadata.hash === input.hash)
      return { ok: true, duplicate: true, head: this.#headOf(book) };
    return { ok: false, reason: "seq", head: this.#headOf(book) };
  }

  async acquire(book: string, holder: string, ttlMs: number): Promise<AcquireResult> {
    await this.#refresh(book);
    const head = this.#headOf(book);
    return {
      ok: true,
      lease: { holder, fence: 0, ttlMs, expiresAt: head.now, head },
    };
  }

  async renew(
    book: string,
    lease: { readonly holder: string; readonly fence: number },
    ttlMs: number,
  ): Promise<RenewResult> {
    const head = this.#headOf(book);
    return {
      ok: true,
      lease: { holder: lease.holder, fence: 0, ttlMs, expiresAt: head.now, head },
    };
  }

  async release(): Promise<void> {}

  /** Nothing to trim: the entries already are the bulk store's objects. */
  async seal(
    book: string,
    input: { readonly upTo: number; readonly manifest: SealManifest },
  ): Promise<SealResult> {
    await this.#refresh(book);
    const head = this.#headOf(book);
    if (input.upTo > head.seq) return { ok: false, reason: "ahead", head };
    return { ok: true, trimmed: 0, head };
  }
}
