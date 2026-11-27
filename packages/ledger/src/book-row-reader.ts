import {
  decodeBookRow,
  encodeBookRow,
  identifier,
  resolveInventoryOwnershipSources,
  type InventoryPostedPosition,
  type InventoryPostedAnchor,
  type BookRowCollection,
  type BookRowTypes,
  type AccountingEffect,
  type BookCommand,
  type BookCommandProtocolEvaluation,
  type BookEffect,
  type ExactRational,
} from "@rastrata/kernel";
import { createPinnedGroupCursor, type PinnedGroupCursor } from "./group-reader.ts";
import type { SqliteSemanticGroupCatalog, CapturedGroupCatalog } from "./group-catalog.ts";
import type { PinnedBookBasis } from "./book-basis.ts";
import { readPinnedAdmissionFacts, type PinnedAdmissionFacts } from "./admission-facts.ts";
import { readPinnedInventoryCostFacts, type PinnedInventoryCostFacts } from "./inventory-facts.ts";
import {
  readPinnedOwnedInventoryPools,
  type PinnedOwnedInventoryPools,
} from "./owned-inventory-pools.ts";
import {
  semanticGroupKey,
  projectSemanticGroupMemberships,
  SEMANTIC_GROUP_COLLECTIONS,
  type SemanticGroupKind,
  type SemanticGroupKey,
  type InventoryMoneyScope,
  moneyScopeValues,
  snapshotMoneyScope,
} from "./semantic-groups.ts";
import type { CapturedRow } from "./source-catalog.ts";
import {
  decodeRetainedCommandIdentity,
  resolveJournalIdentity,
  resolveActivationIdentity,
  resolveAccountingIdentity,
  isAccountingIdentityFamily,
  resolveLotIdentityOrdinal,
  decodeLotIdentityRow,
  isLotIdentityFamily,
  LOT_IDENTITY_COLLECTIONS,
  type LotIdentityFamily,
  type InventoryIdentityKind,
  type InventoryIdentityRows,
  INVENTORY_IDENTITY_FAMILIES,
  isInventoryIdentityKind,
  resolveInventoryIdentity,
} from "./outcome-identities.ts";
import { identityIndexKey } from "./index-pages.ts";
import { LEDGER_LIMITS, requireLedger, snapshotCommand, type LedgerHead } from "./records.ts";

export interface PinnedBookRowReader<H = LedgerHead> {
  readonly head: H;
  readBookBasis(): Promise<PinnedBookBasis>;
  /** Full-state admission bridge, NOT sparse evaluation or a durable receipt. */
  evaluateAdmission(command: BookCommand): Promise<PinnedBookAdmission>;
  /** Absence applies to this raw boundary ID, not to the entire activation population. */
  readActivationIdentity(boundaryId: string): Promise<PinnedActivationIdentityRead>;
  readAdmissionFacts(command: BookCommand): Promise<PinnedAdmissionFacts>;
  readInventoryCostFacts(command: BookCommand): Promise<PinnedInventoryCostFacts>;
  readOwnedInventoryPools(command: BookCommand): Promise<PinnedOwnedInventoryPools>;
  readInventoryMoneyScope(scope: InventoryMoneyScope): Promise<PinnedInventoryMoneyScope>;
  readInventorySourceJournal(journalId: string): Promise<PinnedInventorySourceJournal>;
  /** Global canonical occupancy, not an inventory artifact lookup. */
  readPostingReferenceUsage(referenceId: string): Promise<PinnedPostingReferenceUsage>;
  readAllocationIdentityPresence(id: string): Promise<PinnedAllocationIdentityPresence>;
  read(collection: string, ordinal: bigint): Promise<CapturedRow>;
  readTyped<C extends BookRowCollection>(
    collection: C,
    ordinal: bigint,
  ): Promise<TypedPinnedRow<C>>;
  readCommand(commandId: string): Promise<PinnedCommandRead>;
  readJournalIdentity(
    family: "journal" | "posting",
    id: string,
  ): Promise<PinnedJournalIdentityRead>;
  readAccountingIdentity<F extends AccountingEffect["type"]>(
    family: F,
    id: string,
  ): Promise<PinnedAccountingIdentityRead<F>>;
  readLotIdentity<F extends LotIdentityFamily>(
    family: F,
    id: string,
  ): Promise<PinnedLotIdentityRead<F>>;
  readInventoryIdentity<K extends InventoryIdentityKind>(
    kind: K,
    id: string,
  ): Promise<PinnedInventoryIdentityRead<K>>;
  readInventoryPosition(holdingId: string): Promise<PinnedInventoryPositionRead>;
  openGroup<K extends SemanticGroupKind>(
    kind: K,
    values: readonly string[],
    limit?: number,
    maxRowBytes?: number,
  ): Promise<PinnedGroupCursor<K>>;
  close(): Promise<void>;
}
export interface PinnedBookAdmission {
  readonly commandId: BookCommand["id"];
  readonly commandInputHash: BookCommand["inputHash"];
  readonly headHash: string;
  readonly catalogDigest: string;
  readonly evaluation: BookCommandProtocolEvaluation;
}
export interface CanonicalRevisionWitness {
  readonly revisionOrdinal: bigint;
  readonly revisionRowHash: string;
  readonly memberHash: string;
  readonly population: bigint;
}
export type InventoryRevisionWitness = CanonicalRevisionWitness;
export interface PinnedPostingReferenceUsage {
  readonly referenceId: string;
  readonly headHash: string;
  readonly catalogDigest: string;
  readonly disposition: "used" | "unused";
  /** Latest use, not original creation or proof of a unique reference value. */
  readonly witness: CanonicalRevisionWitness | null;
}
export interface PinnedAllocationIdentityPresence {
  readonly id: string;
  readonly headHash: string;
  readonly catalogDigest: string;
  readonly disposition: "present" | "absent";
  readonly origin: "legacy" | "owned" | null;
}
export interface PinnedInventoryMoneyScope {
  readonly scope: InventoryMoneyScope;
  readonly headHash: string;
  readonly catalogDigest: string;
  readonly ownership: "managed" | "unmanaged";
  readonly ownershipWitness: InventoryRevisionWitness | null;
  readonly postedBalance: ExactRational;
  readonly journals: {
    readonly descriptorHash: string | null;
    readonly memberHash: string | null;
    readonly population: bigint;
  };
}
export interface PinnedInventorySourceJournal {
  readonly journalId: string;
  readonly headHash: string;
  readonly catalogDigest: string;
  /** Unreferenced does not prove that the journal itself exists or is absent. */
  readonly disposition: "referenced" | "unreferenced";
  readonly witness: InventoryRevisionWitness | null;
}
export type PinnedInventoryPositionRead = {
  readonly id: string;
  readonly headHash: string;
  readonly catalogDigest: string;
  readonly current: PinnedLotIdentityRead<"lotHolding">;
} & (
  | {
      readonly disposition: "absent" | "unowned";
      readonly position: null;
      readonly anchor: null;
      readonly revisionOrdinal: null;
      readonly revisionRowHash: null;
      readonly groupMemberHash: null;
      readonly groupPopulation: 0n;
    }
  | {
      readonly disposition: "owned";
      readonly position: InventoryPostedPosition;
      readonly anchor: InventoryPostedAnchor;
      readonly revisionOrdinal: bigint;
      readonly revisionRowHash: string;
      readonly groupMemberHash: string;
      readonly groupPopulation: bigint;
    }
);

export type PinnedCommandRead = {
  readonly commandId: string;
  readonly catalogDigest: string;
  readonly headHash: string;
} & (
  | {
      readonly disposition: "present";
      readonly ordinal: bigint;
      readonly rowHash: string;
      readonly encoded: string;
      readonly row: BookRowTypes["protocol.retainedResults"];
    }
  | {
      readonly disposition: "absent";
      readonly ordinal: null;
      readonly rowHash: null;
      readonly encoded: null;
      readonly row: null;
    }
);
export type TypedPinnedRow<C extends BookRowCollection> = Omit<CapturedRow, "disposition"> &
  (
    | { readonly disposition: "present"; readonly row: BookRowTypes[C] }
    | { readonly disposition: "absent"; readonly row: null }
  );
export type PinnedJournalIdentityRead = {
  readonly family: "journal" | "posting";
  readonly id: string;
  readonly catalogDigest: string;
  readonly headHash: string;
} & (
  | {
      readonly disposition: "present";
      readonly outcomeSequence: bigint;
      readonly journal: Extract<TypedPinnedRow<"state.journals">, { disposition: "present" }>;
      readonly posting: BookRowTypes["state.journals"]["journal"]["postings"][number] | null;
    }
  | {
      readonly disposition: "absent";
      readonly outcomeSequence: null;
      readonly journal: null;
      readonly posting: null;
    }
);
export type PinnedActivationIdentityRead = {
  readonly id: string;
  readonly catalogDigest: string;
  readonly headHash: string;
} & (
  | {
      readonly disposition: "present";
      readonly outcomeSequence: bigint;
      readonly bookRevision: bigint;
      readonly sourceRevisionRowHash: string;
      readonly effect: Extract<BookEffect, { type: "activation" }>;
    }
  | {
      readonly disposition: "absent";
      readonly outcomeSequence: null;
      readonly bookRevision: null;
      readonly sourceRevisionRowHash: null;
      readonly effect: null;
    }
);
export type PinnedAccountingIdentityRead<F extends AccountingEffect["type"]> = {
  readonly family: F;
  readonly id: string;
  readonly catalogDigest: string;
  readonly headHash: string;
} & (
  | {
      readonly disposition: "present";
      readonly outcomeSequence: bigint;
      readonly bookRevision: bigint;
      /** Commitment to the authenticated creating revision, not a guessed effect-row ordinal. */
      readonly sourceRevisionRowHash: string;
      readonly effect: Extract<AccountingEffect, { readonly type: F }>;
    }
  | {
      readonly disposition: "absent";
      readonly outcomeSequence: null;
      readonly bookRevision: null;
      readonly sourceRevisionRowHash: null;
      readonly effect: null;
    }
);
export type PinnedLotIdentityRead<F extends LotIdentityFamily> = {
  readonly family: F;
  readonly id: string;
  readonly catalogDigest: string;
  readonly headHash: string;
} & (
  | {
      readonly disposition: "present";
      readonly creationOutcomeSequence: bigint;
      readonly current: Extract<
        TypedPinnedRow<(typeof LOT_IDENTITY_COLLECTIONS)[F]>,
        { disposition: "present" }
      >;
    }
  | {
      readonly disposition: "absent";
      readonly creationOutcomeSequence: null;
      readonly current: null;
    }
);

export type PinnedInventoryIdentityRead<K extends InventoryIdentityKind> = {
  readonly kind: K;
  readonly id: string;
  readonly catalogDigest: string;
  readonly headHash: string;
} & (
  | {
      readonly disposition: "present";
      readonly outcomeSequence: bigint;
      readonly bookRevision: bigint;
      readonly sourceRevisionRowHash: string;
      readonly row: InventoryIdentityRows[K];
    }
  | {
      readonly disposition: "absent";
      readonly outcomeSequence: null;
      readonly bookRevision: null;
      readonly sourceRevisionRowHash: null;
      readonly row: null;
    }
);

interface Ports<H> {
  readonly head: H;
  readonly headHash: string;
  readonly bookId: string;
  readonly catalogDigest: string;
  readonly groups: SqliteSemanticGroupCatalog;
  readonly groupCapture: CapturedGroupCatalog;
  readonly collectionDomain: (collection: BookRowCollection) => string;
  readonly basis: () => Promise<PinnedBookBasis>;
  readonly admission: (command: BookCommand) => BookCommandProtocolEvaluation;
  readonly rawRow: (collection: string, ordinal: bigint) => Promise<CapturedRow>;
  readonly lookup: (key: string) => Promise<bigint | null>;
  readonly confirm: () => Promise<void>;
  readonly release: () => Promise<void>;
}

/** Internal reader over owner-authenticated ports. Opening it is NOT recovery or
 * admission authority. Both storage profiles retain their distinct canonical
 * hashes, source catalogs and recovery policy. Every operation confirms the live
 * context before and after delivery; failure retires the entire reader. */
export function createPinnedBookRowReader<H>(ports: Ports<H>): PinnedBookRowReader<H> {
  const head = ports.head,
    headHash = ports.headHash;
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  }
  const retire = async () => {
    closed = true;
    await ports.release();
  };
  const confirm = ports.confirm;
  const rawRow = ports.rawRow;
  const run = <T>(operation: () => Promise<T>): Promise<T> =>
    serial(async () => {
      requireLedger(!closed, "source_catalog_reader_closed");
      try {
        await confirm();
        const result = await operation();
        await confirm();
        return result;
      } catch (error) {
        try {
          await retire();
        } catch {
          /* durable lease expiry handles uncertain release */
        }
        throw error;
      }
    });
  const read = <T>(collection: string, ordinal: bigint, project: (raw: CapturedRow) => T) =>
    run(async () => project(await rawRow(collection, ordinal)));
  const validateIdentity = (id: string) => {
    requireLedger(
      typeof id === "string" &&
        id.length <= LEDGER_LIMITS.recordBytes &&
        new TextEncoder().encode(id).length <= LEDGER_LIMITS.recordBytes,
      "index_command_id_invalid",
    );
    identifier(id);
  };
  const presentRow = async (collection: string, ordinal: bigint) => {
    const raw = await rawRow(collection, ordinal);
    requireLedger(
      raw.disposition === "present" && raw.encoded !== null && raw.rowHash !== null,
      "index_identity_source_mismatch",
    );
    return {
      ...raw,
      disposition: "present" as const,
      encoded: raw.encoded,
      rowHash: raw.rowHash,
    };
  };
  const creationRows = async (sequence: bigint) => {
    const retained = await presentRow("protocol.retainedResults", sequence);
    const result = decodeBookRow("protocol.retainedResults", retained.encoded);
    requireLedger(
      result.disposition === "decoded" && result.row.outcome === "committed",
      "index_identity_source_mismatch",
    );
    const bookRevision = result.row.observedBookRevision;
    const revision = await presentRow("state.revisions", bookRevision);
    return { retained, revision, bookRevision };
  };
  const readLotIdentity = async <F extends LotIdentityFamily>(
    family: F,
    id: string,
  ): Promise<PinnedLotIdentityRead<F>> => {
    requireLedger(isLotIdentityFamily(family), "index_identity_family_invalid");
    validateIdentity(id);
    const sequence = await ports.lookup(identityIndexKey({ bookId: ports.bookId, family, id }));
    const context = { family, id, catalogDigest: ports.catalogDigest, headHash };
    if (sequence === null)
      return Object.freeze({
        ...context,
        disposition: "absent",
        creationOutcomeSequence: null,
        current: null,
      });
    const { retained, revision } = await creationRows(sequence);
    const ordinal = resolveLotIdentityOrdinal(
      retained.encoded,
      revision.encoded,
      ports.bookId,
      family,
      id,
    );
    const raw = await presentRow(LOT_IDENTITY_COLLECTIONS[family], ordinal);
    const row = decodeLotIdentityRow(raw.encoded, ports.bookId, family, id);
    await confirm();
    return Object.freeze({
      ...context,
      disposition: "present",
      creationOutcomeSequence: sequence,
      current: Object.freeze({ ...raw, row }),
    });
  };
  // Inner cursors run inside one outer owner operation, never behind it.
  const internalGroup = async <K extends SemanticGroupKind>(kind: K, values: readonly string[]) => {
    await confirm();
    return createPinnedGroupCursor(kind, values, 64, 1_048_576, {
      catalog: ports.groups,
      capture: ports.groupCapture,
      collectionDomain: ports.collectionDomain(SEMANTIC_GROUP_COLLECTIONS[kind]),
      sourceCatalogDigest: ports.catalogDigest,
      headHash,
      confirm,
      rawRow,
      run: async (operation) => operation(),
    });
  };
  const latestRevisionWitness = async (
    key: SemanticGroupKey,
  ): Promise<CanonicalRevisionWitness | null> => {
    const sourceMismatch =
      key.kind === "postingReferenceRevisionsById"
        ? "canonical_reference_source_mismatch"
        : "inventory_scope_source_mismatch";
    const last = await ports.groups.readLastMember(
      ports.groupCapture,
      ports.collectionDomain("state.revisions"),
      key,
      confirm,
    );
    if (last.entry === null) return null;
    const ordinal = BigInt(`0x${last.entry.key}`);
    const raw = await presentRow("state.revisions", ordinal);
    requireLedger(
      raw.rowHash === last.entry.value &&
        raw.headHash === headHash &&
        raw.catalogDigest === ports.catalogDigest &&
        last.memberHash !== null &&
        last.population > 0n,
      sourceMismatch,
    );
    const decoded = decodeBookRow("state.revisions", raw.encoded);
    requireLedger(
      decoded.disposition === "decoded" &&
        decoded.row.bookId === ports.bookId &&
        decoded.row.bookRevision === ordinal &&
        (key.kind === "postingReferenceRevisionsById" ||
          decoded.row.command.type === "postOwnedInventoryTransaction") &&
        projectSemanticGroupMemberships("state.revisions", raw.encoded, ordinal).some(
          (member) => JSON.stringify(member.group) === JSON.stringify(key),
        ),
      sourceMismatch,
    );
    return Object.freeze({
      revisionOrdinal: ordinal,
      revisionRowHash: raw.rowHash,
      memberHash: last.memberHash,
      population: last.population,
    });
  };
  return Object.freeze({
    head,
    readAllocationIdentityPresence: (id: string) =>
      run(async (): Promise<PinnedAllocationIdentityPresence> => {
        validateIdentity(id);
        const context = { id, headHash, catalogDigest: ports.catalogDigest };
        const sequence = await ports.lookup(
          identityIndexKey({ bookId: ports.bookId, family: "lotAllocation", id }),
        );
        if (sequence === null)
          return Object.freeze({ ...context, disposition: "absent", origin: null });
        const { retained, revision } = await creationRows(sequence);
        const decoded = decodeBookRow("state.revisions", revision.encoded);
        requireLedger(decoded.disposition === "decoded", "index_identity_source_mismatch");
        const owned = decoded.row.command.type === "postOwnedInventoryTransaction";
        if (owned)
          resolveInventoryIdentity(
            retained.encoded,
            revision.encoded,
            ports.bookId,
            "quantityAllocation",
            id,
          );
        else
          resolveLotIdentityOrdinal(
            retained.encoded,
            revision.encoded,
            ports.bookId,
            "lotAllocation",
            id,
          );
        return Object.freeze({
          ...context,
          disposition: "present",
          origin: owned ? "owned" : "legacy",
        });
      }),
    readInventoryMoneyScope: (input: InventoryMoneyScope) => {
      let scope: InventoryMoneyScope;
      try {
        scope = snapshotMoneyScope(input);
      } catch (error) {
        return run(async (): Promise<PinnedInventoryMoneyScope> => {
          throw error;
        });
      }
      return run(async (): Promise<PinnedInventoryMoneyScope> => {
        const basis = await ports.basis();
        requireLedger(
          scope.bookId === ports.bookId &&
            scope.functionalCommodityId === basis.header.identity.functionalCommodityId,
          "ledger_identity_mismatch",
        );
        const values = moneyScopeValues(scope);
        const ownershipWitness = await latestRevisionWitness(
          semanticGroupKey("inventoryRevisionsByMoneyScope", values),
        );
        const balance = await ports.groups.readPostedBalance(
          ports.groupCapture,
          ports.collectionDomain("state.journals"),
          semanticGroupKey("journalsByMoneyScope", values),
          confirm,
        );
        return Object.freeze({
          scope,
          headHash,
          catalogDigest: ports.catalogDigest,
          ownership: ownershipWitness === null ? "unmanaged" : "managed",
          ownershipWitness,
          postedBalance: balance.postedBalance,
          journals: Object.freeze({
            descriptorHash: balance.descriptorHash,
            memberHash: balance.memberHash,
            population: balance.population,
          }),
        });
      });
    },
    readInventorySourceJournal: (journalId: string) =>
      run(async (): Promise<PinnedInventorySourceJournal> => {
        validateIdentity(journalId);
        const witness = await latestRevisionWitness(
          semanticGroupKey("inventoryRevisionsBySourceJournal", [journalId]),
        );
        return Object.freeze({
          journalId,
          headHash,
          catalogDigest: ports.catalogDigest,
          disposition: witness === null ? "unreferenced" : "referenced",
          witness,
        });
      }),
    readPostingReferenceUsage: (referenceId: string) =>
      run(async (): Promise<PinnedPostingReferenceUsage> => {
        validateIdentity(referenceId);
        const witness = await latestRevisionWitness(
          semanticGroupKey("postingReferenceRevisionsById", [referenceId]),
        );
        return Object.freeze({
          referenceId,
          headHash,
          catalogDigest: ports.catalogDigest,
          disposition: witness === null ? "unused" : "used",
          witness,
        });
      }),
    readOwnedInventoryPools: (input: BookCommand) => {
      let command: BookCommand;
      try {
        command = snapshotCommand(input);
      } catch (error) {
        return run(async (): Promise<PinnedOwnedInventoryPools> => {
          throw error;
        });
      }
      return run(() =>
        readPinnedOwnedInventoryPools(command, {
          basis: () => ports.basis(),
          openAccount: (id) => internalGroup("holdingsByAccount", [id]),
          lot: (id) => readLotIdentity("lot", id),
          confirm,
        }),
      );
    },
    readInventoryPosition: (id: string) =>
      run(async (): Promise<PinnedInventoryPositionRead> => {
        validateIdentity(id);
        const basis = await ports.basis();
        const key = semanticGroupKey("inventoryRevisionsByHolding", [id]);
        const last = await ports.groups.readLastMember(
          ports.groupCapture,
          ports.collectionDomain("state.revisions"),
          key,
          confirm,
        );
        const current = await readLotIdentity("lotHolding", id);
        const context = { id, headHash, catalogDigest: ports.catalogDigest, current };
        if (last.entry === null)
          return Object.freeze({
            ...context,
            disposition: current.disposition === "absent" ? "absent" : "unowned",
            position: null,
            anchor: null,
            revisionOrdinal: null,
            revisionRowHash: null,
            groupMemberHash: null,
            groupPopulation: 0n,
          });
        requireLedger(current.disposition === "present", "inventory_position_holding_missing");
        const ordinal = BigInt(`0x${last.entry.key}`);
        const raw = await presentRow("state.revisions", ordinal);
        requireLedger(
          raw.rowHash === last.entry.value &&
            raw.headHash === headHash &&
            raw.catalogDigest === ports.catalogDigest,
          "inventory_position_source_mismatch",
        );
        const decoded = decodeBookRow("state.revisions", raw.encoded);
        requireLedger(
          decoded.disposition === "decoded" &&
            decoded.row.bookId === ports.bookId &&
            decoded.row.bookRevision === ordinal &&
            decoded.row.command.type === "postOwnedInventoryTransaction" &&
            projectSemanticGroupMemberships("state.revisions", raw.encoded, ordinal).some(
              (m) => JSON.stringify(m.group) === JSON.stringify(key),
            ),
          "inventory_position_source_mismatch",
        );
        const movements = decoded.row.effects
          .flatMap((effect) =>
            effect.type === "inventoryOwnership"
              ? [
                  ...effect.value.journalLinkedMovements,
                  ...effect.value.quantityOnlyMovements,
                ].filter((m) => m.coordinate.holdingId === id)
              : [],
          )
          .sort((a, b) =>
            a.artifactOrdinal < b.artifactOrdinal
              ? -1
              : a.artifactOrdinal > b.artifactOrdinal
                ? 1
                : 0,
          );
        const movement = movements.at(-1);
        requireLedger(
          movement &&
            movement.bookRevision === ordinal &&
            movement.afterPosition.originMovementId === movement.id &&
            movement.afterPosition.originArtifactOrdinal === movement.artifactOrdinal &&
            movement.afterPosition.originEffectKey === movement.effectKey &&
            movement.afterPosition.originBookRevision === ordinal,
          "inventory_position_source_mismatch",
        );
        const position = movement.afterPosition;
        const anchorSequence = await ports.lookup(
          identityIndexKey({
            bookId: ports.bookId,
            family: "inventoryAnchor",
            id: position.anchor.id,
          }),
        );
        requireLedger(anchorSequence !== null, "inventory_position_anchor_missing");
        const anchorRows = await creationRows(anchorSequence);
        const anchor = resolveInventoryIdentity(
          anchorRows.retained.encoded,
          anchorRows.revision.encoded,
          ports.bookId,
          "anchor",
          position.anchor.id,
        );
        await confirm();
        // Synchronous arithmetic over source-authenticated immutable copies. The
        // live async owner pin is checked immediately before and after this join;
        // this local read context is never returned as an admission capability.
        const resolved = resolveInventoryOwnershipSources(
          {
            bookId: basis.header.identity.bookId,
            bookRevision: basis.header.bookRevision,
            assertCurrent: () => {},
            readCurrentHolding: () => current.current.row,
            readCurrentPosition: () => position,
            readAnchor: () => anchor,
            readPositionAfterImage: () => movement.afterPosition,
          },
          [current.current.row.id],
        );
        requireLedger(
          resolved.disposition === "resolved" &&
            resolved.sources.length === 1 &&
            last.memberHash !== null,
          "inventory_position_balance_mismatch",
        );
        await confirm();
        return Object.freeze({
          ...context,
          disposition: "owned",
          position,
          anchor,
          revisionOrdinal: ordinal,
          revisionRowHash: raw.rowHash,
          groupMemberHash: last.memberHash,
          groupPopulation: last.population,
        });
      }),
    readInventoryCostFacts: (input: BookCommand) => {
      let command: BookCommand;
      try {
        command = snapshotCommand(input);
      } catch (error) {
        return run(async (): Promise<PinnedInventoryCostFacts> => {
          throw error;
        });
      }
      return run(() => {
        requireLedger(
          command.type === "postInventoryTransaction",
          "inventory_facts_command_invalid",
        );
        return readPinnedInventoryCostFacts(command, {
          basis: () => ports.basis(),
          openGroup: (values) => internalGroup("nonzeroHoldingsByAccountCommodity", values),
          lot: (id) => readLotIdentity("lot", id),
          confirm,
        });
      });
    },
    readActivationIdentity: (id: string) =>
      run(async (): Promise<PinnedActivationIdentityRead> => {
        validateIdentity(id);
        const sequence = await ports.lookup(
          identityIndexKey({ bookId: ports.bookId, family: "openingBoundary", id }),
        );
        const context = { id, catalogDigest: ports.catalogDigest, headHash };
        if (sequence === null)
          return Object.freeze({
            ...context,
            disposition: "absent",
            outcomeSequence: null,
            bookRevision: null,
            sourceRevisionRowHash: null,
            effect: null,
          });
        const { retained, revision, bookRevision } = await creationRows(sequence);
        const effect = resolveActivationIdentity(
          retained.encoded,
          revision.encoded,
          ports.bookId,
          id,
        );
        await confirm();
        return Object.freeze({
          ...context,
          disposition: "present",
          outcomeSequence: sequence,
          bookRevision,
          sourceRevisionRowHash: revision.rowHash,
          effect,
        });
      }),
    readAdmissionFacts: (input: BookCommand) => {
      let command: BookCommand;
      try {
        command = snapshotCommand(input);
      } catch (error) {
        return run(async (): Promise<PinnedAdmissionFacts> => {
          throw error;
        });
      }
      return run(() =>
        readPinnedAdmissionFacts(command, {
          basis: () => ports.basis(),
          openGroup: internalGroup,
          confirm,
        }),
      );
    },
    readBookBasis: () => run(() => ports.basis()),
    evaluateAdmission: (input: BookCommand) => {
      let command: BookCommand;
      try {
        command = snapshotCommand(input);
      } catch (error) {
        return run(async (): Promise<PinnedBookAdmission> => {
          throw error;
        });
      }
      return run(async () =>
        Object.freeze({
          commandId: command.id,
          commandInputHash: command.inputHash,
          headHash,
          catalogDigest: ports.catalogDigest,
          evaluation: ports.admission(command),
        }),
      );
    },
    openGroup: <K extends SemanticGroupKind>(
      kind: K,
      values: readonly string[],
      limit = 64,
      maxRowBytes = 1_048_576,
    ) => {
      // Snapshot mutable caller arrays before entering the async owner queue.
      let copied: ReturnType<typeof semanticGroupKey>;
      try {
        copied = semanticGroupKey(kind, values);
      } catch (error) {
        return run(async (): Promise<PinnedGroupCursor<K>> => {
          throw error;
        });
      }
      return run(async () => {
        await confirm();
        return createPinnedGroupCursor(kind, copied.values, limit, maxRowBytes, {
          catalog: ports.groups,
          capture: ports.groupCapture,
          collectionDomain: ports.collectionDomain(SEMANTIC_GROUP_COLLECTIONS[kind]),
          sourceCatalogDigest: ports.catalogDigest,
          headHash,
          confirm,
          rawRow,
          run,
        });
      });
    },
    read: (collection: string, ordinal: bigint) => read(collection, ordinal, (raw) => raw),
    readTyped: <C extends BookRowCollection>(collection: C, ordinal: bigint) =>
      read(collection, ordinal, (raw): TypedPinnedRow<C> => {
        if (raw.disposition === "absent")
          return Object.freeze({ ...raw, disposition: "absent", row: null });
        requireLedger(raw.encoded !== null, "source_catalog_row_invalid");
        const decoded = decodeBookRow(collection, raw.encoded);
        requireLedger(decoded.disposition === "decoded", "source_catalog_row_invalid");
        return Object.freeze({ ...raw, disposition: "present", row: decoded.row });
      }),
    readCommand: (commandId: string) =>
      run(async (): Promise<PinnedCommandRead> => {
        validateIdentity(commandId);
        const ordinal = await ports.lookup(
          identityIndexKey({ bookId: ports.bookId, family: "command", id: commandId }),
        );
        const context = { commandId, catalogDigest: ports.catalogDigest, headHash };
        if (ordinal === null)
          return Object.freeze({
            ...context,
            disposition: "absent",
            ordinal: null,
            rowHash: null,
            encoded: null,
            row: null,
          });
        const raw = await rawRow("protocol.retainedResults", ordinal);
        requireLedger(
          raw.disposition === "present" && raw.encoded !== null && raw.rowHash !== null,
          "index_identity_source_mismatch",
        );
        const row = decodeRetainedCommandIdentity(raw.encoded, ports.bookId, commandId);
        await confirm();
        return Object.freeze({
          ...context,
          disposition: "present",
          ordinal,
          rowHash: raw.rowHash,
          encoded: raw.encoded,
          row,
        });
      }),
    readJournalIdentity: (family: "journal" | "posting", id: string) =>
      run(async (): Promise<PinnedJournalIdentityRead> => {
        requireLedger(
          family === "journal" || family === "posting",
          "index_identity_family_invalid",
        );
        validateIdentity(id);
        const sequence = await ports.lookup(identityIndexKey({ bookId: ports.bookId, family, id }));
        const context = { family, id, catalogDigest: ports.catalogDigest, headHash };
        if (sequence === null)
          return Object.freeze({
            ...context,
            disposition: "absent",
            outcomeSequence: null,
            journal: null,
            posting: null,
          });
        const { retained, revision } = await creationRows(sequence);
        const found = resolveJournalIdentity(
          retained.encoded,
          revision.encoded,
          ports.bookId,
          family,
          id,
        );
        const raw = await presentRow("state.journals", found.booked.postingSequence);
        requireLedger(
          raw.encoded === encodeBookRow("state.journals", found.booked),
          "index_identity_source_mismatch",
        );
        await confirm();
        return Object.freeze({
          ...context,
          disposition: "present",
          outcomeSequence: sequence,
          journal: Object.freeze({ ...raw, row: found.booked }),
          posting: found.posting,
        });
      }),
    readAccountingIdentity: <F extends AccountingEffect["type"]>(family: F, id: string) =>
      run(async (): Promise<PinnedAccountingIdentityRead<F>> => {
        requireLedger(isAccountingIdentityFamily(family), "index_identity_family_invalid");
        validateIdentity(id);
        const sequence = await ports.lookup(identityIndexKey({ bookId: ports.bookId, family, id }));
        const context = { family, id, catalogDigest: ports.catalogDigest, headHash };
        if (sequence === null)
          return Object.freeze({
            ...context,
            disposition: "absent",
            outcomeSequence: null,
            bookRevision: null,
            sourceRevisionRowHash: null,
            effect: null,
          });
        const { retained, revision, bookRevision } = await creationRows(sequence);
        const effect = resolveAccountingIdentity(
          retained.encoded,
          revision.encoded,
          ports.bookId,
          family,
          id,
        );
        await confirm();
        return Object.freeze({
          ...context,
          disposition: "present",
          outcomeSequence: sequence,
          bookRevision,
          sourceRevisionRowHash: revision.rowHash,
          effect,
        });
      }),
    readLotIdentity: <F extends LotIdentityFamily>(family: F, id: string) =>
      run(() => readLotIdentity(family, id)),
    readInventoryIdentity: <K extends InventoryIdentityKind>(kind: K, id: string) =>
      run(async (): Promise<PinnedInventoryIdentityRead<K>> => {
        requireLedger(isInventoryIdentityKind(kind), "index_identity_family_invalid");
        validateIdentity(id);
        const sequence = await ports.lookup(
          identityIndexKey({ bookId: ports.bookId, family: INVENTORY_IDENTITY_FAMILIES[kind], id }),
        );
        const context = { kind, id, catalogDigest: ports.catalogDigest, headHash };
        if (sequence === null)
          return Object.freeze({
            ...context,
            disposition: "absent",
            outcomeSequence: null,
            bookRevision: null,
            sourceRevisionRowHash: null,
            row: null,
          });
        const { retained, revision, bookRevision } = await creationRows(sequence);
        const row = resolveInventoryIdentity(
          retained.encoded,
          revision.encoded,
          ports.bookId,
          kind,
          id,
        );
        await confirm();
        return Object.freeze({
          ...context,
          disposition: "present",
          outcomeSequence: sequence,
          bookRevision,
          sourceRevisionRowHash: revision.rowHash,
          row,
        });
      }),
    close: () =>
      serial(async () => {
        if (!closed) await retire();
      }),
  });
}
