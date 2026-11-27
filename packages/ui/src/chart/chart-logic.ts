/** The chart editor's rules, with no UI in them: building and merging rows, picking codes, and
 * checking a chart before it is sent. Pure functions of their arguments, so they are easy to test
 * and behave the same in a story, the app and a test. */
import type {
  AccountView,
  ChartAccount,
  ChartProblem,
  ChartRole,
  ChartTags,
  ClosedPeriod,
  SetupChoices,
  SetupDocument,
  SlotKind,
  TaxFormChoice,
} from "./chart-types";
import { monthName } from "../format";
import type { ChartMessages } from "./messages";

export const ROLE_ORDER: readonly ChartRole[] = [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
];

/** The first fiscal year of every book made in the browser, the earliest the application accepts. A
 * calendar only grows forward, so the books begin on a day of their own (this year's start) and the
 * years before it stay in the calendar for whoever later brings an earlier history in. */
export const CALENDAR_FIRST_YEAR = 2000;

/** What `book.setup` accepts for an account code. */
export const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$/;
export const MAX_ACCOUNTS = 200;
export const MAX_NAME = 120;
export const BALANCE_SHEET: readonly ChartRole[] = ["asset", "liability", "equity"];

/** Codes in the order a person reads them: "1000" before "1010" before "2000", and "9" before "10". */
export const compareCodes = (a: string, b: string): number =>
  a.localeCompare(b, "en", { numeric: true });

let counter = 0;
/** A fresh row identity. Rows keep their key while their code and name change. */
export const newKey = (): string => `row-${++counter}`;

export const isBalanceSheet = (role: ChartRole): boolean => BALANCE_SHEET.includes(role);

const bases: Readonly<Record<SlotKind, number>> = { bank: 1000, card: 2000 };

/** The first free code in a bank's or card's range: 1000, 1010, ... for banks and 2000, 2010, ... for cards,
 * then the codes between. Empty when the range is full. */
export function nextSlotCode(accounts: readonly { code: string }[], kind: SlotKind): string {
  const used = new Set(accounts.map((account) => account.code.trim().toLowerCase()));
  const base = bases[kind];
  for (const step of [10, 1])
    for (let code = base; code < base + 100; code += step)
      if (!used.has(String(code))) return String(code);
  return "";
}

/** Rows grouped for display in the order a chart is read. */
export function groupByRole(
  accounts: readonly ChartAccount[],
): { role: ChartRole; accounts: ChartAccount[] }[] {
  return ROLE_ORDER.map((role) => ({
    role,
    accounts: accounts.filter((account) => account.role === role),
  }));
}

export interface TaxLineOption {
  readonly value: string;
  readonly label: string;
  readonly group: string;
  readonly note?: string | undefined;
}

/** A form as people say it ("Schedule C", "Form 1120-S"), not its full title on the IRS's page. */
const FORM_SHORT: Readonly<Record<string, string>> = {
  scheduleC: "Schedule C",
  form1120S: "Form 1120-S",
  form1065: "Form 1065",
  form1125A: "Form 1125-A",
};
export const formShortName = (form: { id: string; name: string }): string =>
  FORM_SHORT[form.id] ?? form.name;

/** The tax lines an account of this type may carry, as options grouped by form. */
export function taxLineOptions(forms: readonly TaxFormChoice[], role: string): TaxLineOption[] {
  return forms.flatMap((form) =>
    form.lines
      .filter((line) => line.roles.includes(role))
      .map((line) => ({
        value: line.id,
        label: `Line ${line.number} · ${line.label}`,
        group: form.name,
        note: line.note,
      })),
  );
}

/** Problems a person can fix before a chart is sent, each pointing at the field that has it. */
export function validateChart(
  accounts: readonly ChartAccount[],
  messages: ChartMessages["editor"],
): ChartProblem[] {
  const problems: ChartProblem[] = [];
  if (accounts.length > MAX_ACCOUNTS)
    problems.push({ id: "chart-editor", message: messages.tooMany });
  const seen = new Map<string, string>();
  for (const account of accounts) {
    const code = account.code.trim();
    const codeId = `chart-code-${account.key}`;
    if (code === "")
      problems.push({ id: codeId, message: messages.codeMissing, short: messages.shortRequired });
    else if (!CODE_PATTERN.test(code))
      problems.push({
        id: codeId,
        message: messages.codeInvalid(code),
        short: messages.shortInvalid,
      });
    else if (seen.has(code.toLowerCase()))
      problems.push({
        id: codeId,
        message: messages.codeDuplicate(code),
        short: messages.shortDuplicate,
      });
    else seen.set(code.toLowerCase(), account.key);
    const label = code || messages.newAccount;
    const name = account.name.trim();
    if (name === "")
      problems.push({
        id: `chart-name-${account.key}`,
        message: messages.nameMissing(label),
        short: messages.shortRequired,
      });
    else if (account.name.length > MAX_NAME)
      problems.push({
        id: `chart-name-${account.key}`,
        message: messages.nameTooLong(label),
        short: messages.shortTooLong,
      });
  }
  if (!accounts.some((account) => account.role === "asset"))
    problems.push({ id: "chart-editor", message: messages.needAsset });
  return problems;
}

/** The `book.setup` input for a finished chart. A tag the person cleared is left out. */
export function toSetupDocument(
  choices: SetupChoices,
  accounts: readonly ChartAccount[],
): SetupDocument {
  return {
    name: choices.name.trim(),
    currency: choices.currency,
    fiscalYear: CALENDAR_FIRST_YEAR,
    fiscalYearStartMonth: choices.startMonth,
    booksStartOn: `${String(choices.firstYear).padStart(4, "0")}-${String(choices.startMonth).padStart(2, "0")}-01`,
    periodModel: choices.periodModel,
    basis: choices.basis,
    // In code order, so a line added last (a second card, a third bank) sits with its neighbours.
    accounts: [...accounts]
      .sort((a, b) => compareCodes(a.code.trim(), b.code.trim()))
      .map((account) => {
        const tags: {
          cashFlowClass?: NonNullable<ChartTags["cashFlowClass"]>;
          taxLine?: string;
          roleKey?: string;
          kind?: SlotKind;
        } = {};
        if (account.tags.cashFlowClass) tags.cashFlowClass = account.tags.cashFlowClass;
        if (account.tags.taxLine) tags.taxLine = account.tags.taxLine;
        if (account.tags.roleKey) tags.roleKey = account.tags.roleKey;
        if (account.tags.kind) tags.kind = account.tags.kind;
        return {
          code: account.code.trim(),
          name: account.name.trim(),
          role: account.role,
          ...(Object.keys(tags).length > 0 ? { tags } : {}),
        };
      }),
  };
}

/** Two charts for the same choices have the same key; a different key means rebuild. */
export const chartKey = (choices: SetupChoices, taxYear: number): string =>
  JSON.stringify([choices.templateId, choices.basis, taxYear, [...choices.addOns].sort()]);

/** The tax year to ask for: the book's first year, kept inside the years the catalog covers. */
export function clampTaxYear(year: number, covered: readonly number[]): number {
  const first = Math.min(...covered);
  const last = Math.max(...covered);
  return Math.min(Math.max(year, first), last);
}

/** "January 2026 to December 2026", "October 2026 to September 2027". */
export function fiscalYearSpan(
  firstYear: number,
  startMonth: number,
  locale = "en-US",
): { from: string; to: string } {
  const lastMonth = startMonth === 1 ? 12 : startMonth - 1;
  const lastYear = startMonth === 1 ? firstYear : firstYear + 1;
  return {
    from: `${monthName(startMonth, locale)} ${firstYear}`,
    to: `${monthName(lastMonth, locale)} ${lastYear}`,
  };
}

/** True for the account types that sit on the balance sheet; every other type is income or cost. */
export const isBalanceSheetType = (role: string): boolean =>
  (BALANCE_SHEET as readonly string[]).includes(role);

/** The accounts a person is looking for: every word of the search must appear somewhere in the
 * account's code, name, type, role key or tax line (and its name), ignoring case. `taxLineText`
 * turns a tax line id into the words shown for it, so a search for "advertising" finds line 8. An
 * empty search finds every account. */
export function searchAccounts(
  accounts: readonly AccountView[],
  query: string,
  taxLineText: (id: string) => string | undefined,
): AccountView[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...accounts];
  return accounts.filter((account) => {
    const haystack = [
      account.code,
      account.name,
      account.role,
      account.tags.roleKey,
      account.tags.taxLine,
      account.tags.taxLine ? taxLineText(account.tags.taxLine) : undefined,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** A real calendar date in `YYYY-MM-DD` form, checked without going through a time zone. */
export function isRealDate(value: string): boolean {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const length = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day <= length;
}

/** The closed periods a change from `effectiveOn` would reach: every period that ends on or after it. */
export function reachedPeriods(
  periods: readonly ClosedPeriod[],
  effectiveOn: string,
): ClosedPeriod[] {
  return isRealDate(effectiveOn) ? periods.filter((period) => period.endsOn >= effectiveOn) : [];
}

/** A role key as the service accepts it: lower-case words joined by dots or hyphens. */
export const ROLE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
export const ROLE_KEY_MAX = 40;

/** The chart's five kinds, in the order a chart is read, and where each account type belongs. Gains and
 * losses are income for this purpose: they are where a statement puts them. */
export const CHART_GROUPS = ["asset", "liability", "equity", "income", "expense"] as const;
export type ChartGroupId = (typeof CHART_GROUPS)[number];

const GROUP_OF: Readonly<Record<string, ChartGroupId>> = {
  asset: "asset",
  liability: "liability",
  equity: "equity",
  income: "income",
  gain: "income",
  unrealizedGain: "income",
  expense: "expense",
};

/** The kind an account type is listed under. */
export const chartGroupOf = (role: string): ChartGroupId => GROUP_OF[role] ?? "asset";

const isZeroBalance = (balance: string): boolean => /^-?0+(\.0+)?$/.test(balance);

/** One kind of account as the folded chart shows it. */
export interface ChartGroup {
  readonly id: ChartGroupId;
  /** Every account of the kind that the search admits, in the order given. */
  readonly accounts: readonly AccountView[];
  /** The ones shown at rest: open accounts that hold something. */
  readonly holding: readonly AccountView[];
  /** The rest: accounts with a zero balance, and closed ones. Shown when asked for. */
  readonly rest: readonly AccountView[];
}

/** The chart, folded by kind. At rest a kind shows the accounts that hold something; the others (a zero
 * balance, or closed) are counted under it and shown when asked. A kind with no account is left out. */
export function groupAccounts(accounts: readonly AccountView[]): ChartGroup[] {
  return CHART_GROUPS.flatMap((id) => {
    const own = accounts.filter((account) => chartGroupOf(account.role) === id);
    if (own.length === 0) return [];
    const holding = own.filter(
      (account) => account.closedOn === null && !isZeroBalance(account.balance),
    );
    return [
      { id, accounts: own, holding, rest: own.filter((account) => !holding.includes(account)) },
    ];
  });
}

/** The kinds that are open when the page is first seen: income and expenses, when they hold something.
 * They are what a person categorizes to every day; what is owned and owed is in the bank and card rows
 * above the chart, and opens when asked. */
export const openAtRest = (groups: readonly ChartGroup[]): ChartGroupId[] =>
  groups
    .filter(
      (group) => (group.id === "income" || group.id === "expense") && group.holding.length > 0,
    )
    .map((group) => group.id);
