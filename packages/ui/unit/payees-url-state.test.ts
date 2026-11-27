import { describe, expect, test } from "bun:test";
import type { FiscalYearSpan } from "../src/reports/period";
import type { ReportCalendar } from "../src/reports/url-state";
import {
  defaultPayeesState,
  parsePayeesState,
  type PayeesScreenState,
  serializePayeesState,
} from "../src/payees/url-state";

const years: FiscalYearSpan[] = [
  { year: 2025, startsOn: "2025-10-01", endsOn: "2026-09-30" },
  { year: 2024, startsOn: "2024-10-01", endsOn: "2025-09-30" },
];
const calendar: ReportCalendar = { years, today: "2026-03-15" };
const parse = (search: string) => parsePayeesState(search, calendar);
const start = () => defaultPayeesState(calendar);

describe("the screen's state round-trips through its address", () => {
  const states: PayeesScreenState[] = [
    start(),
    { ...start(), direction: "spent" },
    { ...start(), direction: "received", page: 3 },
    {
      ...start(),
      range: { preset: "lastQuarter", from: "2025-10-01", to: "2025-12-31" },
      revision: "9007199254740993",
    },
    {
      ...start(),
      range: { preset: "custom", from: "2026-03-01", to: "2026-03-31" },
      payee: "pay_0a1b2c3d",
    },
  ];

  for (const state of states)
    test(`${serializePayeesState(state) || "the plain address"}`, () => {
      const query = serializePayeesState(state);
      expect(parse(`?${query}`).state).toEqual(state);
      // The query names only what is not the default, in a fixed order.
      expect(serializePayeesState(parse(query).state)).toBe(query);
    });

  test("the plain address is the default state, and the default state is a plain address", () => {
    expect(parse("").state).toEqual(start());
    expect(serializePayeesState(start())).toBe("");
  });
});

describe("an address is data", () => {
  test("what is not a known value is the default, and nothing is reflected back", () => {
    const hostile = new URLSearchParams({
      show: "<script>alert(1)</script>",
      page: "1e3",
      payee: "../../etc/passwd",
      revision: "-1",
    });
    expect(parse(`?${hostile.toString()}`).state).toEqual(start());
    expect(parse("?page=0").state.page).toBe(1);
    expect(parse("?page=100001").state.page).toBe(1);
    expect(parse("?page=7&page=9").state.page).toBe(7);
    expect(parse("?show=spent&show=received").state.direction).toBe("spent");
    expect(parse("?payee=").state.payee).toBeUndefined();
    expect(parse(`?payee=${"a".repeat(129)}`).state.payee).toBeUndefined();
    expect(parse(`?payee=${"a".repeat(128)}`).state.payee).toBe("a".repeat(128));
  });

  test("the dates are read the way the Reports screen reads them, and a bad link is said so", () => {
    const fine = parse("?from=2026-01-01&to=2026-03-31");
    expect(fine.state.range).toMatchObject({ from: "2026-01-01", to: "2026-03-31" });
    expect(fine.notice).toBeUndefined();
    const bad = parse("?from=2026-13-01&to=2026-03-31");
    expect(bad.state.range).toEqual(start().range);
    expect(bad.notice).toContain("not both real dates");
  });
});
