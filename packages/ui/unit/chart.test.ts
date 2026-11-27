import { describe, expect, test } from "bun:test";
import {
  chartKey,
  clampTaxYear,
  groupAccounts,
  fiscalYearSpan,
  isRealDate,
  newKey,
  nextSlotCode,
  openAtRest,
  reachedPeriods,
  ROLE_KEY_MAX,
  ROLE_KEY_PATTERN,
  taxLineOptions,
  toSetupDocument,
  validateChart,
  searchAccounts,
} from "../src/chart/chart-logic";
import type {
  AccountView,
  ChartAccount,
  SetupChoices,
  TaxFormChoice,
} from "../src/chart/chart-types";
import { chartMessages, mergeChartMessages } from "../src/chart/messages";

const account = (
  code: string,
  name: string,
  role: ChartAccount["role"],
  extra: Partial<ChartAccount> = {},
): ChartAccount => ({ key: newKey(), code, name, role, tags: {}, ...extra });

const choices: SetupChoices = {
  name: "  Example Studio  ",
  currency: "USD",
  firstYear: 2026,
  startMonth: 1,
  periodModel: "monthly",
  basis: "cash",
  templateId: "sole-proprietor",
  addOns: ["online-business"],
};

describe("bank and card codes", () => {
  test("banks start at 1000 and cards at 2000, ten apart", () => {
    expect(nextSlotCode([], "bank")).toBe("1000");
    expect(nextSlotCode([], "card")).toBe("2000");
    expect(nextSlotCode([{ code: "1000" }, { code: "1010" }], "bank")).toBe("1020");
    expect(nextSlotCode([{ code: "2000" }], "card")).toBe("2010");
  });

  test("a code in use under another spelling still counts as used", () => {
    expect(nextSlotCode([{ code: " 1000 " }], "bank")).toBe("1010");
  });

  test("when the tens are full the ones between are used, and a full range answers empty", () => {
    const tens = Array.from({ length: 10 }, (_, index) => ({ code: String(1000 + index * 10) }));
    expect(nextSlotCode(tens, "bank")).toBe("1001");
    const all = Array.from({ length: 100 }, (_, index) => ({ code: String(1000 + index) }));
    expect(nextSlotCode(all, "bank")).toBe("");
  });
});

describe("checking a chart before it is sent", () => {
  const messages = chartMessages.editor;
  const problems = (accounts: ChartAccount[]) => validateChart(accounts, messages);

  test("a good chart has no problems", () => {
    expect(
      problems([account("1000", "Checking", "asset"), account("3000", "Capital", "equity")]),
    ).toEqual([]);
  });

  test("a missing, malformed or repeated code points at its own field", () => {
    const a = account("", "Cash", "asset");
    const b = account("1 000", "Savings", "asset");
    const c = account("1000", "Petty cash", "asset");
    const d = account("1000", "Drawer", "asset");
    const found = problems([a, b, c, d]);
    expect(found.map((item) => item.id)).toEqual([
      `chart-code-${a.key}`,
      `chart-code-${b.key}`,
      `chart-code-${d.key}`,
    ]);
    expect(found[2]?.message).toContain("1000");
    expect(found[0]?.short).toBe("Required");
  });

  test("codes repeat across spellings of the same letters, as the service compares them", () => {
    const found = problems([account("AB", "One", "asset"), account("ab", "Two", "asset")]);
    expect(found).toHaveLength(1);
    expect(found[0]?.short).toBe("Already used");
  });

  test("a code is two to twenty letters, digits, hyphens or underscores", () => {
    for (const bad of ["1", "-100", "a b", "x".repeat(21), "10.0", "é100"])
      expect(problems([account(bad, "Cash", "asset")]).length, bad).toBe(1);
    for (const good of ["10", "A-1", "ops_cash", "x".repeat(20)])
      expect(problems([account(good, "Cash", "asset")]), good).toEqual([]);
  });

  test("a name is needed and has a ceiling", () => {
    const blank = account("1000", "   ", "asset");
    const long = account("1010", "x".repeat(121), "asset");
    const found = problems([blank, long]);
    expect(found.map((item) => item.id)).toEqual([
      `chart-name-${blank.key}`,
      `chart-name-${long.key}`,
    ]);
  });

  test("a book needs an asset account to post to, and no more than two hundred accounts", () => {
    expect(problems([account("3000", "Capital", "equity")]).map((item) => item.id)).toEqual([
      "chart-editor",
    ]);
    const many = Array.from({ length: 201 }, (_, index) =>
      account(String(1000 + index), `Account ${index}`, "asset"),
    );
    expect(problems(many).map((item) => item.id)).toContain("chart-editor");
  });
});

describe("the book.setup document", () => {
  test("is trimmed, carries the tags that are set and leaves out the ones that are not", () => {
    const accounts = [
      account("1000", "  Checking ", "asset", { tags: { cashFlowClass: "cash" } }),
      account("4000", "Sales", "income", {
        tags: { taxLine: "scheduleC.line1", roleKey: "revenue.sales" },
      }),
      account("6000", "Advertising", "expense"),
    ];
    expect(toSetupDocument(choices, accounts)).toEqual({
      name: "Example Studio",
      currency: "USD",
      // The calendar starts in 2000 for every book; the books begin on the first day of the year chosen.
      fiscalYear: 2000,
      fiscalYearStartMonth: 1,
      booksStartOn: "2026-01-01",
      periodModel: "monthly",
      basis: "cash",
      accounts: [
        { code: "1000", name: "Checking", role: "asset", tags: { cashFlowClass: "cash" } },
        {
          code: "4000",
          name: "Sales",
          role: "income",
          tags: { taxLine: "scheduleC.line1", roleKey: "revenue.sales" },
        },
        { code: "6000", name: "Advertising", role: "expense" },
      ],
    });
  });

  test("notes never reach the service", () => {
    const [row] = toSetupDocument(choices, [
      account("1000", "Checking", "asset", { note: "Name it." }),
    ]).accounts;
    expect(Object.keys(row ?? {}).sort()).toEqual(["code", "name", "role"]);
  });

  test("a tag the person cleared is not sent as an empty value", () => {
    const [row] = toSetupDocument(choices, [
      account("6000", "Advertising", "expense", { tags: { taxLine: undefined } }),
    ]).accounts;
    expect(row).toEqual({ code: "6000", name: "Advertising", role: "expense" });
  });
});

describe("rebuilding the chart", () => {
  test("the same choices give the same key, in any add-on order, and a different one differs", () => {
    const a = chartKey({ ...choices, addOns: ["a", "b"] }, 2026);
    expect(chartKey({ ...choices, addOns: ["b", "a"] }, 2026)).toBe(a);
    // The name and the calendar do not change the chart; the type, basis, add-ons and year do.
    expect(
      chartKey({ ...choices, addOns: ["a", "b"], name: "Another name", startMonth: 10 }, 2026),
    ).toBe(a);
    expect(chartKey({ ...choices, addOns: ["a", "b"], basis: "accrual" }, 2026)).not.toBe(a);
    expect(chartKey({ ...choices, addOns: ["a", "b"], templateId: "generic" }, 2026)).not.toBe(a);
    expect(chartKey({ ...choices, addOns: ["a"] }, 2026)).not.toBe(a);
    expect(chartKey({ ...choices, addOns: ["a", "b"] }, 2025)).not.toBe(a);
  });

  test("the tax year is the first fiscal year, kept inside the years the catalog covers", () => {
    expect(clampTaxYear(2026, [2025, 2026])).toBe(2026);
    expect(clampTaxYear(2025, [2025, 2026])).toBe(2025);
    expect(clampTaxYear(2019, [2025, 2026])).toBe(2025);
    expect(clampTaxYear(2040, [2025, 2026])).toBe(2026);
  });
});

describe("the first fiscal year", () => {
  test("a calendar year runs January to December", () => {
    expect(fiscalYearSpan(2026, 1)).toEqual({ from: "January 2026", to: "December 2026" });
  });

  test("an October year ends in September of the next year, as the calendar lane defines it", () => {
    expect(fiscalYearSpan(2026, 10)).toEqual({ from: "October 2026", to: "September 2027" });
    expect(fiscalYearSpan(2026, 2)).toEqual({ from: "February 2026", to: "January 2027" });
  });
});

describe("tax line choices", () => {
  const form: TaxFormChoice = {
    id: "scheduleC",
    name: "Schedule C (Form 1040)",
    taxYear: 2026,
    status: "draft",
    lines: [
      {
        id: "scheduleC.line1",
        number: "1",
        label: "Gross receipts or sales",
        part: "Part I",
        roles: ["income"],
      },
      {
        id: "scheduleC.line8",
        number: "8",
        label: "Advertising",
        part: "Part II",
        roles: ["expense"],
      },
      {
        id: "scheduleC.line2",
        number: "2",
        label: "Returns and allowances",
        part: "Part I",
        roles: ["income", "expense"],
      },
    ],
  };

  test("offers only the lines that take the account's kind, labelled with the printed number", () => {
    expect(taxLineOptions([form], "income").map((item) => item.label)).toEqual([
      "Line 1 · Gross receipts or sales",
      "Line 2 · Returns and allowances",
    ]);
    expect(taxLineOptions([form], "expense").map((item) => item.value)).toEqual([
      "scheduleC.line8",
      "scheduleC.line2",
    ]);
    expect(taxLineOptions([form], "asset")).toEqual([]);
  });
});

describe("copy", () => {
  test("a partial override falls back to English key by key", () => {
    const merged = mergeChartMessages({ wizard: { back: "Atrás" } });
    expect(merged.wizard.back).toBe("Atrás");
    expect(merged.wizard.continue).toBe(chartMessages.wizard.continue);
    expect(merged.books.cash).toBe(chartMessages.books.cash);
  });

  test("the two things Rastrata will not do are said where they matter", () => {
    // The form is named where the tax lines are shown, on the review step, and nothing more: its year and
    // whether the IRS has finished it are for the Taxes page, and the legal line is in the terms.
    expect(chartMessages.review.taxNotice("Schedule C")).toBe("Tax lines are from Schedule C.");
    expect(chartMessages.review.chartChange).toBe("You can change any account later.");
    // Invoices are said where accrual is offered, because accrual assumes them.
    expect(chartMessages.books.accrualHelp).toContain("You record invoices and bills yourself");
  });
});

describe("finding accounts", () => {
  const view = (
    code: string,
    name: string,
    role: string,
    tags: AccountView["tags"] = {},
    extra: Partial<AccountView> = {},
  ): AccountView => ({
    id: code,
    code,
    name,
    role,
    parentCode: null,
    openedOn: "2026-01-01",
    closedOn: null,
    balance: "0.00",
    tags,
    ...extra,
  });
  const rows = [
    view("1000", "Operating account", "asset", { cashFlowClass: "cash" }),
    view("1300", "Inventory", "asset"),
    view("1100", "Stripe balance", "asset", { cashFlowClass: "cash", roleKey: "stripe.balance" }),
    view("4000", "Sales", "income", { taxLine: "scheduleC.line1" }),
    view("6000", "Advertising", "expense", { taxLine: "scheduleC.line8" }),
    view("6200", "Software", "expense"),
    view("6900", "Old tool", "expense", { taxLine: "scheduleC.line8" }, { closedOn: "2026-06-30" }),
  ];
  const text = (id: string) =>
    ({
      "scheduleC.line8": "Schedule C line 8 · Advertising",
      "scheduleC.line1": "Schedule C line 1 · Gross receipts or sales",
    })[id];
  const codes = (query = "") => searchAccounts(rows, query, text).map((row) => row.code);

  test("with no search every account is shown, in the order given", () => {
    expect(codes()).toEqual(["1000", "1300", "1100", "4000", "6000", "6200", "6900"]);
    expect(codes("   ")).toEqual(["1000", "1300", "1100", "4000", "6000", "6200", "6900"]);
  });

  test("a search matches code, name, type, role key and tax line, ignoring case", () => {
    expect(codes("6000")).toEqual(["6000"]);
    expect(codes("STRIPE")).toEqual(["1100"]);
    expect(codes("income")).toEqual(["4000"]);
    expect(codes("stripe.balance")).toEqual(["1100"]);
    expect(codes("scheduleC.line8")).toEqual(["6000", "6900"]);
  });

  test("a search also finds an account by the words of its tax line", () => {
    expect(codes("advertising")).toEqual(["6000", "6900"]);
    expect(codes("gross receipts")).toEqual(["4000"]);
  });

  test("every word must match, in any order", () => {
    expect(codes("line 8")).toEqual(["6000", "6900"]);
    expect(codes("advertising old")).toEqual(["6900"]);
    expect(codes("  old   advertising  ")).toEqual(["6900"]);
    expect(codes("zzzz")).toEqual([]);
  });
});

describe("the chart folded by kind", () => {
  const held = (
    code: string,
    role: string,
    balance: string,
    closedOn: string | null = null,
  ): AccountView => ({
    id: code,
    code,
    name: `Account ${code}`,
    role,
    parentCode: null,
    openedOn: "2026-01-01",
    closedOn,
    balance,
    tags: {},
  });
  const rows = [
    held("1000", "asset", "624.06"),
    held("1300", "asset", "0.00"),
    held("2000", "liability", "0.00"),
    held("4000", "income", "-1420.12"),
    held("4900", "gain", "12.00"),
    held("6000", "expense", "131.00"),
    held("6200", "expense", "0.00"),
    held("6900", "expense", "0.00", "2026-06-30"),
  ];
  const groups = groupAccounts(rows);
  const codesOf = (list: readonly { code: string }[]) => list.map((row) => row.code);

  test("the kinds are in the order a chart is read, and a kind with no account is left out", () => {
    expect(groups.map((group) => group.id)).toEqual(["asset", "liability", "income", "expense"]);
    expect(groupAccounts([])).toEqual([]);
  });

  test("a gain is listed with income, where a statement puts it", () => {
    expect(codesOf(groups.find((group) => group.id === "income")?.accounts ?? [])).toEqual([
      "4000",
      "4900",
    ]);
  });

  test("a kind shows the open accounts that hold something; a zero balance and a closed account are the rest", () => {
    const expenses = groups.find((group) => group.id === "expense");
    expect(codesOf(expenses?.holding ?? [])).toEqual(["6000"]);
    expect(codesOf(expenses?.rest ?? [])).toEqual(["6200", "6900"]);
    expect(codesOf(expenses?.accounts ?? [])).toEqual(["6000", "6200", "6900"]);
    const liabilities = groups.find((group) => group.id === "liability");
    expect(liabilities?.holding).toEqual([]);
    expect(codesOf(liabilities?.rest ?? [])).toEqual(["2000"]);
  });

  test("income and expenses are open at rest when they hold something; what is owned and owed opens when asked", () => {
    expect(openAtRest(groups)).toEqual(["income", "expense"]);
    expect(openAtRest(groupAccounts(rows.map((row) => ({ ...row, balance: "0.00" }))))).toEqual([]);
  });
});

describe("tag dates", () => {
  test("a date is real, checked without a time zone", () => {
    for (const good of ["2026-01-01", "2024-02-29", "2000-02-29"])
      expect(isRealDate(good), good).toBe(true);
    for (const bad of [
      "2026-02-29",
      "2100-02-29",
      "2026-13-01",
      "2026-04-31",
      "2026-1-1",
      "",
      "tomorrow",
    ])
      expect(isRealDate(bad), bad).toBe(false);
  });

  test("a change from a date reaches every closed period that ends on or after it", () => {
    const periods = [
      { label: "January", startsOn: "2026-01-01", endsOn: "2026-01-31" },
      { label: "February", startsOn: "2026-02-01", endsOn: "2026-02-28" },
    ];
    expect(reachedPeriods(periods, "2026-01-15").map((item) => item.label)).toEqual([
      "January",
      "February",
    ]);
    expect(reachedPeriods(periods, "2026-02-28").map((item) => item.label)).toEqual(["February"]);
    expect(reachedPeriods(periods, "2026-03-01")).toEqual([]);
    expect(reachedPeriods(periods, "not a date")).toEqual([]);
  });

  test("a role key is lower-case words joined by dots or hyphens", () => {
    for (const good of ["stripe.balance", "payouts.in-transit", "refunds", "a1.b2"])
      expect(ROLE_KEY_PATTERN.test(good), good).toBe(true);
    for (const bad of ["Stripe", "stripe..balance", "stripe.", "1stripe", "a b", ""])
      expect(ROLE_KEY_PATTERN.test(bad), bad).toBe(false);
    expect(ROLE_KEY_MAX).toBe(40);
  });
});
