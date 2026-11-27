import type { BookState } from "@rastrata/kernel";

import type { AccountTagMap } from "../account-tags.ts";
import type {
  CashAccount,
  CashFlow,
  CashFlowLine,
  CashFlowSection,
  ReportWarning,
  StatementTotal,
} from "../client-contracts.gen.ts";
import { ApplicationError } from "../errors.ts";
import { formatMoney } from "../money.ts";
import { isProfitLossRole, type ChartAccount } from "./chart.ts";
import { compileColumn, reportContext, resolveRange, type Column } from "./columns.ts";
import { comparisonColumn, type ReportOptions } from "./core.ts";
import { type OpeningEffect, openingEffect } from "./opening-position.ts";
import { CASH_FLOW_VERSION, cashFlowPopulationHash } from "./population.ts";

const money = formatMoney;

type SectionKey = CashFlowSection["key"];
type Group = CashFlowLine["group"];

const SECTION_LABELS: Readonly<Record<SectionKey, string>> = {
  operating: "Operating activities",
  investing: "Investing activities",
  financing: "Financing activities",
  unclassified: "Not classified",
};
const SECTION_ORDER: readonly SectionKey[] = [
  "operating",
  "investing",
  "financing",
  "unclassified",
];

/** Pin the tags to a recorded revision, and say where they come from. The compiler is pure: the
 * handler reads the tag map from product state and passes it in. */
export interface CashFlowOptions extends ReportOptions {
  readonly tags: AccountTagMap;
}

/** One balance-sheet account's contribution to a column, in cents. */
interface Contribution {
  readonly section: SectionKey;
  readonly group: Group;
  readonly account: ChartAccount;
  /** The cash effect: positive brings cash in. It is the negative of the ledger-signed change of the
   * account, because every journal balances: what cash gained, the other accounts' debits gave up. */
  readonly cents: bigint;
}

interface CashFlowFigures {
  readonly netIncome: bigint;
  readonly contributions: readonly Contribution[];
  readonly cash: readonly {
    readonly account: ChartAccount;
    readonly opening: bigint;
    readonly closing: bigint;
  }[];
  readonly warnings: ReportWarning[];
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** Classify every balance-sheet account's change in one column.
 *
 * Because each journal balances, the changes of all accounts over a range sum to zero, so
 * `change in cash = net income - (the ledger-signed changes of every other balance-sheet account)`.
 * Each of those changes lands in exactly one section, by its tag, so the statement ties to the cash
 * accounts exactly, with no residual and no tolerance. An account whose tag is missing is shown as
 * Not classified (it must still be somewhere for the arithmetic to hold) and is warned about, never
 * guessed into a section.
 *
 * The opening entry is the position the books start from, not activity: its postings dated inside
 * the range (`opening`) are taken out of every change, so the cash at the start of the period holds
 * the opening cash, net income holds no opening profit and loss, and no line shows the opening
 * balances as financing. The identity above still holds, because the opening journals balance. */
function classify(
  accounts: readonly ChartAccount[],
  column: Column,
  tags: AccountTagMap,
  opening: ReadonlyMap<string, bigint>,
): CashFlowFigures {
  const { cumulative, range } = column.accumulated;
  const warnings: ReportWarning[] = [];
  const contributions: Contribution[] = [];
  const cash: { account: ChartAccount; opening: bigint; closing: bigint }[] = [];
  const ignored: ChartAccount[] = [];
  const notCash: ChartAccount[] = [];
  const untagged: ChartAccount[] = [];
  let netIncome = 0n;
  for (const account of accounts) {
    const change = (range.get(account.id) ?? 0n) - (opening.get(account.id) ?? 0n);
    const tag = tags.tagsFor(account.id, column.to).cashFlowClass;
    if (isProfitLossRole(account.role)) {
      // Net income already carries income and expense accounts, so a tag on one has no effect.
      netIncome -= change;
      if (tag !== undefined) ignored.push(account);
      continue;
    }
    const closing = cumulative.get(account.id) ?? 0n;
    if (tag === "cash") {
      if (account.role === "asset") {
        cash.push({ account, opening: closing - change, closing });
        continue;
      }
      notCash.push(account);
    }
    if (change === 0n) continue;
    let section: SectionKey;
    let group: Group = "account";
    if (tag === "operating") {
      section = "operating";
      group = "workingCapital";
    } else if (tag === "noncash") {
      section = "operating";
      group = "nonCash";
    } else if (tag === "investing") section = "investing";
    else if (tag === "financing") section = "financing";
    else {
      section = "unclassified";
      if (tag === undefined) untagged.push(account);
    }
    contributions.push({ section, group, account, cents: -change });
  }
  if (untagged.length > 0)
    warnings.push({
      code: "unclassified_accounts",
      message: `${untagged.length} ${plural(untagged.length, "account has", "accounts have")} activity in this range and no cash-flow tag (${untagged
        .slice(0, 5)
        .map((account) => `${account.code} ${account.name}`)
        .join(
          ", ",
        )}${untagged.length > 5 ? ", and more" : ""}). Their changes are shown under Not classified, not in operating, investing or financing, until they are tagged in your chart of accounts.`,
    });
  if (notCash.length > 0)
    warnings.push({
      code: "cash_tag_not_an_asset",
      message: `${notCash.map((account) => `${account.code} ${account.name}`).join(", ")} ${plural(notCash.length, "is", "are")} tagged cash but ${plural(notCash.length, "is", "are")} not an asset account, so ${plural(notCash.length, "it is", "they are")} treated as not classified.`,
    });
  if (ignored.length > 0)
    warnings.push({
      code: "tag_ignored",
      message: `${ignored.map((account) => `${account.code} ${account.name}`).join(", ")} ${plural(ignored.length, "carries", "carry")} a cash-flow tag, which has no effect: income and expense accounts are already in net income.`,
    });
  return { netIncome, contributions, cash, warnings };
}

/** Say so when the opening entry falls inside the range, so the cash at the start of the period is
 * not a puzzle: it holds the opening balances, which the statement reads as where the books start. */
function startingPosition(effect: OpeningEffect): ReportWarning[] {
  if (effect.dates.length === 0) return [];
  return [
    {
      code: "opening_position",
      message: `The opening balances dated ${effect.dates.join(", ")} are the position the books start from, so they are in the cash at the start of the period and in none of the activity below.`,
    },
  ];
}

const sectionTotal = (figures: CashFlowFigures, key: SectionKey): bigint =>
  figures.contributions.reduce(
    (sum, item) => (item.section === key ? sum + item.cents : sum),
    key === "operating" ? figures.netIncome : 0n,
  );

/** What a column is worth in cents: the figures every line and total of the statement are read from. */
function cashChange(figures: CashFlowFigures): bigint {
  return figures.cash.reduce((sum, item) => sum + (item.closing - item.opening), 0n);
}

function figure(current: bigint, previous?: bigint) {
  return previous === undefined
    ? { amount: money(current) }
    : { amount: money(current), comparative: money(previous), change: money(current - previous) };
}

const total = (key: string, label: string, current: bigint, previous?: bigint): StatementTotal => ({
  key,
  label,
  ...figure(current, previous),
});

/** The facts every cash-flow statement states, available or not. */
type CashFlowBase = Pick<
  CashFlow,
  | "compilerVersion"
  | "populationHash"
  | "ledgerPopulationHash"
  | "tagMapHash"
  | "tagsRevision"
  | "bookRevision"
  | "postingSequence"
  | "asOf"
  | "periodStart"
  | "currency"
  | "basis"
  | "fiscalYear"
>;

/** The statement when no account is tagged cash: there is nothing to tie it to, so nothing is shown
 * and the reason says what to do. */
function unavailable(base: CashFlowBase, warnings: ReportWarning[]): CashFlow {
  return {
    ...base,
    available: false,
    reason:
      "No account is tagged as cash, so there is nothing to tie the statement to. Tag your bank and cash accounts (cash-flow tag: cash) and every other balance-sheet account in your chart of accounts.",
    sections: [],
    cashAccounts: [],
    openingCash: null,
    netChange: null,
    closingCash: null,
    ties: null,
    totals: [],
    comparison: null,
    warnings,
  };
}

/** The indirect cash-flow statement for a range, tied to the accounts tagged cash.
 *
 * Net income comes from the profit and loss of the same range. Each balance-sheet account's change
 * goes to the section its tag names; an `operating` account is a working-capital change and a
 * `noncash` account is an add-back (both inside operating). Gains and losses on disposals stay inside
 * net income and the whole change of the asset sits in investing, as bookkeeping packages present
 * it; an accountant may present them differently, and nothing here is accounting or tax advice. */
export function compileCashFlow(
  state: BookState,
  asOf: string,
  options: CashFlowOptions,
): CashFlow {
  const context = reportContext(state, asOf, options.basis);
  const range = resolveRange(context, asOf, options.from);
  const current = compileColumn(context, range.from, asOf);
  const {
    column: previous,
    comparison,
    warnings: comparisonWarnings,
  } = comparisonColumn(context, options.compare, range.from, asOf);
  const { accounts } = context;
  const position = openingEffect(context, current);
  const figures = classify(accounts, current, options.tags, position.byAccount);
  const before =
    previous &&
    classify(accounts, previous, options.tags, openingEffect(context, previous).byAccount);
  const base: CashFlowBase = {
    compilerVersion: CASH_FLOW_VERSION,
    populationHash: cashFlowPopulationHash(current.populationHash, options.tags.hash),
    ledgerPopulationHash: current.populationHash,
    tagMapHash: options.tags.hash,
    tagsRevision: String(options.tags.revision),
    bookRevision: state.bookRevision.toString(),
    postingSequence: state.latestPostingSequence.toString(),
    asOf,
    periodStart: range.from,
    currency: state.identity.functionalCommodityId,
    basis: context.basis,
    fiscalYear: range.fiscalYear,
  };
  const warnings = [...figures.warnings, ...startingPosition(position), ...comparisonWarnings];
  if (figures.cash.length === 0) return unavailable(base, warnings);

  // Lines: the union of the accounts that moved in either column, in chart order.
  const order = new Map(accounts.map((account, index) => [account.id, index]));
  const lineKey = (item: Contribution) => `${item.section}:${item.account.id}`;
  const currentLines = new Map(figures.contributions.map((item) => [lineKey(item), item]));
  const previousLines = new Map((before?.contributions ?? []).map((item) => [lineKey(item), item]));
  const sections: CashFlowSection[] = [];
  for (const key of SECTION_ORDER) {
    const keys = [...new Set([...currentLines.keys(), ...previousLines.keys()])].filter((name) =>
      name.startsWith(`${key}:`),
    );
    const items = keys
      .map((name) => {
        const current = currentLines.get(name);
        const earlier = previousLines.get(name);
        return { item: (current ?? earlier) as Contribution, current, earlier };
      })
      .sort(
        (left, right) =>
          groupRank(left.item.group) - groupRank(right.item.group) ||
          (order.get(left.item.account.id) ?? 0) - (order.get(right.item.account.id) ?? 0),
      );
    const lines: CashFlowLine[] = [];
    if (key === "operating")
      lines.push({
        key: "netIncome",
        group: "netIncome",
        label: "Net income",
        code: null,
        accountId: null,
        ...figure(figures.netIncome, before?.netIncome),
      });
    for (const { item, current, earlier } of items)
      lines.push({
        key: item.account.id,
        group: item.group,
        label: item.account.name,
        code: item.account.code,
        accountId: item.account.id,
        ...figure(current?.cents ?? 0n, before ? (earlier?.cents ?? 0n) : undefined),
      });
    if (key === "unclassified" && lines.length === 0) continue;
    const sum = sectionTotal(figures, key);
    const earlierSum = before && sectionTotal(before, key);
    sections.push({
      key,
      label: SECTION_LABELS[key],
      lines,
      total: money(sum),
      ...(earlierSum === undefined
        ? {}
        : { comparative: money(earlierSum), change: money(sum - earlierSum) }),
    });
  }

  const cashAccounts: CashAccount[] = figures.cash.map(({ account, opening, closing }) => ({
    accountId: account.id,
    code: account.code,
    name: account.name,
    opening: money(opening),
    closing: money(closing),
    change: money(closing - opening),
  }));
  const opening = figures.cash.reduce((sum, item) => sum + item.opening, 0n);
  const closing = figures.cash.reduce((sum, item) => sum + item.closing, 0n);
  const netChange = cashChange(figures);
  const sectionsSum = SECTION_ORDER.reduce((sum, key) => sum + sectionTotal(figures, key), 0n);
  // Every journal balances, so this cannot differ; if it does the book or this compiler is wrong and
  // no figure is shown.
  if (sectionsSum !== netChange || closing - opening !== netChange)
    throw new ApplicationError(
      "report_does_not_tie",
      "The cash-flow statement does not tie to the cash accounts",
      500,
    );
  const beforeOpening = before?.cash.reduce((sum, item) => sum + item.opening, 0n);
  const beforeClosing = before?.cash.reduce((sum, item) => sum + item.closing, 0n);
  return {
    ...base,
    available: true,
    reason: null,
    sections,
    cashAccounts,
    openingCash: money(opening),
    netChange: money(netChange),
    closingCash: money(closing),
    ties: true,
    totals: [
      total("netChange", "Net change in cash", netChange, before && cashChange(before)),
      total("openingCash", "Cash at the start of the period", opening, beforeOpening),
      total("closingCash", "Cash at the end of the period", closing, beforeClosing),
    ],
    comparison,
    warnings,
  };
}

const groupRank = (group: Group): number =>
  group === "netIncome" ? 0 : group === "nonCash" ? 1 : group === "workingCapital" ? 2 : 3;
