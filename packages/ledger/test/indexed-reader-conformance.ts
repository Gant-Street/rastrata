import { expect } from "bun:test";
import {
  BOOK_ROW_COLLECTIONS,
  encodeBookRow,
  encodeDurableBook,
  isInventoryPostedReductionMovement,
  type DurableBookAggregate,
  type BookRowCollection,
} from "@rastrata/kernel";
import type { IndexedLedgerOwner } from "../src/indexed-ledger-owner.ts";
import { projectLegacyLogicalBook } from "../src/logical-book.ts";
import { indexedRowCommitment } from "../src/indexed-book-state.ts";
import { isAccountingIdentityFamily, LOT_IDENTITY_COLLECTIONS } from "../src/outcome-identities.ts";
import type { SemanticGroupKind } from "../src/semantic-groups.ts";

/** Expected bytes/effects come from an independently executed full kernel book,
 * not owner output, physical catalogs or the indexed change compiler. */
export async function checkIndexedReader(
  owner: IndexedLedgerOwner,
  expected: DurableBookAggregate,
) {
  const reader = await owner.openCurrentRowReader();
  try {
    const basis = await reader.readBookBasis();
    expect(basis.headHash).toBe(reader.head.contentHash);
    expect(basis.header.contentHash).toEqual(expected.state.contentHash);
    expect(basis.configuration.row).toEqual(expected.state.activeConfigurationSnapshot);
    expect(basis.openingBoundary?.row ?? null).toEqual(expected.state.openingBoundary ?? null);
    expect(basis.financialRevision?.row ?? null).toEqual(expected.state.revisions.at(-1) ?? null);
    const projection = await projectLegacyLogicalBook(encodeDurableBook(expected));
    expect(projection.collections.map((c) => c.name).sort()).toEqual(
      [...BOOK_ROW_COLLECTIONS].sort(),
    );
    for (const c of projection.collections) {
      const collection = c.name as BookRowCollection;
      for (const row of c.rows) {
        const found = await reader.readTyped(collection, row.ordinal);
        expect(found.disposition).toBe("present");
        if (found.disposition !== "present") throw new Error("Missing canonical row");
        expect(found.encoded).toBe(row.encoded);
        expect(encodeBookRow(collection, found.row)).toBe(row.encoded);
        expect(found.rowHash).toBe(
          indexedRowCommitment(
            expected.state.financialIdentityHash,
            collection,
            row.ordinal,
            row.encoded,
          ),
        );
        expect(found.headHash).toBe(reader.head.contentHash);
        expect(found.catalogDigest).toBe(basis.catalogDigest);
      }
      expect(await reader.readTyped(collection, BigInt(c.rows.length) + 1n)).toMatchObject({
        disposition: "absent",
        row: null,
        encoded: null,
        rowHash: null,
      });
    }
    const sequenceByCommandId = new Map<string, bigint>();
    for (const [i, result] of expected.protocol.retainedResults.entries()) {
      sequenceByCommandId.set(result.commandId, BigInt(i) + 1n);
      const found = await reader.readCommand(result.commandId);
      expect(found).toMatchObject({ disposition: "present", ordinal: BigInt(i) + 1n, row: result });
    }
    expect((await reader.readCommand("unseen-command/α")).disposition).toBe("absent");
    const lotCreationSequence = new Map<string, bigint>();
    for (const revision of expected.state.revisions) {
      const sequence = sequenceByCommandId.get(revision.command.id) ?? -1n;
      expect(sequence).toBeGreaterThan(0n);
      for (const effect of revision.effects) {
        if (effect.type === "lotState") {
          for (const item of [
            ...effect.lotState.lots,
            ...effect.lotState.holdings,
            ...effect.lotState.allocations,
          ]) {
            const itemId = "allocation" in item ? item.allocation.id : item.id;
            if (!lotCreationSequence.has(itemId)) {
              lotCreationSequence.set(itemId, sequence);
            }
          }
        }
        if (effect.type === "activation") {
          expect(await reader.readActivationIdentity(effect.boundary.id)).toMatchObject({
            disposition: "present",
            outcomeSequence: sequence,
            bookRevision: revision.bookRevision,
            effect,
          });
        } else if (effect.type === "journal") {
          const found = await reader.readJournalIdentity("journal", effect.booked.journal.id);
          expect(found).toMatchObject({
            disposition: "present",
            outcomeSequence: sequence,
            journal: { row: effect.booked },
            posting: null,
          });
          for (const posting of effect.booked.journal.postings) {
            expect(await reader.readJournalIdentity("posting", posting.id)).toMatchObject({
              disposition: "present",
              outcomeSequence: sequence,
              journal: { row: effect.booked },
              posting,
            });
          }
        } else if (effect.type === "inventoryOwnership") {
          for (const anchor of effect.value.newAnchors)
            expect(await reader.readInventoryIdentity("anchor", anchor.id)).toMatchObject({
              disposition: "present",
              outcomeSequence: sequence,
              bookRevision: revision.bookRevision,
              row: anchor,
            });
          for (const movement of [
            ...effect.value.journalLinkedMovements,
            ...effect.value.quantityOnlyMovements,
          ]) {
            expect(await reader.readInventoryIdentity("movement", movement.id)).toMatchObject({
              disposition: "present",
              outcomeSequence: sequence,
              bookRevision: revision.bookRevision,
              row: movement,
            });
            if (isInventoryPostedReductionMovement(movement))
              expect(
                await reader.readInventoryIdentity(
                  "quantityAllocation",
                  movement.quantityAllocation.id,
                ),
              ).toMatchObject({
                disposition: "present",
                outcomeSequence: sequence,
                bookRevision: revision.bookRevision,
                row: movement.quantityAllocation,
              });
          }
        } else if (isAccountingIdentityFamily(effect.type) && "value" in effect) {
          expect(await reader.readAccountingIdentity(effect.type, effect.value.id)).toMatchObject({
            disposition: "present",
            outcomeSequence: sequence,
            bookRevision: revision.bookRevision,
            effect,
          });
        }
      }
    }
    for (const [family, rows] of [
      ["lot", expected.state.lots],
      ["lotHolding", expected.state.lotHoldings],
      ["lotAllocation", expected.state.lotAllocations],
    ] as const) {
      for (const row of rows) {
        const id = "allocation" in row ? row.allocation.id : row.id;
        const found = await reader.readLotIdentity(family, id);
        expect(found.disposition).toBe("present");
        if (found.disposition !== "present") throw new Error("Missing lot identity");
        expect(found.current.encoded).toBe(encodeBookRow(LOT_IDENTITY_COLLECTIONS[family], row));
        const creationSequence = lotCreationSequence.get(id);
        if (creationSequence === undefined) throw new Error("Missing lot creation sequence");
        expect(found.creationOutcomeSequence).toBe(creationSequence);
      }
      expect((await reader.readLotIdentity(family, "unseen-lot/α")).disposition).toBe("absent");
    }
    // Independent raw predicates; deliberately do not use the production
    // semantic-group projector to manufacture expected membership.
    const groups = new Map<
      string,
      { kind: SemanticGroupKind; values: string[]; rows: { ordinal: bigint; encoded: string }[] }
    >();
    const member = (
      kind: SemanticGroupKind,
      values: string[],
      collection: BookRowCollection,
      ordinal: bigint,
      row: Parameters<typeof encodeBookRow>[1],
    ) => {
      const key = JSON.stringify([kind, values]);
      const group = groups.get(key) ?? { kind, values, rows: [] };
      group.rows.push({ ordinal, encoded: encodeBookRow(collection, row) });
      groups.set(key, group);
    };
    expected.state.lotHoldings.forEach((h, i) => {
      member("holdingsByLot", [h.lotId], "state.lotHoldings", BigInt(i) + 1n, h);
      member("holdingsByAccount", [h.accountId], "state.lotHoldings", BigInt(i) + 1n, h);
      if (!h.remainingQuantity.isZero())
        member(
          "nonzeroHoldingsByAccountCommodity",
          [h.accountId, h.commodityId],
          "state.lotHoldings",
          BigInt(i) + 1n,
          h,
        );
    });
    expected.state.periodTransitions.forEach((r, i) => {
      member("transitionsByPeriod", [r.periodId], "state.periodTransitions", BigInt(i) + 1n, r);
    });
    expected.state.accountingState.allocationRecognitions.forEach((r, i) => {
      member(
        "recognitionsBySchedule",
        [r.scheduleId],
        "state.accountingState.allocationRecognitions",
        BigInt(i) + 1n,
        r,
      );
    });
    expected.state.accountingState.remeasurementResults.forEach((r, i) => {
      if (r.kind === "unrealized")
        member(
          "unrealizedByPolicy",
          [r.policyId],
          "state.accountingState.remeasurementResults",
          BigInt(i) + 1n,
          r,
        );
    });
    expected.state.accountingState.remeasurementReversals.forEach((r, i) => {
      member(
        "reversalsByOriginalResult",
        [r.originalResultId],
        "state.accountingState.remeasurementReversals",
        BigInt(i) + 1n,
        r,
      );
    });
    for (const group of groups.values()) {
      const cursor = await reader.openGroup(group.kind, group.values, 1);
      const actual: { ordinal: bigint; encoded: string }[] = [];
      while (true) {
        const page = await cursor.next();
        actual.push(...page.rows.map((r) => ({ ordinal: r.ordinal, encoded: r.encoded })));
        expect(page.headHash).toBe(reader.head.contentHash);
        expect(page.population).toBe(BigInt(group.rows.length));
        expect(page.consumed).toBe(BigInt(actual.length));
        if (page.complete) break;
      }
      expect(actual).toEqual(group.rows);
      await cursor.close();
    }
    for (const kind of [
      "holdingsByLot",
      "holdingsByAccount",
      "nonzeroHoldingsByAccountCommodity",
      "recognitionsBySchedule",
      "transitionsByPeriod",
      "unrealizedByPolicy",
      "reversalsByOriginalResult",
    ] as const) {
      const cursor = await reader.openGroup(
        kind,
        kind === "nonzeroHoldingsByAccountCommodity" ? ["absent", "absent"] : ["absent"],
      );
      expect(await cursor.next()).toMatchObject({
        complete: true,
        population: 0n,
        consumed: 0n,
        rows: [],
      });
      await cursor.close();
    }
  } finally {
    await reader.close();
  }
}
