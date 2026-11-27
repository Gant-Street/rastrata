import { describe, expect, test } from "bun:test";
import {
  compareCanonicalText,
  diagnostic,
  fiscalCalendarId,
  fiscalPeriodId,
  localDate,
  validateBookConfiguration,
  type BookState,
  type FiscalPeriod,
  type SemanticDiagnostic,
} from "../src/index.ts";
import { freshState } from "./fixtures.ts";

/**
 * `validatePeriods` ran for every command and compared every period with every other period: once to
 * find a sequence another period carries, once for each pair of regular periods. A calendar of ten
 * years (120 periods) made a command cost three times what it cost with one year; twenty years, seven
 * times. It now looks sequences up and reads on from a period only as far as the next one starts after
 * it ends. This is the function as it was, kept here as the oracle, and the new one must give the same
 * diagnostics, in the same order, for any set of periods.
 */
function legacyValidatePeriods(state: Pick<BookState, "identity" | "periods">): SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  const ids = new Set<string>();
  const regular = state.periods
    .filter((period) => period.kind === "regular")
    .sort((left, right) => compareCanonicalText(left.startsOn, right.startsOn) || compareCanonicalText(left.id, right.id));
  for (const [index, period] of state.periods.entries()) {
    if (ids.has(period.id) || period.calendarId !== state.identity.fiscalCalendarId) {
      diagnostics.push(diagnostic("fiscal_period_admission", `periods[${index}]`, "Period identity is duplicated or belongs to another fiscal calendar", ["ACC-027", "ACC-029", "ACC-038"]));
    }
    ids.add(period.id);
    if (period.startsOn > period.endsOn) {
      diagnostics.push(diagnostic("fiscal_period_admission", `periods[${index}]`, "Fiscal period ends before it starts", ["ACC-013", "ACC-029"]));
    }
    if (period.sequence <= 0n || state.periods.some((other) => other !== period && other.sequence === period.sequence)) {
      diagnostics.push(diagnostic("fiscal_period_admission", `periods[${index}].sequence`, "Fiscal period sequences must be positive and unique within the calendar", ["ACC-029", "ACC-038"]));
    }
  }
  for (const [index, left] of regular.entries()) {
    for (const right of regular.slice(index + 1)) {
      if (right.startsOn <= left.endsOn) {
        diagnostics.push(diagnostic("fiscal_period_admission", "periods", `Regular periods ${left.id} and ${right.id} overlap`, ["ACC-029"]));
      }
    }
  }
  for (const [index, current] of regular.slice(1).entries()) {
    const previous = regular[index]!;
    const expectedStart = new Date(Date.parse(`${previous.endsOn}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    if (current.startsOn !== expectedStart) {
      diagnostics.push(diagnostic("fiscal_period_admission", "periods", `Regular periods ${previous.id} and ${current.id} are not gap-free`, ["ACC-029"]));
    }
  }
  return diagnostics;
}

const base = freshState().state;
const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function calendar(months: number, year = 2026): FiscalPeriod[] {
  return Array.from({ length: months }, (_, serial) => {
    const y = year + Math.floor(serial / 12);
    const index = serial % 12;
    const month = String(index + 1).padStart(2, "0");
    const leap = index === 1 && y % 4 === 0 ? 1 : 0;
    return Object.freeze({
      id: fiscalPeriodId(`period-${y}-${month}`),
      calendarId: base.identity.fiscalCalendarId,
      fiscalYear: BigInt(y),
      sequence: BigInt(serial + 1),
      label: `${y}-${month}`,
      kind: "regular" as const,
      startsOn: localDate(`${y}-${month}-01`),
      endsOn: localDate(`${y}-${month}-${String(days[index]! + leap).padStart(2, "0")}`),
    });
  });
}

function periodDiagnostics(periods: readonly FiscalPeriod[]) {
  return validateBookConfiguration({ ...base, periods }).filter((item) => item.code === "fiscal_period_admission");
}

function expectSame(periods: readonly FiscalPeriod[], label: string) {
  expect(periodDiagnostics(periods), label).toEqual(legacyValidatePeriods({ identity: base.identity, periods }));
}

function rng(seed: number): () => number {
  let value = seed | 0 || 1;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 4294967296;
  };
}

describe("validating fiscal periods says what it said, without comparing every period with every other", () => {
  test("a clean calendar of any length is accepted", () => {
    for (const months of [0, 1, 2, 12, 36, 240]) {
      expect(periodDiagnostics(calendar(months)), `${months} months`).toEqual([]);
      expectSame(calendar(months), `${months} months`);
    }
  });

  test("the problems it reports, by kind, are the same ones in the same order", () => {
    const months = calendar(6);
    const shift = (index: number, change: Partial<FiscalPeriod>) => months.map((period, position) => (position === index ? { ...period, ...change } : period));
    const cases: Record<string, readonly FiscalPeriod[]> = {
      overlap: shift(2, { startsOn: localDate("2026-02-15") }),
      "overlap by one day": shift(3, { startsOn: localDate("2026-03-31") }),
      gap: shift(2, { startsOn: localDate("2026-03-03") }),
      "inverted dates": shift(1, { startsOn: localDate("2026-02-20"), endsOn: localDate("2026-02-10") }),
      "duplicate id": shift(4, { id: months[1]!.id }),
      "duplicate sequence": shift(4, { sequence: months[1]!.sequence }),
      "zero sequence": shift(0, { sequence: 0n }),
      "negative sequence": shift(5, { sequence: -2n }),
      "another calendar": shift(3, { calendarId: fiscalCalendarId("someone-else") }),
      "the same object twice": [...months, months[2]!],
      "the same sequence on the same object twice and another": [...months.slice(0, 2), months[1]!, ...months.slice(2)],
      reversed: [...months].reverse(),
      "sequences that are not numbers never match each other": shift(1, { sequence: Number.NaN as never }).map((period, position) => (position === 3 ? { ...period, sequence: Number.NaN as never } : period)),
      "an adjustment period inside a month": [...months, { ...months[1]!, id: fiscalPeriodId("adjustment"), kind: "adjustment" as const, sequence: 99n }],
      "everything wrong": months.map((period) => ({ ...period, startsOn: localDate("2026-01-01"), endsOn: localDate("2026-12-31"), sequence: 1n })),
    };
    for (const [label, periods] of Object.entries(cases)) {
      expectSame(periods, label);
      // The order a calendar is listed in does not matter, an adjustment period may lie inside a month, and
      // one object listed twice is one period with one sequence, though its identifier is then repeated.
      const clean = ["reversed", "the same sequence on the same object twice and another", "an adjustment period inside a month", "sequences that are not numbers never match each other"].includes(label);
      if (!clean) expect(periodDiagnostics(periods).length, label).toBeGreaterThan(0);
    }
  });

  test("random calendars with random damage", () => {
    const draw = rng(0x9e3779b9);
    let flagged = 0;
    for (let trial = 0; trial < 3000; trial += 1) {
      const periods = calendar(Math.floor(draw() * 16));
      for (let damage = Math.floor(draw() * 4); damage > 0 && periods.length > 0; damage -= 1) {
        const at = Math.floor(draw() * periods.length);
        const other = Math.floor(draw() * periods.length);
        const period = periods[at]!;
        switch (Math.floor(draw() * 10)) {
          case 0: periods[at] = { ...period, startsOn: periods[other]!.startsOn }; break;
          case 1: periods[at] = { ...period, endsOn: periods[other]!.endsOn }; break;
          case 2: periods[at] = { ...period, sequence: periods[other]!.sequence }; break;
          case 3: periods[at] = { ...period, id: periods[other]!.id }; break;
          case 4: periods[at] = { ...period, sequence: BigInt(Math.floor(draw() * 6) - 2) }; break;
          case 5: periods[at] = { ...period, kind: period.kind === "regular" ? "adjustment" : "regular" }; break;
          case 6: periods[at] = { ...period, calendarId: fiscalCalendarId(draw() < 0.5 ? "other" : String(base.identity.fiscalCalendarId)) }; break;
          case 7: periods.splice(Math.floor(draw() * (periods.length + 1)), 0, periods[other]!); break;
          case 8: [periods[at], periods[other]] = [periods[other]!, periods[at]!]; break;
          default: periods.splice(at, 1);
        }
      }
      expectSame(periods, `trial ${trial}`);
      if (periodDiagnostics(periods).length > 0) flagged += 1;
    }
    // The damage is real: most trials have something to report, and some have nothing.
    expect(flagged).toBeGreaterThan(1500);
    expect(flagged).toBeLessThan(3000);
  });
});
