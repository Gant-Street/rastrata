import { createHash } from "node:crypto";
import { hashCanonical } from "@rastrata/kernel";
import { readCanonicalIdentityPopulation, type CanonicalIdentity } from "./identity-audit.ts";
import type { ProductionLedger } from "./ledger.ts";
import { requireLedger } from "./records.ts";

// Internal candidate codec. Physical location allocation, immutable publication,
// reader pins and retirement are owner responsibilities, not digest guarantees.
export const INDEX_KEY_SCHEMA = "rastrata-permanent-identity-v1";
export const INDEX_PAGE_VERSION = "rastrata-index-page-v1";
export const INDEX_PAGE_BYTES = 8_192;
const HEADER = 9,
  LEAF = 40,
  CHILD = 140;
const MAGIC = [82, 73, 80, 49]; // RIP1; deliberately not the experiment's RIX1.
const HEX = /^[0-9a-f]{64}$/;
const NATURAL = /^(0|[1-9][0-9]{0,19})$/;
const MAX = (1n << 64n) - 1n;
const MAX_DEPTH = 16;

export interface IndexPageReference {
  readonly location: string;
  readonly digest: string;
  readonly byteCount: number;
  readonly representationVersion: typeof INDEX_PAGE_VERSION;
}
export interface IndexRoot {
  readonly contentHash: string;
  readonly keySchemaVersion: typeof INDEX_KEY_SCHEMA;
  readonly population: string;
  readonly page: IndexPageReference | null;
}
export interface IndexEntry {
  readonly key: string;
  readonly sequence: bigint;
}
export interface IndexChild {
  readonly page: IndexPageReference;
  readonly min: string;
  readonly max: string;
  readonly population: bigint;
}
export type IndexPageReader = (location: string) => Promise<Uint8Array | undefined>;

declare const balancedIndexBrand: unique symbol;
export interface BalancedIndex {
  readonly [balancedIndexBrand]: true;
  readonly root: IndexRoot;
  readonly height: number;
}
const verifiedBalancedIndexes = new WeakSet<object>();
interface InsertEvidence {
  readonly before: IndexRoot;
  readonly after: IndexRoot;
  readonly entry: IndexEntry;
  readonly pages: readonly IndexPageReference[];
}
const preparedInsertions = new WeakMap<object, InsertEvidence>();

/** Instance-local provenance from the actual COW algorithm, not a structural
 * caller claim. Page bytes still require storage-side verification and ownership. */
export function verifyPreparedIndexInsertion(input: object): InsertEvidence {
  const evidence = preparedInsertions.get(input);
  requireLedger(evidence, "index_insertion_unprepared");
  return evidence;
}
function balancedIndex(root: IndexRoot, height: number): BalancedIndex {
  const index = Object.freeze({ root, height }) as BalancedIndex;
  verifiedBalancedIndexes.add(index);
  return index;
}

/** Full physical-layout audit for bounded COW eligibility, not canonical
 * population/owner authority. All leaves must have the same depth. The opaque
 * result cannot be replaced by a caller's claimed height or boolean. */
export async function auditBalancedIndex(
  rootInput: unknown,
  expectedHash: string,
  read: IndexPageReader,
): Promise<BalancedIndex> {
  const root = verifyIndexRoot(rootInput, expectedHash);
  let height = 0;
  async function walk(
    page: IndexPageReference,
    expected: Pick<IndexChild, "min" | "max" | "population"> | null,
    depth: number,
  ): Promise<void> {
    requireLedger(depth <= MAX_DEPTH, "index_page_depth_exceeded");
    const decoded = await readPage(page, read);
    requireLedger(
      decoded.population === (expected?.population ?? BigInt(root.population)),
      "index_page_population_mismatch",
    );
    if (expected)
      requireLedger(
        decoded.min === expected.min && decoded.max === expected.max,
        "index_page_fence_mismatch",
      );
    if (decoded.children.length > 0) {
      for (const child of decoded.children) await walk(child.page, child, depth + 1);
    } else {
      requireLedger(height === 0 || height === depth, "index_layout_unbalanced");
      height = depth;
    }
  }
  if (root.page) await walk(root.page, null, 1);
  return balancedIndex(root, height);
}

function shape(value: unknown, fields: readonly string[]): Record<string, unknown> {
  requireLedger(value !== null && typeof value === "object", "index_page_shape_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireLedger(
    Reflect.ownKeys(value).length === fields.length &&
      fields.every((field) => descriptors[field] && "value" in descriptors[field]),
    "index_page_shape_invalid",
  );
  return Object.fromEntries(fields.map((field) => [field, descriptors[field]?.value]));
}
function hex(value: unknown): string {
  requireLedger(typeof value === "string" && HEX.test(value), "index_page_digest_invalid");
  return value;
}
function uint(value: unknown): bigint {
  requireLedger(
    typeof value === "bigint" && value > 0n && value <= MAX,
    "index_page_counter_invalid",
  );
  return value;
}
function reference(value: unknown): IndexPageReference {
  const row = shape(value, ["location", "digest", "byteCount", "representationVersion"]);
  requireLedger(
    typeof row.location === "string" && /^derived\/[0-9a-f]{64}$/.test(row.location),
    "index_page_location_invalid",
  );
  requireLedger(
    typeof row.byteCount === "number" &&
      Number.isInteger(row.byteCount) &&
      row.byteCount >= HEADER + LEAF &&
      row.byteCount <= INDEX_PAGE_BYTES,
    "index_page_length_invalid",
  );
  requireLedger(row.representationVersion === INDEX_PAGE_VERSION, "index_page_version_unsupported");
  return Object.freeze({
    location: row.location,
    digest: hex(row.digest),
    byteCount: row.byteCount,
    representationVersion: INDEX_PAGE_VERSION,
  });
}
function rootHash(population: string, page: IndexPageReference | null): string {
  return hashCanonical({
    domain: "rastrata-index-root-v1",
    keySchemaVersion: INDEX_KEY_SCHEMA,
    population,
    page: page ? { ...page, byteCount: BigInt(page.byteCount) } : null,
  }).digest;
}
export function createIndexRoot(population: bigint, page: IndexPageReference | null): IndexRoot {
  requireLedger(
    population >= 0n && population <= MAX && (population === 0n) === (page === null),
    "index_root_population_invalid",
  );
  const checked = page === null ? null : reference(page);
  return Object.freeze({
    contentHash: rootHash(String(population), checked),
    keySchemaVersion: INDEX_KEY_SCHEMA,
    population: String(population),
    page: checked,
  });
}
export function verifyIndexRoot(input: unknown, expectedHash: string): IndexRoot {
  const row = shape(input, ["contentHash", "keySchemaVersion", "population", "page"]);
  requireLedger(row.keySchemaVersion === INDEX_KEY_SCHEMA, "index_key_schema_unsupported");
  requireLedger(
    typeof row.population === "string" && NATURAL.test(row.population),
    "index_root_population_invalid",
  );
  const root = createIndexRoot(
    BigInt(row.population),
    row.page === null ? null : reference(row.page),
  );
  requireLedger(
    root.contentHash === hex(row.contentHash) && root.contentHash === hex(expectedHash),
    "index_root_hash_mismatch",
  );
  return root;
}
export function identityIndexKey(
  entry: Pick<CanonicalIdentity, "bookId" | "family" | "id">,
): string {
  return hashCanonical({
    domain: INDEX_KEY_SCHEMA,
    bookId: entry.bookId,
    family: entry.family,
    id: entry.id,
  }).digest;
}
function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
function data(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function putHex(bytes: Uint8Array, offset: number, value: string) {
  hex(value);
  for (let i = 0; i < 32; i++)
    bytes[offset + i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
}
function getHex(bytes: Uint8Array, offset: number) {
  return [...bytes.subarray(offset, offset + 32)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
function ordered(previous: string | undefined, min: string, max: string) {
  requireLedger(
    hex(min) <= hex(max) && (previous === undefined || previous < min),
    "index_page_order_invalid",
  );
}

/** Encodes one bounded page, not an index builder. The caller allocates a fresh,
 * non-reusable location; this function cannot establish that it is fresh. */
export function encodeIndexPage(
  location: string,
  rows: readonly IndexEntry[],
  children: readonly IndexChild[] = [],
) {
  requireLedger(rows.length > 0 !== children.length > 0, "index_page_kind_invalid");
  const branch = children.length > 0;
  const length = HEADER + (branch ? children.length * CHILD : rows.length * LEAF);
  requireLedger(length <= INDEX_PAGE_BYTES, "index_page_length_invalid");
  const bytes = new Uint8Array(length);
  bytes.set(MAGIC);
  bytes[4] = branch ? 1 : 0;
  data(bytes).setUint32(5, branch ? children.length : rows.length, false);
  let previous: string | undefined,
    population = 0n;
  rows.forEach((row, i) => {
    ordered(previous, row.key, row.key);
    previous = row.key;
    const offset = HEADER + i * LEAF;
    putHex(bytes, offset, row.key);
    data(bytes).setBigUint64(offset + 32, uint(row.sequence), false);
    population++;
  });
  children.forEach((child, i) => {
    ordered(previous, child.min, child.max);
    previous = child.max;
    const page = reference(child.page),
      offset = HEADER + i * CHILD;
    putHex(bytes, offset, child.min);
    putHex(bytes, offset + 32, child.max);
    putHex(bytes, offset + 64, page.digest);
    putHex(bytes, offset + 96, page.location.slice(8));
    data(bytes).setUint32(offset + 128, page.byteCount, false);
    data(bytes).setBigUint64(offset + 132, uint(child.population), false);
    population += child.population;
  });
  uint(population);
  const page = reference({
    location,
    digest: digest(bytes),
    byteCount: length,
    representationVersion: INDEX_PAGE_VERSION,
  });
  const min = branch ? children[0]?.min : rows[0]?.key;
  requireLedger(min !== undefined && previous !== undefined, "index_page_kind_invalid");
  return { bytes, descriptor: Object.freeze({ page, min, max: previous, population }) };
}

async function readPage(page: IndexPageReference, read: IndexPageReader) {
  return verifyIndexPageBytes(page, await read(page.location));
}

/** Own and validate one complete page. Child bytes must still be fetched and
 * verified before this branch can support a retained/selected root. */
export function verifyIndexPageBytes(input: unknown, fetched: unknown) {
  const page = reference(input);
  requireLedger(
    fetched instanceof Uint8Array && fetched.byteLength === page.byteCount,
    "index_page_missing_or_short",
  );
  const bytes = fetched.slice(); // Own the verified snapshot across later awaits.
  requireLedger(digest(bytes) === page.digest, "index_page_hash_mismatch");
  requireLedger(
    MAGIC.every((byte, i) => bytes[i] === byte),
    "index_page_version_unsupported",
  );
  const kind = bytes[4];
  requireLedger(kind === 0 || kind === 1, "index_page_kind_invalid");
  const count = data(bytes).getUint32(5, false);
  requireLedger(
    count > 0 && bytes.length === HEADER + count * (kind === 0 ? LEAF : CHILD),
    "index_page_length_invalid",
  );
  const rows: IndexEntry[] = [],
    children: IndexChild[] = [];
  let previous: string | undefined,
    population = 0n;
  for (let i = 0; i < count; i++) {
    const offset = HEADER + i * (kind === 0 ? LEAF : CHILD);
    const min = getHex(bytes, offset),
      max = kind === 0 ? min : getHex(bytes, offset + 32);
    ordered(previous, min, max);
    previous = max;
    if (kind === 0) {
      rows.push({ key: min, sequence: uint(data(bytes).getBigUint64(offset + 32, false)) });
      population++;
    } else {
      const childPopulation = uint(data(bytes).getBigUint64(offset + 132, false));
      children.push({
        min,
        max,
        population: childPopulation,
        page: reference({
          location: `derived/${getHex(bytes, offset + 96)}`,
          digest: getHex(bytes, offset + 64),
          byteCount: data(bytes).getUint32(offset + 128, false),
          representationVersion: INDEX_PAGE_VERSION,
        }),
      });
      population += childPopulation;
    }
  }
  uint(population);
  return {
    page,
    bytes,
    rows,
    children,
    population,
    min: kind === 0 ? rows[0]?.key : children[0]?.min,
    max: previous,
  };
}

/** Full streaming traversal of a ROOT ALREADY SELECTED BY TRUSTED VIEW AUTHORITY.
 * This verifies every selected page, not just a lookup path. Requires durable pins
 * externally; it cannot ensure continued availability after a read succeeds. */
export async function* enumerateIndexPages(
  rootInput: unknown,
  expectedHash: string,
  read: IndexPageReader,
): AsyncGenerator<IndexEntry> {
  const root = verifyIndexRoot(rootInput, expectedHash);
  async function* walk(
    page: IndexPageReference,
    expected: Pick<IndexChild, "min" | "max" | "population"> | null,
    depth: number,
  ): AsyncGenerator<IndexEntry> {
    requireLedger(depth <= MAX_DEPTH, "index_page_depth_exceeded");
    const decoded = await readPage(page, read);
    requireLedger(
      decoded.population === (expected?.population ?? BigInt(root.population)),
      "index_page_population_mismatch",
    );
    if (expected)
      requireLedger(
        decoded.min === expected.min && decoded.max === expected.max,
        "index_page_fence_mismatch",
      );
    if (decoded.children.length) {
      for (const child of decoded.children) yield* walk(child.page, child, depth + 1);
    } else yield* decoded.rows;
  }
  if (root.page) yield* walk(root.page, null, 1);
}

/** Authenticated key membership/non-membership within an ALREADY AUDITED root.
 * This verifies one path, not the health/completeness of unvisited child pages.
 * Root selection, canonical population audit and a durable pin remain mandatory
 * owner responsibilities. A found digest is only a locator: resolve the original
 * raw accounting identity before admission, including collision detection. */
export async function lookupIndexEntry(
  rootInput: unknown,
  expectedHash: string,
  keyInput: string,
  read: IndexPageReader,
) {
  const key = hex(keyInput);
  const root = verifyIndexRoot(rootInput, expectedHash);
  let page = root.page;
  let expected: Pick<IndexChild, "min" | "max" | "population"> | null = null;
  let pagesRead = 0,
    bytesRead = 0;
  function result(sequence: bigint | null) {
    return Object.freeze({ key, sequence, rootHash: root.contentHash, pagesRead, bytesRead });
  }
  while (page !== null) {
    requireLedger(pagesRead < MAX_DEPTH, "index_page_depth_exceeded");
    const decoded = await readPage(page, read);
    pagesRead++;
    bytesRead += decoded.bytes.length;
    requireLedger(
      decoded.population === (expected?.population ?? BigInt(root.population)),
      "index_page_population_mismatch",
    );
    if (expected)
      requireLedger(
        decoded.min === expected.min && decoded.max === expected.max,
        "index_page_fence_mismatch",
      );
    if (decoded.children.length > 0) {
      // Authenticated disjoint fences prove absence between children. A required
      // child's missing bytes never take this branch: readPage must reject them.
      const child = decoded.children.find(
        (candidate) => candidate.min <= key && key <= candidate.max,
      );
      if (!child) return result(null);
      page = child.page;
      expected = child;
    } else {
      // The entire bounded leaf is validated before searching, so missing a key
      // here is a proof against this root, not an unauthenticated SQL NOT EXISTS.
      return result(decoded.rows.find((entry) => entry.key === key)?.sequence ?? null);
    }
  }
  return result(null);
}

export interface IndexRangeBatch {
  readonly rootHash: string;
  readonly lower: string | null;
  readonly upper: string | null;
  readonly entries: readonly IndexEntry[];
  readonly matchedThrough: bigint;
  readonly complete: boolean;
  readonly pagesRead: bigint;
  readonly bytesRead: bigint;
}

/** Stream the complete half-open key interval [lower, upper) of an ALREADY
 * AUDITED root. Null denotes an unbounded endpoint. Authenticated child fences
 * prune disjoint subtrees; every required page still verifies bytes/count/fences.
 * Memory is bounded by depth, page size and one batch plus lookahead, not history.
 *
 * Only draining through complete=true proves the whole interval. A returned prefix
 * or cancellation is NOT completeness. This is hash-key order, not accounting
 * date/account order: semantic secondary-key schemas remain separate. Pins, root
 * authority and canonical source resolution are still owner responsibilities. */
export function scanIndexRange(
  rootInput: unknown,
  expectedHash: string,
  lowerInput: string | null,
  upperInput: string | null,
  read: IndexPageReader,
  batchSize = 128,
): AsyncGenerator<IndexRangeBatch> {
  const root = verifyIndexRoot(rootInput, expectedHash);
  const lower = lowerInput === null ? null : hex(lowerInput);
  const upper = upperInput === null ? null : hex(upperInput);
  requireLedger(lower === null || upper === null || lower <= upper, "index_range_invalid");
  requireLedger(
    Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 256,
    "index_range_batch_invalid",
  );
  let pagesRead = 0n,
    bytesRead = 0n,
    matchedThrough = 0n;
  async function* walk(
    page: IndexPageReference,
    expected: Pick<IndexChild, "min" | "max" | "population"> | null,
    depth: number,
  ): AsyncGenerator<IndexEntry> {
    requireLedger(depth <= MAX_DEPTH, "index_page_depth_exceeded");
    const decoded = await readPage(page, read);
    pagesRead++;
    bytesRead += BigInt(decoded.bytes.length);
    requireLedger(
      decoded.population === (expected?.population ?? BigInt(root.population)),
      "index_page_population_mismatch",
    );
    if (expected)
      requireLedger(
        decoded.min === expected.min && decoded.max === expected.max,
        "index_page_fence_mismatch",
      );
    if (decoded.children.length) {
      for (const child of decoded.children)
        if ((lower === null || child.max >= lower) && (upper === null || child.min < upper))
          yield* walk(child.page, child, depth + 1);
    } else
      for (const entry of decoded.rows)
        if ((lower === null || entry.key >= lower) && (upper === null || entry.key < upper))
          yield Object.freeze({ ...entry });
  }
  function batch(entries: IndexEntry[], complete: boolean): IndexRangeBatch {
    return Object.freeze({
      rootHash: root.contentHash,
      lower,
      upper,
      entries: Object.freeze(entries),
      matchedThrough,
      complete,
      pagesRead,
      bytesRead,
    });
  }
  return (async function* () {
    let entries: IndexEntry[] = [];
    if (root.page && (lower === null || upper === null || lower !== upper)) {
      for await (const entry of walk(root.page, null, 1)) {
        // One-row lookahead distinguishes an exact full final batch from a
        // prefix. Do not emit a final success before reading the required suffix.
        if (entries.length === batchSize) {
          yield batch(entries, false);
          entries = [];
        }
        entries.push(entry);
        matchedThrough++;
      }
    }
    yield batch(entries, true);
  })();
}

/** Prepare ONE insertion into a verified balanced tree. The handle proves only
 * physical layout, not canonical identity completeness, pin liveness, availability
 * or posting authority. No page is written or root selected here. The owner must
 * reserve globally fresh, non-reusable
 * locations; this routine additionally rejects collisions within the plan and
 * against references observed on the input path. It cannot prove freshness in
 * unvisited/retired storage. Cross-partition checks and atomic publication remain
 * owner responsibilities. Old pages and the input root are never mutated. */
export async function prepareIndexInsert(
  index: BalancedIndex,
  entryInput: IndexEntry,
  read: IndexPageReader,
  allocateLocation: () => string,
) {
  requireLedger(verifiedBalancedIndexes.has(index), "index_layout_unverified");
  const raw = shape(entryInput, ["key", "sequence"]);
  const entry = Object.freeze({ key: hex(raw.key), sequence: uint(raw.sequence) });
  const before = index.root;
  const population = BigInt(before.population) + 1n;
  uint(population);
  const leafCapacity = Math.floor((INDEX_PAGE_BYTES - HEADER) / LEAF);
  const branchCapacity = Math.floor((INDEX_PAGE_BYTES - HEADER) / CHILD);
  const ancestors: { page: Awaited<ReturnType<typeof readPage>>; selected: number }[] = [];
  const protectedLocations = new Set<string>();
  let page = before.page;
  let expected: Pick<IndexChild, "min" | "max" | "population"> | null = null;
  let leafRows: IndexEntry[] = [];
  let pagesRead = 0,
    bytesRead = 0;
  while (page !== null) {
    requireLedger(pagesRead < MAX_DEPTH, "index_page_depth_exceeded");
    protectedLocations.add(page.location);
    const decoded = await readPage(page, read);
    pagesRead++;
    bytesRead += decoded.bytes.length;
    requireLedger(
      decoded.population === (expected?.population ?? BigInt(before.population)),
      "index_page_population_mismatch",
    );
    if (expected)
      requireLedger(
        decoded.min === expected.min && decoded.max === expected.max,
        "index_page_fence_mismatch",
      );
    if (decoded.children.length === 0) {
      leafRows = decoded.rows;
      break;
    }
    for (const child of decoded.children) protectedLocations.add(child.page.location);
    // A gap belongs to the next child; beyond the last fence extends the last
    // child. Its new range cannot overlap an untouched neighbor.
    const candidate = decoded.children.findIndex((child) => entry.key <= child.max);
    const selected = candidate < 0 ? decoded.children.length - 1 : candidate;
    const child = decoded.children[selected];
    requireLedger(child, "index_page_shape_invalid");
    ancestors.push({ page: decoded, selected });
    expected = child;
    page = child.page;
  }
  requireLedger(!leafRows.some((row) => row.key === entry.key), "index_identity_exists");
  requireLedger(pagesRead === index.height, "index_layout_unbalanced");
  const rows = [...leafRows, entry].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // Reject impossible root growth BEFORE reserving locations or producing pages.
  let carry = rows.length > leafCapacity ? 2 : 1;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ancestor = ancestors[i];
    requireLedger(ancestor, "index_page_shape_invalid");
    carry = ancestor.page.children.length - 1 + carry > branchCapacity ? 2 : 1;
  }
  const depth = Math.max(index.height, 1) + (carry === 2 ? 1 : 0);
  requireLedger(depth <= MAX_DEPTH, "index_page_depth_exceeded");
  const allocated = new Set<string>();
  const pages: ReturnType<typeof encodeIndexPage>[] = [];
  function encode(rows: readonly IndexEntry[], children: readonly IndexChild[] = []) {
    const location = allocateLocation();
    requireLedger(
      !allocated.has(location) && !protectedLocations.has(location),
      "index_page_location_reused",
    );
    const encoded = encodeIndexPage(location, rows, children);
    allocated.add(location);
    pages.push(encoded);
    return encoded.descriptor;
  }
  let replacements: IndexChild[];
  if (rows.length <= leafCapacity) replacements = [encode(rows)];
  else {
    const split = Math.floor(rows.length / 2);
    replacements = [encode(rows.slice(0, split)), encode(rows.slice(split))];
  }
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ancestor = ancestors[i];
    requireLedger(ancestor, "index_page_shape_invalid");
    const children = [...ancestor.page.children];
    children.splice(ancestor.selected, 1, ...replacements);
    if (children.length <= branchCapacity) replacements = [encode([], children)];
    else {
      const split = Math.floor(children.length / 2);
      replacements = [encode([], children.slice(0, split)), encode([], children.slice(split))];
    }
  }
  const top = replacements.length === 1 ? replacements[0] : encode([], replacements);
  requireLedger(top && top.population === population, "index_page_population_mismatch");
  const after = createIndexRoot(population, top.page);
  const prepared = Object.freeze({
    before,
    after,
    index: balancedIndex(after, depth),
    entry,
    pages: Object.freeze(pages.map((encoded) => Object.freeze(encoded))),
    pagesRead,
    bytesRead,
    depth,
    bytesPrepared: pages.reduce((sum, encoded) => sum + encoded.bytes.length, 0),
  });
  preparedInsertions.set(
    prepared,
    Object.freeze({
      before,
      after,
      entry,
      pages: Object.freeze(pages.map((page) => Object.freeze({ ...page.descriptor.page }))),
    }),
  );
  return prepared;
}

/** Small-book audit oracle, not indexed posting or scalable reconstruction.
 * The canonical source is real replay-verified history. Hash collisions fail
 * closed; normal point lookup will separately need original-identity resolution. */
export async function auditStoredIdentityIndex(
  ledger: ProductionLedger,
  rootInput: unknown,
  expectedHash: string,
  read: IndexPageReader,
) {
  const source = await readCanonicalIdentityPopulation(ledger);
  const root = verifyIndexRoot(rootInput, expectedHash);
  requireLedger(
    BigInt(root.population) === BigInt(source.entries.length),
    "index_identity_population_incomplete",
  );
  const expected = new Map<string, CanonicalIdentity>();
  for (const entry of source.entries) {
    const key = identityIndexKey(entry);
    requireLedger(!expected.has(key), "index_identity_digest_collision");
    expected.set(key, entry);
  }
  let count = 0n;
  for await (const entry of enumerateIndexPages(root, expectedHash, read)) {
    const original = expected.get(entry.key);
    requireLedger(
      original && original.outcomeSequence === entry.sequence,
      "index_identity_mismatch",
    );
    expected.delete(entry.key);
    count++;
  }
  requireLedger(expected.size === 0, "index_identity_population_incomplete");
  return Object.freeze({
    bookId: source.bookId,
    head: source.head,
    rootHash: root.contentHash,
    identities: count,
    populationHash: source.populationHash,
    exactEntriesVerified: true as const,
    pageIntegrityVerified: true as const,
  });
}
