import { expect, test } from "bun:test";
import {
  activityHref,
  defaultTaxState,
  parseTaxState,
  safeDownloadName,
  serializeTaxState,
  TAX_FORMS,
  TAX_TABS,
  type TaxScreenState,
} from "../../src/routes/tax/controller";

test("a plain address is the default state, and the default state is a plain address", () => {
  expect(parseTaxState("")).toEqual(defaultTaxState());
  expect(serializeTaxState(defaultTaxState())).toBe("");
});

test("every state the screen can be in is kept in its address and comes back the same", () => {
  for (const tab of TAX_TABS)
    for (const year of [null, 2025, 2026])
      for (const form of [null, ...TAX_FORMS])
        for (const meals of [50, 80] as const)
          for (const period of ["month", "quarter", "year"] as const) {
            const state: TaxScreenState = { tab, year, form, meals, period };
            const query = serializeTaxState(state);
            expect(parseTaxState(`?${query}`), query).toEqual(state);
            // The query names only what is not the default, in a fixed order.
            expect(serializeTaxState(parseTaxState(query))).toBe(query);
          }
});

test("an address is data: what is not a known value is the default, and nothing is reflected back", () => {
  const hostile = new URLSearchParams({
    tab: "<script>alert(1)</script>",
    year: "20x6",
    form: "scheduleZ",
    meals: "99",
    period: "decade",
  });
  expect(parseTaxState(`?${hostile.toString()}`)).toEqual(defaultTaxState());
  expect(parseTaxState("?year=2026&year=1999")).toMatchObject({ year: 2026 });
  expect(parseTaxState("?year=")).toMatchObject({ year: null });
  expect(parseTaxState("?year=202600")).toMatchObject({ year: null });
  expect(parseTaxState("?tab=pack&tab=sales")).toMatchObject({ tab: "pack" });
  expect(serializeTaxState({ ...defaultTaxState(), tab: "vendors", year: 2026 })).toBe(
    "tab=vendors&year=2026",
  );
});

test("a link to an account's activity names the population the figure was read from, and escapes what it is given", () => {
  const href = activityHref({
    accountId: "a&b=c d",
    asOf: "2026-12-31",
    reportFrom: "2026-01-01",
    population: "abc123",
    from: "2026-02-10",
    to: "2026-02-12",
  });
  const url = new URL(href, "http://example.test");
  expect(url.pathname).toBe("/ledger");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    accountId: "a&b=c d",
    asOf: "2026-12-31",
    population: "abc123",
    reportFrom: "2026-01-01",
    from: "2026-02-10",
    to: "2026-02-12",
  });
});

test("a name the service sends is made safe before it is a file name", () => {
  expect(safeDownloadName("schedule-c-worksheet-2026.csv")).toBe("schedule-c-worksheet-2026.csv");
  expect(safeDownloadName("../../etc/passwd")).toBe("etc-passwd");
  expect(safeDownloadName("a b\\c:d*e?.csv")).toBe("a-b-c-d-e-.csv");
  expect(safeDownloadName("...")).toBe("download");
  expect(safeDownloadName("")).toBe("download");
  expect(safeDownloadName("x".repeat(500))).toHaveLength(120);
  expect(safeDownloadName("‮gnp.exe")).not.toContain("‮");
});
