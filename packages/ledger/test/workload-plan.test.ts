import { expect, test } from "bun:test";
import { eventCommands, summarizeWorkload, workloadProfiles } from "../scripts/workload-plan.ts";

const service = workloadProfiles[0];

test("business workload arithmetic has independently specified decade totals", () => {
  const expected = [
    [2_306_851n, 2_352_989n],
    [38_558_611n, 39_329_784n],
    [7_621_411n, 7_773_840n],
    [1_531n, 1_562n],
  ];
  for (const [index, profile] of workloadProfiles.entries()) {
    const target = expected[index];
    if (target === undefined) throw new Error("Missing independent expected totals");
    const summary = summarizeWorkload(profile);
    expect([summary.committed, summary.retainedOutcomes]).toEqual(target);
    expect(summary.submissionAttempts).toBe(summary.retainedOutcomes + summary.retryAttempts);
    expect(summary.status).toBe("proposal-not-executed");
    expect(summary.productionExecutionVerified).toBe(false);
  }
});

test("matched bank lines add neither financial effects nor retained commands", () => {
  const base = summarizeWorkload(service);
  const changed = summarizeWorkload({
    ...service,
    monthly: { ...service.monthly, matchedBankStatementLines: 1_000_000 },
  });
  expect(eventCommands.matchedBankStatementLines).toEqual([]);
  expect(changed.retainedOutcomes).toBe(base.retainedOutcomes);
  expect(changed.committedByType).toEqual(base.committedByType);
  expect(changed.events.matchedBankStatementLines).toBe(120_000_000n);
});

test("event-to-command expansion includes acquisition, cost, lifecycle and permanent rejections", () => {
  const inventory = summarizeWorkload(workloadProfiles[1]);
  expect(inventory.committedByType.recognizeOpenItem).toBe(7_200_000n);
  expect(inventory.committedByType.postInventoryTransaction).toBe(18_000_000n);
  expect(inventory.committedByType.postJournal).toBe(3_720_000n);
  expect(inventory.committedByType.closePeriod).toBe(160n);
  expect(inventory.committedByType.reopenPeriod).toBe(40n);
  expect(inventory.retainedRejections).toBe(771_173n);
  expect(inventory.retryAttempts).toBe(3_932_979n);
  expect(inventory.payloadSensitivity[1]?.payloadBytes).toBe(40_273_698_816n);
});

test("growth doubles event volume, not book activation or fixed live population targets", () => {
  const base = summarizeWorkload(service);
  const growth = summarizeWorkload(service, 2);
  expect(growth.committed).toBe((base.committed - 211n) * 2n + 211n);
  expect(growth.committedByType.activateBook).toBe(1n);
  expect(growth.populationTargets).toEqual(base.populationTargets);
});

test("planning arithmetic rejects invalid counts and uses exact wide products", () => {
  for (const value of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() =>
      summarizeWorkload({
        ...service,
        monthly: { ...service.monthly, creditSales: value },
      }),
    ).toThrow();
    expect(() =>
      summarizeWorkload({
        ...service,
        populationTargets: { ...service.populationTargets, openItems: value },
      }),
    ).toThrow();
    expect(() => summarizeWorkload(service, value)).toThrow();
  }
  expect(() => summarizeWorkload(service, 0)).toThrow();
  expect(() => summarizeWorkload({ ...service, id: " " })).toThrow();
  const wide = summarizeWorkload({
    ...service,
    monthly: { ...service.monthly, creditSales: Number.MAX_SAFE_INTEGER },
  });
  expect(wide.events.creditSales).toBe(1_080_863_910_568_918_920n);
});

test("the planning command emits eight explicit unexecuted scenarios with exact string counters", () => {
  const result = Bun.spawnSync([
    process.execPath,
    `${import.meta.dir}/../scripts/workload-plan.ts`,
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  const rows = JSON.parse(result.stdout.toString());
  expect(rows).toHaveLength(8);
  expect(
    rows.map(
      (row: { profileId: string; volumeMultiplier: number }) =>
        `${row.profileId}:${row.volumeMultiplier}`,
    ),
  ).toEqual([
    "service:1",
    "service:2",
    "inventory:1",
    "inventory:2",
    "multicurrency:1",
    "multicurrency:2",
    "consolidation:1",
    "consolidation:2",
  ]);
  for (const row of rows) {
    expect(row.status).toBe("proposal-not-executed");
    expect(row.productionExecutionVerified).toBe(false);
    expect(row.retainedOutcomes).toMatch(/^[1-9][0-9]*$/);
    expect(BigInt(row.retainedOutcomes)).toBe(
      BigInt(row.committed) + BigInt(row.retainedRejections),
    );
  }
});
