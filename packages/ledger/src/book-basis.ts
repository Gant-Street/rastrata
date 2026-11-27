import {
  contentHashEquals,
  hashFinancialIdentity,
  hashBookConfigurationSnapshot,
  encodeBookRow,
  decodeBookRow,
  encodeBookStateHeader,
  type BookState,
  type BookRowCollection,
  type BookRowTypes,
} from "@rastrata/kernel";
import type { CapturedRow } from "./source-catalog.ts";
import { COMPACT_LEDGER_FORMAT, requireLedger, type LedgerHead } from "./records.ts";
import { ledgerIndexHeadCommitment } from "./index-view-audit.ts";
import {
  decodeIndexedBookHead,
  type IndexedBookHead,
  type IndexedBookState,
} from "./indexed-book-state.ts";

export type SourcedBasisRow<C extends BookRowCollection> = Omit<
  CapturedRow,
  "disposition" | "encoded" | "rowHash"
> & {
  readonly disposition: "present";
  readonly encoded: string;
  readonly rowHash: string;
  readonly row: BookRowTypes[C];
};
export interface PinnedBookBasis {
  readonly catalogDigest: string;
  readonly headHash: string;
  /** Scalars from complete verified recovery, bound to this live full head.
   * contentHash commits the WHOLE original kernel state, not this partial header
   * or the separate indexed state/head framing. No hash-domain equivalence is implied. */
  readonly header: Pick<
    BookState,
    | "identity"
    | "financialIdentityHash"
    | "contentHash"
    | "status"
    | "bookRevision"
    | "latestPostingSequence"
    | "configurationRevision"
    | "configurationHash"
  >;
  readonly configuration: SourcedBasisRow<"state.configurationSnapshots">;
  readonly openingBoundary: SourcedBasisRow<"state.openingBoundary"> | null;
  readonly financialRevision: SourcedBasisRow<"state.revisions"> | null;
}

/** Internal common-read boundary, not a complete command read set or accounting
 * admission. Only the owner supplies a fully recovered canonical state, pinned
 * head and authenticated current-row port. No full history scan occurs here. */
export async function readPinnedBookBasis(
  state: BookState,
  head: LedgerHead,
  catalogDigest: string,
  rawRow: (collection: string, ordinal: bigint) => Promise<CapturedRow>,
  confirm: () => Promise<void>,
): Promise<PinnedBookBasis> {
  const headHash = ledgerIndexHeadCommitment(head, COMPACT_LEDGER_FORMAT);
  await confirm();
  requireLedger(
    head.bookRevision === String(state.bookRevision) &&
      head.postingSequence === String(state.latestPostingSequence) &&
      head.configurationRevision === String(state.configurationRevision) &&
      head.configurationHash === state.configurationHash.digest &&
      head.stateHash === state.contentHash.digest &&
      contentHashEquals(hashFinancialIdentity(state.identity), state.financialIdentityHash),
    "book_basis_header_mismatch",
  );
  return readBasisRows(state, headHash, head.revisionHash ?? null, catalogDigest, rawRow, confirm);
}

/** New-format counterpart. The owner has already replayed accounting and compared
 * every indexed state projection. Authenticate the distinct indexed head/header;
 * do not manufacture a legacy LedgerHead or treat its state hash as equivalent. */
export async function readPinnedIndexedBookBasis(
  state: BookState,
  indexed: IndexedBookState,
  head: IndexedBookHead,
  catalogDigest: string,
  rawRow: (collection: string, ordinal: bigint) => Promise<CapturedRow>,
  confirm: () => Promise<void>,
): Promise<PinnedBookBasis> {
  await confirm();
  const verified = decodeIndexedBookHead(
    JSON.stringify(head),
    indexed,
    head.identity,
    head.identity.objectId,
  );
  requireLedger(
    indexed.header ===
      encodeBookStateHeader({
        identity: state.identity,
        financialIdentityHash: state.financialIdentityHash,
        status: state.status,
        bookRevision: state.bookRevision,
        latestPostingSequence: state.latestPostingSequence,
        configurationRevision: state.configurationRevision,
        configurationHash: state.configurationHash,
      }) && contentHashEquals(hashFinancialIdentity(state.identity), state.financialIdentityHash),
    "book_basis_header_mismatch",
  );
  return readBasisRows(
    state,
    verified.contentHash,
    verified.revisionHash?.digest ?? null,
    catalogDigest,
    rawRow,
    confirm,
  );
}

async function readBasisRows(
  state: BookState,
  headHash: string,
  revisionHash: string | null,
  catalogDigest: string,
  rawRow: (collection: string, ordinal: bigint) => Promise<CapturedRow>,
  confirm: () => Promise<void>,
): Promise<PinnedBookBasis> {
  const header = Object.freeze({
    identity: Object.freeze({ ...state.identity }),
    financialIdentityHash: Object.freeze({ ...state.financialIdentityHash }),
    contentHash: Object.freeze({ ...state.contentHash }),
    status: state.status,
    bookRevision: state.bookRevision,
    latestPostingSequence: state.latestPostingSequence,
    configurationRevision: state.configurationRevision,
    configurationHash: Object.freeze({ ...state.configurationHash }),
  });
  async function fetch<C extends BookRowCollection>(
    collection: C,
    ordinal: bigint,
    expected: BookRowTypes[C] | undefined,
  ): Promise<SourcedBasisRow<C> | null> {
    const raw = await rawRow(collection, ordinal);
    requireLedger(
      raw.catalogDigest === catalogDigest &&
        raw.headHash === headHash &&
        raw.collection === collection &&
        raw.ordinal === ordinal,
      "book_basis_source_mismatch",
    );
    if (expected === undefined) {
      requireLedger(
        raw.disposition === "absent" && raw.rowHash === null && raw.encoded === null,
        "book_basis_source_mismatch",
      );
      return null;
    }
    requireLedger(
      raw.disposition === "present" &&
        raw.rowHash !== null &&
        raw.encoded !== null &&
        raw.encoded === encodeBookRow(collection, expected),
      "book_basis_source_mismatch",
    );
    const decoded = decodeBookRow(collection, raw.encoded);
    requireLedger(decoded.disposition === "decoded", "book_basis_source_mismatch");
    return Object.freeze({
      ...raw,
      disposition: "present",
      rowHash: raw.rowHash,
      encoded: raw.encoded,
      row: decoded.row,
    });
  }
  const configuration = await fetch(
    "state.configurationSnapshots",
    state.configurationRevision + 1n,
    state.activeConfigurationSnapshot,
  );
  requireLedger(
    configuration &&
      configuration.row.revision === state.configurationRevision &&
      configuration.row.admissionSnapshot.bookId === state.identity.bookId &&
      contentHashEquals(configuration.row.contentHash, state.configurationHash) &&
      contentHashEquals(hashBookConfigurationSnapshot(configuration.row), state.configurationHash),
    "book_basis_configuration_mismatch",
  );
  const openingBoundary = await fetch("state.openingBoundary", 1n, state.openingBoundary);
  const financialRevision = await fetch(
    "state.revisions",
    state.bookRevision === 0n ? 1n : state.bookRevision,
    state.revisions.at(-1),
  );
  requireLedger(
    state.bookRevision === 0n
      ? financialRevision === null
      : financialRevision !== null &&
          financialRevision.row.bookRevision === state.bookRevision &&
          financialRevision.row.bookId === state.identity.bookId &&
          financialRevision.row.chainHash.digest === revisionHash,
    "book_basis_revision_mismatch",
  );
  await confirm();
  return Object.freeze({
    catalogDigest,
    headHash,
    header,
    configuration,
    openingBoundary,
    financialRevision,
  });
}
