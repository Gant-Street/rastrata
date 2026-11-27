import { createHash } from "node:crypto";
import type { Clock } from "./clock.ts";
import {
  MAX_LIST,
  ObjectStoreError,
  type ListedObject,
  type ListPage,
  type ObjectMeta,
  type ObjectStore,
  type PutOptions,
  type PutResult,
  type StoredObject,
} from "./objectstore.ts";
import {
  FAULT_KINDS,
  Wire,
  type FaultKind,
  type FaultRates,
  type LatencyModel,
  type ScriptedFault as WireScriptedFault,
} from "./wire.ts";

export { FAULT_KINDS };
export type { FaultKind, FaultRates, LatencyModel };

export type StoreOp = "put" | "get" | "head" | "list" | "delete";
export const STORE_OPS: readonly StoreOp[] = ["put", "get", "head", "list", "delete"];
export type ScriptedFault = WireScriptedFault<StoreOp>;

export interface MemoryStoreOptions {
  /** Root of every random stream: the same seed and the same calls give the same faults. */
  readonly seed?: number;
  readonly clock?: Clock;
  readonly latency?: LatencyModel | { readonly [op in StoreOp]?: LatencyModel };
  readonly faults?: FaultRates | { readonly [op in StoreOp]?: FaultRates };
  /** How long a freshly written object stays invisible to get, head and list (the write path is
   * always strongly consistent): a store with weaker reads than S3 and R2 have. */
  readonly visibilityDelayMs?: number | { readonly min: number; readonly max: number };
  /** What a lost response costs the client before it gives up. */
  readonly timeoutMs?: number;
}

export interface StoreStats {
  readonly ops: Record<StoreOp, number>;
  readonly classA: number;
  readonly classB: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly conflicts: number;
  readonly faults: Record<FaultKind, number>;
}

interface Held {
  readonly body: Uint8Array;
  readonly metadata: Readonly<Record<string, string>>;
  readonly visibleAt: number;
  etag?: string;
}

/** An in-memory bucket with the semantics the protocol depends on (create-only writes are atomic,
 * listings are ordered, reads are consistent unless told otherwise) and the seeded faults of a
 * {@link Wire}. Every call goes through a client, so a simulation can kill one process and leave
 * the others running. The store itself is the client "default". */
export class MemoryObjectStore implements ObjectStore {
  readonly wire: Wire<StoreOp>;
  readonly clock: Clock;
  readonly #objects = new Map<string, Held>();
  #keys: string[] = [];
  #visibility: MemoryStoreOptions["visibilityDelayMs"];
  readonly #views = new Map<string, ObjectStore>();
  #bytesIn = 0;
  #bytesOut = 0;
  #conflicts = 0;

  constructor(options: MemoryStoreOptions = {}) {
    this.wire = new Wire<StoreOp>(STORE_OPS, {
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.latency ? { latency: options.latency } : {}),
      ...(options.faults ? { faults: options.faults } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    this.clock = this.wire.clock;
    this.#visibility = options.visibilityDelayMs;
  }

  /** Change the model in the middle of a run (a simulation checks its result with faults off). */
  configure(
    options: Pick<MemoryStoreOptions, "latency" | "faults" | "visibilityDelayMs" | "timeoutMs">,
  ): void {
    this.wire.configure({
      ...("latency" in options ? { latency: options.latency } : {}),
      ...("faults" in options ? { faults: options.faults } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    if ("visibilityDelayMs" in options) this.#visibility = options.visibilityDelayMs;
  }

  /** Calls made through this view belong to `id`; killing the id freezes them for good. */
  client(id: string): ObjectStore {
    let view = this.#views.get(id);
    if (!view) {
      view = {
        putIfAbsent: (key, body, options) => this.#put(id, key, body, options),
        get: (key) => this.#get(id, key),
        head: (key) => this.#head(id, key),
        list: (prefix, after, limit) => this.#list(id, prefix, after, limit),
        delete: (key) => this.#delete(id, key),
      };
      this.#views.set(id, view);
    }
    return view;
  }

  kill(client: string): void {
    this.wire.kill(client);
  }
  isDead(client: string): boolean {
    return this.wire.isDead(client);
  }
  onKill(listener: (client: string) => void): void {
    this.wire.onKill(listener);
  }
  script(rules: readonly ScriptedFault[]): void {
    this.wire.script(rules);
  }

  putIfAbsent(key: string, body: Uint8Array, options?: PutOptions): Promise<PutResult> {
    return this.#put("default", key, body, options);
  }
  get(key: string): Promise<StoredObject | null> {
    return this.#get("default", key);
  }
  head(key: string): Promise<ObjectMeta | null> {
    return this.#head("default", key);
  }
  list(prefix: string, after?: string, limit?: number): Promise<ListPage> {
    return this.#list("default", prefix, after, limit);
  }
  delete(key: string): Promise<void> {
    return this.#delete("default", key);
  }

  // ---- the god's-eye view, for tests: no latency, no faults, no visibility delay -------------

  peek(key: string): StoredObject | null {
    const held = this.#objects.get(key);
    return held ? this.#stored(key, held) : null;
  }
  keys(prefix = ""): string[] {
    return this.#keys.filter((key) => key.startsWith(prefix));
  }
  get size(): number {
    return this.#objects.size;
  }
  /** Write without the create-only check or any fault (to plant corruption in a test). */
  plant(key: string, body: Uint8Array, metadata: Record<string, string> = {}): void {
    this.#store(key, body, metadata, 0);
  }
  /** Remove without any fault (a test that loses an object). */
  remove(key: string): void {
    if (this.#objects.delete(key)) this.#keys.splice(this.#lowerBound(key), 1);
  }
  clear(): void {
    this.#objects.clear();
    this.#keys = [];
  }

  get stats(): StoreStats {
    const { put = 0, get = 0, head = 0, list = 0, delete: del = 0 } = this.wire.calls;
    return {
      ops: { put, get, head, list, delete: del },
      classA: put + list,
      classB: get + head,
      bytesIn: this.#bytesIn,
      bytesOut: this.#bytesOut,
      conflicts: this.#conflicts,
      faults: { ...this.wire.faultsSeen },
    };
  }
  resetStats(): void {
    this.wire.resetCounts();
    this.#bytesIn = 0;
    this.#bytesOut = 0;
    this.#conflicts = 0;
  }

  // ---- operations ----------------------------------------------------------------------------

  #put(
    client: string,
    key: string,
    body: Uint8Array,
    options: PutOptions | undefined,
  ): Promise<PutResult> {
    const copy = body.slice();
    const metadata = lowerCase(options?.metadata);
    return this.wire.call(client, "put", key, () => {
      this.#bytesIn += copy.byteLength;
      if (this.#objects.has(key)) {
        this.#conflicts += 1;
        return { created: false } as const;
      }
      const held = this.#store(key, copy, metadata, this.#visibleAt());
      return { created: true, etag: this.#etag(held) } as const;
    });
  }

  #get(client: string, key: string): Promise<StoredObject | null> {
    return this.wire.call(client, "get", key, () => {
      const held = this.#visible(key);
      if (!held) return null;
      this.#bytesOut += held.body.byteLength;
      return this.#stored(key, held);
    });
  }

  #head(client: string, key: string): Promise<ObjectMeta | null> {
    return this.wire.call(client, "head", key, () => {
      const held = this.#visible(key);
      if (!held) return null;
      const { body: _body, ...meta } = this.#stored(key, held);
      return meta;
    });
  }

  #list(
    client: string,
    prefix: string,
    after: string | undefined,
    limit: number | undefined,
  ): Promise<ListPage> {
    const bound = Math.min(Math.max(1, limit ?? MAX_LIST), MAX_LIST);
    return this.wire.call(client, "list", prefix, () => {
      const objects: ListedObject[] = [];
      let truncated = false;
      let index = this.#lowerBound(
        after !== undefined && after >= prefix ? `${after}\u0000` : prefix,
      );
      for (; index < this.#keys.length; index += 1) {
        const key = this.#keys[index] as string;
        if (!key.startsWith(prefix)) break;
        const held = this.#visible(key);
        if (!held) continue;
        if (objects.length === bound) {
          truncated = true;
          break;
        }
        objects.push({ key, size: held.body.byteLength, etag: this.#etag(held) });
      }
      return { objects, truncated };
    });
  }

  #delete(client: string, key: string): Promise<void> {
    return this.wire.call(client, "delete", key, () => {
      this.remove(key);
    });
  }

  // ---- the data ---------------------------------------------------------------------------------

  #visibleAt(): number {
    const delay = this.#visibility;
    if (delay === undefined) return 0;
    const ms =
      typeof delay === "number"
        ? delay
        : delay.min + this.wire.stream("visibility").next() * (delay.max - delay.min);
    return ms > 0 ? this.clock.now() + ms : 0;
  }

  #visible(key: string): Held | undefined {
    const held = this.#objects.get(key);
    return held && held.visibleAt <= this.clock.now() ? held : undefined;
  }

  #store(key: string, body: Uint8Array, metadata: Record<string, string>, visibleAt: number): Held {
    if (key.length === 0 || new TextEncoder().encode(key).length > 1024)
      throw new ObjectStoreError("The key must be 1 to 1,024 bytes", 400, "KeyTooLong");
    const held: Held = { body, metadata, visibleAt };
    if (!this.#objects.has(key)) this.#keys.splice(this.#lowerBound(key), 0, key);
    this.#objects.set(key, held);
    return held;
  }

  #stored(key: string, held: Held): StoredObject {
    return {
      key,
      body: held.body,
      size: held.body.byteLength,
      etag: this.#etag(held),
      metadata: held.metadata,
    };
  }

  #etag(held: Held): string {
    held.etag ??= `"${createHash("md5").update(held.body).digest("hex")}"`;
    return held.etag;
  }

  /** The index of the first key not less than `target`. */
  #lowerBound(target: string): number {
    let low = 0;
    let high = this.#keys.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.#keys[middle] as string) < target) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}

function lowerCase(metadata: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(metadata ?? {})) result[name.toLowerCase()] = value;
  return result;
}
