import { expect, test } from "bun:test";
import { hashCanonical } from "@rastrata/kernel";
import {
  buildTagMap,
  CASH_FLOW_CLASSES,
  hashTagRecords,
  isCalendarDate,
  SETUP_EFFECTIVE_ON,
  tagProblem,
  validateChartTags,
  type TagRecord,
} from "../src/chart/tags.ts";
import {
  knownTaxLine,
  LATEST_TAX_YEAR,
  lineAcceptsRole,
  nearestTaxYear,
  TAX_FORM_IDS,
  TAX_YEARS,
  taxForm,
  taxForms,
  taxLineIn,
} from "../src/chart/tax-lines.ts";
import { chartSchema } from "../src/slices/chart/schema.ts";

const record = (
  seq: number,
  accountId: string,
  tag: TagRecord["tag"],
  effectiveOn: string,
  value: string | null,
): TagRecord => ({ seq, accountId, tag, effectiveOn, value });

test("the tag map folds records by effective date, then by when they were recorded", () => {
  const map = buildTagMap(
    [
      record(0, "6000", "taxLine", SETUP_EFFECTIVE_ON, "scheduleC.line8"),
      record(1, "6000", "taxLine", "2026-07-01", "scheduleC.line22"),
      record(2, "6000", "taxLine", "2026-07-01", "scheduleC.line18"),
      record(3, "6000", "cashFlowClass", "2026-01-01", "operating"),
      record(4, "6000", "cashFlowClass", "2026-09-01", null),
    ],
    4,
  );
  expect(map.revision).toBe(4);
  expect(map.tagsFor("6000", "2025-12-31")).toEqual({ taxLine: "scheduleC.line8" });
  expect(map.tagsFor("6000", "2026-01-01")).toEqual({
    taxLine: "scheduleC.line8",
    cashFlowClass: "operating",
  });
  expect(map.tagsFor("6000", "2026-07-01")).toEqual({
    taxLine: "scheduleC.line18",
    cashFlowClass: "operating",
  });
  expect(map.tagsFor("6000", "2026-09-01")).toEqual({ taxLine: "scheduleC.line18" });
  expect(map.tagsFor("nobody", "2026-09-01")).toEqual({});
});

test("records arriving in any order give the same map and the same hash", () => {
  const records = [
    record(1, "a", "taxLine", "2026-01-01", "scheduleC.line8"),
    record(2, "b", "roleKey", "2026-01-01", "stripe.fees"),
    record(3, "a", "taxLine", "2026-06-01", "scheduleC.line22"),
    record(4, "a", "cashFlowClass", "2026-01-01", "operating"),
  ];
  const shuffled = [records[3], records[1], records[0], records[2]] as TagRecord[];
  expect(hashTagRecords(shuffled)).toBe(hashTagRecords(records));
  expect(buildTagMap(shuffled, 4).tagsFor("a", "2026-07-01")).toEqual(
    buildTagMap(records, 4).tagsFor("a", "2026-07-01"),
  );
});

test("the hash describes what is in force: repeating a value or clearing nothing adds nothing", () => {
  const base = [record(1, "a", "taxLine", "2026-01-01", "scheduleC.line8")];
  expect(
    hashTagRecords([...base, record(2, "a", "taxLine", "2026-05-01", "scheduleC.line8")]),
  ).toBe(hashTagRecords(base));
  expect(hashTagRecords([...base, record(2, "b", "taxLine", "2026-05-01", null)])).toBe(
    hashTagRecords(base),
  );
  expect(
    hashTagRecords([...base, record(2, "a", "taxLine", "2026-05-01", "scheduleC.line9")]),
  ).not.toBe(hashTagRecords(base));
  expect(hashTagRecords([...base, record(2, "a", "taxLine", "2026-05-01", null)])).not.toBe(
    hashTagRecords(base),
  );
  // Moving the same value to another date is a change.
  expect(hashTagRecords([record(1, "a", "taxLine", "2026-02-01", "scheduleC.line8")])).not.toBe(
    hashTagRecords(base),
  );
});

test("no tags hashes to the digest the contract stub always returned", () => {
  expect(hashTagRecords([])).toBe(hashCanonical({ type: "AccountTagMap", tags: [] }).digest);
  expect(buildTagMap([], 0).hash).toBe(hashTagRecords([]));
});

test("dates are real calendar dates", () => {
  for (const good of ["2026-01-01", "2024-02-29", "2000-02-29", "2100-12-31"])
    expect(isCalendarDate(good), good).toBe(true);
  for (const bad of [
    "2026-02-29",
    "2100-02-29",
    "2026-13-01",
    "2026-00-10",
    "2026-04-31",
    "26-01-01",
    "2026-1-1",
    "",
  ])
    expect(isCalendarDate(bad), bad).toBe(false);
});

test("which values an account may carry follows its role", () => {
  expect(tagProblem("asset", "cashFlowClass", "cash")).toBeNull();
  expect(tagProblem("equity", "cashFlowClass", "financing")).toBeNull();
  expect(tagProblem("expense", "cashFlowClass", "operating")?.message).toContain("balance-sheet");
  expect(tagProblem("income", "cashFlowClass", "operating")?.code).toBe("invalid_tag");
  expect(tagProblem("liability", "cashFlowClass", "cash")?.message).toContain("Only an asset");
  expect(tagProblem("asset", "cashFlowClass", "everything")?.message).toContain(
    CASH_FLOW_CLASSES.join(", "),
  );
  expect(tagProblem("expense", "taxLine", "scheduleC.line8")).toBeNull();
  expect(tagProblem("income", "taxLine", "scheduleC.line1")).toBeNull();
  expect(tagProblem("expense", "taxLine", "scheduleC.line2")).toBeNull();
  expect(tagProblem("income", "taxLine", "scheduleC.line2")).toBeNull();
  expect(tagProblem("asset", "taxLine", "scheduleC.line8")?.message).toContain("Advertising");
  expect(tagProblem("expense", "taxLine", "scheduleC.line1")?.message).toContain(
    "Gross receipts or sales",
  );
  expect(tagProblem("expense", "taxLine", "scheduleC.line99")?.code).toBe("unknown_tax_line");
  expect(tagProblem("expense", "taxLine", "line8")?.code).toBe("invalid_tag");
  expect(tagProblem("asset", "roleKey", "stripe.balance")).toBeNull();
  expect(tagProblem("asset", "roleKey", "payouts.in-transit")).toBeNull();
  for (const bad of ["Stripe", "stripe..balance", "stripe.", "1stripe", "a b", "x".repeat(41)])
    expect(tagProblem("asset", "roleKey", bad), bad).not.toBeNull();
});

test("a chart is checked tag by tag and a role key names one account", () => {
  expect(() =>
    validateChartTags([
      { code: "1000", role: "asset", tags: { cashFlowClass: "cash", roleKey: "bank.main" } },
      { code: "6000", role: "expense", tags: { taxLine: "scheduleC.line8" } },
      { code: "6100", role: "expense" },
    ]),
  ).not.toThrow();
  const failure = (accounts: Parameters<typeof validateChartTags>[0]) => {
    try {
      validateChartTags(accounts);
    } catch (error) {
      return error as { code: string; details: { path: string }[]; message: string };
    }
    throw new Error("expected a failure");
  };
  const duplicate = failure([
    { code: "1000", role: "asset", tags: { roleKey: "bank.main" } },
    { code: "1010", role: "asset", tags: { roleKey: "bank.main" } },
  ]);
  expect(duplicate.code).toBe("role_key_in_use");
  expect(duplicate.message).toContain("1010");
  expect(duplicate.message).toContain("1000");
  expect(duplicate.details[0]?.path).toBe("input.accounts[1].tags.roleKey");
});

test("every cash-flow class the service accepts is one the contract accepts, and no more", () => {
  const definition = chartSchema.definitions.AccountTags;
  const contract = definition?.properties?.cashFlowClass?.enum ?? [];
  expect([...contract].sort()).toEqual([...CASH_FLOW_CLASSES].sort());
});

/** The captions below are the IRS captions as printed on the forms, read from IRS.gov on
 * 2026-10-03 (see docs/reference/program/chart.md). If this test fails the catalog changed: read
 * the form again before updating it. */
const scheduleC2025 = [
  ["1", "Gross receipts or sales"],
  ["2", "Returns and allowances"],
  ["6", "Other income, including federal and state gasoline or fuel tax credit or refund"],
  ["8", "Advertising"],
  ["9", "Car and truck expenses"],
  ["10", "Commissions and fees"],
  ["11", "Contract labor"],
  ["12", "Depletion"],
  ["13", "Depreciation and section 179 expense deduction (not included in Part III)"],
  ["14", "Employee benefit programs (other than on line 19)"],
  ["15", "Insurance (other than health)"],
  ["16a", "Interest: Mortgage (paid to banks, etc.)"],
  ["16b", "Interest: Other"],
  ["17", "Legal and professional services"],
  ["18", "Office expense"],
  ["19", "Pension and profit-sharing plans"],
  ["20a", "Rent or lease: Vehicles, machinery, and equipment"],
  ["20b", "Rent or lease: Other business property"],
  ["21", "Repairs and maintenance"],
  ["22", "Supplies (not included in Part III)"],
  ["23", "Taxes and licenses"],
  ["24a", "Travel and meals: Travel"],
  ["24b", "Travel and meals: Deductible meals"],
  ["25", "Utilities"],
  ["26", "Wages (less employment credits)"],
  ["27a", "Energy efficient commercial bldgs deduction (attach Form 7205)"],
  ["27b", "Other expenses (from line 48)"],
  ["30", "Expenses for business use of your home"],
  ["36", "Purchases less cost of items withdrawn for personal use"],
  ["37", "Cost of labor (do not include any amounts paid to yourself)"],
  ["38", "Materials and supplies"],
  ["39", "Other costs"],
] as const;

test("Schedule C 2025 is the final form and matches the printed captions", () => {
  const form = taxForm("scheduleC", 2025);
  expect(form?.status).toBe("final");
  expect(form?.lines.map((line) => [line.number, line.label])).toEqual(scheduleC2025 as never);
});

test("Schedule C 2026 is the IRS draft: interest is split in three, nothing else moves", () => {
  const form = taxForm("scheduleC", 2026);
  expect(form?.status).toBe("draft");
  const lines = (form?.lines ?? []).map((line) => [line.number, line.label]);
  const expected = scheduleC2025.flatMap((entry) =>
    entry[0] === "16b"
      ? [
          ["16b", "Interest: Vehicle loan"],
          ["16c", "Interest: Other"],
        ]
      : [[entry[0], entry[1]]],
  );
  expect(lines).toEqual(expected);
  // The same printed number means different things in the two years: tags are read per year.
  expect(taxLineIn("scheduleC.line16b", 2025)?.label).toBe("Interest: Other");
  expect(taxLineIn("scheduleC.line16b", 2026)?.label).toBe("Interest: Vehicle loan");
  expect(taxLineIn("scheduleC.line16c", 2025)).toBeUndefined();
  expect(taxLineIn("scheduleC.line16c", 2026)?.label).toBe("Interest: Other");
});

test("Form 1120-S, Form 1065 and Form 1125-A match the printed captions in both years", () => {
  const s = [
    ["1a", "Gross receipts or sales"],
    ["1b", "Less returns and allowances"],
    ["2", "Cost of goods sold (attach Form 1125-A)"],
    ["4", "Net gain (loss) from Form 4797 (attach Form 4797)"],
    ["5", "Other income (loss)"],
    ["7", "Compensation of officers (attach Form 1125-E)"],
    ["8", "Salaries and wages (less employment credits)"],
    ["9", "Repairs and maintenance"],
    ["10", "Bad debts"],
    ["11", "Rents"],
    ["12", "Taxes and licenses"],
    ["13", "Interest"],
    ["14", "Depreciation from Form 4562 not claimed on Form 1125-A or elsewhere on return"],
    ["15", "Depletion"],
    ["16", "Advertising"],
    ["17", "Pension, profit-sharing, etc., plans"],
    ["18", "Employee benefit programs"],
    ["19", "Energy efficient commercial buildings deduction (attach Form 7205)"],
    ["20", "Other deductions (attach statement)"],
  ];
  const partnership = [
    ["1a", "Gross receipts or sales"],
    ["1b", "Less returns and allowances"],
    ["2", "Cost of goods sold (attach Form 1125-A)"],
    ["6", "Net gain (loss) from Form 4797 (attach Form 4797)"],
    ["7", "Other income (loss)"],
    ["9", "Salaries and wages (other than to partners) (less employment credits)"],
    ["10", "Guaranteed payments to partners"],
    ["11", "Repairs and maintenance"],
    ["12", "Bad debts"],
    ["13", "Rent"],
    ["14", "Taxes and licenses"],
    ["15", "Interest"],
    ["16a", "Depreciation (if required, attach Form 4562)"],
    ["17", "Depletion"],
    ["18", "Retirement plans, etc."],
    ["19", "Employee benefit programs"],
    ["20", "Energy efficient commercial buildings deduction (attach Form 7205)"],
    ["21", "Other deductions (attach statement)"],
  ];
  const cogs = [
    ["2", "Purchases"],
    ["3", "Cost of labor"],
    ["4", "Additional section 263A costs (attach schedule)"],
    ["5", "Other costs (attach schedule)"],
  ];
  for (const year of TAX_YEARS) {
    const lines = (id: "form1120S" | "form1065" | "form1125A") =>
      taxForm(id, year)?.lines.map((line) => [line.number, line.label]);
    expect(lines("form1120S"), `1120-S ${year}`).toEqual(s);
    expect(lines("form1065"), `1065 ${year}`).toEqual(partnership);
    expect(lines("form1125A"), `1125-A ${year}`).toEqual(cogs);
  }
  expect(taxForm("form1120S", 2025)?.status).toBe("final");
  expect(taxForm("form1120S", 2026)?.status).toBe("draft");
  expect(taxForm("form1125A", 2026)?.status).toBe("final");
});

test("every form in every year is internally consistent and cites its source", () => {
  for (const year of TAX_YEARS)
    for (const form of taxForms(year)) {
      expect(form.taxYear).toBe(year);
      expect(form.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(form.sources.length).toBeGreaterThan(0);
      for (const source of form.sources) expect(source.url).toMatch(/^https:\/\/www\.irs\.gov\//);
      const ids = form.lines.map((line) => line.id);
      expect(new Set(ids).size, `${form.id} ${year} has a duplicate line`).toBe(ids.length);
      for (const line of form.lines) {
        expect(line.id).toBe(`${form.id}.line${line.number}`);
        expect(line.roles.length).toBeGreaterThan(0);
        expect(line.label.length).toBeGreaterThan(0);
      }
    }
  expect(TAX_FORM_IDS.length).toBe(4);
  expect(LATEST_TAX_YEAR).toBe(Math.max(...TAX_YEARS));
});

test("a tag outlives its year: an earlier year's line stays valid, an unknown one never does", () => {
  expect(knownTaxLine("scheduleC.line16c")?.label).toBe("Interest: Other");
  expect(knownTaxLine("scheduleC.line16b")?.label).toBe("Interest: Vehicle loan");
  expect(knownTaxLine("scheduleC.line3")).toBeUndefined();
  expect(knownTaxLine("scheduleC.line28")).toBeUndefined();
  expect(knownTaxLine("scheduleF.line1")).toBeUndefined();
  expect(lineAcceptsRole("scheduleC.line1", "income")).toBe(true);
  expect(lineAcceptsRole("scheduleC.line1", "expense")).toBe(false);
  expect(lineAcceptsRole("form1120S.line20", "asset")).toBe(false);
});

test("a year the catalog does not cover falls to the nearest one it does", () => {
  expect(nearestTaxYear()).toBe(LATEST_TAX_YEAR);
  expect(nearestTaxYear(2025)).toBe(2025);
  expect(nearestTaxYear(2024)).toBe(2025);
  expect(nearestTaxYear(2031)).toBe(LATEST_TAX_YEAR);
});
