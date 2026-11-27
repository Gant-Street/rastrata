import { expect, test } from "bun:test";
import { shown } from "../support/shown";
import type { ApplicationOutputs } from "@rastrata/application/client-contracts";
import {
  accountViews,
  atBlocks,
  canKeepTrialBalance,
  canUseAsOpening,
  chartPreviewView,
  columnViews,
  cutoverNote,
  gapViews,
  mappingChoices,
  overridesFrom,
  readTolerance,
  reconciledChanges,
  reconciledRows,
  requestBytes,
  stableGaps,
  tbRows,
  tieoutView,
} from "../../src/routes/shadow/xero-logic";

type ChartPreview = ApplicationOutputs["xero.chart.preview"];
type TbPreview = ApplicationOutputs["xero.trialBalance.preview"];
type AtPreview = ApplicationOutputs["xero.transactions.preview"];

const row = (
  fields: Partial<ChartPreview["accounts"][number]> & { code: string; name: string },
): ChartPreview["accounts"][number] => ({
  row: 2,
  type: "Bank",
  typeLabel: "Bank",
  role: "asset",
  bank: false,
  system: false,
  taxCode: "",
  balance: null,
  archived: false,
  accountId: null,
  accountCode: null,
  accountName: null,
  skip: false,
  basis: "none",
  confidence: "none",
  candidates: [],
  problems: [],
  suggestion: null,
  ...fields,
});

const preview = (accounts: ChartPreview["accounts"]): ChartPreview => ({
  source: "file",
  name: "chart.csv",
  sha256: "a".repeat(64),
  importedAt: null,
  rows: accounts.length,
  columns: [],
  accounts,
  counts: {
    accounts: accounts.length,
    mapped: 1,
    skipped: 0,
    unmapped: 1,
    unmappedWithBalance: 0,
    bank: 0,
    certain: 1,
    likely: 0,
    check: 1,
  },
  issues: [],
});

test("the accounts a Xero account may be mapped to are the open ones, in code order", () => {
  expect(
    mappingChoices([
      { id: "2000", code: "2000", name: "Card", closedOn: null },
      { id: "1000", code: "1000", name: "Checking", closedOn: null },
      { id: "9000", code: "9000", name: "Old", closedOn: "2026-01-01" },
    ]),
  ).toEqual([
    { value: "1000", label: "1000 · Checking" },
    { value: "2000", label: "2000 · Card" },
  ]);
});

test("only the codes a person decided are sent as overrides, in code order", () => {
  expect(overridesFrom({ "470": "4000", "310": "skip", "090": "" })).toEqual([
    { xeroCode: "310", skip: true },
    { xeroCode: "470", accountId: "4000" },
  ]);
  expect(overridesFrom({})).toEqual([]);
});

test("a row shows the person's decision, else a saved one, else the match as proposed", () => {
  const rows = [
    row({
      code: "090",
      name: "Checking",
      accountId: "1000",
      accountCode: "1000",
      accountName: "Checking",
      confidence: "certain",
      basis: "name",
    }),
    row({ code: "470", name: "Other Revenue" }),
    row({ code: "310", name: "COGS", skip: true, basis: "saved" }),
    row({
      code: "200",
      name: "Sales",
      accountId: "4000",
      accountCode: "4000",
      accountName: "Sales",
      basis: "saved",
      confidence: "certain",
    }),
  ];
  const views = accountViews(preview(rows), { "470": "4000" });
  expect(views.map((view) => [view.code, view.value])).toEqual([
    ["090", ""],
    ["470", "4000"],
    ["310", "skip"],
    ["200", "4000"],
  ]);
  expect(views[0]?.mapsTo).toBe("1000 · Checking");
  expect(views[1]?.mapsTo).toBeNull();
});

test("what to create for an account nothing resembles is said in words, and only for such an account", () => {
  const unmatched = row({
    code: "470",
    name: "Other Revenue",
    suggestion: { role: "income", cashFlowClass: null, roleKey: null, like: "Other income" },
  });
  const matched = row({
    code: "090",
    name: "Checking",
    accountId: "1000",
    accountCode: "1000",
    accountName: "Checking",
    suggestion: { role: "asset", cashFlowClass: "cash", roleKey: null, like: null },
  });
  const [first, second] = accountViews(preview([unmatched, matched]), {});
  expect(first?.suggestion).toBe(
    "Nothing in your book resembles it. Create an income account like Other income, then choose it here.",
  );
  expect(second?.suggestion).toBeNull();
});

test("tags and problems are carried in words, and a hostile name stays text", () => {
  const views = accountViews(
    preview([
      row({
        code: "999",
        name: "<img src=x onerror=alert(1)>",
        archived: true,
        system: true,
        bank: true,
        // A code the screen has no words for is shown as the service wrote it.
        problems: ["target_closed", "something_new"] as never,
      }),
    ]),
    {},
  );
  expect(views[0]?.tags).toEqual(["archived", "system", "bank"]);
  expect(views[0]?.problems).toEqual(["That account is closed.", "something_new"]);
  expect(views[0]?.name).toBe("<img src=x onerror=alert(1)>");
});

test("the chart preview view keeps the file's issues with their rows", () => {
  const source = preview([row({ code: "090", name: "Checking" })]);
  const view = chartPreviewView(
    {
      ...source,
      issues: [{ severity: "warning", code: "archived_account", message: "x", row: 4 }],
    },
    {},
  );
  expect(view.issues).toEqual([
    { severity: "warning", code: "archived_account", message: "x", row: 4 },
  ]);
  expect(view.counts).toEqual({ accounts: 1, certain: 1, likely: 0, check: 1 });
});

const tb = (fields: Partial<TbPreview> = {}): TbPreview => ({
  name: "tb.csv",
  sha256: "b".repeat(64),
  organisation: null,
  asOf: "2026-06-30",
  layout: "period_and_ytd",
  rows: [
    {
      row: 6,
      section: "Assets",
      xeroCode: "090",
      name: "Checking",
      type: "Bank",
      net: "12000.00",
      status: "mapped",
      accountId: "1000",
      accountCode: "1000",
      accountName: "Checking",
      balance: "12000.00",
    },
    {
      row: 7,
      section: null,
      xeroCode: null,
      name: "Unknown",
      type: null,
      net: "-1.00",
      status: "unmapped",
      accountId: null,
      accountCode: null,
      accountName: null,
      balance: null,
    },
  ],
  sums: { debit: "12000.00", credit: "12000.00", ytdDebit: "12000.00", ytdCredit: "12000.00" },
  fileTotals: null,
  balanced: true,
  balances: [{ accountId: "1000", balance: "12000.00" }],
  leftOut: {
    profitLoss: 0,
    profitLossNet: "0.00",
    unmapped: 1,
    unmappedNet: "-1.00",
    skipped: 0,
    skippedNet: "0.00",
    retainedEarnings: "0.00",
  },
  cutover: { date: "2026-07-01", dayBefore: "2026-06-30", asOfIsDayBefore: true },
  columns: [],
  issues: [],
  ...fields,
});

test("a trial balance row says which account it maps to and what it counts as", () => {
  expect(tbRows(tb()).map((view) => [view.xeroCode, view.mapsTo, view.status])).toEqual([
    ["090", "1000 · Checking", "mapped"],
    [null, null, "unmapped"],
  ]);
});

test("the cutover note says whether the date is right for opening balances", () => {
  expect(cutoverNote(tb())).toBe(
    `That is the day before the start date, ${shown.date("2026-07-01")}: right for opening balances.`,
  );
  const later = tb({
    asOf: "2026-07-31",
    cutover: { date: "2026-07-01", dayBefore: "2026-06-30", asOfIsDayBefore: false },
  });
  expect(cutoverNote(later)).toContain(
    `opening balances want a trial balance as at ${shown.date("2026-06-30")}`,
  );
  expect(cutoverNote(tb({ cutover: null }))).toBeNull();
});

test("opening balances are offered only for a balanced file as at the day before the cutover", () => {
  expect(canUseAsOpening(tb())).toBe(true);
  expect(canUseAsOpening(undefined)).toBe(false);
  expect(canUseAsOpening(tb({ balanced: false }))).toBe(false);
  expect(canUseAsOpening(tb({ balances: [] }))).toBe(false);
  expect(
    canUseAsOpening(
      tb({ cutover: { date: "2026-07-01", dayBefore: "2026-06-30", asOfIsDayBefore: false } }),
    ),
  ).toBe(false);
  expect(
    canUseAsOpening(
      tb({ issues: [{ severity: "error", code: "amount_unreadable", message: "x", row: 9 }] }),
    ),
  ).toBe(false);
});

test("a trial balance that does not balance can never be kept", () => {
  expect(canKeepTrialBalance(tb())).toBe(true);
  expect(canKeepTrialBalance(tb({ balanced: false }))).toBe(false);
  expect(canKeepTrialBalance(undefined)).toBe(false);
});

test("a block agrees with the file only when the file has a total row for it", () => {
  const block = (fields: Partial<AtPreview["blocks"][number]>): AtPreview["blocks"][number] => ({
    heading: "Checking",
    xeroCode: "090",
    name: "Checking",
    status: "mapped",
    accountId: "1000",
    accountCode: "1000",
    accountName: "Checking",
    lines: 2,
    debit: "10.00",
    credit: "4.00",
    fileDebit: "10.00",
    fileCredit: "4.00",
    sample: [],
    ...fields,
  });
  const source: AtPreview = {
    name: "at.csv",
    sha256: "c".repeat(64),
    organisation: null,
    periodFrom: "2026-07-01",
    periodTo: "2026-07-31",
    blocks: [
      block({}),
      block({ heading: "Lost row", fileCredit: "5.00" }),
      block({ heading: "No total", fileDebit: null, fileCredit: null }),
    ],
    lineCount: 6,
    columns: [],
    issues: [],
  };
  expect(atBlocks(source).map((view) => view.agrees)).toEqual([true, false, null]);
});

test("a day Xero was reconciled through is typed, saved, changed or cleared, and a bad one is named", () => {
  const saved = [
    { code: "090", through: "2026-07-31" },
    { code: "091", through: "2026-06-30" },
  ];
  expect(reconciledChanges(saved, { "090": "2026-07-31", "091": "", "092": "2026-07-15" })).toEqual(
    {
      choices: [{ code: "092", through: "2026-07-15" }],
      clear: ["091"],
      bad: [],
    },
  );
  expect(reconciledChanges(saved, { "090": "31/07/2026" }).bad).toEqual(["090"]);
  expect(reconciledChanges(saved, { "090": "2026-08-31" }).choices).toEqual([
    { code: "090", through: "2026-08-31" },
  ]);
  expect(reconciledChanges([], { "090": "" })).toEqual({ choices: [], clear: [], bad: [] });
});

test("the Xero bank accounts are listed from the chart, with what is saved and what was typed", () => {
  const chart = preview([
    row({ code: "091", name: "Savings", bank: true }),
    row({ code: "090", name: "Checking", bank: true }),
    row({ code: "200", name: "Sales" }),
  ]);
  expect(
    reconciledRows(chart, [{ code: "090", name: "Checking", through: "2026-07-31" }], {
      "091": "2026-06-30",
    }),
  ).toEqual([
    { code: "090", name: "Checking", through: "2026-07-31" },
    { code: "091", name: "Savings", through: "2026-06-30" },
  ]);
  // No chart yet: a saved date still shows.
  expect(
    reconciledRows(undefined, [{ code: "090", name: null, through: "2026-07-31" }], {}),
  ).toEqual([{ code: "090", name: "090", through: "2026-07-31" }]);
});

test("a days-apart box takes a whole number from 0 to 14, or nothing", () => {
  expect(readTolerance("")).toEqual({ ok: true, days: undefined });
  expect(readTolerance(" 3 ")).toEqual({ ok: true, days: 3 });
  expect(readTolerance("0")).toEqual({ ok: true, days: 0 });
  expect(readTolerance("14")).toEqual({ ok: true, days: 14 });
  for (const text of ["15", "-1", "2.5", "three", "1e1", "100"])
    expect(readTolerance(text)).toEqual({ ok: false });
});

test("the comparison view keeps every figure as the wire string, and lines only where there are some", () => {
  const report: ApplicationOutputs["tieout.report"] = {
    currency: "USD",
    basis: "cash",
    cutoverDate: "2026-07-01",
    toleranceDays: 3,
    periods: [
      {
        from: "2026-07-01",
        to: "2026-07-31",
        xeroReconciled: true,
        notReconciled: [],
        accounts: [
          {
            accountId: "1000",
            code: "1000",
            name: "Checking",
            role: "asset",
            basis: "closing",
            status: "differs",
            reason: null,
            xero: "10.00",
            rastrata: "9.00",
            difference: "-1.00",
            carried: "0.00",
            matched: 3,
            unmatched: null,
            unmatchedCount: null,
            residual: "-1.00",
            explained: false,
          },
          {
            accountId: "2000",
            code: "2000",
            name: "Card",
            role: "liability",
            basis: "closing",
            status: "not_comparable",
            reason: { code: "xero_not_reconciled", message: "Xero was not reconciled." },
            xero: null,
            rastrata: null,
            difference: null,
            carried: null,
            matched: 0,
            unmatched: null,
            unmatchedCount: null,
            residual: null,
            explained: false,
          },
        ],
        unmapped: [],
      },
    ],
    summary: {
      periods: 1,
      comparable: 1,
      matches: 0,
      differs: 1,
      explained: 0,
      unexplained: 1,
      notComparable: 1,
      linesOnlyInXero: 0,
      linesOnlyInRastrata: 0,
    },
    notes: [],
  };
  const view = tieoutView(report);
  const [differs, notComparable] = view.periods[0]?.accounts ?? [];
  expect(differs).toMatchObject({
    difference: "-1.00",
    residual: "-1.00",
    explained: false,
    unmatched: [],
  });
  expect(notComparable).toMatchObject({ reason: "Xero was not reconciled.", xero: null });
});

test("a gap the comparison found is said in the app's words, and one a person typed is left as they typed it", () => {
  const found = {
    id: 8,
    kind: "difference" as const,
    title: "1000 Business checking: a line in Xero and not in Rastrata, 2026-08-14",
    detail: "Xero has a payment of 49.99 dated 2026-08-14. The Inbox has no line for it.",
    source: "tieout" as const,
    status: "open" as const,
    openedAt: "2026-09-02T14:05:00.000Z",
    openedBy: "owner",
    closedAt: null,
    closedBy: null,
    resolution: null,
  };
  const typed = {
    ...found,
    id: 9,
    source: "manual" as const,
    title: "Dated 2026-08-14: the line is a Journal entry",
    detail: "",
  };
  const views = gapViews({ open: 2, closed: 0, gaps: [found, typed] });
  expect(views[0]).toMatchObject({
    title: `1000 Business checking: a transaction in Xero and not in Rastrata, ${shown.date("2026-08-14")}`,
    detail: `Xero has a payment of ${shown.money("49.99")} dated ${shown.date("2026-08-14")}. The review list has no transaction for it.`,
  });
  expect(views[1]).toMatchObject({ title: "Dated 2026-08-14: the line is a Journal entry" });
});

test("a gap keeps its words, its numbers and who touched it", () => {
  const views = gapViews({
    open: 1,
    closed: 0,
    gaps: [
      {
        id: 7,
        kind: "difference",
        title: "A line in Xero and not here",
        detail: "d",
        source: "tieout",
        status: "open",
        openedAt: "2026-09-02T14:05:00.000Z",
        openedBy: "owner",
        closedAt: null,
        closedBy: null,
        resolution: null,
      },
    ],
  });
  expect(views).toEqual([
    {
      id: 7,
      kind: "difference",
      title: "A transaction in Xero and not here",
      detail: "d",
      source: "tieout",
      status: "open",
      openedAt: "2026-09-02T14:05:00.000Z",
      openedBy: "owner",
      closedAt: null,
      closedBy: null,
      resolution: null,
    },
  ]);
});

test("a file is measured as it is sent: quotes, new lines and accents cost what they cost in a request", () => {
  expect(requestBytes("abc")).toBe(5);
  expect(requestBytes('a"b\n')).toBe(8);
  expect(requestBytes("\u00e9")).toBe(4);
  // A file full of quoted cells is larger in a request than it is on disk.
  const quoted = '"a","b","c"\n'.repeat(1000);
  expect(requestBytes(quoted)).toBeGreaterThan(quoted.length * 1.2);
});

test("a gap that did not change is the same object on the next reading, so its card is not made again", () => {
  const keep = stableGaps();
  const gap = (id: number, status: "open" | "closed") => ({
    id,
    kind: "difference" as const,
    title: `Gap ${id}`,
    detail: "",
    source: "manual" as const,
    status,
    openedAt: "2026-09-02T14:05:00.000Z",
    openedBy: "owner",
    closedAt: null,
    closedBy: null,
    resolution: null,
  });
  const first = keep([gap(1, "open"), gap(2, "open")]);
  const second = keep([gap(1, "open"), gap(2, "closed"), gap(3, "open")]);
  expect(second[0]).toBe(first[0]);
  expect(second[1]).not.toBe(first[1]);
  expect(second[1]?.status).toBe("closed");
  expect(second).toHaveLength(3);
  // A gap that went away and came back is a new object: nothing is kept for what was not shown.
  const third = keep([gap(1, "open")]);
  const fourth = keep([gap(1, "open"), gap(3, "open")]);
  expect(fourth[0]).toBe(third[0]);
  expect(fourth[1]).not.toBe(second[2]);
});

test("the columns of a file are shown as the file wrote them and as they were read, in the order found", () => {
  const source = preview([row({ code: "090", name: "Checking" })]);
  const columns = [
    { field: "code", header: "*Code" },
    { field: "name", header: "<b>*Name</b>" },
  ];
  expect(columnViews(columns)).toEqual(columns);
  // A hostile header is data: it is passed through untouched for the screen to show as text.
  expect(chartPreviewView({ ...source, columns }, {}).columns[1]?.header).toBe("<b>*Name</b>");
  expect(columnViews([])).toEqual([]);
});
