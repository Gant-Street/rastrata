import {
  decodeDurableBook,
  encodeDurableBook,
  hashCanonical,
  DURABLE_BOOK_CODEC_VERSION,
  type BookState,
  type BookProtocolState,
  type AccountingCanonicalState,
} from "@rastrata/kernel";
import { emptyLogicalMap, logicalMapHash, prepareLogicalChange } from "./logical-map.ts";
import { requireLedger } from "./records.ts";

/** Exact legacy-content projection oracle, NOT the future indexed kernel codec.
 * It materializes the bounded legacy aggregate and cannot confer live book/head
 * authority. Production adoption still requires independently verified replay. */
export const LOGICAL_BOOK_PROJECTION = "rastrata-legacy-state-projection-candidate-v1";
type Disposition =
  | "revisionAlias"
  | "header"
  | "legacyHash"
  | "configurationAlias"
  | "sequence"
  | "replaceableSequence"
  | "singleton"
  | "accountingCatalog";
export const LOGICAL_STATE_FIELDS = Object.freeze({
  inventoryOwnershipEffects: "revisionAlias",
  identity: "header",
  financialIdentityHash: "header",
  contentHash: "legacyHash",
  status: "header",
  bookRevision: "header",
  latestPostingSequence: "header",
  configurationRevision: "header",
  configurationHash: "header",
  configurationSnapshots: "sequence",
  activeConfigurationSnapshot: "configurationAlias",
  openingBoundary: "singleton",
  periods: "configurationAlias",
  admissionSnapshot: "configurationAlias",
  policies: "configurationAlias",
  quantizationPolicies: "configurationAlias",
  accountingPolicySnapshot: "configurationAlias",
  accountingState: "accountingCatalog",
  lots: "replaceableSequence",
  lotHoldings: "replaceableSequence",
  lotAllocations: "replaceableSequence",
  journals: "sequence",
  corrections: "sequence",
  periodTransitions: "sequence",
  closePackages: "sequence",
  revisions: "sequence",
} satisfies Record<keyof BookState, Disposition>);
export const LOGICAL_ACCOUNTING_FIELDS = Object.freeze({
  provisionalInventoryLayers: true,
  inventoryRecostings: true,
  inventoryValueAdjustments: true,
  openItems: true,
  settlements: true,
  settlementAllocations: true,
  remeasurementResults: true,
  remeasurementReversals: true,
  allocationSchedules: true,
  allocationRecognitions: true,
  allocationScheduleRevisions: true,
  taxDeterminations: true,
  consolidationCompilations: true,
} satisfies Record<keyof AccountingCanonicalState, true>);
const PROTOCOL_FIELDS = { retainedResults: true } satisfies Record<keyof BookProtocolState, true>;

export interface LogicalProjectionRow {
  readonly ordinal: bigint;
  readonly key: string;
  readonly encoded: string;
  readonly contentHash: string;
}
export interface LogicalProjectionCollection {
  readonly name: string;
  readonly domain: string;
  readonly encodedRoot: string;
  readonly rootHash: string;
  readonly rows: readonly LogicalProjectionRow[];
}

// Read the existing codec's canonical tagged wire nodes rather than inventing a
// money encoder or reducing exact rationals/decimals to untagged object shapes.
function members(value: unknown): Map<string, unknown> {
  requireLedger(
    Array.isArray(value) && value.length === 2 && value[0] === "o" && Array.isArray(value[1]),
    "logical_book_wire_invalid",
  );
  const result = new Map<string, unknown>();
  for (const entry of value[1]) {
    requireLedger(
      Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        !result.has(entry[0]),
      "logical_book_wire_invalid",
    );
    result.set(entry[0], entry[1]);
  }
  return result;
}
function array(value: unknown): readonly unknown[] {
  requireLedger(
    Array.isArray(value) && value.length === 2 && value[0] === "a" && Array.isArray(value[1]),
    "logical_book_wire_invalid",
  );
  return value[1];
}
function exactFields(
  values: ReadonlyMap<string, unknown>,
  fields: object,
  optional: readonly string[] = [],
) {
  requireLedger(
    [...values.keys()].every((key) => Object.hasOwn(fields, key)) &&
      Object.keys(fields).every((key) => optional.includes(key) || values.has(key)),
    "logical_book_unmapped_field",
  );
}

export async function projectLegacyLogicalBook(encoded: string) {
  requireLedger(typeof encoded === "string", "logical_book_source_invalid");
  const decoded = decodeDurableBook(encoded);
  requireLedger(decoded.disposition === "decoded", "logical_book_source_invalid");
  requireLedger(
    encodeDurableBook(decoded.aggregate) === encoded,
    "logical_book_source_noncanonical",
  );
  const wire = JSON.parse(encoded);
  const aggregate = members(wire.body);
  exactFields(aggregate, { state: true, protocol: true });
  const state = members(aggregate.get("state"));
  const accounting = members(state.get("accountingState"));
  const protocol = members(aggregate.get("protocol"));
  exactFields(state, LOGICAL_STATE_FIELDS, ["openingBoundary", "inventoryOwnershipEffects"]);
  exactFields(accounting, LOGICAL_ACCOUNTING_FIELDS);
  exactFields(protocol, PROTOCOL_FIELDS);
  const financialIdentity = JSON.stringify(state.get("financialIdentityHash"));
  const nodes = new Map<string, string>();
  const readNode = async (digest: string) => nodes.get(digest);
  const collections: LogicalProjectionCollection[] = [];
  const header: Record<string, string> = {};
  const aliases: Record<string, string> = {};
  async function collect(name: string, values: readonly unknown[]) {
    const domain = hashCanonical({
      profile: LOGICAL_BOOK_PROJECTION,
      sourceCodec: DURABLE_BOOK_CODEC_VERSION,
      financialIdentity,
      collection: name,
      keySchema: "one-based-256-bit-ordinal",
    }).digest;
    let encodedRoot = emptyLogicalMap(domain);
    let rootHash = logicalMapHash(encodedRoot, domain);
    const rows: LogicalProjectionRow[] = [];
    for (let index = 0; index < values.length; index++) {
      const ordinal = BigInt(index) + 1n;
      const key = ordinal.toString(16).padStart(64, "0");
      const row = JSON.stringify(values[index]);
      const contentHash = hashCanonical({ domain, ordinal, encoded: row }).digest;
      const result = await prepareLogicalChange(
        encodedRoot,
        rootHash,
        domain,
        key,
        null,
        contentHash,
        readNode,
      );
      for (const node of result.nodes) nodes.set(node.digest, node.encoded);
      encodedRoot = result.encodedRoot;
      rootHash = result.rootHash;
      rows.push(Object.freeze({ ordinal, key, encoded: row, contentHash }));
    }
    collections.push(
      Object.freeze({ name, domain, encodedRoot, rootHash, rows: Object.freeze(rows) }),
    );
  }
  for (const [name, disposition] of Object.entries(LOGICAL_STATE_FIELDS)) {
    const value = state.get(name);
    switch (disposition) {
      case "revisionAlias":
        // decodeDurableBook above proved exact equality to immutable revision
        // effects. The complete revision rows below already commit this history.
        break;
      case "header":
        header[name] = JSON.stringify(value);
        break;
      case "legacyHash":
        break; // Kept as source evidence below, not a new-state root.
      case "configurationAlias":
        aliases[name] = hashCanonical({
          profile: LOGICAL_BOOK_PROJECTION,
          alias: name,
          encoded: JSON.stringify(value),
        }).digest;
        break;
      case "singleton":
        await collect(`state.${name}`, value === undefined ? [] : [value]);
        break;
      case "sequence":
      case "replaceableSequence":
        await collect(`state.${name}`, array(value));
        break;
      case "accountingCatalog":
        for (const field of Object.keys(LOGICAL_ACCOUNTING_FIELDS))
          await collect(`state.accountingState.${field}`, array(accounting.get(field)));
        break;
      default: {
        const unsupported: never = disposition;
        throw new Error(`Unsupported logical projection disposition: ${String(unsupported)}`);
      }
    }
  }
  for (const name of Object.keys(PROTOCOL_FIELDS))
    await collect(`protocol.${name}`, array(protocol.get(name)));
  const headerHash = hashCanonical({
    profile: LOGICAL_BOOK_PROJECTION,
    sourceCodec: DURABLE_BOOK_CODEC_VERSION,
    header,
    aliases,
  }).digest;
  const roots = (prefix: string) =>
    collections
      .filter((c) => c.name.startsWith(prefix))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((c) => ({ name: c.name, rootHash: c.rootHash, population: BigInt(c.rows.length) }));
  return Object.freeze({
    profile: LOGICAL_BOOK_PROJECTION,
    sourceCodec: DURABLE_BOOK_CODEC_VERSION,
    sourceAggregateHash: hashCanonical({ profile: LOGICAL_BOOK_PROJECTION, encoded }).digest,
    legacyStateHash: decoded.aggregate.state.contentHash,
    headerHash,
    stateRoot: hashCanonical({
      profile: LOGICAL_BOOK_PROJECTION,
      financialIdentity,
      headerHash,
      collections: roots("state."),
    }).digest,
    protocolRoot: hashCanonical({
      profile: LOGICAL_BOOK_PROJECTION,
      financialIdentity,
      collections: roots("protocol."),
    }).digest,
    collections: Object.freeze(collections),
    readNode,
  });
}
