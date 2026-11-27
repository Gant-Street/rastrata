import { createHash } from "node:crypto";
import { decodeBookOutcome } from "@rastrata/kernel";
import { completeScope } from "./compact-records.ts";
import { requireLedger, type CompleteBookScope } from "./records.ts";
import {
  NATIVE_LEDGER_FORMAT,
  type NativeLedgerReader,
  type NativeLedgerHead,
} from "./native-ledger-repository.ts";
import type {
  R2ArchiveObjectStore,
  ArchivePayloadReference,
  ArchiveControlVersion,
} from "./r2-archive-store.ts";

const FORMAT = "rastrata-native-outbox-v1";
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Overlap independent immutable payload I/O, never authority/control writes.
 * Four jobs keep the existing one-MiB/sixteen-outcome bound and leave connection
 * headroom. Settle the whole active group on failure before returning to its
 * alarm/restore owner; no detached writes or partially verified batch escapes. */
async function payloadsInOrder<T, R>(
  items: readonly T[],
  process: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += 4) {
    const group = await Promise.allSettled(items.slice(start, start + 4).map(process));
    const failure = group.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    for (const result of group) if (result.status === "fulfilled") results.push(result.value);
  }
  return results;
}
export interface NativeArchiveEntry {
  readonly head: NativeLedgerHead;
  readonly previousHash: string;
  readonly payload: ArchivePayloadReference;
}
export interface NativeArchiveBatch {
  readonly format: typeof FORMAT;
  readonly genesis: ArchivePayloadReference;
  readonly initial: NativeLedgerHead;
  readonly from: NativeLedgerHead;
  readonly through: NativeLedgerHead;
  readonly previous: ArchivePayloadReference | null;
  readonly entries: readonly NativeArchiveEntry[];
}
interface Control {
  readonly format: typeof FORMAT;
  readonly fence: string;
  readonly status: "active" | "sealed";
  readonly manifest: ArchivePayloadReference;
  readonly through: NativeLedgerHead;
}
export interface NativeArchiveSeal {
  readonly scope: CompleteBookScope;
  readonly genesisHash: string;
  readonly head: NativeLedgerHead;
  readonly fence: string;
  readonly control: ArchiveControlVersion;
}
export interface NativeArchiveProgress {
  readonly status: "caughtUp" | "pending";
  readonly writerFence: string;
  readonly archivedSequence: string;
  readonly observedSequence: string;
  readonly pendingOutcomes: string;
}
function fields(value: unknown, keys: string): Record<string, unknown> {
  requireLedger(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === keys,
    "native_archive_invalid",
  );
  const descriptors = Object.getOwnPropertyDescriptors(value),
    result: Record<string, unknown> = {};
  requireLedger(
    Reflect.ownKeys(descriptors).length === keys.split(",").length,
    "native_archive_invalid",
  );
  for (const key of keys.split(",")) {
    const descriptor = descriptors[key];
    requireLedger(
      descriptor && "value" in descriptor && descriptor.enumerable,
      "native_archive_invalid",
    );
    result[key] = descriptor.value;
  }
  return result;
}
function digest(value: unknown): string {
  requireLedger(
    typeof value === "string" && /^[0-9a-f]{64}$/.test(value),
    "native_archive_invalid",
  );
  return value;
}
function head(value: unknown): NativeLedgerHead {
  const row = fields(value, "bookRevision,chainHash,sequence");
  for (const key of ["sequence", "bookRevision"])
    requireLedger(
      typeof row[key] === "string" && /^(0|[1-9][0-9]{0,18})$/.test(row[key]),
      "native_archive_invalid",
    );
  const sequence = row.sequence as string,
    bookRevision = row.bookRevision as string;
  requireLedger(
    BigInt(sequence) <= (1n << 63n) - 1n && BigInt(bookRevision) <= BigInt(sequence),
    "native_archive_invalid",
  );
  return Object.freeze({ sequence, bookRevision, chainHash: digest(row.chainHash) });
}
function reference(value: unknown): ArchivePayloadReference {
  const row = fields(value, "objectKey,payloadBytes,payloadHash");
  requireLedger(
    typeof row.objectKey === "string" &&
      row.objectKey.length <= 1024 &&
      typeof row.payloadBytes === "number" &&
      Number.isSafeInteger(row.payloadBytes) &&
      row.payloadBytes >= 0 &&
      row.payloadBytes <= 1048576,
    "native_archive_invalid",
  );
  return Object.freeze({
    objectKey: row.objectKey,
    payloadHash: digest(row.payloadHash),
    payloadBytes: row.payloadBytes,
  });
}
function control(version: ArchiveControlVersion): Control {
  const row = fields(JSON.parse(version.body), "fence,format,manifest,status,through");
  requireLedger(
    row.format === FORMAT &&
      typeof row.fence === "string" &&
      /^(0|[1-9][0-9]{0,63})$/.test(row.fence) &&
      (row.status === "active" || row.status === "sealed"),
    "native_archive_invalid",
  );
  return Object.freeze({
    format: FORMAT,
    fence: row.fence,
    status: row.status,
    manifest: reference(row.manifest),
    through: head(row.through),
  });
}

/** Closed framing only. Provenance requires observing the configured R2 store;
 * a decoded seal is not current catalog authority or complete history replay. */
export function normalizeNativeArchiveSeal(
  value: unknown,
  expectedScope: CompleteBookScope,
): NativeArchiveSeal {
  const row = fields(value, "control,fence,genesisHash,head,scope");
  const scope = completeScope(row.scope as CompleteBookScope, expectedScope.objectId);
  requireLedger(
    same(scope, completeScope(expectedScope, expectedScope.objectId)),
    "native_archive_invalid",
  );
  const version = fields(row.control, "body,nonce,storageRevision");
  requireLedger(
    typeof version.body === "string" &&
      encoder.encode(version.body).length <= 16384 &&
      typeof version.storageRevision === "string" &&
      version.storageRevision.length > 0 &&
      version.storageRevision.length <= 1024 &&
      typeof version.nonce === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(version.nonce),
    "native_archive_invalid",
  );
  const stored = Object.freeze({
    body: version.body,
    nonce: version.nonce,
    storageRevision: version.storageRevision,
  });
  const selected = control(stored),
    stopped = head(row.head);
  requireLedger(
    selected.status === "sealed" && selected.fence === row.fence && same(selected.through, stopped),
    "native_archive_invalid",
  );
  return Object.freeze({
    scope,
    genesisHash: digest(row.genesisHash),
    head: stopped,
    fence: selected.fence,
    control: stored,
  });
}

async function verifyFrontier(
  store: R2ArchiveObjectStore,
  scope: CompleteBookScope,
  selected: Control,
  stopped: NativeLedgerHead,
  genesisHash: string,
): Promise<void> {
  requireLedger(same(selected.through, stopped), "native_archive_cutoff_incomplete");
  const latest = batch(await store.readImmutable(selected.manifest));
  requireLedger(
    same(latest.through, stopped) &&
      latest.genesis.payloadHash === genesisHash &&
      same(latest.initial, {
        sequence: "0",
        bookRevision: "0",
        chainHash: hash(
          JSON.stringify([NATIVE_LEDGER_FORMAT, hash(JSON.stringify(scope)), genesisHash]),
        ),
      }),
    "native_archive_invalid",
  );
  requireLedger(
    hash(decoder.decode(await store.readImmutable(latest.genesis))) === genesisHash,
    "native_archive_invalid",
  );
}

/** Maintenance-only fence publication at an externally approved stopped head.
 * Does not drain, initialize missing control, choose a shorter cutoff or claim
 * that every historical payload has been replayed. The catalog must first obtain
 * actual retirement evidence; writable recovery still verifies the full archive. */
export async function sealNativeArchive(
  store: R2ArchiveObjectStore,
  inputScope: CompleteBookScope,
  genesisHash: string,
  expectedHead: NativeLedgerHead,
  previousFence: string,
  nextFence: string,
): Promise<NativeArchiveSeal> {
  const scope = completeScope(inputScope, inputScope.objectId),
    stopped = head(expectedHead);
  digest(genesisHash);
  requireLedger(
    typeof previousFence === "string" &&
      /^(0|[1-9][0-9]{0,63})$/.test(previousFence) &&
      typeof nextFence === "string" &&
      /^(0|[1-9][0-9]{0,63})$/.test(nextFence) &&
      BigInt(nextFence) === BigInt(previousFence) + 1n,
    "native_archive_writer_fenced",
  );
  store.assertScope(scope, scope.objectId);
  const version = await store.readControl();
  requireLedger(version !== null, "native_archive_control_missing");
  const selected = control(version);
  requireLedger(
    selected.status === "active" ? selected.fence === previousFence : selected.fence === nextFence,
    "native_archive_writer_fenced",
  );
  await verifyFrontier(store, scope, selected, stopped, genesisHash);
  let sealedVersion = version;
  if (selected.status === "active") {
    const result = await store.compareAndSwapControl(
      version,
      JSON.stringify({ ...selected, fence: nextFence, status: "sealed" } satisfies Control),
    );
    requireLedger(result.disposition === "written", "native_archive_seal_conflict");
    sealedVersion = result.version;
  }
  requireLedger(same(await store.readControl(), sealedVersion), "native_archive_seal_changed");
  return normalizeNativeArchiveSeal(
    { scope, genesisHash, head: stopped, fence: nextFence, control: sealedVersion },
    scope,
  );
}
/** Read-only check of the resumed writer at the exact recovery cutoff. */
export async function readResumedNativeArchive(
  store: R2ArchiveObjectStore,
  input: NativeArchiveSeal,
): Promise<ArchiveControlVersion> {
  const seal = normalizeNativeArchiveSeal(input, input.scope);
  store.assertScope(seal.scope, seal.scope.objectId);
  const version = await store.readControl();
  requireLedger(version !== null, "native_archive_control_missing");
  const expected = { ...control(seal.control), status: "active" };
  requireLedger(same(control(version), expected), "native_archive_resume_conflict");
  await verifyFrontier(store, seal.scope, control(version), seal.head, seal.genesisHash);
  requireLedger(same(await store.readControl(), version), "native_archive_resume_conflict");
  return version;
}

/** Coordinator-only: prepared local access is still unavailable. Preserve every
 * manifest/outcome byte and advance no sequence. Exact active readback reconciles
 * a lost reply; other fences, cutoffs or missing controls cannot be adopted. */
export async function resumeNativeArchive(
  store: R2ArchiveObjectStore,
  input: NativeArchiveSeal,
): Promise<ArchiveControlVersion> {
  const seal = normalizeNativeArchiveSeal(input, input.scope);
  store.assertScope(seal.scope, seal.scope.objectId);
  const current = await store.readControl();
  requireLedger(current !== null, "native_archive_control_missing");
  if (control(current).status === "active") return readResumedNativeArchive(store, seal);
  requireLedger(same(current, seal.control), "native_archive_seal_changed");
  await verifyFrontier(store, seal.scope, control(current), seal.head, seal.genesisHash);
  const changed = await store.compareAndSwapControl(
    current,
    JSON.stringify({ ...control(current), status: "active" }),
  );
  requireLedger(changed.disposition === "written", "native_archive_resume_conflict");
  return readResumedNativeArchive(store, seal);
}

function batch(bytes: Uint8Array): NativeArchiveBatch {
  const row = fields(
    JSON.parse(decoder.decode(bytes)),
    "entries,format,from,genesis,initial,previous,through",
  );
  requireLedger(
    row.format === FORMAT && Array.isArray(row.entries) && row.entries.length <= 16,
    "native_archive_invalid",
  );
  const from = head(row.from),
    through = head(row.through),
    initial = head(row.initial);
  const entries = row.entries.map((value: unknown) => {
    const entry = fields(value, "head,payload,previousHash");
    return Object.freeze({
      head: head(entry.head),
      previousHash: digest(entry.previousHash),
      payload: reference(entry.payload),
    });
  });
  let previous = from,
    totalBytes = 0;
  for (const entry of entries) {
    requireLedger(
      BigInt(entry.head.sequence) === BigInt(previous.sequence) + 1n &&
        entry.previousHash === previous.chainHash &&
        BigInt(entry.head.bookRevision) >= BigInt(previous.bookRevision) &&
        BigInt(entry.head.bookRevision) <= BigInt(previous.bookRevision) + 1n,
      "recovery_segment_gap_detected",
    );
    totalBytes += entry.payload.payloadBytes;
    previous = entry.head;
  }
  requireLedger(
    totalBytes <= 1048576 &&
      same(previous, through) &&
      initial.sequence === "0" &&
      initial.bookRevision === "0",
    "native_archive_invalid",
  );
  requireLedger(
    row.previous === null
      ? entries.length === 0 && same(from, initial) && same(through, initial)
      : entries.length > 0,
    "recovery_segment_gap_detected",
  );
  return Object.freeze({
    format: FORMAT,
    genesis: reference(row.genesis),
    initial,
    from,
    through,
    previous: row.previous === null ? null : reference(row.previous),
    entries: Object.freeze(entries),
  });
}

/** Reads one immutable manifest, not its outcome bodies. The caller must follow
 * every previous link from the selected seal to establish complete membership;
 * a self-consistent disconnected manifest is not a recovery chain. */
export async function readNativeArchiveBatch(
  store: R2ArchiveObjectStore,
  input: NativeArchiveSeal,
  requested?: ArchivePayloadReference,
): Promise<{ readonly reference: ArchivePayloadReference; readonly batch: NativeArchiveBatch }> {
  const seal = normalizeNativeArchiveSeal(input, input.scope);
  store.assertScope(seal.scope, seal.scope.objectId);
  requireLedger(same(await store.readControl(), seal.control), "native_archive_seal_changed");
  const ref = requested === undefined ? control(seal.control).manifest : reference(requested);
  const item = batch(await store.readImmutable(ref));
  requireLedger(
    item.genesis.payloadHash === seal.genesisHash &&
      same(item.initial, {
        sequence: "0",
        bookRevision: "0",
        chainHash: hash(
          JSON.stringify([
            NATIVE_LEDGER_FORMAT,
            hash(JSON.stringify(seal.scope)),
            seal.genesisHash,
          ]),
        ),
      }) &&
      (requested !== undefined || same(item.through, seal.head)),
    "native_archive_invalid",
  );
  requireLedger(same(await store.readControl(), seal.control), "native_archive_seal_changed");
  return Object.freeze({ reference: ref, batch: item });
}

/** One admitted archive batch is at most sixteen outcomes and one MiB. Re-reading
 * its immutable manifest avoids trusting cached/request-supplied entry bodies. */
export async function readNativeArchiveOutcomes(
  store: R2ArchiveObjectStore,
  input: NativeArchiveSeal,
  requested: ArchivePayloadReference,
): Promise<{
  readonly batch: NativeArchiveBatch;
  readonly genesis: string | null;
  readonly outcomes: readonly {
    readonly head: NativeLedgerHead;
    readonly previousHash: string;
    readonly encoded: string;
  }[];
}> {
  const seal = normalizeNativeArchiveSeal(input, input.scope);
  const { batch: item } = await readNativeArchiveBatch(store, seal, requested);
  const scopeHash = hash(JSON.stringify(seal.scope));
  const outcomes = await payloadsInOrder(item.entries, async (entry) => {
    const encoded = decoder.decode(await store.readImmutable(entry.payload));
    const decoded = decodeBookOutcome(encoded);
    requireLedger(
      decoded.disposition === "decoded" &&
        decoded.payload.command.bookId === seal.scope.bookId &&
        decoded.payload.originalResult.observedBookRevision.toString() ===
          entry.head.bookRevision &&
        hash(
          JSON.stringify([
            NATIVE_LEDGER_FORMAT,
            scopeHash,
            entry.head.sequence,
            entry.head.bookRevision,
            entry.previousHash,
            entry.payload.payloadHash,
          ]),
        ) === entry.head.chainHash,
      "native_archive_outcome_corrupt",
    );
    return Object.freeze({ head: entry.head, previousHash: entry.previousHash, encoded });
  });
  const genesis =
    item.previous === null ? decoder.decode(await store.readImmutable(item.genesis)) : null;
  requireLedger(same(await store.readControl(), seal.control), "native_archive_seal_changed");
  return Object.freeze({ batch: item, genesis, outcomes: Object.freeze(outcomes) });
}

/** The canonical native outcome log is the durable outbox. Payloads are immutable;
 * one conditional pointer update publishes a bounded contiguous batch. No R2 I/O
 * runs in a book transaction or save acknowledgement. A durable alarm owner must
 * schedule/retry this relay. This is not a restore permit or a writable installer. */
export class NativeOutcomeOutbox {
  readonly scope: CompleteBookScope;
  private readonly scopeHash: string;
  constructor(
    private readonly source: Pick<NativeLedgerReader, "scope" | "outcomePage">,
    private readonly store: R2ArchiveObjectStore,
    private readonly authority: () => { readonly fence: string; readonly pending: boolean },
  ) {
    this.scope = completeScope(source.scope, source.scope.objectId);
    this.scopeHash = hash(JSON.stringify(this.scope));
    store.assertScope(this.scope, this.scope.objectId);
  }
  private fence(): string {
    const value = this.authority();
    requireLedger(
      !value.pending &&
        typeof value.fence === "string" &&
        /^(0|[1-9][0-9]{0,63})$/.test(value.fence),
      "native_archive_writer_fenced",
    );
    return value.fence;
  }
  private unchanged(fence: string): void {
    requireLedger(this.fence() === fence, "native_archive_writer_fenced");
  }
  private initial(genesis: ArchivePayloadReference): NativeLedgerHead {
    return {
      sequence: "0",
      bookRevision: "0",
      chainHash: hash(JSON.stringify([NATIVE_LEDGER_FORMAT, this.scopeHash, genesis.payloadHash])),
    };
  }
  /** Bounded, read-only observation of an active archive's contiguous cursor.
   * This is neither elapsed-time lag, a full payload audit nor restore authority.
   * Concurrent source appends may follow observedSequence; changed archive
   * control or fencing makes this sample unavailable, never falsely caught up. */
  async inspectProgress(admit?: () => void): Promise<NativeArchiveProgress> {
    const fence = this.fence(),
      version = await this.store.readControl();
    requireLedger(version !== null, "native_archive_control_missing");
    const selected = control(version);
    requireLedger(
      selected.fence === fence && selected.status === "active",
      "native_archive_writer_fenced",
    );
    const latest = batch(await this.store.readImmutable(selected.manifest));
    requireLedger(
      same(latest.through, selected.through) && same(latest.initial, this.initial(latest.genesis)),
      "native_archive_invalid",
    );
    const page = await this.source.outcomePage(selected.through, 1, admit);
    requireLedger(hash(page.genesis) === latest.genesis.payloadHash, "native_archive_invalid");
    requireLedger(
      same(await this.store.readControl(), version),
      "native_archive_observation_changed",
    );
    this.unchanged(fence);
    const pending = BigInt(page.observedTip.sequence) - BigInt(selected.through.sequence);
    return Object.freeze({
      status: pending === 0n ? "caughtUp" : "pending",
      writerFence: fence,
      archivedSequence: selected.through.sequence,
      observedSequence: page.observedTip.sequence,
      pendingOutcomes: pending.toString(),
    });
  }
  /** Read-only completion check for an already retired owner. Never seals a
   * pointer or treats arbitrary fencing as successful backup completion. */
  async isSealedAt(expectedHead: NativeLedgerHead, expectedFence: string): Promise<boolean> {
    const stopped = head(expectedHead),
      version = await this.store.readControl();
    requireLedger(version !== null, "native_archive_control_missing");
    const selected = control(version);
    if (selected.status !== "sealed") return false;
    requireLedger(selected.fence === expectedFence, "native_archive_writer_fenced");
    const page = await this.source.outcomePage(stopped, 1);
    requireLedger(
      same(page.observedTip, stopped) && page.outcomes.length === 0,
      "native_archive_source_changed",
    );
    await verifyFrontier(this.store, this.scope, selected, stopped, hash(page.genesis));
    requireLedger(same(await this.store.readControl(), version), "native_archive_seal_changed");
    return true;
  }
  /** Explicit reservation-time initialization. Never called by drain: a missing
   * established archive pointer is an error, not permission to start over. The
   * production catalog must authorize this operation before exposing the writer. */
  async initialize(): Promise<void> {
    const fence = this.fence(),
      current = await this.store.readControl();
    if (current !== null) {
      const existing = control(current);
      requireLedger(
        existing.fence === fence && existing.status === "active",
        "native_archive_writer_fenced",
      );
      const selected = batch(await this.store.readImmutable(existing.manifest));
      requireLedger(
        same(selected.through, existing.through) &&
          same(selected.initial, this.initial(selected.genesis)),
        "native_archive_invalid",
      );
      const page = await this.source.outcomePage(existing.through, 1);
      requireLedger(hash(page.genesis) === selected.genesis.payloadHash, "native_archive_invalid");
      this.unchanged(fence);
      return;
    }
    const page = await this.source.outcomePage(null, 1);
    const genesis = await this.store.putImmutable(encoder.encode(page.genesis));
    requireLedger(same(page.from, this.initial(genesis)), "native_archive_invalid");
    const manifest = await this.store.putImmutable(
      encoder.encode(
        JSON.stringify({
          format: FORMAT,
          genesis,
          initial: page.from,
          from: page.from,
          through: page.from,
          previous: null,
          entries: [],
        } satisfies NativeArchiveBatch),
      ),
    );
    this.unchanged(fence);
    const published = await this.store.compareAndSwapControl(
      null,
      JSON.stringify({
        format: FORMAT,
        fence,
        status: "active",
        manifest,
        through: page.from,
      } satisfies Control),
    );
    requireLedger(published.disposition === "written", "native_archive_initialization_conflict");
  }
  async drain(maximumOutcomes = 16): Promise<{
    readonly disposition: "advanced" | "idle" | "conflict";
    readonly through: NativeLedgerHead;
    readonly observedTip: NativeLedgerHead;
  }> {
    requireLedger(
      Number.isSafeInteger(maximumOutcomes) && maximumOutcomes >= 1 && maximumOutcomes <= 16,
      "native_archive_invalid",
    );
    const fence = this.fence(),
      version = await this.store.readControl();
    requireLedger(version !== null, "native_archive_control_missing");
    const selected = control(version);
    requireLedger(
      selected.fence === fence && selected.status === "active",
      "native_archive_writer_fenced",
    );
    const latest = batch(await this.store.readImmutable(selected.manifest));
    requireLedger(
      same(latest.through, selected.through) && same(latest.initial, this.initial(latest.genesis)),
      "native_archive_invalid",
    );
    let through = selected.through,
      bytes = 0;
    const pending: { head: NativeLedgerHead; previousHash: string; bytes: Uint8Array }[] = [];
    let page = await this.source.outcomePage(through, 1);
    requireLedger(hash(page.genesis) === latest.genesis.payloadHash, "native_archive_invalid");
    const observedTip = page.observedTip;
    while (
      pending.length < maximumOutcomes &&
      BigInt(through.sequence) < BigInt(observedTip.sequence)
    ) {
      const outcome = page.outcomes[0];
      requireLedger(
        outcome !== undefined &&
          outcome.previousHash === through.chainHash &&
          BigInt(outcome.head.sequence) === BigInt(through.sequence) + 1n,
        "recovery_segment_gap_detected",
      );
      const payloadBytes = encoder.encode(outcome.encoded);
      if (bytes + payloadBytes.length > 1048576) break;
      this.unchanged(fence);
      pending.push({ head: outcome.head, previousHash: outcome.previousHash, bytes: payloadBytes });
      bytes += payloadBytes.length;
      through = outcome.head;
      if (
        pending.length < maximumOutcomes &&
        BigInt(through.sequence) < BigInt(observedTip.sequence)
      )
        page = await this.source.outcomePage(through, 1);
    }
    this.unchanged(fence);
    if (!pending.length) return { disposition: "idle", through, observedTip };
    const entries = await payloadsInOrder(pending, async (outcome): Promise<NativeArchiveEntry> => {
      this.unchanged(fence);
      const payload = await this.store.putImmutable(outcome.bytes);
      this.unchanged(fence);
      return { head: outcome.head, previousHash: outcome.previousHash, payload };
    });
    this.unchanged(fence);
    const manifest = await this.store.putImmutable(
      encoder.encode(
        JSON.stringify({
          format: FORMAT,
          genesis: latest.genesis,
          initial: latest.initial,
          from: selected.through,
          through,
          previous: selected.manifest,
          entries,
        } satisfies NativeArchiveBatch),
      ),
    );
    this.unchanged(fence);
    const result = await this.store.compareAndSwapControl(
      version,
      JSON.stringify({
        format: FORMAT,
        fence,
        status: "active",
        manifest,
        through,
      } satisfies Control),
    );
    return Object.freeze({
      disposition: result.disposition === "written" ? "advanced" : "conflict",
      through: result.disposition === "written" ? through : selected.through,
      observedTip,
    });
  }

  /** Bounded reverse-batch inspection. Consume to completion to verify the entire
   * selected archive. A restore installer can spool these batches in SQLite and
   * replay forwards without holding history in memory. It still needs independent
   * cutoff/fence authorization and accounting replay; hashes alone are not proof. */
  async *inspect(expectedSeal?: NativeArchiveSeal): AsyncGenerator<{
    readonly from: NativeLedgerHead;
    readonly through: NativeLedgerHead;
    readonly genesis: string | null;
    readonly outcomes: readonly {
      readonly head: NativeLedgerHead;
      readonly previousHash: string;
      readonly encoded: string;
    }[];
  }> {
    const seal =
      expectedSeal === undefined ? null : normalizeNativeArchiveSeal(expectedSeal, this.scope);
    const version = await this.store.readControl();
    requireLedger(version !== null, "native_archive_control_missing");
    requireLedger(seal === null || same(version, seal.control), "native_archive_seal_changed");
    const selected = control(version);
    let ref = selected.manifest,
      expected = selected.through;
    let genesisReference: ArchivePayloadReference | null = null;
    for (;;) {
      const item = batch(await this.store.readImmutable(ref));
      requireLedger(
        same(item.through, expected) &&
          same(item.initial, this.initial(item.genesis)) &&
          (genesisReference === null || same(item.genesis, genesisReference)),
        "recovery_segment_gap_detected",
      );
      genesisReference = item.genesis;
      requireLedger(
        seal === null || item.genesis.payloadHash === seal.genesisHash,
        "native_archive_invalid",
      );
      const outcomes = [];
      for (const entry of item.entries) {
        const encoded = decoder.decode(await this.store.readImmutable(entry.payload));
        const decoded = decodeBookOutcome(encoded);
        requireLedger(
          decoded.disposition === "decoded" &&
            decoded.payload.command.bookId === this.scope.bookId &&
            decoded.payload.originalResult.observedBookRevision.toString() ===
              entry.head.bookRevision &&
            hash(
              JSON.stringify([
                NATIVE_LEDGER_FORMAT,
                this.scopeHash,
                entry.head.sequence,
                entry.head.bookRevision,
                entry.previousHash,
                entry.payload.payloadHash,
              ]),
            ) === entry.head.chainHash,
          "native_archive_outcome_corrupt",
        );
        outcomes.push({ head: entry.head, previousHash: entry.previousHash, encoded });
      }
      const genesis =
        item.previous === null
          ? decoder.decode(await this.store.readImmutable(item.genesis))
          : null;
      yield Object.freeze({
        from: item.from,
        through: item.through,
        genesis,
        outcomes: Object.freeze(outcomes),
      });
      if (item.previous === null) break;
      expected = item.from;
      ref = item.previous;
    }
    requireLedger(
      same(await this.store.readControl(), version),
      "native_archive_changed_during_inspection",
    );
  }
}
