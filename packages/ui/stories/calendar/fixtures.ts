import type {
  CalendarFiscalYear,
  CalendarPeriod,
  CalendarView,
  PeriodHistoryEntry,
  YearEndChecklistItem,
  YearEndPlanView,
  YearEndStatementsView,
  YearEndStepView,
} from "../../src";

/** Fictional data only. An October fiscal year: fiscal year 2027 runs 2027-10-01 to 2028-09-30. */
const MONTHS = [
  "October",
  "November",
  "December",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
] as const;

const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const pad = (value: number) => String(value).padStart(2, "0");

/** The twelve periods of the October-start fiscal year `year`. `closed` periods from the start are
 * locked with a current close; the next `superseded` are locked with a superseded close; `ended` says
 * how many periods have passed; the first `beforeBooks` end before the books began. */
export function monthlyYear(
  year: number,
  options: { closed?: number; superseded?: number; ended?: number; beforeBooks?: number } = {},
): CalendarPeriod[] {
  const { closed = 0, superseded = 0, ended = 12, beforeBooks = 0 } = options;
  const named = (index: number) => `${MONTHS[index]} ${index < 3 ? year : year + 1}`;
  return MONTHS.map((label, index) => {
    const month = ((9 + index) % 12) + 1;
    const calendarYear = month >= 10 ? year : year + 1;
    const locked = index < closed + superseded;
    const isSuperseded = index >= closed && locked;
    const endsOn = `${calendarYear}-${pad(month)}-${pad(lastDay(calendarYear, month))}`;
    return {
      id: index === 0 && year === 2026 ? "period-01" : `period-${year}-${pad(index + 1)}`,
      label,
      startsOn: `${calendarYear}-${pad(month)}-01`,
      endsOn,
      status: locked ? "closed" : "open",
      closeSuperseded: isSuperseded,
      ended: index < ended,
      beforeBooks: index < beforeBooks,
      empty: false,
      closingReportHref: locked && !isSuperseded ? `/reports?asOf=${endsOn}` : null,
      closingRevision: locked && !isSuperseded ? String(40 + index) : null,
      // Reopening a period with a current close supersedes the closes of the later closed ones.
      supersedes:
        locked && !isSuperseded
          ? Array.from({ length: Math.max(0, closed - index - 1) }, (_, offset) =>
              named(index + 1 + offset),
            )
          : [],
    } satisfies CalendarPeriod;
  });
}

export const years: CalendarFiscalYear[] = [
  {
    fiscalYear: 2026,
    startsOn: "2026-10-01",
    endsOn: "2027-09-30",
    periodCount: 12,
    closedCount: 12,
    supersededCount: 0,
    status: "closed",
    ended: true,
    beforeBooks: false,
    periodsBeforeBooks: 0,
  },
  {
    fiscalYear: 2027,
    startsOn: "2027-10-01",
    endsOn: "2028-09-30",
    periodCount: 12,
    closedCount: 5,
    supersededCount: 0,
    status: "partlyClosed",
    ended: true,
    beforeBooks: false,
    periodsBeforeBooks: 0,
  },
  {
    fiscalYear: 2028,
    startsOn: "2028-10-01",
    endsOn: "2029-09-30",
    periodCount: 12,
    closedCount: 0,
    supersededCount: 0,
    status: "open",
    ended: false,
    beforeBooks: false,
    periodsBeforeBooks: 0,
  },
];

export const calendar: CalendarView = {
  firstDate: "2026-10-01",
  lastDate: "2029-09-30",
  fiscalYearStartMonth: 10,
  today: "2028-11-20",
  booksBegan: null,
};

export const checklistReady: YearEndChecklistItem[] = [
  {
    id: "trial-balance",
    label: "The trial balance balances",
    detail: "Debits and credits are both 48,210.55 USD as of 2028-09-30.",
    state: "ready",
  },
  {
    id: "periods-ended",
    label: "Every period has ended",
    detail: "The last day of the year, 2028-09-30, is before today (2028-11-20).",
    state: "ready",
  },
  {
    id: "closes-current",
    label: "Every close is current",
    detail: "No close of this year was superseded by reopening an earlier period.",
    state: "ready",
  },
  {
    id: "reconcile",
    label: "Bank and card accounts are reconciled",
    detail: "Every tracked account is reconciled through the end of the year.",
    state: "ready",
    href: "/reconcile",
    hrefLabel: "Open Reconcile",
  },
  {
    id: "inbox",
    label: "Nothing from this year is waiting for review",
    detail: "No imported transaction is waiting to be reviewed.",
    state: "ready",
    href: "/inbox",
    hrefLabel: "Open For review",
  },
];

export const checklistAttention: YearEndChecklistItem[] = [
  checklistReady[0] as YearEndChecklistItem,
  {
    id: "periods-ended",
    label: "Every period has ended",
    detail:
      "3 of the 12 periods to close have not ended; the year runs to 2029-09-30 and today is 2028-11-20. Closing a period stops new postings dated in it.",
    state: "attention",
  },
  {
    id: "closes-current",
    label: "Every close is current",
    detail:
      "2 periods of this year were closed before an earlier period was reopened, so their recorded closes no longer match the books. They are still locked. This year-end reopens and closes each again.",
    state: "attention",
  },
  {
    id: "reconcile",
    label: "Bank and card accounts are reconciled",
    detail:
      "Checking has 7 transactions, the oldest dated Aug 14, 2028. Visa has 2 transactions, the oldest dated Sep 2, 2028. Outstanding items are normal; unexpected ones are worth finding first.",
    state: "attention",
    href: "/reconcile",
    hrefLabel: "Open Reconcile",
  },
  {
    id: "inbox",
    label: "Nothing from this year is waiting for review",
    detail: "14 imported transactions are waiting to be reviewed, the oldest dated Jul 3, 2028.",
    state: "attention",
    href: "/inbox",
    hrefLabel: "Open For review",
  },
];

export const checklistUnavailable: YearEndChecklistItem[] = [
  checklistReady[0] as YearEndChecklistItem,
  {
    id: "reconcile",
    label: "Bank and card accounts are reconciled",
    detail: "Reconciliation could not be read.",
    state: "unavailable",
  },
  {
    id: "inbox",
    label: "Nothing from this year is waiting for review",
    detail: "The transactions waiting for review could not be read.",
    state: "unavailable",
  },
];

export const checklistLoading: YearEndChecklistItem[] = [
  { id: "trial-balance", label: "The trial balance balances", detail: "", state: "loading" },
  {
    id: "reconcile",
    label: "Bank and card accounts are reconciled",
    detail: "",
    state: "loading",
  },
  {
    id: "inbox",
    label: "Nothing from this year is waiting for review",
    detail: "",
    state: "loading",
  },
];

export const statements: YearEndStatementsView = {
  currency: "USD",
  basis: "cash",
  asOf: "2028-09-30",
  periodStart: "2027-10-01",
  revenue: "61,480.00",
  expenses: "13,269.45",
  netIncome: "48,210.55",
  assets: "52,901.10",
  liabilities: "4,690.55",
  equity: "48,210.55",
  priorEarnings: "0.00",
  reportHref: "/reports?asOf=2028-09-30",
};

const step = (
  order: number,
  label: string,
  startsOn: string,
  endsOn: string,
  options: Partial<YearEndStepView> = {},
): YearEndStepView => ({
  order,
  label,
  startsOn,
  endsOn,
  status: "open",
  closeSuperseded: false,
  commands: [{ kind: "close", valid: true, warnings: [], problems: [] }],
  ...options,
});

const monthSteps = (options: { keep?: number; reclose?: number; warn?: boolean } = {}) =>
  monthlyYear(2027).map((period, index) =>
    index < (options.keep ?? 0)
      ? step(index + 1, period.label, period.startsOn, period.endsOn, {
          status: "closed",
          commands: [],
        })
      : index < (options.keep ?? 0) + (options.reclose ?? 0)
        ? step(index + 1, period.label, period.startsOn, period.endsOn, {
            status: "closed",
            closeSuperseded: true,
            commands: [
              { kind: "reopen", valid: true, warnings: [], problems: [] },
              { kind: "close", valid: true, warnings: [], problems: [] },
            ],
          })
        : step(index + 1, period.label, period.startsOn, period.endsOn, {
            commands: [
              {
                kind: "close",
                valid: true,
                problems: [],
                warnings:
                  options.warn && index === 11
                    ? [
                        "1000 Checking: 7 postings dated through 2028-09-30 are not on a reconciliation (last reconciled to 2028-08-31). Closing does not check bank balances.",
                      ]
                    : [],
              },
            ],
          }),
  );

export const plan: YearEndPlanView = {
  fiscalYear: 2027,
  valid: true,
  closes: 7,
  superseded: 0,
  reason: "Reviewed with my bookkeeper",
  problems: [],
  steps: monthSteps({ keep: 5, warn: true }),
};

export const planWithReclose: YearEndPlanView = {
  ...plan,
  closes: 9,
  superseded: 2,
  steps: monthSteps({ keep: 3, reclose: 2, warn: true }),
};

export const planInvalid: YearEndPlanView = {
  ...plan,
  valid: false,
  problems: [
    "Fiscal period period-2027-06 is closed",
    "The book changed after the plan was prepared. Prepare it again.",
  ],
};

export const history: PeriodHistoryEntry[] = [
  {
    periodLabel: "February 2028",
    kind: "close",
    recordedAt: "2028-11-18T09:12:44.000Z",
    bookRevision: "412",
    reason: "Year end FY2027, February: Reviewed with my bookkeeper",
    superseded: [],
  },
  {
    periodLabel: "March 2028",
    kind: "reopen",
    recordedAt: "2028-11-12T16:40:03.000Z",
    bookRevision: "398",
    reason: "A supplier restated March",
    superseded: ["April 2028", "May 2028", "June 2028"],
  },
  {
    periodLabel: "March 2028",
    kind: "close",
    recordedAt: "2028-10-02T08:01:19.000Z",
    bookRevision: "371",
    reason: "Month end",
    superseded: [],
  },
];

export const manyHistory: PeriodHistoryEntry[] = Array.from({ length: 60 }, (_, index) => ({
  periodLabel: `${MONTHS[index % 12]} ${2027 + Math.floor(index / 12)}`,
  kind: index % 7 === 3 ? ("reopen" as const) : ("close" as const),
  recordedAt: `2028-1${index % 3}-0${(index % 9) + 1}T10:00:00.000Z`,
  bookRevision: String(300 + index),
  reason: index % 7 === 3 ? "A supplier restated the month" : "Month end",
  superseded: index % 7 === 3 ? ["The next month"] : [],
}));
