/**
 * The generator of lot inputs, for `lots.test.ts`.
 *
 * A case is a world: holdings at a source account, the lots they are of, a request and a selection
 * method, the identities that the allocations and the new destination holdings need, the holdings
 * at the destination account, and the transfer policies. The clean world is one that `allocateLots`
 * and `transferLots` accept; defects (`MUTATORS`) each spoil one named thing, so that every
 * rejection the two functions can give is reached often. The edges are mutators too: ties on the
 * acquisition instant and on the unit cost, holdings with nothing left, requests larger than the
 * holdings, the order of acquisition instants as TEXT against as time, identifiers whose UTF-16
 * order and code point order differ, numbers at the size limit.
 *
 * Every value is made with the shipped constructors and kept as the shipped type, so the wire is
 * made from what the TypeScript is given (`wave2b-wire.ts`).
 *
 * Every source character in this file is ASCII: a code point is written as a number.
 */
import {
  type AccountId,
  type DerivationRecord,
  type DestinationHoldingIdentity,
  ExactRational,
  type Instant,
  type Lot,
  type LotAllocationIdentity,
  type LotHolding,
  type LotSelection,
  type TransferPolicy,
  accountId,
  bookId,
  commodityId,
  derivationId,
  evidenceId,
  hashCanonical,
  identifier,
  instant,
  lotHoldingId,
  lotId,
  lotAllocationId,
  policyId,
  semanticVersion,
} from "../src/index.ts";
import type { Rng } from "./wave2b-wire.ts";
import { ORDER_POINTS } from "./wave2b-gen-admission.ts";
import { chr, instantAt } from "./wave2a-wire.ts";

// ---------------------------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------------------------

export interface LotsWorld {
  sourceHoldings: LotHolding[];
  destinationHoldings: LotHolding[];
  lots: Lot[];
  requested: ExactRational;
  selection: LotSelection;
  policies: TransferPolicy[];
  governedAt: Instant;
  destinationAccountId: AccountId;
  derivation: DerivationRecord;
  allocationIdentities: LotAllocationIdentity[];
  destinationIdentities: DestinationHoldingIdentity[];
  tags: Set<string>;
  names: LotNames;
}

export interface LotNames {
  readonly exotic: boolean;
  lot(index: number): string;
  holding(index: number): string;
  allocation(index: number): string;
  destination(index: number): string;
}

function lotNames(r: Rng, exotic: boolean): LotNames {
  const bare = exotic && r.chance(0.5);
  const make = (prefix: string, shift: number) => (index: number) => {
    if (!exotic) return `${prefix}${index + 1}`;
    const point = ORDER_POINTS[(index + shift) % ORDER_POINTS.length] as number;
    const round = Math.floor((index + shift) / ORDER_POINTS.length);
    return `${bare ? "" : prefix}${chr(point)}${round === 0 ? "" : String(round)}`;
  };
  return {
    exotic,
    lot: make("lot", 0),
    holding: make("h", 5),
    allocation: make("al", 9),
    destination: make("dh", 2),
  };
}

/** A maker that does not refuse: a text that is not an identifier is kept as the string it is, which
 * is what the brand is at run time. The generator makes few of these (an exotic point that is not
 * NFC), and both sides compare identifiers as plain strings. */
function forging<T>(make: (value: string) => T): (value: string) => T {
  return (value) => {
    try {
      return make(value);
    } catch {
      return value as unknown as T;
    }
  };
}
const mkLot = forging(lotId);
const mkHolding = forging(lotHoldingId);
const mkAllocation = forging(lotAllocationId);

const rat = (numerator: number | bigint, denominator: number | bigint = 1): ExactRational =>
  ExactRational.of(BigInt(numerator), BigInt(denominator));

const ZERO = ExactRational.zero();

// ---------------------------------------------------------------------------------------------
// Instants
// ---------------------------------------------------------------------------------------------

const BASE_MILLIS = Date.UTC(2024, 5, 15, 12, 0, 0);
const OFFSETS = [0, 0, 60, -60, 330, -210, 840, -840, 765, -540, 120];
const DIGITS = [0, 0, 1, 2, 3, 3, 4, 6, 9];

/** One moment, written at some offset with some number of fraction digits: many texts, one moment. */
function textAt(r: Rng, millis: number): string {
  return instantAt(millis, r.pick(OFFSETS), r.pick(DIGITS));
}

const HOUR = 3_600_000;

// ---------------------------------------------------------------------------------------------
// The derivation: any record; the allocations carry it unchanged
// ---------------------------------------------------------------------------------------------

function makeDerivation(r: Rng): DerivationRecord {
  const evidence = r.chance(0.5)
    ? [
        {
          id: evidenceId("ev-1"),
          sourceSystem: "ledger",
          sourceRecordId: `r${r.int(1, 99)}`,
          observedAt: instant("2024-06-01T00:00:00Z"),
          contentHash: hashCanonical("evidence"),
        },
      ]
    : [];
  return {
    id: derivationId(`dr-${r.int(1, 9)}`),
    policyId: policyId("pol-1"),
    policyVersion: semanticVersion("1.2.3"),
    algorithmVersion: semanticVersion("0.9.0-rc.1"),
    inputHash: hashCanonical(`input-${r.int(0, 3)}`),
    actorId: identifier<"Actor">("actor-7"),
    state: r.pick(["proposed", "approved", "rejected", "applied"] as const),
    recordedAt: instant(textAt(r, BASE_MILLIS + 5 * HOUR)),
    evidence,
  };
}

// ---------------------------------------------------------------------------------------------
// The clean world
// ---------------------------------------------------------------------------------------------

const COMMODITIES = ["BTC", "XAU", "AAPL", "ETH"];
const UNIT_COSTS = [rat(1), rat(2), rat(5, 2), rat(10), rat(25, 4), rat(7, 3)];

interface Numbers {
  quantity: ExactRational;
  basis: ExactRational;
  allowance: ExactRational;
  carrying: ExactRational;
}

function holdingNumbers(r: Rng, depleted: boolean, unit?: ExactRational): Numbers {
  if (depleted) return { quantity: ZERO, basis: ZERO, allowance: ZERO, carrying: ZERO };
  const quantity = rat(r.int(1, 60), r.int(1, 7));
  const basis = quantity.multiply(unit ?? (r.pick(UNIT_COSTS) as ExactRational));
  const allowance = r.chance(0.5) ? ZERO : rat(r.int(-40, 80), r.int(1, 5));
  return { quantity, basis, allowance, carrying: basis.add(allowance) };
}

export function holdingWith(base: LotHolding, numbers: Numbers): LotHolding {
  return {
    ...base,
    remainingQuantity: numbers.quantity,
    remainingTotalBasis: numbers.basis,
    remainingValuationAllowance: numbers.allowance,
    remainingCarryingAmount: numbers.carrying,
  };
}

/** The sum of the quantities of the holdings that have some. */
const totalOf = (holdings: readonly LotHolding[]): ExactRational =>
  holdings.reduce((sum, h) => sum.add(h.remainingQuantity), ZERO);

export function specificSelectionFor(
  r: Rng,
  holdings: readonly LotHolding[],
): { selection: LotSelection; requested: ExactRational } {
  const live = holdings.filter((h) => !h.remainingQuantity.isZero());
  const chosen = live.length === 0 ? [] : r.shuffle(live).slice(0, r.int(1, live.length));
  const allocations = chosen.map((h) => ({
    holdingId: h.id,
    quantity: h.remainingQuantity.multiply(rat(r.int(1, 4), 4)),
  }));
  return {
    selection: { method: "specificIdentification", allocations },
    requested: allocations.reduce((sum, a) => sum.add(a.quantity), ZERO),
  };
}

export function cleanLotsWorld(r: Rng, exoticChance = 0.4): LotsWorld {
  const exotic = r.chance(exoticChance);
  const names = lotNames(r, exotic);
  const commodity = r.pick(COMMODITIES) as string;
  const tags = new Set<string>(exotic ? ["exotic ids"] : []);

  // The lots: the acquisition instants are drawn from a small pool of texts, so that some lots tie.
  const lotCount = r.int(2, 5);
  const pool = Array.from({ length: r.int(1, lotCount) }, () =>
    textAt(r, BASE_MILLIS - r.int(0, 6) * HOUR - r.pick([0, 0, 1, 1000, 30 * 60_000])),
  );
  const lots: Lot[] = [];
  for (let index = 0; index < lotCount; index++) {
    lots.push({
      id: mkLot(names.lot(index)),
      bookId: bookId("b"),
      commodityId: commodityId(commodity),
      acquiredAt: instant(r.pick(pool) as string),
      acquisitionQuantity: rat(r.int(1, 100), r.int(1, 4)),
      acquisitionTotalBasis: rat(r.int(0, 500), r.int(1, 4)),
      basisCommodityId: commodityId("USD"),
      evidenceIds: r.chance(0.5) ? ["ev-1"] : ["ev-1", "ev-2"],
    });
  }

  // The source holdings.
  const holdingCount = r.int(2, 6);
  const sourceHoldings: LotHolding[] = [];
  const unitForLot = lots.map(() => r.pick(UNIT_COSTS) as ExactRational);
  for (let index = 0; index < holdingCount; index++) {
    const lotIndex = r.int(0, lotCount - 1);
    const numbers = holdingNumbers(
      r,
      r.chance(0.15),
      r.chance(0.5) ? unitForLot[lotIndex] : undefined,
    );
    sourceHoldings.push(
      holdingWith(
        {
          id: mkHolding(names.holding(index)),
          bookId: bookId("b"),
          lotId: (lots[lotIndex] as Lot).id,
          accountId: accountId("acct-a"),
          commodityId: commodityId(commodity),
          basisCommodityId: commodityId("USD"),
          remainingQuantity: ZERO,
          remainingTotalBasis: ZERO,
          remainingValuationAllowance: ZERO,
          remainingCarryingAmount: ZERO,
        },
        numbers,
      ),
    );
  }
  // At least one holding with some quantity.
  if (sourceHoldings.every((h) => h.remainingQuantity.isZero())) {
    const first = sourceHoldings[0] as LotHolding;
    sourceHoldings[0] = holdingWith(first, holdingNumbers(r, false));
  }

  // The method and the request.
  const method = r.pick([
    "fifo",
    "lifo",
    "hifo",
    "weightedAverage",
    "specificIdentification",
  ] as const);
  let selection: LotSelection;
  let requested: ExactRational;
  if (method === "specificIdentification") {
    ({ selection, requested } = specificSelectionFor(r, sourceHoldings));
  } else {
    selection = { method };
    const total = totalOf(sourceHoldings);
    const fraction = rat(r.int(1, 8), 8);
    requested = r.chance(0.85) ? total.multiply(fraction) : total;
    if (requested.isZero()) requested = rat(1, 3);
  }

  // The identities of the allocations, and of the holdings the transfer founds.
  const allocationIdentities = r.shuffle(
    sourceHoldings.map((h, index) => ({
      holdingId: h.id,
      allocationId: mkAllocation(names.allocation(index)),
    })),
  );
  const destinationIdentities = r.shuffle(
    sourceHoldings.map((h, index) => ({
      sourceHoldingId: h.id,
      destinationHoldingId: mkHolding(names.destination(index + 10)),
    })),
  );

  // The destination.
  const destinationHoldings: LotHolding[] = [];
  if (r.chance(0.5)) {
    const count = r.int(1, 3);
    for (let index = 0; index < count; index++) {
      const lotIndex = r.int(0, lotCount - 1);
      destinationHoldings.push(
        holdingWith(
          {
            id: mkHolding(names.destination(index)),
            bookId: bookId("b"),
            lotId: (lots[lotIndex] as Lot).id,
            accountId: accountId("acct-b"),
            commodityId: commodityId(commodity),
            basisCommodityId: commodityId("USD"),
            remainingQuantity: ZERO,
            remainingTotalBasis: ZERO,
            remainingValuationAllowance: ZERO,
            remainingCarryingAmount: ZERO,
          },
          holdingNumbers(r, false),
        ),
      );
    }
  }

  // The policies and the moment they govern.
  const governedMillis = BASE_MILLIS + r.int(0, 3) * HOUR;
  const main: TransferPolicy = {
    id: policyId("tp-1"),
    version: semanticVersion("1.0.0"),
    bookId: bookId("b"),
    sourceAccountId: accountId("acct-a"),
    destinationAccountId: accountId("acct-b"),
    validFrom: instant(textAt(r, governedMillis - (r.pick([0, 1, 1000, HOUR]) as number))),
    ...(r.chance(0.5)
      ? {}
      : { validTo: instant(textAt(r, governedMillis + (r.pick([1, 1000, 24 * HOUR]) as number))) }),
    treatment: r.chance(0.85) ? "continuity" : "disposalAndReacquisition",
  };
  const policies: TransferPolicy[] = [main];

  return {
    sourceHoldings,
    destinationHoldings,
    lots,
    requested,
    selection,
    policies,
    governedAt: instant(textAt(r, governedMillis)),
    destinationAccountId: accountId("acct-b"),
    derivation: makeDerivation(r),
    allocationIdentities,
    destinationIdentities,
    tags,
    names,
  };
}

// ---------------------------------------------------------------------------------------------
// Mutators
// ---------------------------------------------------------------------------------------------

export type Group =
  | "holdings"
  | "request"
  | "lots"
  | "selection"
  | "identities"
  | "edge"
  | "transfer";

interface Mutator {
  readonly name: string;
  readonly group: Group;
  readonly aim: string;
  readonly apply: (w: LotsWorld, r: Rng) => void;
}

const live = (w: LotsWorld): number[] =>
  w.sourceHoldings.flatMap((h, index) => (h.remainingQuantity.isZero() ? [] : [index]));

const someIndex = (w: LotsWorld, r: Rng): number | undefined =>
  w.sourceHoldings.length === 0 ? undefined : r.int(0, w.sourceHoldings.length - 1);

const someLiveIndex = (w: LotsWorld, r: Rng): number | undefined => {
  const indexes = live(w);
  return indexes.length === 0 ? undefined : (r.pick(indexes) as number);
};

function patchHolding(w: LotsWorld, index: number | undefined, patch: Partial<LotHolding>): void {
  if (index === undefined) return;
  w.sourceHoldings[index] = { ...(w.sourceHoldings[index] as LotHolding), ...patch };
}

function patchLot(w: LotsWorld, index: number, patch: Partial<Lot>): void {
  w.lots[index] = { ...(w.lots[index] as Lot), ...patch };
}

/** The lot a holding is of, as an index into the lots, if the lots have it. */
const lotIndexOf = (w: LotsWorld, holding: LotHolding): number =>
  w.lots.findIndex((lot) => lot.id === holding.lotId);

function ensureSpecific(w: LotsWorld, r: Rng): void {
  if (w.selection.method === "specificIdentification") return;
  const chosen = specificSelectionFor(r, w.sourceHoldings);
  w.selection = chosen.selection;
  w.requested = chosen.requested;
}

const METHODS = ["fifo", "lifo", "hifo", "weightedAverage"] as const;

/** `holding` made into the same book, account, lot and commodity as the others, if it was not. */
const MUTATORS: Mutator[] = [
  // ---- the holdings (validateHoldings) ----
  {
    name: "dupHoldingId",
    group: "holdings",
    aim: "canonical_identity_conflict @ holdings[].id",
    apply(w) {
      const [first, second] = w.sourceHoldings;
      if (first !== undefined && second !== undefined) patchHolding(w, 1, { id: first.id });
    },
  },
  {
    name: "negativeQuantity",
    group: "holdings",
    aim: "lot_overallocation: negative quantity",
    apply(w, r) {
      const index = someLiveIndex(w, r);
      if (index !== undefined) {
        const h = w.sourceHoldings[index] as LotHolding;
        patchHolding(w, index, { remainingQuantity: h.remainingQuantity.negate() });
      }
    },
  },
  {
    name: "negativeBasis",
    group: "holdings",
    aim: "lot_overallocation: negative basis",
    apply(w, r) {
      const index = someLiveIndex(w, r);
      if (index !== undefined) {
        const h = w.sourceHoldings[index] as LotHolding;
        const basis = h.remainingTotalBasis.negate();
        patchHolding(w, index, {
          remainingTotalBasis: basis,
          remainingCarryingAmount: basis.add(h.remainingValuationAllowance),
        });
      }
    },
  },
  {
    name: "carryingMismatch",
    group: "holdings",
    aim: "lot_overallocation @ holdings[].remainingCarryingAmount",
    apply(w, r) {
      const index = someIndex(w, r);
      if (index !== undefined) {
        const h = w.sourceHoldings[index] as LotHolding;
        patchHolding(w, index, {
          remainingCarryingAmount: h.remainingCarryingAmount.add(
            rat(r.pick([1, -1, 7]), r.pick([1, 3])),
          ),
        });
      }
    },
  },
  {
    name: "depletedMismatch",
    group: "holdings",
    aim: "lot_overallocation: a depleted holding with basis, allowance or carrying amount, or basis without quantity",
    apply(w, r) {
      const index = someIndex(w, r);
      if (index === undefined) return;
      const h = w.sourceHoldings[index] as LotHolding;
      switch (r.int(0, 3)) {
        case 0: // quantity but no basis
          patchHolding(w, index, {
            remainingQuantity: rat(3),
            remainingTotalBasis: ZERO,
            remainingValuationAllowance: ZERO,
            remainingCarryingAmount: ZERO,
          });
          break;
        case 1: // basis but no quantity
          patchHolding(w, index, {
            remainingQuantity: ZERO,
            remainingTotalBasis: rat(5),
            remainingValuationAllowance: ZERO,
            remainingCarryingAmount: rat(5),
          });
          break;
        case 2: // no quantity or basis, an allowance that carries
          patchHolding(w, index, {
            remainingQuantity: ZERO,
            remainingTotalBasis: ZERO,
            remainingValuationAllowance: rat(4),
            remainingCarryingAmount: rat(4),
          });
          break;
        default: // no quantity or basis, an allowance and an opposite carrying amount
          patchHolding(w, index, {
            remainingQuantity: ZERO,
            remainingTotalBasis: ZERO,
            remainingValuationAllowance: h.remainingValuationAllowance.isZero() ? rat(2) : ZERO,
            remainingCarryingAmount: ZERO,
          });
      }
    },
  },
  {
    name: "noHoldings",
    group: "holdings",
    aim: "no holding at all",
    apply(w) {
      w.sourceHoldings = [];
    },
  },
  // ---- the request ----
  {
    name: "requestedZero",
    group: "request",
    aim: "lot_overallocation @ requestedQuantity (zero)",
    apply(w) {
      w.requested = ZERO;
    },
  },
  {
    name: "requestedNegative",
    group: "request",
    aim: "lot_overallocation @ requestedQuantity (negative)",
    apply(w) {
      w.requested = w.requested.isZero() ? rat(-1) : w.requested.negate();
    },
  },
  {
    name: "requestedTooMuch",
    group: "request",
    aim: "lot_overallocation: requested quantity exceeds the holdings",
    apply(w, r) {
      w.requested = totalOf(w.sourceHoldings).add(rat(r.int(1, 5), r.int(1, 3)));
      if (w.selection.method === "specificIdentification") {
        w.selection = { method: r.pick(METHODS) };
      }
    },
  },
  // ---- the lots ----
  {
    name: "dupLotId",
    group: "lots",
    aim: "canonical_identity_conflict @ lots",
    apply(w) {
      const [first, second] = w.lots;
      if (first !== undefined && second !== undefined) patchLot(w, 1, { id: first.id });
    },
  },
  {
    name: "unknownLot",
    group: "lots",
    aim: "lot_overallocation: a holding of no lot",
    apply(w, r) {
      patchHolding(w, someIndex(w, r), {
        lotId: mkLot(r.pick(["lot-zz", w.names.lot(40)]) as string),
      });
    },
  },
  {
    name: "lotOfOtherBook",
    group: "lots",
    aim: "lot_overallocation: the lot is of another book",
    apply(w, r) {
      const index = someIndex(w, r);
      const lot = index === undefined ? -1 : lotIndexOf(w, w.sourceHoldings[index] as LotHolding);
      if (lot >= 0) patchLot(w, lot, { bookId: bookId("b2") });
    },
  },
  {
    name: "lotOfOtherCommodity",
    group: "lots",
    aim: "lot_overallocation: the lot is of another commodity",
    apply(w, r) {
      const index = someIndex(w, r);
      const lot = index === undefined ? -1 : lotIndexOf(w, w.sourceHoldings[index] as LotHolding);
      if (lot >= 0) patchLot(w, lot, { commodityId: commodityId("DOGE") });
    },
  },
  {
    name: "lotOfOtherBasisCommodity",
    group: "lots",
    aim: "lot_overallocation: the lot's basis is in another commodity",
    apply(w, r) {
      const index = someIndex(w, r);
      const lot = index === undefined ? -1 : lotIndexOf(w, w.sourceHoldings[index] as LotHolding);
      if (lot >= 0) patchLot(w, lot, { basisCommodityId: commodityId("EUR") });
    },
  },
  {
    name: "lotQuantityNotPositive",
    group: "lots",
    aim: "lot_overallocation: the lot acquired nothing or less",
    apply(w, r) {
      const index = someIndex(w, r);
      const lot = index === undefined ? -1 : lotIndexOf(w, w.sourceHoldings[index] as LotHolding);
      if (lot >= 0)
        patchLot(w, lot, { acquisitionQuantity: r.chance(0.5) ? ZERO : rat(-r.int(1, 9), 2) });
    },
  },
  {
    name: "lotBasisNegative",
    group: "lots",
    aim: "lot_overallocation: the lot's basis is negative",
    apply(w, r) {
      const index = someIndex(w, r);
      const lot = index === undefined ? -1 : lotIndexOf(w, w.sourceHoldings[index] as LotHolding);
      if (lot >= 0) patchLot(w, lot, { acquisitionTotalBasis: rat(-r.int(1, 9), r.int(1, 3)) });
    },
  },
  {
    name: "lotWithoutEvidence",
    group: "lots",
    aim: "lot_overallocation: the lot has no evidence",
    apply(w, r) {
      const index = someIndex(w, r);
      const lot = index === undefined ? -1 : lotIndexOf(w, w.sourceHoldings[index] as LotHolding);
      if (lot >= 0) patchLot(w, lot, { evidenceIds: [] });
    },
  },
  {
    name: "holdingOfOtherBook",
    group: "lots",
    aim: "lot_overallocation: holdings of two books",
    apply(w, r) {
      patchHolding(w, someIndex(w, r), { bookId: bookId("b2") });
    },
  },
  {
    name: "holdingOfOtherCommodity",
    group: "lots",
    aim: "lot_overallocation: holdings of two commodities",
    apply(w, r) {
      patchHolding(w, someIndex(w, r), { commodityId: commodityId("DOGE") });
    },
  },
  {
    name: "holdingOfOtherBasisCommodity",
    group: "lots",
    aim: "lot_overallocation: holdings with two basis commodities",
    apply(w, r) {
      patchHolding(w, someIndex(w, r), { basisCommodityId: commodityId("EUR") });
    },
  },
  {
    name: "mixScope",
    group: "lots",
    aim: "lot_overallocation: holdings, each with a lot that fits it, of two books, commodities or basis commodities",
    apply(w, r) {
      const index = someLiveIndex(w, r);
      if (index === undefined) return;
      const holding = w.sourceHoldings[index] as LotHolding;
      const at = lotIndexOf(w, holding);
      if (at < 0) return;
      const lot = w.lots[at] as Lot;
      // A new lot of its own for the holding, in another book, commodity or basis commodity.
      const other = r.int(0, 2);
      const fresh: Lot = {
        ...lot,
        id: mkLot(w.names.lot(30 + index)),
        ...(other === 0 ? { bookId: bookId("b2") } : {}),
        ...(other === 1 ? { commodityId: commodityId("DOGE") } : {}),
        ...(other === 2 ? { basisCommodityId: commodityId("EUR") } : {}),
      };
      w.lots.push(fresh);
      patchHolding(w, index, {
        lotId: fresh.id,
        ...(other === 0 ? { bookId: bookId("b2") } : {}),
        ...(other === 1 ? { commodityId: commodityId("DOGE") } : {}),
        ...(other === 2 ? { basisCommodityId: commodityId("EUR") } : {}),
      });
    },
  },
  // ---- the selection ----
  {
    name: "switchMethod",
    group: "selection",
    aim: "another method on the same holdings",
    apply(w, r) {
      w.selection = { method: r.pick(METHODS) };
      const total = totalOf(w.sourceHoldings);
      if (w.requested.compare(total) > 0 || w.requested.isZero())
        w.requested = total.multiply(rat(1, 2));
      if (w.requested.isZero()) w.requested = rat(1, 3);
    },
  },
  {
    name: "specificDuplicateHolding",
    group: "selection",
    aim: "lot_overallocation @ selection.allocations (a holding twice)",
    apply(w, r) {
      ensureSpecific(w, r);
      if (w.selection.method !== "specificIdentification") return;
      const first = w.selection.allocations[0];
      if (first !== undefined) {
        w.selection = {
          method: "specificIdentification",
          allocations: [
            ...w.selection.allocations,
            { holdingId: first.holdingId, quantity: rat(1, 2) },
          ],
        };
        w.requested = w.selection.allocations.reduce((sum, a) => sum.add(a.quantity), ZERO);
      }
    },
  },
  {
    name: "specificNotPositive",
    group: "selection",
    aim: "lot_overallocation @ selection.allocations (a quantity of zero or less)",
    apply(w, r) {
      ensureSpecific(w, r);
      if (w.selection.method !== "specificIdentification") return;
      const allocations = [...w.selection.allocations];
      const at = allocations.length === 0 ? -1 : r.int(0, allocations.length - 1);
      if (at >= 0) {
        allocations[at] = {
          holdingId: (allocations[at] as { holdingId: LotHolding["id"] }).holdingId,
          quantity: r.chance(0.5) ? ZERO : rat(-r.int(1, 4), 2),
        };
        w.selection = { method: "specificIdentification", allocations };
        w.requested = allocations.reduce((sum, a) => sum.add(a.quantity), ZERO);
        if (w.requested.isZero() || w.requested.isNegative()) w.requested = rat(1, 2);
      }
    },
  },
  {
    name: "specificTotalMismatch",
    group: "selection",
    aim: "lot_overallocation @ selection.allocations (the total is not the request)",
    apply(w, r) {
      ensureSpecific(w, r);
      w.requested = w.requested.add(rat(r.pick([1, -1, 3]), r.pick([2, 5])));
      if (w.requested.isZero() || w.requested.isNegative()) w.requested = rat(7, 3);
    },
  },
  {
    name: "specificUnknownHolding",
    group: "selection",
    aim: "lot_overallocation @ selection.allocations (a holding that is not there)",
    apply(w, r) {
      ensureSpecific(w, r);
      if (w.selection.method !== "specificIdentification") return;
      const allocations = [...w.selection.allocations];
      const quantity = rat(r.int(1, 5), 2);
      allocations.push({
        holdingId: mkHolding(r.pick(["hz", w.names.holding(40)]) as string),
        quantity,
      });
      w.selection = { method: "specificIdentification", allocations };
      w.requested = allocations.reduce((sum, a) => sum.add(a.quantity), ZERO);
    },
  },
  {
    name: "specificExceedsHolding",
    group: "selection",
    aim: "lot_overallocation @ selection.allocations (more than the holding has)",
    apply(w, r) {
      ensureSpecific(w, r);
      if (w.selection.method !== "specificIdentification") return;
      const allocations = [...w.selection.allocations];
      if (allocations.length === 0) return;
      const at = r.int(0, allocations.length - 1);
      const item = allocations[at] as { holdingId: LotHolding["id"]; quantity: ExactRational };
      const holding = w.sourceHoldings.find((h) => h.id === item.holdingId);
      if (holding === undefined) return;
      allocations[at] = {
        holdingId: item.holdingId,
        quantity: holding.remainingQuantity.add(rat(r.int(1, 5), r.int(1, 3))),
      };
      w.selection = { method: "specificIdentification", allocations };
      w.requested = allocations.reduce((sum, a) => sum.add(a.quantity), ZERO);
    },
  },
  {
    name: "specificFromDepleted",
    group: "selection",
    aim: "a specific selection that names a holding with nothing in it",
    apply(w, r) {
      ensureSpecific(w, r);
      if (w.selection.method !== "specificIdentification") return;
      const empty = w.sourceHoldings.find((h) => h.remainingQuantity.isZero());
      if (empty === undefined) return;
      const allocations = [
        ...w.selection.allocations,
        { holdingId: empty.id, quantity: rat(1, 2) },
      ];
      w.selection = { method: "specificIdentification", allocations };
      w.requested = allocations.reduce((sum, a) => sum.add(a.quantity), ZERO);
    },
  },
  // ---- the identities ----
  {
    name: "missingIdentity",
    group: "identities",
    aim: "lot_overallocation @ identities",
    apply(w, r) {
      if (w.allocationIdentities.length > 0) {
        w.allocationIdentities.splice(r.int(0, w.allocationIdentities.length - 1), 1);
      }
    },
  },
  {
    name: "duplicateAllocationId",
    group: "identities",
    aim: "canonical_identity_conflict @ allocations",
    apply(w) {
      const [first, second] = w.allocationIdentities;
      if (first !== undefined && second !== undefined) {
        w.allocationIdentities[1] = {
          holdingId: second.holdingId,
          allocationId: first.allocationId,
        };
      }
    },
  },
  {
    name: "identityRepeats",
    group: "identities",
    aim: "two identities for one holding: the first is used",
    apply(w, r) {
      const first = w.allocationIdentities[0];
      if (first !== undefined) {
        w.allocationIdentities.splice(r.int(0, w.allocationIdentities.length), 0, {
          holdingId: first.holdingId,
          allocationId: mkAllocation(w.names.allocation(30)),
        });
      }
    },
  },
  // ---- edges ----
  {
    name: "ties",
    group: "edge",
    aim: "lots acquired at one instant (one text), holdings of one unit cost, holdings of one lot",
    apply(w, r) {
      const text = w.lots[0]?.acquiredAt;
      if (text !== undefined) {
        for (let index = 0; index < w.lots.length; index++) {
          if (r.chance(0.7)) patchLot(w, index, { acquiredAt: text });
        }
      }
      const unit = r.pick(UNIT_COSTS) as ExactRational;
      const lot = w.lots[0];
      for (let index = 0; index < w.sourceHoldings.length; index++) {
        const h = w.sourceHoldings[index] as LotHolding;
        if (h.remainingQuantity.isZero()) continue;
        const basis = h.remainingQuantity.multiply(unit);
        patchHolding(w, index, {
          remainingTotalBasis: basis,
          remainingCarryingAmount: basis.add(h.remainingValuationAllowance),
          ...(lot !== undefined && r.chance(0.5) ? { lotId: lot.id } : {}),
        });
      }
      w.tags.add("ties");
    },
  },
  {
    name: "textOrderIsNotTimeOrder",
    group: "edge",
    aim: "two instants whose text order is not their time order (first in orders by the text)",
    apply(w, r) {
      // The same moment written with offsets so that the text of the earlier one sorts last.
      const [a, b] = w.lots;
      if (a === undefined || b === undefined) return;
      const earlierMoment = BASE_MILLIS - 20 * HOUR;
      const laterMoment = BASE_MILLIS - 19 * HOUR;
      // Earlier moment in a positive offset: its wall clock reads later than the later moment's.
      patchLot(w, 0, { acquiredAt: instant(instantAt(earlierMoment, 840, r.pick([0, 3]))) });
      patchLot(w, 1, { acquiredAt: instant(instantAt(laterMoment, -840, r.pick([0, 3]))) });
      w.tags.add("text order is not time order");
    },
  },
  {
    name: "zeroRemaining",
    group: "edge",
    aim: "holdings with nothing left, among holdings with some",
    apply(w, r) {
      for (let index = 0; index < w.sourceHoldings.length; index++) {
        if (r.chance(0.4)) {
          patchHolding(w, index, {
            remainingQuantity: ZERO,
            remainingTotalBasis: ZERO,
            remainingValuationAllowance: ZERO,
            remainingCarryingAmount: ZERO,
          });
        }
      }
      w.tags.add("zero remaining");
    },
  },
  {
    name: "hugeQuantities",
    group: "edge",
    aim: "numbers of thousands of digits, whose products can pass the size limit",
    apply(w, r) {
      const index = someLiveIndex(w, r);
      if (index === undefined) return;
      const bits = r.pick([200, 4100, 8200, 9000, 16000]);
      try {
        const quantity = rat((1n << BigInt(bits)) + BigInt(r.int(0, 999)), r.pick([1, 3, 7]));
        const basis = quantity.multiply(rat(r.pick([1, 2, 5]), r.pick([1, 2])));
        const allowance = r.chance(0.5) ? ZERO : rat(r.int(1, 9));
        patchHolding(w, index, {
          remainingQuantity: quantity,
          remainingTotalBasis: basis,
          remainingValuationAllowance: allowance,
          remainingCarryingAmount: basis.add(allowance),
        });
        w.requested = r.chance(0.5) ? quantity.multiply(rat(1, 2)) : rat(r.int(1, 20), 3);
        if (w.selection.method === "specificIdentification") {
          w.selection = { method: r.pick(METHODS) };
        }
      } catch {
        // The numbers passed the size limit while being made: leave the world as it is.
      }
      w.tags.add("size limit");
    },
  },
  {
    name: "hifoOverflow",
    group: "edge",
    aim: "a highest-cost order whose division passes the size limit for one holding",
    apply(w, r) {
      const index = someLiveIndex(w, r);
      if (index === undefined) return;
      try {
        const quantity = ExactRational.of(1n, 1n << 1000n);
        const basis = rat((1n << 16000n) + 1n, 1n);
        patchHolding(w, index, {
          remainingQuantity: quantity,
          remainingTotalBasis: basis,
          remainingValuationAllowance: ZERO,
          remainingCarryingAmount: basis,
        });
        w.selection = { method: "hifo" };
        w.requested = rat(1, 3);
      } catch {
        return;
      }
      w.tags.add("hifo overflow");
    },
  },
  // ---- the transfer ----
  {
    name: "extremeInstants",
    group: "transfer",
    aim: "policy bounds and the governed moment at the ends of what Date.parse reads",
    apply(w, r) {
      const POOL = [
        "0000-01-01T00:00:00Z",
        "0000-01-01T00:00:00+14:00",
        "0000-12-31T23:59:59.999-14:00",
        "1969-12-31T23:59:59.999Z",
        "1970-01-01T00:00:00Z",
        "1970-01-01T00:00:00.0005Z",
        "2038-01-19T03:14:07Z",
        "9999-12-31T23:59:59.999Z",
        "9999-12-31T23:59:59.999999999999-14:00",
        "9999-12-31T23:59:59+00:00",
        "10000-01-01T00:00:00Z".slice(1),
      ].filter((text) => {
        try {
          instant(text);
          return true;
        } catch {
          return false;
        }
      });
      const pick = () => instant(r.pick(POOL) as string);
      w.governedAt = pick();
      w.policies = w.policies.map((p) => ({
        ...p,
        validFrom: pick(),
        ...(r.chance(0.5) ? { validTo: pick() } : {}),
      }));
      w.tags.add("extreme instants");
    },
  },
  {
    name: "noSource",
    group: "transfer",
    aim: "lot_overallocation @ sourceHoldings (none)",
    apply(w) {
      w.sourceHoldings = [];
    },
  },
  {
    name: "mixedSource",
    group: "transfer",
    aim: "book_isolation_violation @ sourceHoldings (two books or accounts)",
    apply(w, r) {
      const index = someIndex(w, r);
      if (index === undefined) return;
      patchHolding(
        w,
        index,
        r.chance(0.5) ? { bookId: bookId("b2") } : { accountId: accountId("acct-c") },
      );
    },
  },
  {
    name: "policyNone",
    group: "transfer",
    aim: "transfer_policy_missing: found 0",
    apply(w, r) {
      switch (r.int(0, 5)) {
        case 0:
          w.policies = [];
          break;
        case 1:
          w.policies = w.policies.map((p) => ({ ...p, bookId: bookId("b2") }));
          break;
        case 2:
          w.policies = w.policies.map((p) => ({ ...p, sourceAccountId: accountId("acct-x") }));
          break;
        case 3:
          w.policies = w.policies.map((p) => ({ ...p, destinationAccountId: accountId("acct-y") }));
          break;
        case 4: // starts after the governed moment, by a millisecond or an hour
          w.policies = w.policies.map((p) => ({
            ...p,
            validFrom: instant(textAt(r, Date.parse(w.governedAt) + (r.pick([1, HOUR]) as number))),
          }));
          break;
        default: // ends at or before the governed moment: the end is excluded
          w.policies = w.policies.map((p) => ({
            ...p,
            validTo: instant(
              textAt(r, Date.parse(w.governedAt) - (r.pick([0, 0, 1, HOUR]) as number)),
            ),
          }));
      }
    },
  },
  {
    name: "policyBoundary",
    group: "transfer",
    aim: "a policy that starts exactly at the governed moment, or ends exactly at it (excluded)",
    apply(w, r) {
      const moment = Date.parse(w.governedAt);
      w.policies = w.policies.map((p) =>
        r.chance(0.5)
          ? { ...p, validFrom: instant(textAt(r, moment)) }
          : { ...p, validTo: instant(textAt(r, moment + r.pick([0, 1]))) },
      );
    },
  },
  {
    name: "policyTwice",
    group: "transfer",
    aim: "transfer_policy_missing: found 2 or 3",
    apply(w, r) {
      const main = w.policies[0];
      if (main === undefined) return;
      const extra = r.chance(0.5) ? 1 : 2;
      for (let index = 0; index < extra; index++) {
        w.policies.push({
          ...main,
          id: policyId(`tp-${index + 2}`),
          treatment: r.pick(["continuity", "disposalAndReacquisition"] as const),
        });
      }
    },
  },
  {
    name: "policyDecoys",
    group: "transfer",
    aim: "policies that do not apply, beside the one that does",
    apply(w, r) {
      const main = w.policies[0];
      if (main === undefined) return;
      const moment = Date.parse(w.governedAt);
      w.policies.splice(r.int(0, w.policies.length), 0, {
        ...main,
        id: policyId("tp-decoy"),
        bookId: bookId("b2"),
      });
      w.policies.push({
        ...main,
        id: policyId("tp-late"),
        validFrom: instant(textAt(r, moment + HOUR)),
      });
    },
  },
  {
    name: "treatmentDisposal",
    group: "transfer",
    aim: "requiresDisposalAndReacquisition",
    apply(w) {
      w.policies = w.policies.map((p) => ({
        ...p,
        treatment: "disposalAndReacquisition" as const,
      }));
    },
  },
  {
    name: "treatmentContinuity",
    group: "transfer",
    aim: "a continuity transfer",
    apply(w) {
      w.policies = w.policies.map((p) => ({ ...p, treatment: "continuity" as const }));
    },
  },
  {
    name: "sameAccount",
    group: "transfer",
    aim: "lot_overallocation @ destinationAccountId (the same account)",
    apply(w) {
      // The destination is the source account, and the policy matches it.
      w.destinationAccountId = accountId("acct-a");
      w.policies = w.policies.map((p) => ({
        ...p,
        destinationAccountId: accountId("acct-a"),
        treatment: "continuity" as const,
      }));
    },
  },
  {
    name: "destinationOutOfScope",
    group: "transfer",
    aim: "book_isolation_violation @ destinationHoldings",
    apply(w, r) {
      const first = w.sourceHoldings[0];
      if (first === undefined) return;
      const base: LotHolding = w.destinationHoldings[0] ?? {
        ...first,
        id: mkHolding(w.names.destination(50)),
        accountId: accountId("acct-b"),
        remainingQuantity: rat(1),
        remainingTotalBasis: rat(2),
        remainingValuationAllowance: ZERO,
        remainingCarryingAmount: rat(2),
      };
      const spoiled: LotHolding = (() => {
        switch (r.int(0, 3)) {
          case 0:
            return { ...base, bookId: bookId("b2") };
          case 1:
            return { ...base, accountId: accountId("acct-q") };
          case 2:
            return { ...base, commodityId: commodityId("DOGE") };
          default:
            return { ...base, basisCommodityId: commodityId("EUR") };
        }
      })();
      w.destinationHoldings = [spoiled, ...w.destinationHoldings.slice(1)];
    },
  },
  {
    name: "destinationDuplicateId",
    group: "transfer",
    aim: "canonical_identity_conflict @ destinationHoldings (a repeated id, or one a source holding has)",
    apply(w, r) {
      const source = w.sourceHoldings[0];
      if (source === undefined) return;
      const base = w.destinationHoldings[0] ?? {
        ...source,
        id: mkHolding(w.names.destination(51)),
        accountId: accountId("acct-b"),
        remainingQuantity: rat(1),
        remainingTotalBasis: rat(2),
        remainingValuationAllowance: ZERO,
        remainingCarryingAmount: rat(2),
      };
      if (r.chance(0.5)) {
        w.destinationHoldings = [base, { ...base }, ...w.destinationHoldings.slice(1)];
      } else {
        w.destinationHoldings = [{ ...base, id: source.id }, ...w.destinationHoldings.slice(1)];
      }
    },
  },
  {
    name: "missingDestinationIdentity",
    group: "transfer",
    aim: "canonical_identity_conflict @ destinationIdentities (none for a new holding)",
    apply(w, r) {
      if (w.destinationIdentities.length > 0) {
        w.destinationIdentities.splice(r.int(0, w.destinationIdentities.length - 1), 1);
      }
    },
  },
  {
    name: "destinationIdentityTaken",
    group: "transfer",
    aim: "canonical_identity_conflict @ destinationHoldings (the new identifier is already assigned)",
    apply(w, r) {
      if (w.destinationIdentities.length === 0) return;
      const at = r.int(0, w.destinationIdentities.length - 1);
      const item = w.destinationIdentities[at] as DestinationHoldingIdentity;
      const taken =
        w.destinationHoldings[0]?.id ?? (r.chance(0.5) ? w.sourceHoldings[0]?.id : undefined);
      if (taken !== undefined) {
        w.destinationIdentities[at] = {
          sourceHoldingId: item.sourceHoldingId,
          destinationHoldingId: taken,
        };
      }
    },
  },
  {
    name: "destinationIdentityRepeated",
    group: "transfer",
    aim: "two destination identities for one source holding, or the same new identifier twice",
    apply(w, r) {
      const [first, second] = w.destinationIdentities;
      if (first === undefined) return;
      if (second !== undefined && r.chance(0.5)) {
        w.destinationIdentities[1] = {
          sourceHoldingId: second.sourceHoldingId,
          destinationHoldingId: first.destinationHoldingId,
        };
      } else {
        w.destinationIdentities.unshift({
          sourceHoldingId: first.sourceHoldingId,
          destinationHoldingId: mkHolding(w.names.destination(60)),
        });
      }
    },
  },
  {
    name: "firstSourceOnly",
    group: "transfer",
    aim: "the destination is checked against the FIRST source holding only: put one of another commodity first",
    apply(w, r) {
      const first = w.sourceHoldings[0];
      if (first === undefined) return;
      const decoy: LotHolding = {
        ...first,
        id: mkHolding(w.names.holding(60)),
        commodityId: commodityId(r.pick(["DOGE", "EUR"]) as string),
        remainingQuantity: ZERO,
        remainingTotalBasis: ZERO,
        remainingValuationAllowance: ZERO,
        remainingCarryingAmount: ZERO,
      };
      w.sourceHoldings = [decoy, ...w.sourceHoldings];
      w.tags.add("first source only");
    },
  },
];

export const MUTATOR_NAMES = MUTATORS.map((m) => m.name);

// ---------------------------------------------------------------------------------------------
// A case
// ---------------------------------------------------------------------------------------------

export interface Profile {
  readonly groups: readonly Group[];
  readonly clean: number;
  readonly heap: number;
  /** A group the defects are drawn from this often, the rest of the time from every group. A
   * defect late in `transferLots` is reached only when the checks before it pass, so those are
   * asked for more often, and one at a time. */
  readonly focus?: { readonly group: Group; readonly chance: number };
}

export const ALLOCATE: Profile = {
  groups: ["holdings", "request", "lots", "selection", "identities", "edge"],
  clean: 0.25,
  heap: 0.08,
};

export const TRANSFER: Profile = {
  groups: ["holdings", "request", "lots", "selection", "identities", "edge", "transfer"],
  clean: 0.2,
  heap: 0.05,
  focus: { group: "transfer", chance: 0.55 },
};

/**
 * The one class of input on which the model and the engine can differ: the highest-cost order, with
 * at least three candidates, one of which has a unit cost whose division passes the size limit (so
 * that comparing it throws) and one of which has no lot (so that comparing it with another does not
 * divide at all). Then whether the TypeScript throws depends on which pairs the engine's sort
 * compares, and the model's insertion sort compares others (`Lots.compareCandidates`, Lots.lean). The
 * generator never makes it; `lots.test.ts` pins it.
 */
export function hifoPairsMatter(
  holdings: readonly LotHolding[],
  lots: readonly Lot[],
  method: string,
): boolean {
  if (method !== "hifo") return false;
  const candidates = holdings.filter((h) => !h.remainingQuantity.isZero());
  if (candidates.length < 3) return false;
  const overflows = (h: LotHolding): boolean => {
    try {
      h.remainingTotalBasis.divide(h.remainingQuantity);
      return false;
    } catch {
      return true;
    }
  };
  const resolved = (h: LotHolding): boolean => lots.some((lot) => lot.id === h.lotId);
  return candidates.some(overflows) && candidates.some((h) => !resolved(h));
}

export function makeLotsWorld(r: Rng, profile: Profile): LotsWorld {
  const world = cleanLotsWorld(r);
  const pool = MUTATORS.filter((m) => profile.groups.includes(m.group));
  const focused = pool.filter((m) => m.group === profile.focus?.group);
  let defects = 0;
  if (!r.chance(profile.clean))
    defects = r.chance(profile.heap) ? r.int(4, 8) : r.weighted([0, 6, 2, 1]);
  if (defects === 0) world.tags.add("clean");
  for (let index = 0; index < defects; index++) {
    const mutator = (
      focused.length > 0 && r.chance(profile.focus?.chance ?? 0) ? r.pick(focused) : r.pick(pool)
    ) as Mutator;
    mutator.apply(world, r);
    world.tags.add(`mutator:${mutator.name}`);
  }
  if (hifoPairsMatter(world.sourceHoldings, world.lots, world.selection.method)) {
    // Not this class: the first-in order has no division to throw.
    world.selection = { method: "fifo" };
    world.tags.add("hifo order: engine-dependent class left out");
  }
  return world;
}
