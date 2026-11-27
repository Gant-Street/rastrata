import { expect, test } from "bun:test";
import {
  planPermanentIdentities,
  projectFlatLocatorBytes,
} from "../scripts/permanent-identity-plan.ts";
import { workloadProfiles } from "../scripts/workload-plan.ts";

test("identity sizing independently accounts for one recurring business event plus fixed lifecycle", () => {
  const base = workloadProfiles[0];
  const monthly = Object.fromEntries(
    Object.keys(base.monthly).map((key) => [key, 0]),
  ) as unknown as typeof base.monthly;
  // 211 fixed commands -> 216 retained IDs; 160 close-package IDs. Bank matching
  // adds none. One event/month adds 120 commands and changes retained IDs to 338.
  const empty = { ...base, monthly };
  expect(planPermanentIdentities(empty).minimumLogicalKeys).toBe(376n);
  const expected = [
    ["otherJournals", 858n], // 338 commands + 120 journals + 240 postings + 160 closes
    ["creditSales", 978n], // plus 120 open items
    ["settlementPayments", 1098n], // plus 120 settlements + 120 allocation edges
    ["inventoryReceiptLines", 1098n], // plus 120 lots + 120 holdings
    ["inventoryIssueLines", 978n], // plus 120 allocation-or-provisional identities
    ["matchedBankStatementLines", 376n],
  ] as const;
  for (const [event, keys] of expected) {
    const plan = planPermanentIdentities({ ...base, monthly: { ...monthly, [event]: 1 } });
    expect(plan.minimumLogicalKeys).toBe(keys);
    expect(plan.flatSha256KeyBytesOnly).toBe(keys * 32n);
    expect(plan.status).toBe("planning-minimum-not-executed");
    expect(plan.productionExecutionVerified).toBe(false);
  }
});

test("inventory registry counts far more keys than outcomes without double-counting alternative effects", () => {
  const base = planPermanentIdentities(workloadProfiles[1]);
  expect(base.retainedOutcomes).toBe(39_329_784n);
  expect(base.counts.journals).toBe(38_532_000n);
  expect(base.counts.postings).toBe(77_064_000n);
  expect(base.counts.lots).toBe(3_600_000n);
  expect(base.counts.holdings).toBe(3_600_000n);
  expect(base.counts.inventoryIssueAllocationOrProvisionalLayer).toBe(18_000_000n);
  expect(base.counts.settlements).toBe(8_640_000n);
  expect(base.counts.settlementAllocations).toBe(8_640_000n);
  expect(base.minimumLogicalKeys).toBe(205_484_344n);
  const growth = planPermanentIdentities(workloadProfiles[1], 2);
  expect(growth.minimumLogicalKeys).toBe(410_968_312n);
  expect(growth.flatSha256KeyBytesOnly).toBe(13_150_985_984n);
  expect(growth.counts.closePackages).toBe(160n);
  expect(growth.counts.commands).toBe(78_659_352n);
});

test("projection is exact arithmetic with explicit invalid-input guards", () => {
  expect(projectFlatLocatorBytes(4n, 10n, 3n)).toBe(14n);
  expect(projectFlatLocatorBytes(0n, 10n, 3n)).toBe(0n);
  expect(() => projectFlatLocatorBytes(-1n, 10n, 3n)).toThrow();
  expect(() => projectFlatLocatorBytes(1n, 0n, 3n)).toThrow();
  expect(() => projectFlatLocatorBytes(1n, 10n, 0n)).toThrow();
  expect(() => planPermanentIdentities(workloadProfiles[1], 0)).toThrow();
  expect(() => planPermanentIdentities(workloadProfiles[1], -1)).toThrow();
});

test("the CLI binds its raw sizing source and discloses unexecuted projections", () => {
  const result = Bun.spawnSync([
    process.execPath,
    `${import.meta.dir}/../scripts/permanent-identity-plan.ts`,
  ]);
  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout.toString());
  expect(report.measurement).toMatchObject({
    layout: "hash32-locator-only",
    rows: 300_000,
    databaseBytes: 14_766_080,
  });
  expect(report.sourceIdentities).toHaveLength(3);
  expect(report.scenarios).toHaveLength(8);
  expect(report.productionReadinessProven).toBe(false);
  for (const scenario of report.scenarios) {
    expect(scenario.productionExecutionVerified).toBe(false);
    expect(scenario.measuredAtTargetVolume).toBe(false);
    expect(BigInt(scenario.minimumLogicalKeys)).toBeGreaterThan(BigInt(scenario.retainedOutcomes));
  }
});
