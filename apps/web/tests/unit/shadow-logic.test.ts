import { expect, test } from "bun:test";
import type { CutoverChecklist, OpeningReview } from "@rastrata/application/client-contracts";
import {
  type ChartRow,
  type SectionText,
  balancesInput,
  cardSummary,
  checklistView,
  entryFigures,
  entrySections,
  entryView,
  fieldIds,
  issueViews,
  offsetChoices,
  offsetFor,
  readAmount,
  tidy,
  valuesFromReview,
} from "../../src/routes/shadow/logic";

const row = (
  id: string,
  name: string,
  role: ChartRow["role"],
  extra: Partial<ChartRow> = {},
): ChartRow => ({ id, code: id, name, role, openedOn: "2026-01-01", closedOn: null, ...extra });

const CHART: ChartRow[] = [
  row("1000", "Business checking", "asset"),
  row("1100", "Stripe balance", "asset"),
  row("2000", "Business credit card", "liability"),
  row("3000", "Owner's investment", "equity"),
  row("3900", "Opening balance equity", "equity"),
  row("4000", "Sales", "income"),
  row("6000", "Software", "expense"),
  row("1700", "Old savings", "asset", { closedOn: "2026-06-30" }),
];

const TEXT: SectionText = {
  assets: "Assets",
  liabilities: "Liabilities",
  equity: "Equity",
  profitLoss: "Income and expenses",
  profitLossHint: "Optional.",
  amountProblem: "Not an amount.",
};

test("a typed amount is read exactly, in the forms a person writes it, and never rounded", () => {
  const cents = (text: string) => {
    const read = readAmount(text);
    return read.kind === "ok" ? read.cents : read.kind;
  };
  expect(cents("12,000.00")).toBe(1_200_000n);
  expect(cents("1,234.5")).toBe(123_450n);
  expect(cents("$12")).toBe(1_200n);
  expect(cents("(250.00)")).toBe(-25_000n);
  expect(cents("-250.00")).toBe(-25_000n);
  expect(cents("250.00-")).toBe(-25_000n);
  expect(cents("0")).toBe(0n);
  expect(cents("")).toBe("empty");
  expect(cents("   ")).toBe("empty");
  for (const bad of ["12.345", "abc", "1,23.00", "1.2.3", "--5", "12,3456.00", "1e3"])
    expect(cents(bad)).toBe("bad");
  // Past 2^53 a float loses the last cent; cents in a bigint do not.
  expect(cents("9007199254740993.01")).toBe(900_719_925_474_099_301n);
});

test("an amount is tidied to its canonical form only when it is an amount", () => {
  expect(tidy("12000")).toBe("12000.00");
  expect(tidy("12,000")).toBe("12000.00");
  expect(tidy("1300.5")).toBe("1300.50");
  expect(tidy("(5)")).toBe("-5.00");
  expect(tidy("abc")).toBe("abc");
  expect(tidy("12.345")).toBe("12.345");
  expect(tidy("")).toBe("");
});

test("a figure the shared formatter showed, with its real minus sign, reads again", () => {
  const cents = (text: string) => {
    const read = readAmount(text);
    return read.kind === "ok" ? read.cents : read.kind;
  };
  expect(cents("\u22121,250.00")).toBe(-125_000n);
  expect(cents("\u22125.00")).toBe(-500n);
  expect(tidy("\u22125")).toBe("-5.00");
});

test("the offset is the equity account named for opening balances, or the one chosen", () => {
  expect(offsetFor(CHART, "").account?.id).toBe("3900");
  expect(offsetFor(CHART, "3000").account?.id).toBe("3000");
  expect(offsetFor(CHART, "4000")).toEqual({ account: null, problem: true });
  const unnamed = CHART.filter((item) => item.id !== "3900");
  expect(offsetFor(unnamed, "")).toEqual({ account: null, problem: true });
  expect(offsetChoices(CHART).map((choice) => choice.value)).toEqual(["3000", "3900"]);
});

test("the totals and the offset come from exact cents while the person types", () => {
  const figures = entryFigures(
    CHART,
    { "1000": "12,000.00", "2000": "523.10", "1100": "1300.50" },
    "",
  );
  expect(figures.entered).toEqual({ debit: "13300.50", credit: "523.10" });
  // Debits exceed credits, so the offset is a credit and the two sides agree.
  expect(figures.offset).toEqual({
    code: "3900",
    name: "Opening balance equity",
    side: "credit",
    amount: "12777.40",
  });
  expect(figures.totals).toEqual({ debit: "13300.50", credit: "13300.50" });
  expect(figures.problems).toBe(0);
  expect(figures.anyEntered).toBe(true);
});

test("the unusual side is a negative amount, and the offset follows", () => {
  const figures = entryFigures(CHART, { "1000": "-250.00", "2000": "-40.00" }, "");
  // The overdrawn bank is a credit of 250.00 and the card in credit a debit of 40.00: the offset
  // must be a debit of 210.00 for the two sides to agree.
  expect(figures.entered).toEqual({ debit: "40.00", credit: "250.00" });
  expect(figures.offset?.side).toBe("debit");
  expect(figures.offset?.amount).toBe("210.00");
  expect(figures.totals).toEqual({ debit: "250.00", credit: "250.00" });
});

test("0.10 plus 0.20 is 0.30, and one cent past 2^53 still counts", () => {
  const small = entryFigures(CHART, { "1000": "0.10", "1100": "0.20", "2000": "0.30" }, "");
  expect(small.offset?.side).toBe("none");
  expect(small.totals).toEqual({ debit: "0.30", credit: "0.30" });
  const big = entryFigures(CHART, { "1000": "9007199254740993.01", "2000": "0.01" }, "");
  expect(big.offset).toMatchObject({ side: "credit", amount: "9007199254740993.00" });
  expect(big.totals).toEqual({ debit: "9007199254740993.01", credit: "9007199254740993.01" });
});

test("amounts that cannot be read are counted and never added in", () => {
  const figures = entryFigures(
    CHART,
    { "1000": "100.00", "1100": "12.345", "2000": "abc", "4000": "" },
    "",
  );
  expect(figures.problems).toBe(2);
  expect(figures.entered).toEqual({ debit: "100.00", credit: "0.00" });
  expect(entryFigures(CHART, {}, "").anyEntered).toBe(false);
  expect(entryFigures(CHART, { "1000": "0.00" }, "").anyEntered).toBe(false);
});

test("an offset account that cannot be told leaves the entry out of balance until one is chosen", () => {
  const unnamed = CHART.filter((item) => item.id !== "3900");
  const figures = entryFigures(unnamed, { "1000": "100.00" }, "");
  expect(figures.offset).toBeNull();
  expect(figures.totals).toEqual({ debit: "100.00", credit: "0.00" });
  const chosen = entryFigures(unnamed, { "1000": "100.00" }, "3000");
  expect(chosen.offset).toMatchObject({ code: "3000", side: "credit", amount: "100.00" });
  expect(chosen.totals).toEqual({ debit: "100.00", credit: "100.00" });
});

test("the table lists open accounts by kind, without the offset, and says why an amount is wrong", () => {
  const sections = entrySections(CHART, { "1000": "12,000.00", "2000": "x" }, "", false, TEXT);
  expect(sections.map((section) => section.id)).toEqual([
    "assets",
    "liabilities",
    "equity",
    "profit",
  ]);
  const ids = sections.flatMap((section) => section.rows.map((item) => item.id));
  // The calculated offset and the closed account are not rows.
  expect(ids).toEqual(["1000", "1100", "2000", "3000", "4000", "6000"]);
  const checking = sections[0]?.rows[0];
  expect(checking).toMatchObject({ value: "12,000.00", debit: "12000.00", credit: "" });
  expect(sections[1]?.rows[0]).toMatchObject({
    value: "x",
    error: "Not an amount.",
    debit: "",
    credit: "",
  });
  // A liability's positive balance is a credit.
  const card = entrySections(CHART, { "2000": "523.10" }, "", false, TEXT)[1]?.rows[0];
  expect(card).toMatchObject({ debit: "", credit: "523.10" });
  // Income and expense accounts are folded away until asked for or until one holds an amount.
  expect(sections[3]?.collapsed).toBe(true);
  expect(entrySections(CHART, {}, "", true, TEXT)[3]?.collapsed).toBe(false);
  expect(entrySections(CHART, { "6000": "10.00" }, "", false, TEXT)[3]?.collapsed).toBe(false);
});

test("a closed account is offered only once an amount has reached it, so it can be cleared", () => {
  const rows = (values: Record<string, string>) =>
    entrySections(CHART, values, "", false, TEXT).flatMap((section) =>
      section.rows.map((item) => item.id),
    );
  expect(rows({})).not.toContain("1700");
  // A file named the closed account: the table shows it, with the amount, and it can be emptied.
  expect(rows({ "1700": "250.00" })).toContain("1700");
  expect(rows({ "1700": "  " })).not.toContain("1700");
});

test("an issue links to a field only when that field is on the screen", () => {
  const fields = fieldIds(entrySections(CHART, { "1000": "1.00" }, "", false, TEXT));
  // Open rows only: not the calculated offset, not the closed account, not the folded income and
  // expense accounts.
  expect([...fields].sort()).toEqual(["1000", "1100", "2000", "3000"]);
  expect([...fieldIds(entrySections(CHART, {}, "", true, TEXT))].sort()).toEqual([
    "1000",
    "1100",
    "2000",
    "3000",
    "4000",
    "6000",
  ]);
  const issues: OpeningReview["issues"] = [
    {
      severity: "error",
      code: "amount_invalid",
      message: "Not an amount.",
      accountId: "1000",
      row: 3,
    },
    { severity: "info", code: "offset_credit", message: "The offset.", accountId: "3900" },
    { severity: "error", code: "account_closed", message: "Closed.", accountId: "1700" },
    { severity: "error", code: "too_many_lines", message: "Too many." },
  ];
  const views = issueViews(issues, fields);
  expect(views.map((view) => view.accountId)).toEqual(["1000", undefined, undefined, undefined]);
  // Nothing else about an issue is changed or dropped.
  expect(views[0]).toEqual({
    severity: "error",
    code: "amount_invalid",
    message: "Not an amount.",
    row: 3,
    accountId: "1000",
  });
  expect(views[3]).toEqual({ severity: "error", code: "too_many_lines", message: "Too many." });
});

test("the service is sent only the amounts that read, as the wire takes them", () => {
  expect(
    balancesInput(
      CHART,
      {
        "1000": "12,000.00",
        "1100": "0",
        "2000": "(5.5)",
        "3000": "x",
        "3900": "9.00",
        "4000": "",
      },
      "",
    ),
  ).toEqual([
    { accountId: "1000", balance: "12000.00" },
    { accountId: "2000", balance: "-5.50" },
  ]);
  // Choosing another offset makes the named account an ordinary row again.
  expect(balancesInput(CHART, { "3900": "9.00" }, "3000")).toEqual([
    { accountId: "3900", balance: "9.00" },
  ]);
});

const review = (): OpeningReview => ({
  cutoverDate: "2026-11-01",
  entryDate: "2026-10-31",
  currency: "USD",
  valid: true,
  lines: [
    {
      accountId: "1000",
      code: "1000",
      name: "Business checking",
      role: "asset",
      side: "debit",
      balance: "12000.00",
      debit: "12000.00",
      credit: "0.00",
      row: 2,
    },
    {
      accountId: "2000",
      code: "2000",
      name: "Business credit card",
      role: "liability",
      side: "credit",
      balance: "523.10",
      debit: "0.00",
      credit: "523.10",
    },
  ],
  offset: {
    accountId: "3900",
    code: "3900",
    name: "Opening balance equity",
    debit: "0.00",
    credit: "11476.90",
    chosen: false,
  },
  totals: {
    enteredDebit: "12000.00",
    enteredCredit: "523.10",
    debit: "12000.00",
    credit: "12000.00",
    balanced: true,
  },
  zeroBalances: 0,
  issues: [],
  contentHash: "a".repeat(64),
  sourceId: "opening-2026-11-01-aaaaaaaaaaaa",
  calendar: null,
  recordedCutover: "2026-11-01",
  existing: { status: "none" },
});

test("a file's balances fill the table, and the entry is shown with the offset last", () => {
  expect(valuesFromReview(review())).toEqual({ "1000": "12000.00", "2000": "523.10" });
  const entry = entryView(review());
  expect(entry.lines.map((line) => [line.code, line.offset === true])).toEqual([
    ["1000", false],
    ["2000", false],
    ["3900", true],
  ]);
  // The entry is shown on the date it is posted on, the day before the cutover date.
  expect(entry).toMatchObject({
    date: "2026-10-31",
    debit: "12000.00",
    credit: "12000.00",
    balanced: true,
  });
  // With no entry date (a date that cannot be used) the cutover date is what there is to show.
  expect(entryView({ ...review(), entryDate: null }).date).toBe("2026-11-01");
});

// ---- The checklist ---------------------------------------------------------------------------

const checklist = (overrides: Partial<CutoverChecklist> = {}): CutoverChecklist => ({
  asOf: "2026-11-05",
  bookRevision: "18",
  hasHistory: true,
  currency: "USD",
  cutover: { date: "2026-10-01", basis: "recorded" },
  opening: { status: "posted", journalId: "j-1", cutoverDate: "2026-10-01" },
  period: {
    id: "period-10",
    label: "October 2026",
    startsOn: "2026-10-01",
    endsOn: "2026-10-31",
    status: "open",
    ended: true,
  },
  verdict: {
    state: "not_yet",
    summary: "Not yet: 1 thing stands in the way of closing October 2026.",
    blocking: [
      {
        code: "never_reconciled",
        section: "accounts",
        message: "1000 Business checking has not been reconciled to a statement yet.",
        accountId: "1000",
      },
    ],
    attention: [],
  },
  accounts: [
    {
      accountId: "1000",
      code: "1000",
      name: "Business checking",
      role: "asset",
      kind: "bank",
      reason: "cash",
      bookBalance: "10700.01",
      hasActivity: true,
      lastReconciliation: null,
      throughPeriodEnd: false,
      draft: {
        id: "d 1",
        statementDate: "2026-10-31",
        statementBalance: "10700.01",
        difference: "12.00",
      },
      unreconciled: { count: 2, oldestOn: "2026-10-25" },
      uncleared: { count: 4, total: "10700.01", oldestOn: "2026-10-01" },
      status: "blocked",
      reasons: [],
    },
  ],
  otherAccounts: [],
  stripe: null,
  inbox: { available: true, waiting: 2, oldestOn: "2026-10-25", toReview: 3 },
  backups: {
    available: false,
    reason: "This runtime cannot make backups.",
    verifiedAt: null,
    ageHours: null,
    limitHours: 48,
    drill: null,
  },
  openPeriods: [],
  shadowRun: {
    required: 2,
    provenCount: 1,
    provenThrough: "2026-10-31",
    complete: false,
    months: [],
  },
  unavailable: [],
  ...overrides,
});

test("the checklist is shown as the service said it, with the draft linked and nothing recomputed", () => {
  const view = checklistView(checklist());
  expect(view.verdict.state).toBe("not_yet");
  expect(view.accounts[0]).toMatchObject({
    code: "1000",
    status: "blocked",
    waiting: { count: 2, oldestOn: "2026-10-25" },
    draft: { href: "/reconcile/d%201", difference: "12.00" },
    last: null,
  });
  expect(view.backups).toMatchObject({
    available: false,
    reason: "This runtime cannot make backups.",
  });
  expect(view.shadowRun?.provenCount).toBe(1);
  expect(view.backups.keptByService).toBeUndefined();
});

test("a service that keeps the history of the books itself says so in the checklist, and the page is told", () => {
  const kept = checklistView(
    checklist({
      backups: {
        available: false,
        keptByService: true,
        verifiedAt: null,
        ageHours: null,
        limitHours: 48,
        drill: null,
      },
    }),
  );
  expect(kept.backups).toMatchObject({ available: false, keptByService: true, reason: null });
});

test("the notes of a month are carried as the facts they are, and a service that makes none leaves them out", () => {
  expect("notes" in checklistView(checklist())).toBe(false);
  expect(checklistView(checklist({ notes: [] })).notes).toEqual([]);
  const view = checklistView(
    checklist({
      notes: [
        {
          code: "catchall_holds_money",
          message: "Other expenses holds 1,240.00 from 31 transactions in March 2026.",
          account: { id: "6290", code: "6290", name: "Other expenses", role: "expense" },
          from: "2026-03-01",
          to: "2026-03-31",
          amount: "1240.00",
          transactions: 31,
          largest: [{ name: "Adobe", amount: "420.00", kind: "payee" }],
        },
        {
          code: "catchall_not_checked",
          message: "Other income could not be checked.",
          account: { id: "4900", code: "4900", name: "Other income", role: "income" },
        },
      ],
    }),
  );
  // The words are the screen's own; the service's sentence is not carried.
  expect(view.notes).toEqual([
    {
      code: "catchall_holds_money",
      account: { id: "6290", code: "6290", name: "Other expenses", role: "expense" },
      from: "2026-03-01",
      to: "2026-03-31",
      amount: "1240.00",
      transactions: 31,
      largest: [{ name: "Adobe", amount: "420.00", kind: "payee" }],
    },
    {
      code: "catchall_not_checked",
      account: { id: "4900", code: "4900", name: "Other income", role: "income" },
      largest: [],
    },
  ]);
});

test("the Home card says what to do: start, post the opening entry, or the verdict", () => {
  expect(
    cardSummary(checklist({ cutover: null, opening: { status: "none" }, hasHistory: false })).state,
  ).toBe("start");
  expect(cardSummary(checklist({ opening: { status: "planned" } })).state).toBe("opening");
  const normal = cardSummary(checklist());
  expect(normal).toMatchObject({
    state: "not_yet",
    first: "1000 Business checking has not been reconciled to a statement yet.",
    shadowRun: { provenCount: 1, required: 2 },
  });
  // A cutover taken from a posted opening entry, or a book that never recorded one, shows the verdict.
  expect(
    cardSummary(checklist({ cutover: { date: "2026-10-01", basis: "opening_entry" } })).state,
  ).toBe("not_yet");
});

test("the offer to move from another system is only for a book with nothing in it", () => {
  const nothing = { cutover: null, opening: { status: "none" as const }, hasHistory: false };
  expect(cardSummary(checklist(nothing)).state).toBe("start");
  // A book that already has history is shown what stands in the way of closing its month, with no
  // cutover recorded and no opening entry: the offer is a feature prompt, not a status.
  const withHistory = cardSummary(checklist({ ...nothing, hasHistory: true }));
  expect(withHistory.state).toBe("not_yet");
  expect(withHistory.first).toBe(
    "1000 Business checking has not been reconciled to a statement yet.",
  );
  // An opening entry however it was made (here one made by hand and found by the service) is not a
  // book with nothing in it either, nor is a recorded cutover whose entry is waiting to be posted.
  expect(
    cardSummary(
      checklist({
        cutover: null,
        opening: { status: "posted", byHand: true, journalId: "j-1", entryDate: "2026-09-30" },
        hasHistory: true,
      }),
    ).state,
  ).toBe("not_yet");
  expect(
    cardSummary(
      checklist({
        cutover: { date: "2026-10-01", basis: "recorded" },
        opening: { status: "none" },
        hasHistory: false,
      }),
    ).state,
  ).toBe("opening");
});
