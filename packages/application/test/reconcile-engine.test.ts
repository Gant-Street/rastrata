import { expect, test } from "bun:test";
import {
  addDays,
  canonicalStatementBalance,
  isCalendarDate,
  reconcileFigures,
  statementAmount,
  statementDateProblem,
  statementSign,
} from "../src/reconcile/engine.ts";
import { formatMoney, parseMoney } from "../src/money.ts";

/** A small deterministic generator so the property tests fail the same way every time. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test("a difference is exact where floating point is not: 0.10 + 0.20 clears 0.30", () => {
  // 0.1 + 0.2 === 0.30000000000000004 in floating point; cents never go near it.
  const figures = reconcileFigures({
    opening: 0n,
    statement: parseMoney("0.30"),
    selected: [parseMoney("0.10"), parseMoney("0.20")],
  });
  expect(figures).toEqual({
    selectedCount: 2,
    selectedTotal: "0.30",
    clearedBalance: "0.30",
    difference: "0.00",
    canComplete: true,
  });
  const off = reconcileFigures({
    opening: 0n,
    statement: parseMoney("0.30"),
    selected: [parseMoney("0.10"), parseMoney("0.19")],
  });
  expect(off.difference).toBe("0.01");
  expect(off.canComplete).toBe(false);
});

test("a single cent is a difference at amounts a float cannot hold", () => {
  const big = parseMoney("9007199254740993.01");
  expect(reconcileFigures({ opening: big, statement: big + 1n, selected: [] }).difference).toBe(
    "0.01",
  );
  expect(
    reconcileFigures({ opening: big, statement: big, selected: [parseMoney("0.01")] }).difference,
  ).toBe("-0.01");
  expect(reconcileFigures({ opening: big, statement: big * 2n, selected: [big] }).canComplete).toBe(
    true,
  );
});

test("the difference is statement minus opening minus the selected lines, signs included", () => {
  const figures = reconcileFigures({
    opening: parseMoney("1000.00"),
    statement: parseMoney("-250.50"),
    selected: [parseMoney("-800.00"), parseMoney("-450.50"), parseMoney("0.00")],
  });
  expect(figures.selectedTotal).toBe("-1250.50");
  expect(figures.clearedBalance).toBe("-250.50");
  expect(figures.difference).toBe("0.00");
  expect(figures.selectedCount).toBe(3);
  // Zero is never "-0.00".
  expect(reconcileFigures({ opening: 5n, statement: 5n, selected: [] }).difference).toBe("0.00");
});

test("a liability is read the way its statement prints it", () => {
  // A card that owes 120.00 has a ledger balance of -120.00; the statement says 120.00.
  expect(statementSign("debit")).toBe(1n);
  expect(statementSign("credit")).toBe(-1n);
  expect(formatMoney(statementAmount(parseMoney("-120.00"), "credit"))).toBe("120.00");
  expect(formatMoney(statementAmount(parseMoney("-120.00"), "debit"))).toBe("-120.00");
  // A payment is a debit to the liability and reduces what the statement shows.
  expect(formatMoney(statementAmount(parseMoney("50.00"), "credit"))).toBe("-50.00");
});

test("any selection that sums to the statement balance is complete, and one wrong line is not", () => {
  const next = random(20261003);
  for (let round = 0; round < 200; round++) {
    const count = 1 + Math.floor(next() * 40);
    const amounts = Array.from({ length: count }, () => {
      const cents = BigInt(Math.floor(next() * 2_000_000) + 1);
      return next() < 0.5 ? -cents : cents;
    });
    const opening = BigInt(Math.floor(next() * 10_000_000)) - 5_000_000n;
    const statement = opening + amounts.reduce((sum, cents) => sum + cents, 0n);
    const exact = reconcileFigures({ opening, statement, selected: amounts });
    expect(exact.difference).toBe("0.00");
    expect(exact.canComplete).toBe(true);
    const dropped = Math.floor(next() * amounts.length);
    const without = amounts.filter((_, index) => index !== dropped);
    const missing = reconcileFigures({ opening, statement, selected: without });
    expect(missing.difference).toBe(formatMoney(amounts[dropped] as bigint));
    expect(missing.canComplete).toBe(amounts[dropped] === 0n);
  }
});

test("a statement balance is read exactly or not at all", () => {
  expect(canonicalStatementBalance("1234.50")).toBe("1234.50");
  expect(canonicalStatementBalance("-0.00")).toBe("0.00");
  expect(canonicalStatementBalance("-12.00")).toBe("-12.00");
  for (const bad of [
    "1,234.50",
    "1234.5",
    "1234",
    "01.00",
    ".50",
    "$12.00",
    "12.000",
    " 12.00",
    "12345678901234567.00",
    "NaN",
    "",
  ])
    expect(canonicalStatementBalance(bad), bad).toBeNull();
  expect(canonicalStatementBalance("9999999999999999.99")).toBe("9999999999999999.99");
});

test("calendar dates are real days, with leap years", () => {
  for (const good of ["2026-01-31", "2024-02-29", "2000-02-29", "2026-12-31"])
    expect(isCalendarDate(good), good).toBe(true);
  for (const bad of [
    "2026-02-29",
    "2026-02-31",
    "2026-04-31",
    "2026-13-01",
    "2026-00-10",
    "2026-01-00",
    "2026-1-5",
    "26-01-05",
    "2026-01-05T00:00:00Z",
    "1899-12-31",
    "",
  ])
    expect(isCalendarDate(bad), bad).toBe(false);
  expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
  expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
  expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  expect(() => addDays("2026-02-30", 1)).toThrow();
});

test("a statement date must be real, not far in the future, and after the previous statement", () => {
  const facts = { today: "2026-10-03", lastStatementDate: "2026-09-30" };
  expect(statementDateProblem("2026-10-03", facts)).toBeNull();
  // One day of slack absorbs time zones; two days ahead is a typo.
  expect(statementDateProblem("2026-10-04", facts)).toBeNull();
  expect(statementDateProblem("2026-10-05", facts)).toBe("in_future");
  expect(statementDateProblem("2062-10-03", facts)).toBe("in_future");
  expect(statementDateProblem("2026-09-30", facts)).toBe("not_after_last");
  expect(statementDateProblem("2026-08-31", facts)).toBe("not_after_last");
  expect(statementDateProblem("2026-10-01", facts)).toBeNull();
  expect(statementDateProblem("2026-02-30", facts)).toBe("invalid");
  expect(
    statementDateProblem("2026-10-03", { today: "2026-10-03", lastStatementDate: null }),
  ).toBeNull();
});
