import { expect, test } from "bun:test";
import { resolveBookAccountingPeriod, fiscalPeriodId, localDate, type BookAccountingPeriodReadContext, type FiscalPeriod, type JournalTransaction } from "../src/index.ts";
import { periods, IDS } from "./fixtures.ts";

const adjustment: FiscalPeriod = Object.freeze({ ...periods[0]!, id: fiscalPeriodId("jan-adjustment"), kind: "adjustment", sequence: 3n });
const catalog = Object.freeze([...periods, adjustment]);

test("accounting-period selection needs no journal or posting and preserves inclusive date boundaries", () => {
  const calls: string[] = [];
  const context: BookAccountingPeriodReadContext = { periods: catalog, periodStatus(id) { calls.push(id); return "open"; } };
  for (const [date, expected] of [["2026-01-01", IDS.period1], ["2026-01-31", IDS.period1], ["2026-02-01", IDS.period2], ["2026-02-28", IDS.period2]] as const) {
    for (const kind of ["ordinary", "opening", "adjustment", "closing", "reversing"] as const) {
      const activity = Object.freeze({ accountingDate: localDate(date), kind });
      const selected = resolveBookAccountingPeriod(context, activity, undefined, false);
      expect("code" in selected).toBe(false);
      if ("code" in selected) throw new Error(selected.message);
      expect(selected.id).toBe(expected);
      expect(calls.at(-1)).toBe(expected);
      expect(Object.keys(activity)).toEqual(["accountingDate", "kind"]);
    }
  }
  expect(calls.length).toBe(20);
  expect(Object.keys(context)).toEqual(["periods", "periodStatus"]);
});

test("an adjustment period requires explicit selection and an admitted activity kind", () => {
  const calls: string[] = [];
  const context: BookAccountingPeriodReadContext = { periods: catalog, periodStatus(id) { calls.push(id); return "open"; } };
  const activity = { accountingDate: localDate("2026-01-15"), kind: "adjustment" as const };
  expect(resolveBookAccountingPeriod(context, activity, undefined, false)).toBe(periods[0]!);
  for (const kind of ["ordinary", "opening", "adjustment", "closing", "reversing"] as const) {
    const beforeCalls = calls.length;
    const selected = resolveBookAccountingPeriod(context, { ...activity, kind }, adjustment.id, false);
    if (kind === "adjustment" || kind === "closing") {
      expect(selected).toBe(adjustment);
      expect(calls.slice(beforeCalls)).toEqual([adjustment.id]);
    } else {
      expect(selected).toEqual({ code: "fiscal_period_admission", path: "fiscalPeriodId", message: "Explicit fiscal period does not admit this journal date and kind", requirementIds: ["ACC-029"] });
      expect(calls.length).toBe(beforeCalls);
    }
  }
});

test("missing, overlapping and incompatible periods fail before closure lookup", () => {
  const activity = { accountingDate: localDate("2026-01-15"), kind: "ordinary" as const };
  const periodStatus = () => { throw new Error("Unexpected closure lookup"); };
  for (const available of [[], [adjustment], [periods[0]!, { ...periods[0]!, id: fiscalPeriodId("overlap") }]]) {
    const selected = resolveBookAccountingPeriod({ periods: available, periodStatus }, activity, undefined, false);
    expect("code" in selected).toBe(true);
    if (!("code" in selected)) throw new Error("Invalid period population admitted");
    expect(selected.path).toBe("journal.accountingDate");
    expect(selected.message).toBe(`Accounting date must resolve to exactly one regular fiscal period; found ${available.length === 2 ? 2 : 0}`);
  }
  for (const id of [fiscalPeriodId("unknown"), IDS.period2]) {
    expect(resolveBookAccountingPeriod({ periods: catalog, periodStatus }, activity, id, false)).toEqual({ code: "fiscal_period_admission", path: "fiscalPeriodId", message: "Explicit fiscal period does not admit this journal date and kind", requirementIds: ["ACC-029"] });
  }
  for (const date of ["2025-12-31", "2026-03-01"]) {
    const selected = resolveBookAccountingPeriod({ periods: catalog, periodStatus }, { ...activity, accountingDate: localDate(date) }, undefined, false);
    expect("code" in selected).toBe(true);
  }
});

test("closure evidence must be synchronous and complete; governed closed-period mode is not inferred", () => {
  const activity: Pick<JournalTransaction, "accountingDate" | "kind"> = { accountingDate: localDate("2026-01-15"), kind: "adjustment" };
  for (const id of [IDS.period1, adjustment.id]) {
    expect(resolveBookAccountingPeriod({ periods: catalog, periodStatus: () => "closed" }, activity, id, false)).toEqual({ code: "fiscal_period_admission", path: "fiscalPeriodId", message: `Fiscal period ${id} is closed`, requirementIds: ["ACC-029", "ACC-032"] });
    for (const unresolved of [undefined, null, false, "unknown", Promise.resolve("open")]) {
      expect(() => resolveBookAccountingPeriod({ periods: catalog, periodStatus: () => unresolved } as unknown as BookAccountingPeriodReadContext, activity, id, false)).toThrow("Incomplete period closure evidence");
    }
  }
  expect(() => resolveBookAccountingPeriod({ periods: catalog, periodStatus() { throw new Error("Source failed"); } }, activity, undefined, false)).toThrow("Source failed");
  // Matches the existing separately governed close/correction call path. The
  // resolver itself neither grants authority nor commits a non-journal effect.
  expect(resolveBookAccountingPeriod({ periods: catalog, periodStatus() { throw new Error("Governed mode should not look up closure"); } }, activity, adjustment.id, true)).toBe(adjustment);
});
