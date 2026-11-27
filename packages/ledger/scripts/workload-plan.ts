import type { BookCommand } from "@rastrata/kernel";

// Planning arithmetic only: these are synthetic proposals, not measured capacity,
// generated BookCommands, an approved release contract, or jurisdictional policy.
const commandTypes = {
  activateBook: 0n,
  postJournal: 0n,
  correctJournal: 0n,
  closePeriod: 0n,
  reopenPeriod: 0n,
  replaceConfiguration: 0n,
  postInventoryTransaction: 0n,
  postOwnedInventoryTransaction: 0n, // Not exercised by the legacy workload mapping.
  recostProvisionalInventory: 0n,
  adjustInventoryValue: 0n,
  recognizeOpenItem: 0n,
  applySettlement: 0n,
  postCurrencyRemeasurement: 0n,
  createAllocationSchedule: 0n,
  recognizeScheduledAllocation: 0n,
  reviseAllocationSchedule: 0n,
  postTaxedTransaction: 0n,
  compileConsolidation: 0n,
} satisfies Record<BookCommand["type"], bigint>;

export const eventCommands = {
  creditSales: ["recognizeOpenItem"],
  creditPurchases: ["recognizeOpenItem"],
  settlementPayments: ["applySettlement"],
  taxedCashTransactions: ["postTaxedTransaction"],
  otherJournals: ["postJournal"],
  corrections: ["correctJournal"],
  inventoryReceiptLines: ["postJournal"],
  inventoryIssueLines: ["postInventoryTransaction"],
  provisionalRecostings: ["recostProvisionalInventory"],
  inventoryAdjustments: ["adjustInventoryValue"],
  newAllocationSchedules: ["createAllocationSchedule"],
  allocationRecognitions: ["recognizeScheduledAllocation"],
  allocationRevisions: ["reviseAllocationSchedule"],
  currencyRemeasurements: ["postCurrencyRemeasurement"],
  consolidations: ["compileConsolidation"],
  matchedBankStatementLines: [],
} as const satisfies Record<string, readonly BookCommand["type"][]>;

type Event = keyof typeof eventCommands;
export interface WorkloadProfile {
  readonly id: string;
  readonly monthly: Readonly<Record<Event, number>>;
  readonly populationTargets: {
    readonly accounts: number;
    readonly dimensionMembers: number;
    readonly openItems: number;
    readonly liveLots: number;
    readonly activeSchedules: number;
    readonly currencies: number;
    readonly consolidationSources: number;
    readonly balancesPerSource: number;
  };
}

const emptyMonth: Record<Event, number> = {
  creditSales: 0,
  creditPurchases: 0,
  settlementPayments: 0,
  taxedCashTransactions: 0,
  otherJournals: 0,
  corrections: 0,
  inventoryReceiptLines: 0,
  inventoryIssueLines: 0,
  provisionalRecostings: 0,
  inventoryAdjustments: 0,
  newAllocationSchedules: 0,
  allocationRecognitions: 0,
  allocationRevisions: 0,
  currencyRemeasurements: 0,
  consolidations: 0,
  matchedBankStatementLines: 0,
};

export const workloadProfiles = [
  {
    id: "service",
    monthly: {
      ...emptyMonth,
      creditSales: 5_000,
      creditPurchases: 2_000,
      settlementPayments: 8_400,
      taxedCashTransactions: 3_000,
      otherJournals: 500,
      corrections: 100,
      newAllocationSchedules: 20,
      allocationRecognitions: 200,
      allocationRevisions: 2,
      matchedBankStatementLines: 12_000,
    },
    populationTargets: {
      accounts: 500,
      dimensionMembers: 1_000,
      openItems: 15_000,
      liveLots: 0,
      activeSchedules: 200,
      currencies: 1,
      consolidationSources: 0,
      balancesPerSource: 0,
    },
  },
  {
    id: "inventory",
    monthly: {
      ...emptyMonth,
      creditSales: 50_000,
      creditPurchases: 10_000,
      settlementPayments: 72_000,
      taxedCashTransactions: 5_000,
      otherJournals: 1_000,
      corrections: 1_000,
      inventoryReceiptLines: 30_000,
      inventoryIssueLines: 150_000,
      provisionalRecostings: 100,
      inventoryAdjustments: 100,
      newAllocationSchedules: 100,
      allocationRecognitions: 2_000,
      allocationRevisions: 20,
      matchedBankStatementLines: 80_000,
    },
    populationTargets: {
      accounts: 1_000,
      dimensionMembers: 10_000,
      openItems: 120_000,
      liveLots: 100_000,
      activeSchedules: 2_000,
      currencies: 1,
      consolidationSources: 0,
      balancesPerSource: 0,
    },
  },
  {
    id: "multicurrency",
    monthly: {
      ...emptyMonth,
      creditSales: 20_000,
      creditPurchases: 5_000,
      settlementPayments: 30_000,
      taxedCashTransactions: 2_000,
      otherJournals: 1_000,
      corrections: 250,
      newAllocationSchedules: 200,
      allocationRecognitions: 5_000,
      allocationRevisions: 50,
      currencyRemeasurements: 10,
      matchedBankStatementLines: 35_000,
    },
    populationTargets: {
      accounts: 2_000,
      dimensionMembers: 20_000,
      openItems: 60_000,
      liveLots: 0,
      activeSchedules: 5_000,
      currencies: 10,
      consolidationSources: 0,
      balancesPerSource: 0,
    },
  },
  {
    id: "consolidation",
    monthly: { ...emptyMonth, consolidations: 1, otherJournals: 10 },
    populationTargets: {
      accounts: 2_000,
      dimensionMembers: 20_000,
      openItems: 0,
      liveLots: 0,
      activeSchedules: 0,
      currencies: 10,
      consolidationSources: 20,
      balancesPerSource: 2_000,
    },
  },
] as const satisfies readonly WorkloadProfile[];

function count(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid workload count");
  return BigInt(value);
}

function ceilRatio(value: bigint, numerator: bigint, denominator: bigint): bigint {
  return (value * numerator + denominator - 1n) / denominator;
}

export function summarizeWorkload(profile: WorkloadProfile, volumeMultiplier = 1) {
  const multiplier = count(volumeMultiplier);
  if (multiplier === 0n || profile.id.trim().length === 0) throw new Error("Empty workload");
  for (const population of Object.values(profile.populationTargets)) count(population);
  const committedByType = { ...commandTypes };
  const events: Partial<Record<Event, bigint>> = {};
  for (const event of Object.keys(eventCommands) as Event[]) {
    const total = count(profile.monthly[event]) * 120n * multiplier;
    events[event] = total;
    for (const type of eventCommands[event]) committedByType[type] += total;
  }
  // One activation, 120 month closes, 40 quarterly reopen/reclose exercises,
  // and 10 annual configuration changes. These are not volume-multiplied.
  committedByType.activateBook += 1n;
  committedByType.closePeriod += 160n;
  committedByType.reopenPeriod += 40n;
  committedByType.replaceConfiguration += 10n;
  const committed = Object.values(committedByType).reduce((a, b) => a + b, 0n);
  // Additional distinct, retainable business rejections, not transport/auth failures.
  const retainedRejections = ceilRatio(committed, 2n, 100n);
  const retainedOutcomes = committed + retainedRejections;
  const retryAttempts = ceilRatio(retainedOutcomes, 10n, 100n);
  return {
    status: "proposal-not-executed" as const,
    profileId: profile.id,
    months: 120,
    volumeMultiplier,
    populationTargets: profile.populationTargets,
    events,
    committedByType,
    committed,
    retainedRejections,
    retainedOutcomes,
    retryAttempts,
    submissionAttempts: retainedOutcomes + retryAttempts,
    // Hypothetical bytes/outcome, NOT a codec measurement or total storage forecast.
    payloadSensitivity: [256n, 1_024n, 4_096n].map((bytesPerOutcome) => ({
      bytesPerOutcome,
      payloadBytes: retainedOutcomes * bytesPerOutcome,
    })),
    productionExecutionVerified: false,
  };
}

if (import.meta.main) {
  console.log(
    JSON.stringify(
      workloadProfiles.flatMap((profile) =>
        [1, 2].map((scale) => summarizeWorkload(profile, scale)),
      ),
      (_key, value: unknown) => (typeof value === "bigint" ? String(value) : value),
      2,
    ),
  );
}
