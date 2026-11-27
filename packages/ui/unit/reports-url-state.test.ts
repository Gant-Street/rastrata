import { describe, expect, test } from "bun:test";
import type { FiscalYearSpan } from "../src/reports/period";
import {
  canShare,
  defaultState,
  parseState,
  serializeState,
  type ReportCalendar,
  type ReportScreenState,
} from "../src/reports/url-state";

const years: FiscalYearSpan[] = [
  { year: 2024, startsOn: "2024-10-01", endsOn: "2025-09-30" },
  { year: 2025, startsOn: "2025-10-01", endsOn: "2026-09-30" },
];
const TODAY = "2026-03-15";
const calendar: ReportCalendar = { years, today: TODAY };
const parse = (search: string) => parseState(search, calendar);
const start = () => defaultState(calendar);

describe("the screen's state round-trips through its address", () => {
  const states: ReportScreenState[] = [
    start(),
    { ...start(), tab: "cash-flow" },
    {
      ...start(),
      tab: "balance-sheet",
      range: { preset: "lastMonth", from: "2026-02-01", to: "2026-02-28" },
      compare: "previousYear",
    },
    {
      ...start(),
      tab: "general-ledger",
      range: { preset: "lastQuarter", from: "2025-10-01", to: "2025-12-31" },
      page: 7,
      showZero: true,
    },
    {
      ...start(),
      range: { preset: "lastFiscalYear", from: "2024-10-01", to: "2025-09-30" },
      compare: "previousPeriod",
      revision: "9007199254740993",
    },
    {
      ...start(),
      tab: "trial-balance",
      range: { preset: "custom", from: "2026-01-05", to: "2026-03-15" },
    },
    // Custom stays custom even when the dates happen to be a month: the person is typing them.
    { ...start(), range: { preset: "custom", from: "2026-03-01", to: "2026-03-31" } },
  ];

  test("every state survives being written and read back", () => {
    for (const state of states) {
      const address = serializeState(state);
      const { state: back, notice } = parse(address);
      expect(back, address).toEqual(state);
      expect(notice, address).toBeUndefined();
    }
  });

  test("the usual address names the statement and nothing else: defaults are never written", () => {
    expect(serializeState(start())).toBe("tab=profit-loss");
    expect(serializeState({ ...start(), tab: "cash-flow" })).toBe("tab=cash-flow");
    expect(serializeState({ ...start(), compare: "previousYear" })).toBe(
      "tab=profit-loss&compare=previous-year",
    );
    expect(serializeState({ ...start(), page: 1, showZero: false })).toBe("tab=profit-loss");
  });

  test("the fiscal year to date is today's, so it is no dates; every other period is its dates", () => {
    expect(serializeState(start())).toBe("tab=profit-loss");
    expect(
      serializeState({
        ...start(),
        range: { preset: "thisMonth", from: "2026-03-01", to: "2026-03-31" },
      }),
    ).toBe("tab=profit-loss&from=2026-03-01&to=2026-03-31");
    expect(
      serializeState({
        ...start(),
        range: { preset: "custom", from: "2026-03-01", to: "2026-03-31" },
      }),
    ).toBe("tab=profit-loss&period=custom&from=2026-03-01&to=2026-03-31");
  });

  test("dates alone are read as the period they are, or as custom dates when they are none", () => {
    expect(parse("from=2026-03-01&to=2026-03-31").state.range.preset).toBe("thisMonth");
    expect(parse("from=2026-02-01&to=2026-02-28").state.range.preset).toBe("lastMonth");
    expect(parse("from=2025-10-01&to=2026-03-15").state.range.preset).toBe("fiscalYearToDate");
    expect(parse("from=2026-03-05&to=2026-03-09").state.range).toEqual({
      preset: "custom",
      from: "2026-03-05",
      to: "2026-03-09",
    });
    // Dates that are in order but outside the calendar, or the wrong way round, are custom dates: the
    // field says what is wrong with them.
    expect(parse("from=2031-01-01&to=2031-01-31").state.range.preset).toBe("custom");
    expect(parse("from=2026-03-31&to=2026-03-01").state.range.preset).toBe("custom");
  });

  test("a half-typed custom date stays in the address so a reload keeps what was typed", () => {
    const state: ReportScreenState = {
      ...start(),
      range: { preset: "custom", from: "2026-01-01", to: "" },
    };
    expect(serializeState(state)).toBe("tab=profit-loss&period=custom&from=2026-01-01&to=");
    expect(parse(serializeState(state)).state.range).toEqual({
      preset: "custom",
      from: "2026-01-01",
      to: "",
    });
  });
});

describe("months in columns", () => {
  test("by month is written for the statements that have months, and read back", () => {
    for (const tab of ["profit-loss", "balance-sheet"] as const) {
      const state = { ...start(), tab, by: "month" as const };
      const address = serializeState(state);
      expect(address).toContain("by=month");
      expect(parse(address).state).toEqual(state);
    }
  });

  test("by month is left out of the address where there are no months to lay side by side", () => {
    for (const tab of ["trial-balance", "general-ledger", "cash-flow"] as const)
      expect(serializeState({ ...start(), tab, by: "month" })).toBe(`tab=${tab}`);
  });

  test("months in columns turn the comparison off, in the address and when it is read", () => {
    const written = serializeState({ ...start(), by: "month", compare: "previousYear" });
    expect(written).toBe("tab=profit-loss&by=month");
    // A link that asks for both gets the months.
    const read = parse("by=month&compare=previous-year").state;
    expect(read.by).toBe("month");
    expect(read.compare).toBe("none");
  });

  test("anything but month is the total", () => {
    for (const value of ["total", "", "months", "MONTH", "__proto__", "1"])
      expect(parse(`by=${value}`).state.by).toBe("total");
    expect(start().by).toBe("total");
  });

  test("a comparison is kept on every statement, so a reload on the trial balance still has it", () => {
    const state = {
      ...start(),
      tab: "trial-balance" as const,
      compare: "previousYear" as const,
    };
    expect(parse(serializeState(state)).state).toEqual(state);
  });
});

describe("% of income", () => {
  test("is written as share=income and read back, with the comparison and the dates it goes with", () => {
    expect(serializeState({ ...start(), share: "income" })).toBe("tab=profit-loss&share=income");
    expect(parse("share=income").state.share).toBe("income");
    const state: ReportScreenState = {
      ...start(),
      range: { preset: "lastMonth", from: "2026-02-01", to: "2026-02-28" },
      compare: "previousYear",
      share: "income",
    };
    const address = serializeState(state);
    expect(address).toBe(
      "tab=profit-loss&from=2026-02-01&to=2026-02-28&compare=previous-year&share=income",
    );
    expect(parse(address).state).toEqual(state);
    expect(parse(address).notice).toBeUndefined();
  });

  test("is off by default, and the usual address says nothing about it", () => {
    expect(start().share).toBe("none");
    expect(serializeState(start())).toBe("tab=profit-loss");
    expect(serializeState({ ...start(), share: "none" })).toBe("tab=profit-loss");
  });

  test("anything but income is no share", () => {
    for (const value of ["none", "", "Income", "INCOME", "revenue", "1", "true", "__proto__", "%"])
      expect(parse(`share=${value}`).state.share, value).toBe("none");
  });

  test("is kept on every statement, so a reload on the balance sheet still has it for the profit and loss", () => {
    for (const tab of ["balance-sheet", "cash-flow", "trial-balance", "general-ledger"] as const) {
      const state: ReportScreenState = { ...start(), tab, share: "income" };
      expect(parse(serializeState(state)).state, tab).toEqual(state);
    }
  });

  test("is off with months in columns, in the address and when it is read", () => {
    expect(serializeState({ ...start(), by: "month", share: "income" })).toBe(
      "tab=profit-loss&by=month",
    );
    // A link that asks for both gets the months.
    const read = parse("by=month&share=income").state;
    expect(read.by).toBe("month");
    expect(read.share).toBe("none");
    // Where there are no months to lay out, the choice is not turned off by asking for them.
    expect(serializeState({ ...start(), tab: "trial-balance", by: "month", share: "income" })).toBe(
      "tab=trial-balance&share=income",
    );
  });

  test("is offered for the profit and loss alone", () => {
    expect(canShare("profit-loss")).toBe(true);
    for (const tab of ["balance-sheet", "cash-flow", "trial-balance", "general-ledger"] as const)
      expect(canShare(tab), tab).toBe(false);
  });
});

describe("an address that cannot be honoured gets a safe default and a sentence", () => {
  test("an unknown tab, comparison, page or pin is ignored, never thrown", () => {
    const { state, notice } = parse(
      "tab=income-statement&compare=last-decade&page=-3&zero=yes&revision=-1",
    );
    expect(state).toEqual(start());
    expect(notice).toBeUndefined();
    expect(parse("page=abc").state.page).toBe(1);
    expect(parse("page=1000000").state.page).toBe(1);
    expect(parse("revision=007").state.revision).toBeUndefined();
    expect(parse("revision=12345678901234567890").state.revision).toBeUndefined();
  });

  test("dates that are not real fall back to the fiscal year to date and say so", () => {
    for (const search of [
      "from=2026-02-30&to=2026-03-31",
      "from=2026-01-01",
      "to=2026-03-31",
      "from=&to=",
      "from=soon&to=later",
    ]) {
      const { state, notice } = parse(search);
      expect(state.range, search).toEqual(start().range);
      expect(notice, search).toContain("fiscal year to date");
    }
  });

  test("a hostile address is data: nothing in it is interpreted", () => {
    const { state } = parse(
      "tab=<script>&from=2026-02-01&to=2026-02-28&compare=__proto__&page=1e3&zero=1&x=%00",
    );
    expect(state.tab).toBe("profit-loss");
    expect(state.range).toEqual({ preset: "lastMonth", from: "2026-02-01", to: "2026-02-28" });
    expect(state.compare).toBe("none");
    expect(state.page).toBe(1);
  });
});

describe("older links keep working", () => {
  test("a period the way the old picker wrote it opens as the dates it stood for", () => {
    expect(parse("period=month:2026-02").state.range).toEqual({
      preset: "lastMonth",
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(parse("period=month:2025-11").state.range).toEqual({
      preset: "custom",
      from: "2025-11-01",
      to: "2025-11-30",
    });
    expect(parse("period=quarter:2025-Q2").state.range).toMatchObject({
      from: "2026-01-01",
      to: "2026-03-31",
    });
    expect(parse("period=year:2024").state.range).toEqual({
      preset: "lastFiscalYear",
      from: "2024-10-01",
      to: "2025-09-30",
    });
    expect(parse("period=ytd").state).toEqual(start());
    expect(parse("period=month:2026-02").notice).toBeUndefined();
  });

  test("a period this book does not have falls back to the fiscal year to date and says so", () => {
    for (const period of [
      "month:2031-01",
      "quarter:2025-Q9",
      "year:1999",
      "week:3",
      "month",
      "nonsense",
    ]) {
      const { state, notice } = parse(`period=${period}`);
      expect(state.range, period).toEqual(start().range);
      expect(notice, period).toContain("fiscal year to date");
    }
  });

  test("only an end date opens as dates from the start of its fiscal year", () => {
    const { state, notice } = parse("asOf=2026-01-31");
    expect(state.range).toMatchObject({ from: "2025-10-01", to: "2026-01-31" });
    expect(notice).toBeUndefined();
  });

  test("an end date and a start date are both kept, and a date outside the calendar is left to the field", () => {
    expect(parse("asOf=2026-01-31&from=2026-01-01").state.range).toMatchObject({
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(parse("asOf=2031-06-30").state.range).toEqual({
      preset: "custom",
      from: "2031-06-30",
      to: "2031-06-30",
    });
    expect(parse("asOf=2026-02-30").notice).toContain("not a real date");
    expect(parse("asOf=2026-02-30").state.range).toEqual(start().range);
    // A pinned revision from an old link is carried through.
    expect(parse("asOf=2026-01-31&revision=9").state.revision).toBe("9");
  });
});
