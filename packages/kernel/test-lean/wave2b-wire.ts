/**
 * What the two test files of the second wave (b) share: `admission.test.ts` (journal admission,
 * `journal.ts`) and `lots.test.ts` (`lots.ts`). It holds the wire of `proofs/Oracle/Wave2b.lean`
 * (see the head of that file for every record), the way an outcome of the TypeScript is made
 * comparable with the model's, and a seeded generator of random numbers.
 *
 * The wire is ASCII only, as everywhere in this folder (`wave2a-wire.ts` has the pieces it builds
 * on: a string is the hexadecimal of its UTF-16 code units, an integer is a decimal string, a
 * rational is `{numerator, denominator}` and a decimal is `{coefficient, scale}`).
 *
 * Every wire object here is made from the TypeScript VALUE the shipped function is given, never
 * from the description the generator started with, so that what the model reads is exactly what the
 * TypeScript read.
 */
import {
  type AccountId,
  type AccountSnapshot,
  type AccountingCoordinate,
  type Instant,
  allocateLots,
  transferLots,
  type AccountingDimensionSnapshot,
  type DerivationRecord,
  type DimensionMemberSnapshot,
  ExactNumberError,
  type JournalAdmissionSnapshot,
  type JournalTransaction,
  type Lot,
  type LotAllocation,
  type LotAllocationIdentity,
  type LotHolding,
  type LotSelection,
  type Posting,
  type SemanticDiagnostic,
  type TransferPolicy,
  type DestinationHoldingIdentity,
} from "../src/index.ts";
import type { OracleClient, OracleOutcome } from "./oracle-client.ts";
import {
  NUM_RUNS,
  clip,
  count,
  decWire,
  derivationWire,
  diagnosticWire,
  ratWire,
  textToWire as t,
  type SweepCase,
} from "./wave2a-wire.ts";
import type { ExactRational } from "../src/index.ts";

// ---------------------------------------------------------------------------------------------
// A seeded generator. Each case of a test has a generator of its own, made from the seed of the
// test and the index of the case, so that a failing case can be rebuilt alone from its index.
// ---------------------------------------------------------------------------------------------

/** mulberry32: a small generator whose whole state is one 32-bit number. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed | 0;
  }

  /** The seed of case `index` of a stream of cases: two numbers mixed so that neighbours differ. */
  static forCase(seed: number, stream: number, index: number): Rng {
    let mixed = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(stream + 1, 0xc2b2ae35);
    mixed = Math.imul(mixed ^ (mixed >>> 13), 0x27d4eb2f) ^ Math.imul(index + 1, 0x165667b1);
    mixed ^= mixed >>> 15;
    return new Rng(mixed);
  }

  /** A number in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let a = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    a = (a + Math.imul(a ^ (a >>> 7), 61 | a)) ^ a;
    return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer in [low, high]. */
  int(low: number, high: number): number {
    return low + Math.floor(this.next() * (high - low + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(values: readonly T[]): T {
    return values[Math.floor(this.next() * values.length)] as T;
  }

  /** Each value kept with the probability. */
  subset<T>(values: readonly T[], probability: number): T[] {
    return values.filter(() => this.chance(probability));
  }

  /** A fresh array in a random order. */
  shuffle<T>(values: readonly T[]): T[] {
    const out = [...values];
    for (let index = out.length - 1; index > 0; index--) {
      const other = Math.floor(this.next() * (index + 1));
      [out[index], out[other]] = [out[other] as T, out[index] as T];
    }
    return out;
  }

  /** An index chosen with the given weights. */
  weighted(weights: readonly number[]): number {
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let point = this.next() * total;
    for (let index = 0; index < weights.length; index++) {
      point -= weights[index] as number;
      if (point < 0) return index;
    }
    return weights.length - 1;
  }

  /** A bigint of `bits` binary digits at most, any sign. */
  bigInt(bits: number): bigint {
    let value = 0n;
    for (let done = 0; done < bits; done += 30) {
      const take = Math.min(30, bits - done);
      value = (value << BigInt(take)) | BigInt(Math.floor(this.next() * 2 ** take));
    }
    return value;
  }
}

// ---------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------

/**
 * The TypeScript's outcome in the model's terms: an `ExactNumberError` is its code. Any other
 * exception is NOT thrown here: it becomes an outcome (`typescript_threw:<name>: <message>`) that
 * no model answer equals, so that the comparison fails with the input of the case in its message
 * instead of the whole test stopping on an exception without one.
 */
export function outcomeOf<T>(fn: () => T): OracleOutcome<T> {
  try {
    return { kind: "ok", value: fn() };
  } catch (err) {
    if (err instanceof ExactNumberError) return { kind: "error", code: err.code };
    const name = err instanceof Error ? err.name : typeof err;
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", code: `typescript_threw:${name}: ${message}` };
  }
}

// ---------------------------------------------------------------------------------------------
// The records of journal admission
// ---------------------------------------------------------------------------------------------

export function accountWire(account: AccountSnapshot) {
  return {
    id: t(account.id),
    bookId: t(account.bookId),
    code: t(account.code),
    name: t(account.name),
    role: account.role,
    normalSide: account.normalSide,
    postingAllowed: account.postingAllowed,
    openedOn: t(account.openedOn),
    closedOn: account.closedOn === undefined ? null : t(account.closedOn),
    parentId: account.parentId === undefined ? null : t(account.parentId),
    allowedCommodityIds: account.allowedCommodityIds.map(t),
  };
}

export function dimensionWire(dimension: AccountingDimensionSnapshot) {
  return {
    id: t(dimension.id),
    bookId: t(dimension.bookId),
    code: t(dimension.code),
    name: t(dimension.name),
    openedOn: t(dimension.openedOn),
    closedOn: dimension.closedOn === undefined ? null : t(dimension.closedOn),
  };
}

export function memberWire(member: DimensionMemberSnapshot) {
  return {
    id: t(member.id),
    dimensionId: t(member.dimensionId),
    code: t(member.code),
    name: t(member.name),
    openedOn: t(member.openedOn),
    closedOn: member.closedOn === undefined ? null : t(member.closedOn),
    parentId: member.parentId === undefined ? null : t(member.parentId),
  };
}

/** The snapshot as the TypeScript holds it. The map of required dimensions by posting is the
 * object's own enumerable properties in the order `Object.entries` lists them. */
export function snapshotWire(snapshot: JournalAdmissionSnapshot) {
  return {
    bookId: t(snapshot.bookId),
    functionalCommodityId: t(snapshot.functionalCommodityId),
    accounts: snapshot.accounts.map(accountWire),
    dimensions: snapshot.dimensions.map(dimensionWire),
    dimensionMembers: snapshot.dimensionMembers.map(memberWire),
    requiredDimensionIds: snapshot.requiredDimensionIds.map(t),
    requiredDimensionIdsByPosting:
      snapshot.requiredDimensionIdsByPosting === undefined
        ? null
        : Object.entries(snapshot.requiredDimensionIdsByPosting).map(([key, ids]) => [
            t(key),
            ids.map(t),
          ]),
  };
}

export function coordinateWire(coordinate: AccountingCoordinate) {
  return {
    bookId: t(coordinate.bookId),
    functionalCommodityId: t(coordinate.functionalCommodityId),
    accountingDate: t(coordinate.accountingDate),
    accountId: t(coordinate.accountId),
    unitsCommodityId: t(coordinate.unitsCommodityId),
    dimensionMemberIds: coordinate.dimensionMemberIds.map(t),
  };
}

export function postingWire(posting: Posting) {
  return {
    id: t(posting.id),
    ordinal: posting.ordinal.toString(),
    accountId: t(posting.accountId),
    units: {
      canonicalNumber: ratWire(posting.units.canonicalNumber),
      commodityId: t(posting.units.commodityId),
      sourceNumber:
        posting.units.sourceNumber === undefined ? null : decWire(posting.units.sourceNumber),
    },
    bookValue: {
      amount: decWire(posting.bookValue.amount),
      functionalCommodityId: t(posting.bookValue.functionalCommodityId),
    },
    transactionPrice:
      posting.transactionPrice === undefined
        ? null
        : {
            unitRate: ratWire(posting.transactionPrice.unitRate),
            baseCommodityId: t(posting.transactionPrice.baseCommodityId),
            quoteCommodityId: t(posting.transactionPrice.quoteCommodityId),
          },
    costBasis:
      posting.costBasis === undefined
        ? null
        : {
            totalBasis: ratWire(posting.costBasis.totalBasis),
            basisCommodityId: t(posting.costBasis.basisCommodityId),
            sourceTotalBasis:
              posting.costBasis.sourceTotalBasis === undefined
                ? null
                : decWire(posting.costBasis.sourceTotalBasis),
          },
    dimensionMemberIds: posting.dimensionMemberIds.map(t),
  };
}

export function journalWire(journal: JournalTransaction) {
  return {
    id: t(journal.id),
    kind: journal.kind,
    bookId: t(journal.bookId),
    functionalCommodityId: t(journal.functionalCommodityId),
    economicAt: t(journal.economicAt),
    accountingDate: t(journal.accountingDate),
    settledAt: journal.settledAt === undefined ? null : t(journal.settledAt),
    recordedAt: t(journal.recordedAt),
    narration: t(journal.narration),
    postings: journal.postings.map(postingWire),
  };
}

/** A diagnostic of admission on the wire. The `message` is not modelled (`Admission.lean`, head),
 * so it is not on the wire. */
export function admissionDiagnosticWire(d: SemanticDiagnostic) {
  return { code: d.code, path: t(d.path), requirementIds: d.requirementIds.map(t) };
}

/** The shape of a diagnostic, for counting: the code, the path with the identifiers and indexes
 * taken out, and the requirement identifiers. Two diagnostics of one kind are the same check
 * failing in two places. */
export function diagnosticKind(d: SemanticDiagnostic): string {
  const shape = d.path.replace(/\[id=.*?\]/gs, "[id]").replace(/postings\[\d+\]/g, "postings[]");
  return `${d.code} @ ${shape} ${d.requirementIds.join(",")}`;
}

// ---------------------------------------------------------------------------------------------
// The records of the lots
// ---------------------------------------------------------------------------------------------

export function lotWire(lot: Lot) {
  return {
    id: t(lot.id),
    bookId: t(lot.bookId),
    commodityId: t(lot.commodityId),
    acquiredAt: t(lot.acquiredAt),
    acquisitionQuantity: ratWire(lot.acquisitionQuantity),
    acquisitionTotalBasis: ratWire(lot.acquisitionTotalBasis),
    basisCommodityId: t(lot.basisCommodityId),
    evidenceIds: lot.evidenceIds.map(t),
  };
}

export function holdingWire(holding: LotHolding) {
  return {
    id: t(holding.id),
    bookId: t(holding.bookId),
    lotId: t(holding.lotId),
    accountId: t(holding.accountId),
    commodityId: t(holding.commodityId),
    basisCommodityId: t(holding.basisCommodityId),
    remainingQuantity: ratWire(holding.remainingQuantity),
    remainingTotalBasis: ratWire(holding.remainingTotalBasis),
    remainingValuationAllowance: ratWire(holding.remainingValuationAllowance),
    remainingCarryingAmount: ratWire(holding.remainingCarryingAmount),
  };
}

export function selectionWire(selection: LotSelection) {
  if (selection.method === "specificIdentification") {
    return {
      method: selection.method,
      allocations: selection.allocations.map((item) => ({
        holdingId: t(item.holdingId),
        quantity: ratWire(item.quantity),
      })),
    };
  }
  return { method: selection.method };
}

export function identityWire(identity: LotAllocationIdentity) {
  return { holdingId: t(identity.holdingId), allocationId: t(identity.allocationId) };
}

export function destinationIdentityWire(identity: DestinationHoldingIdentity) {
  return {
    sourceHoldingId: t(identity.sourceHoldingId),
    destinationHoldingId: t(identity.destinationHoldingId),
  };
}

export function transferPolicyWire(policy: TransferPolicy) {
  return {
    id: t(policy.id),
    version: t(policy.version),
    bookId: t(policy.bookId),
    sourceAccountId: t(policy.sourceAccountId),
    destinationAccountId: t(policy.destinationAccountId),
    validFrom: t(policy.validFrom),
    validTo: policy.validTo === undefined ? null : t(policy.validTo),
    treatment: policy.treatment,
  };
}

export function allocationWire(allocation: LotAllocation) {
  return {
    id: t(allocation.id),
    holdingId: t(allocation.holdingId),
    lotId: t(allocation.lotId),
    allocatedQuantity: ratWire(allocation.allocatedQuantity),
    allocatedTotalBasis: ratWire(allocation.allocatedTotalBasis),
    allocatedValuationAllowance: ratWire(allocation.allocatedValuationAllowance),
    allocatedCarryingAmount: ratWire(allocation.allocatedCarryingAmount),
    derivation: derivationWire(allocation.derivation),
  };
}

/** A diagnostic of the lots on the wire, WITH its message: the lots model carries the messages. */
export function lotsDiagnosticWire(d: SemanticDiagnostic) {
  return diagnosticWire(d);
}

export type { DerivationRecord };

// ---------------------------------------------------------------------------------------------
// The calls of the lots: one object for each, with the TypeScript's parameter names
// ---------------------------------------------------------------------------------------------

/** What `allocateLots` and `transferLots` are given; `allocateLots` takes the source holdings as
 * its holdings and the allocation identities as its identities. */
export interface LotsInputs {
  readonly sourceHoldings: readonly LotHolding[];
  readonly destinationHoldings: readonly LotHolding[];
  readonly lots: readonly Lot[];
  readonly requested: ExactRational;
  readonly selection: LotSelection;
  readonly policies: readonly TransferPolicy[];
  readonly governedAt: Instant;
  readonly destinationAccountId: AccountId;
  readonly derivation: DerivationRecord;
  readonly allocationIdentities: readonly LotAllocationIdentity[];
  readonly destinationIdentities: readonly DestinationHoldingIdentity[];
}

export function allocateArgs(w: LotsInputs) {
  return {
    holdings: w.sourceHoldings.map(holdingWire),
    lots: w.lots.map(lotWire),
    requestedQuantity: ratWire(w.requested),
    selection: selectionWire(w.selection),
    derivation: derivationWire(w.derivation),
    identities: w.allocationIdentities.map(identityWire),
  };
}

export function transferArgs(w: LotsInputs) {
  return {
    sourceHoldings: w.sourceHoldings.map(holdingWire),
    destinationHoldings: w.destinationHoldings.map(holdingWire),
    lots: w.lots.map(lotWire),
    requestedQuantity: ratWire(w.requested),
    selection: selectionWire(w.selection),
    policies: w.policies.map(transferPolicyWire),
    governedAt: t(w.governedAt),
    destinationAccountId: t(w.destinationAccountId),
    derivation: derivationWire(w.derivation),
    allocationIdentities: w.allocationIdentities.map(identityWire),
    destinationIdentities: w.destinationIdentities.map(destinationIdentityWire),
  };
}

/** `allocateLots` in the model's terms. */
export const tsAllocate = (w: LotsInputs): OracleOutcome<unknown> =>
  outcomeOf(() => {
    const result = allocateLots(
      w.sourceHoldings,
      w.lots,
      w.requested,
      w.selection,
      w.derivation,
      w.allocationIdentities,
    );
    return result.disposition === "allocated"
      ? {
          disposition: "allocated",
          allocations: result.allocations.map(allocationWire),
          holdings: result.holdings.map(holdingWire),
        }
      : { disposition: "rejected", diagnostics: result.diagnostics.map(lotsDiagnosticWire) };
  });

/** `transferLots` in the model's terms. */
export const tsTransfer = (w: LotsInputs): OracleOutcome<unknown> =>
  outcomeOf(() => {
    const result = transferLots(
      w.sourceHoldings,
      w.destinationHoldings,
      w.lots,
      w.requested,
      w.selection,
      w.policies,
      w.governedAt,
      w.destinationAccountId,
      w.derivation,
      w.allocationIdentities,
      w.destinationIdentities,
    );
    if (result.disposition === "transferred") {
      return {
        disposition: "transferred",
        sourceHoldings: result.sourceHoldings.map(holdingWire),
        destinationHoldings: result.destinationHoldings.map(holdingWire),
        allocations: result.allocations.map(allocationWire),
      };
    }
    if (result.disposition === "requiresDisposalAndReacquisition") {
      return {
        disposition: "requiresDisposalAndReacquisition",
        policy: transferPolicyWire(result.policy),
      };
    }
    return { disposition: "rejected", diagnostics: result.diagnostics.map(lotsDiagnosticWire) };
  });

/** The kind of a diagnostic of the lots: the code, the path without indexes and the message
 * without the identifiers it names or the count it reports. */
export function lotsKind(d: SemanticDiagnostic): string {
  const path = d.path.replace(/\[\d+\]/g, "[]");
  const message = d.message
    .replace(
      /^(Holding|Allocation|Destination holding) identifier [\s\S]* (is duplicated|is already assigned)$/,
      "$1 identifier * $2",
    )
    .replace(/found \d+$/, "found N");
  return `${d.code} @ ${path}: ${message}`;
}

// ---------------------------------------------------------------------------------------------
// Sweeps that say everything they found
// ---------------------------------------------------------------------------------------------

/** How many cases a test makes: the number written in the test, scaled by `ORACLE_RUNS` (2000 is
 * the default, so by default the number is the one written). */
export const scaled = (cases: number): number => Math.max(1, Math.round((cases * NUM_RUNS) / 2000));

type Each = { ok?: unknown; error?: string };

export interface Difference {
  readonly index: number;
  readonly input: string;
  readonly ts: OracleOutcome<unknown>;
  readonly lean: OracleOutcome<unknown>;
}

const show = (outcome: OracleOutcome<unknown>): string => clip(JSON.stringify(outcome), 1200);

/**
 * Sends `cases` to the entry `${entry}.each` in batches and compares the TypeScript's outcome with
 * the model's for each. Unlike `sweep` in `wave2a-wire.ts` it does not stop at the first
 * difference: it compares every case and then fails with how many differed and the first few, with
 * the input of each, so that one run shows the whole picture. Returns how many were compared.
 */
export async function compareSweep(
  oracle: OracleClient,
  entry: string,
  name: string,
  cases: Iterable<SweepCase>,
  options: {
    readonly batch?: number;
    readonly tally?: (outcome: OracleOutcome<unknown>, index: number) => void;
    readonly report?: number;
  } = {},
): Promise<number> {
  const size = options.batch ?? 256;
  const report = options.report ?? 3;
  const differences: Difference[] = [];
  let total = 0;
  let batch: SweepCase[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const answer = await oracle.call<Each[]>(`${entry}.each`, [batch.map((one) => one.args)]);
    if (answer.kind !== "ok" || answer.value.length !== batch.length) {
      throw new Error(
        `${entry}.each did not answer every call: ${JSON.stringify(answer).slice(0, 300)}`,
      );
    }
    for (let index = 0; index < batch.length; index++) {
      const one = batch[index] as SweepCase;
      const each = answer.value[index] as Each;
      const lean: OracleOutcome<unknown> =
        each.error === undefined
          ? { kind: "ok", value: each.ok }
          : { kind: "error", code: each.error };
      const ts = one.ts();
      if (!Bun.deepEquals(ts, lean, true)) {
        differences.push({ index: total + index, input: one.show(), ts, lean });
      }
      options.tally?.(ts, total + index);
    }
    total += batch.length;
    batch = [];
  };
  for (const one of cases) {
    batch.push(one);
    if (batch.length === size) await flush();
  }
  await flush();
  count(name, total);
  if (differences.length > 0) {
    const lines = differences
      .slice(0, report)
      .map(
        (d) => `  case ${d.index}: ${d.input}\n    TS:   ${show(d.ts)}\n    Lean: ${show(d.lean)}`,
      );
    throw new Error(
      `${entry} differs in ${differences.length} of ${total} cases (${name}); the first ${lines.length}:\n${lines.join("\n")}`,
    );
  }
  return total;
}
