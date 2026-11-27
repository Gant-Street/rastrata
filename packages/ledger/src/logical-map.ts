import { hashCanonical } from "@rastrata/kernel";
import { requireLedger } from "./records.ts";

/** Candidate logical commitment codec, not an enabled ledger/kernel format.
 * Binary Patricia shape depends only on key/value content, not insertion order or
 * physical placement. Selected-root authority and canonical row projection remain
 * owner obligations. Hash-addressed nodes here are NOT reclaimable page locations. */
export const LOGICAL_MAP_VERSION = "rastrata-logical-map-candidate-v1";
const HEX = /^[0-9a-f]{64}$/;
const NAT = /^[1-9][0-9]{0,19}$/;
const MAX_COUNT = (1n << 64n) - 1n;
const MAX_BYTES = 2048;
interface Reference {
  readonly digest: string;
  readonly min: string;
  readonly max: string;
  readonly count: string;
}
type Node =
  | { readonly kind: "leaf"; readonly key: string; readonly value: string }
  | { readonly kind: "branch"; readonly left: Reference; readonly right: Reference };
export type LogicalNodeReader = (digest: string) => Promise<string | undefined>;
export interface LogicalMapMetrics {
  readonly nodesRead: number;
  readonly bytesRead: number;
  readonly nodesCreated: number;
  readonly bytesCreated: number;
}

function digest(value: unknown): asserts value is string {
  requireLedger(typeof value === "string" && HEX.test(value), "logical_map_digest_invalid");
}
function keys(value: unknown, expected: string): asserts value is Record<string, unknown> {
  requireLedger(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "logical_map_shape_invalid",
  );
  requireLedger(Object.keys(value).sort().join(",") === expected, "logical_map_shape_invalid");
}
function reference(value: unknown): Reference {
  keys(value, "count,digest,max,min");
  digest(value.digest);
  digest(value.min);
  digest(value.max);
  requireLedger(
    typeof value.count === "string" && NAT.test(value.count) && BigInt(value.count) <= MAX_COUNT,
    "logical_map_count_invalid",
  );
  requireLedger(
    value.min <= value.max && (value.min === value.max) === (value.count === "1"),
    "logical_map_range_invalid",
  );
  return Object.freeze({
    digest: value.digest,
    min: value.min,
    max: value.max,
    count: value.count,
  });
}
function firstDifference(a: string, b: string): number {
  for (let i = 0; i < 64; i++) {
    const xor = Number.parseInt(a[i] ?? "", 16) ^ Number.parseInt(b[i] ?? "", 16);
    if (xor) return i * 4 + Math.clz32(xor) - 28;
  }
  return 256;
}
function bit(key: string, position: number): number {
  return (Number.parseInt(key[Math.floor(position / 4)] ?? "", 16) >> (3 - (position % 4))) & 1;
}
function branch(left: Reference, right: Reference): Node {
  requireLedger(left.max < right.min, "logical_map_range_invalid");
  const split = firstDifference(left.min, right.max);
  requireLedger(
    split < 256 &&
      bit(left.min, split) === 0 &&
      bit(right.min, split) === 1 &&
      firstDifference(left.min, left.max) > split &&
      firstDifference(right.min, right.max) > split,
    "logical_map_branch_noncanonical",
  );
  requireLedger(BigInt(left.count) + BigInt(right.count) <= MAX_COUNT, "logical_map_count_invalid");
  return Object.freeze({ kind: "branch", left, right });
}
function decodeNode(encoded: string): Node {
  requireLedger(encoded.length <= MAX_BYTES, "logical_map_bytes_exceeded");
  const raw: unknown = JSON.parse(encoded);
  keys(
    raw,
    typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "leaf"
      ? "key,kind,value"
      : "kind,left,right",
  );
  let node: Node;
  if (raw.kind === "leaf") {
    digest(raw.key);
    digest(raw.value);
    node = Object.freeze({ kind: "leaf", key: raw.key, value: raw.value });
  } else {
    requireLedger(raw.kind === "branch", "logical_map_shape_invalid");
    node = branch(reference(raw.left), reference(raw.right));
  }
  requireLedger(JSON.stringify(node) === encoded, "logical_map_encoding_noncanonical");
  return node;
}
function hash(domain: string, kind: string, encoded: string): string {
  return hashCanonical({ version: LOGICAL_MAP_VERSION, domain, kind, encoded }).digest;
}
function describe(domain: string, node: Node, encoded: string): Reference {
  return Object.freeze({
    digest: hash(domain, "node", encoded),
    min: node.kind === "leaf" ? node.key : node.left.min,
    max: node.kind === "leaf" ? node.key : node.right.max,
    count:
      node.kind === "leaf" ? "1" : (BigInt(node.left.count) + BigInt(node.right.count)).toString(),
  });
}
function encodeRoot(domain: string, tree: Reference | null): string {
  return JSON.stringify({ version: LOGICAL_MAP_VERSION, domain, tree });
}
function decodeRoot(encoded: string, domain: string): Reference | null {
  digest(domain);
  requireLedger(
    typeof encoded === "string" && encoded.length <= MAX_BYTES,
    "logical_map_bytes_exceeded",
  );
  const raw: unknown = JSON.parse(encoded);
  keys(raw, "domain,tree,version");
  requireLedger(
    raw.version === LOGICAL_MAP_VERSION && raw.domain === domain,
    "logical_map_context_mismatch",
  );
  const tree = raw.tree === null ? null : reference(raw.tree);
  requireLedger(encodeRoot(domain, tree) === encoded, "logical_map_encoding_noncanonical");
  return tree;
}

/** Domain is the complete validated financial/profile/collection/key-schema hash;
 * no storage identity, generation, fence or physical address belongs in it. */
export function emptyLogicalMap(domain: string): string {
  digest(domain);
  return encodeRoot(domain, null);
}
export function logicalMapHash(encoded: string, domain: string): string {
  decodeRoot(encoded, domain);
  return hash(domain, "root", encoded);
}

function operation(
  encoded: string,
  expectedHash: string,
  domain: string,
  key: string,
  read: LogicalNodeReader,
) {
  digest(expectedHash);
  digest(key);
  const tree = decodeRoot(encoded, domain);
  requireLedger(hash(domain, "root", encoded) === expectedHash, "logical_map_root_mismatch");
  const metrics = { nodesRead: 0, bytesRead: 0, nodesCreated: 0, bytesCreated: 0 };
  const created: { readonly digest: string; readonly encoded: string }[] = [];
  async function load(ref: Reference, depth: number): Promise<Node> {
    requireLedger(depth <= 256, "logical_map_depth_exceeded");
    const body = await read(ref.digest);
    requireLedger(typeof body === "string", "logical_map_node_missing");
    metrics.nodesRead++;
    requireLedger(body.length <= MAX_BYTES, "logical_map_bytes_exceeded");
    metrics.bytesRead += body.length;
    const node = decodeNode(body);
    requireLedger(
      JSON.stringify(describe(domain, node, body)) === JSON.stringify(ref),
      "logical_map_node_mismatch",
    );
    return node;
  }
  function store(node: Node): Reference {
    const body = JSON.stringify(node);
    const ref = describe(domain, node, body);
    created.push(Object.freeze({ digest: ref.digest, encoded: body }));
    metrics.nodesCreated++;
    metrics.bytesCreated += body.length;
    return ref;
  }
  return { tree, metrics, created, load, store };
}

/** Authenticated point/prefix-absence proof only, not a complete population audit. */
export async function lookupLogicalValue(
  encoded: string,
  expectedHash: string,
  domain: string,
  key: string,
  read: LogicalNodeReader,
): Promise<{ readonly value: string | null; readonly metrics: LogicalMapMetrics }> {
  const op = operation(encoded, expectedHash, domain, key, read);
  let ref = op.tree;
  let depth = 0;
  while (ref !== null) {
    const node = await op.load(ref, depth++);
    if (node.kind === "leaf")
      return Object.freeze({
        value: node.key === key ? node.value : null,
        metrics: Object.freeze(op.metrics),
      });
    const split = firstDifference(ref.min, ref.max);
    if (firstDifference(key, ref.min) < split) break;
    ref = bit(key, split) === 0 ? node.left : node.right;
  }
  return Object.freeze({ value: null, metrics: Object.freeze(op.metrics) });
}

export interface LogicalRangePage {
  readonly rootHash: string;
  readonly domain: string;
  readonly fromInclusive: string | null;
  readonly throughExclusive: string | null;
  readonly entries: readonly { readonly key: string; readonly value: string }[];
  readonly complete: boolean;
  /** First unreturned key, authenticated by this page. Null only on exhaustion.
   * A caller must bind continuation to the same root/domain and original range. */
  readonly nextFromInclusive: string | null;
  readonly metrics: LogicalMapMetrics;
}

/** Prove the greatest key through the authenticated right spine. This does not
 * enumerate or audit the whole map. Root selection remains an owner obligation. */
export async function readLogicalLastEntry(
  encoded: string,
  expectedHash: string,
  domain: string,
  read: LogicalNodeReader,
) {
  const op = operation(encoded, expectedHash, domain, "f".repeat(64), read);
  const population = op.tree === null ? 0n : BigInt(op.tree.count);
  let ref = op.tree;
  let depth = 0;
  while (ref !== null) {
    const node = await op.load(ref, depth++);
    if (node.kind === "leaf")
      return Object.freeze({
        rootHash: expectedHash,
        domain,
        population,
        entry: Object.freeze({ key: node.key, value: node.value }),
        metrics: Object.freeze(op.metrics),
      });
    ref = node.right;
  }
  return Object.freeze({
    rootHash: expectedHash,
    domain,
    population: 0n,
    entry: null,
    metrics: Object.freeze(op.metrics),
  });
}

/** Bounded ordered range proof. Prune only using authenticated subtree fences;
 * read one extra matching leaf to distinguish a full final page from truncation.
 * This is a root-bound page, not an owner pin or proof that a client consumed all
 * earlier pages. Missing required bytes throw and produce no successful page. */
export async function readLogicalRangePage(
  encoded: string,
  expectedHash: string,
  domain: string,
  fromInclusive: string | null,
  throughExclusive: string | null,
  limit: number,
  read: LogicalNodeReader,
): Promise<LogicalRangePage> {
  if (fromInclusive !== null) digest(fromInclusive);
  if (throughExclusive !== null) digest(throughExclusive);
  requireLedger(
    fromInclusive === null || throughExclusive === null || fromInclusive <= throughExclusive,
    "logical_map_range_invalid",
  );
  requireLedger(
    Number.isSafeInteger(limit) && limit >= 1 && limit <= 256,
    "logical_map_page_limit_invalid",
  );
  const op = operation(encoded, expectedHash, domain, fromInclusive ?? "0".repeat(64), read);
  const entries: { readonly key: string; readonly value: string }[] = [];
  let next: string | null = null;
  async function visit(ref: Reference, depth: number): Promise<void> {
    if (
      next !== null ||
      (fromInclusive !== null && ref.max < fromInclusive) ||
      (throughExclusive !== null && ref.min >= throughExclusive)
    )
      return;
    const node = await op.load(ref, depth);
    if (node.kind === "leaf") {
      if (entries.length === limit) next = node.key;
      else entries.push(Object.freeze({ key: node.key, value: node.value }));
      return;
    }
    await visit(node.left, depth + 1);
    await visit(node.right, depth + 1);
  }
  if (op.tree !== null && !(fromInclusive !== null && fromInclusive === throughExclusive))
    await visit(op.tree, 0);
  return Object.freeze({
    rootHash: expectedHash,
    domain,
    fromInclusive,
    throughExclusive,
    entries: Object.freeze(entries),
    complete: next === null,
    nextFromInclusive: next,
    metrics: Object.freeze(op.metrics),
  });
}

/** Produces immutable candidate nodes and root, never writes or publishes them.
 * Null expected means proven absence; null next deletes a live-map entry, not its
 * permanent historical identity. Owner must bind this to canonical row changes. */
export async function prepareLogicalChange(
  encoded: string,
  expectedHash: string,
  domain: string,
  key: string,
  expected: string | null,
  next: string | null,
  read: LogicalNodeReader,
) {
  if (expected !== null) digest(expected);
  if (next !== null) digest(next);
  const op = operation(encoded, expectedHash, domain, key, read);
  function absent(ref: Reference | null): Reference | null {
    requireLedger(expected === null, "logical_map_before_mismatch");
    if (next === null) return ref;
    const leaf = op.store(Object.freeze({ kind: "leaf", key, value: next }));
    return ref === null ? leaf : op.store(key < ref.min ? branch(leaf, ref) : branch(ref, leaf));
  }
  async function change(ref: Reference | null, depth: number): Promise<Reference | null> {
    if (ref === null) return absent(null);
    const node = await op.load(ref, depth);
    if (node.kind === "leaf") {
      if (node.key !== key) return absent(ref);
      requireLedger(node.value === expected, "logical_map_before_mismatch");
      return next === node.value
        ? ref
        : next === null
          ? null
          : op.store(Object.freeze({ kind: "leaf", key, value: next }));
    }
    const split = firstDifference(ref.min, ref.max);
    if (firstDifference(key, ref.min) < split) return absent(ref);
    const left = bit(key, split) === 0;
    const prior = left ? node.left : node.right;
    const updated = await change(prior, depth + 1);
    if (updated === prior) return ref;
    if (updated === null) return left ? node.right : node.left;
    return op.store(left ? branch(updated, node.right) : branch(node.left, updated));
  }
  const resulting = encodeRoot(domain, await change(op.tree, 0));
  return Object.freeze({
    encodedRoot: resulting,
    rootHash: hash(domain, "root", resulting),
    nodes: Object.freeze(op.created),
    metrics: Object.freeze(op.metrics),
  });
}

/** Full content/shape audit; completion is required. The optional observer can
 * compare each ordered row with independently verified canonical accounting data.
 * A structural audit alone does not establish canonical population completeness. */
export async function auditLogicalMap(
  encoded: string,
  expectedHash: string,
  domain: string,
  read: LogicalNodeReader,
  observe?: (key: string, value: string) => void | Promise<void>,
) {
  const op = operation(encoded, expectedHash, domain, "0".repeat(64), read);
  const stack = op.tree === null ? [] : [{ ref: op.tree, depth: 0 }];
  let population = 0n;
  while (stack.length) {
    const frame = stack.pop();
    requireLedger(frame !== undefined, "logical_map_shape_invalid");
    const node = await op.load(frame.ref, frame.depth);
    if (node.kind === "leaf") {
      await observe?.(node.key, node.value);
      population++;
    } else {
      stack.push(
        { ref: node.right, depth: frame.depth + 1 },
        { ref: node.left, depth: frame.depth + 1 },
      );
    }
  }
  requireLedger(population.toString() === (op.tree?.count ?? "0"), "logical_map_count_invalid");
  return Object.freeze({ population, metrics: Object.freeze(op.metrics) });
}
