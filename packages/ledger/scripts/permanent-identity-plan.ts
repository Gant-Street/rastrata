import type { BookCommand } from "@rastrata/kernel";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { summarizeWorkload, workloadProfiles, type WorkloadProfile } from "./workload-plan.ts";

const families = {
  commands: 0n,
  journals: 0n,
  postings: 0n,
  lots: 0n,
  holdings: 0n,
  inventoryIssueAllocationOrProvisionalLayer: 0n,
  inventoryRecostings: 0n,
  inventoryValueAdjustments: 0n,
  openItems: 0n,
  settlements: 0n,
  settlementAllocations: 0n,
  remeasurementResultsOrReversals: 0n,
  allocationSchedules: 0n,
  allocationRecognitions: 0n,
  allocationScheduleRevisions: 0n,
  taxDeterminations: 0n,
  consolidationCompilations: 0n,
  closePackages: 0n,
};
type Family = keyof typeof families;

// Minimum new identities on a successful command, not observed command execution.
// One inventory issue needs at least a lot allocation or a provisional layer;
// one remeasurement creates a result or a reversal. Neither alternative is counted twice.
// Optional journals/successors and extra allocation edges are deliberately excluded.
const commandMinimum = {
  activateBook: {},
  postJournal: { journals: 1 },
  correctJournal: { journals: 1 },
  closePeriod: { closePackages: 1 },
  reopenPeriod: {},
  replaceConfiguration: {},
  postInventoryTransaction: { journals: 1, inventoryIssueAllocationOrProvisionalLayer: 1 },
  postOwnedInventoryTransaction: {}, // Explicitly unsupported below, not a zero-cost estimate.
  recostProvisionalInventory: { inventoryRecostings: 1 },
  adjustInventoryValue: { journals: 1, inventoryValueAdjustments: 1 },
  recognizeOpenItem: { journals: 1, openItems: 1 },
  applySettlement: { settlements: 1, settlementAllocations: 1 },
  postCurrencyRemeasurement: { journals: 1, remeasurementResultsOrReversals: 1 },
  createAllocationSchedule: { allocationSchedules: 1 },
  recognizeScheduledAllocation: { journals: 1, allocationRecognitions: 1 },
  reviseAllocationSchedule: { allocationScheduleRevisions: 1 },
  postTaxedTransaction: { journals: 1, taxDeterminations: 1 },
  compileConsolidation: { journals: 1, consolidationCompilations: 1 },
} satisfies Record<BookCommand["type"], Partial<Record<Family, number>>>;

export function planPermanentIdentities(profile: WorkloadProfile, scale = 1) {
  const workload = summarizeWorkload(profile, scale);
  if (workload.committedByType.postOwnedInventoryTransaction !== 0n)
    throw new Error("Owned inventory requires a reviewed identity/capacity model");
  const counts = { ...families, commands: workload.retainedOutcomes };
  for (const type of Object.keys(commandMinimum) as BookCommand["type"][]) {
    for (const [family, amount] of Object.entries(commandMinimum[type])) {
      counts[family as Family] += workload.committedByType[type] * BigInt(amount);
    }
  }
  // Business-profile assumptions, NOT universal kernel command invariants:
  // each new payment includes one new payment journal, and each receiving line
  // creates one lot plus one holding. Setup/imported population is additional.
  counts.journals += BigInt(profile.monthly.settlementPayments) * 120n * BigInt(scale);
  counts.lots += BigInt(profile.monthly.inventoryReceiptLines) * 120n * BigInt(scale);
  counts.holdings += counts.lots;
  // admitJournal requires at least two real postings, with globally unique IDs.
  counts.postings = 2n * counts.journals;
  const minimumLogicalKeys = Object.values(counts).reduce((a, b) => a + b, 0n);
  return {
    status: "planning-minimum-not-executed" as const,
    profileId: profile.id,
    volumeMultiplier: scale,
    retainedOutcomes: workload.retainedOutcomes,
    counts,
    minimumLogicalKeys,
    // Conditional representation cost: one full SHA-256 key per identity, no values,
    // metadata, page overhead, integrity nodes or compression/derivation scheme.
    flatSha256KeyBytesOnly: minimumLogicalKeys * 32n,
    productionExecutionVerified: false,
  };
}

export function projectFlatLocatorBytes(keys: bigint, measuredBytes: bigint, measuredKeys: bigint) {
  if (keys < 0n || measuredBytes <= 0n || measuredKeys <= 0n)
    throw new Error("Invalid projection input");
  return (keys * measuredBytes + measuredKeys - 1n) / measuredKeys;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "../../..");
  const reportPath = "docs/reference/reviews/ledger-index-capacity-2026-09-05.json";
  const raw = readFileSync(resolve(root, reportPath), "utf8");
  const report = JSON.parse(raw);
  const measurement = report.results.find(
    (result: { layout: { id: string } }) => result.layout.id === "hash32-locator-only",
  );
  const last = measurement?.samples.at(-1);
  if (
    report.completed !== true ||
    measurement?.allMappingsVerified !== true ||
    last?.rows !== measurement.targetRows ||
    !Number.isSafeInteger(last?.databaseBytes) ||
    last.databaseBytes <= 0 ||
    !Number.isSafeInteger(last?.rows) ||
    last.rows <= 0
  ) {
    throw new Error("Missing completed locator experiment");
  }
  console.log(
    JSON.stringify(
      {
        schema: "rastrata-permanent-identity-sizing-v1",
        sourceIdentities: [
          "packages/ledger/scripts/permanent-identity-plan.ts",
          "packages/ledger/scripts/workload-plan.ts",
          reportPath,
        ].map((path) => ({
          path,
          sha256: new Bun.CryptoHasher("sha256")
            .update(readFileSync(resolve(root, path)))
            .digest("hex"),
        })),
        assumptions: [
          "All identities remain assigned for the book lifetime; retries create no new identities.",
          "New payment events include one new journal; receiving lines create one lot and one holding.",
          "Two postings per journal, one settlement allocation per payment, and one allocation-or-provisional identity per inventory issue are minima, not realistic document widths.",
          "Optional closing/recost/revision/FX journals, extra allocations, successor schedules, setup/imports, metadata, secondary indexes, integrity nodes, canonical payloads and live projections are excluded.",
          "Logical keys need not be physically stored as individual rows. Extrapolating a command-only SQLite sample to all families is a sensitivity, not a measured combined registry.",
        ],
        measurement: {
          path: reportPath,
          layout: measurement.layout.id,
          rows: last.rows,
          databaseBytes: last.databaseBytes,
        },
        scenarios: workloadProfiles.flatMap((profile) =>
          [1, 2].map((scale) => {
            const plan = planPermanentIdentities(profile, scale);
            const projectedBytes = projectFlatLocatorBytes(
              plan.minimumLogicalKeys,
              BigInt(last.databaseBytes),
              BigInt(last.rows),
            );
            return {
              ...plan,
              projectedFlatLocatorBytes: projectedBytes,
              measuredAtTargetVolume: false,
            };
          }),
        ),
        productionReadinessProven: false,
      },
      (_key, value: unknown) => (typeof value === "bigint" ? String(value) : value),
      2,
    ),
  );
}
