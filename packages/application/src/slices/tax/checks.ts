/** What a person should look at before relying on a year's figures: periods not yet closed, lines still
 * waiting in the Inbox, accounts not reconciled to the end of the year, accounts with no tax line, a
 * form that is only an IRS draft, a book that starts part-way through the year.
 *
 * These are observations about the books, not determinations about a return. Each check says what it
 * saw in plain words and where on screen to act, and a check that could not be made says "could not be
 * checked", never "ok". The Inbox and the reconciliations belong to other lanes, so they are read
 * through those lanes' own operations and never through their tables. */
import type { BookState } from "@rastrata/kernel";

import type {
  InboxPage,
  ReconcileStatus,
  TaxCheck,
  TaxSalesSummary,
  TaxVendors,
  TaxWorksheet,
} from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { labelsOf, type YearClose, yearClose } from "../../tax/close.ts";
import type { SliceContext } from "../types.ts";
import { callOperation } from "./operations.ts";

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** A read of another lane that may fail: its own refusal means "could not be checked". */
async function attempt<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApplicationError) return null;
    throw error;
  }
}

function periodsCheck(close: YearClose): TaxCheck {
  const ended = close.periods.filter((period) => period.ended);
  const open = ended.filter((period) => period.state === "open");
  const superseded = ended.filter((period) => period.state === "superseded");
  if (ended.length === 0)
    return {
      key: "periods",
      status: "ok",
      title: "Periods closed",
      detail: "No month in this range has ended yet.",
    };
  if (open.length === 0 && superseded.length === 0)
    return {
      key: "periods",
      status: "ok",
      title: "Periods closed",
      detail: `All ${ended.length} ${plural(ended.length, "period", "periods")} that have ended in this range ${plural(ended.length, "is", "are")} closed with a current close.${
        close.state === "closed" && close.last
          ? ` The last close, for ${close.last.label}, was recorded at book revision ${close.last.closingRevision}.`
          : ""
      }`,
    };
  const parts: string[] = [];
  if (open.length > 0)
    parts.push(
      `${open.length} of ${ended.length} ${plural(ended.length, "period that has", "periods that have")} ended in this range ${plural(open.length, "is", "are")} not closed (${labelsOf(open)}). A closed period cannot change by accident.`,
    );
  if (superseded.length > 0)
    parts.push(
      `${superseded.length} ${plural(superseded.length, "period is", "periods are")} locked but ${plural(superseded.length, "its close was", "their closes were")} superseded by a reopening (${labelsOf(superseded)}): ${plural(superseded.length, "it needs", "they need")} closing again before ${plural(superseded.length, "its close describes", "their closes describe")} the books.`,
    );
  return {
    key: "periods",
    status: "attention",
    title: "Periods closed",
    detail: parts.join(" "),
    href: "/periods",
    count: open.length + superseded.length,
  };
}

async function inboxCheck(context: SliceContext, from: string, to: string): Promise<TaxCheck> {
  const page = await attempt(() =>
    callOperation<InboxPage>(context, "inbox.list", {
      filter: { status: ["new", "proposed", "drafted"], covered: false, from, to },
      pageSize: 1,
    }),
  );
  if (!page)
    return {
      key: "inbox",
      status: "unknown",
      title: "Inbox lines",
      detail:
        "The Inbox could not be read, so it is not known whether lines dated in this range are still waiting.",
      href: "/inbox",
    };
  return page.count === 0
    ? {
        key: "inbox",
        status: "ok",
        title: "Inbox lines",
        detail: "No line dated in this range is waiting in the Inbox.",
      }
    : {
        key: "inbox",
        status: "attention",
        title: "Inbox lines",
        detail: `${page.count} ${plural(page.count, "line dated", "lines dated")} in this range ${plural(page.count, "is", "are")} still in the Inbox and not posted, so ${plural(page.count, "it is", "they are")} not in these figures.`,
        href: "/inbox",
        count: page.count,
      };
}

async function reconcileCheck(context: SliceContext, to: string, today: string): Promise<TaxCheck> {
  const status = await attempt(() =>
    callOperation<ReconcileStatus>(context, "reconcile.status", {}),
  );
  if (!status)
    return {
      key: "reconcile",
      status: "unknown",
      title: "Accounts reconciled",
      detail: "Reconciliations could not be read.",
      href: "/reconcile",
    };
  const tracked = status.accounts.filter((row) => row.tracked);
  if (tracked.length === 0)
    return {
      key: "reconcile",
      status: "attention",
      title: "Accounts reconciled",
      detail:
        "No bank or card account has been reconciled to a statement. A statement balance is the best evidence that a year's figures are complete.",
      href: "/reconcile",
    };
  const target = to <= today ? to : today;
  const behind = tracked.filter(
    (row) => row.lastReconciledDate === null || row.lastReconciledDate < target,
  );
  const describe = (row: (typeof tracked)[number]) =>
    `${row.account.name} ${row.lastReconciledDate === null ? "has never been reconciled" : `is reconciled to ${row.lastReconciledDate}`}`;
  if (to > today)
    return {
      key: "reconcile",
      status: "ok",
      title: "Accounts reconciled",
      detail: `The year is not over. ${tracked.map(describe).join("; ")}.`,
    };
  return behind.length === 0
    ? {
        key: "reconcile",
        status: "ok",
        title: "Accounts reconciled",
        detail: `Every tracked account is reconciled to ${target} or later.`,
      }
    : {
        key: "reconcile",
        status: "attention",
        title: "Accounts reconciled",
        detail: `${behind.length} of ${tracked.length} ${plural(tracked.length, "account is", "accounts are")} not reconciled to ${target}: ${behind
          .slice(0, 4)
          .map(describe)
          .join("; ")}${behind.length > 4 ? "; and more" : ""}.`,
        href: "/reconcile",
        count: behind.length,
      };
}

/** The 1099 vendor list, as a check: whether the accounts that hold such payments have been marked,
 * and what is left to decide for vendors at or over the threshold. */
function vendorsCheck(vendors: TaxVendors): TaxCheck {
  const href = "/tax?tab=vendors";
  if (!vendors.accounts.some((account) => account.marked))
    return {
      key: "vendors",
      status: "unknown",
      title: "1099 vendors",
      detail:
        "No account is marked as holding payments that may need a 1099, so this could not be checked. If you paid contractors, lawyers or landlords during the year, mark the accounts that hold those payments.",
      href,
    };
  const unassigned = vendors.payees.filter(
    (payee) =>
      BigInt(payee.counted.replace(".", "")) >= BigInt(vendors.threshold.amount.replace(".", "")),
  ).length;
  const problems: string[] = [];
  if (vendors.needW9 > 0)
    problems.push(`${vendors.needW9} ${plural(vendors.needW9, "has", "have")} no W-9 on file`);
  if (vendors.undecided > 0)
    problems.push(`${vendors.undecided} ${plural(vendors.undecided, "is", "are")} not decided`);
  if (unassigned > 0)
    problems.push(
      `${unassigned} ${plural(unassigned, "payee", "payees")} paid ${vendors.threshold.amount} or more ${plural(unassigned, "is", "are")} not on the vendor list`,
    );
  if (problems.length === 0)
    return {
      key: "vendors",
      status: "ok",
      title: "1099 vendors",
      detail: `${vendors.overThreshold} ${plural(vendors.overThreshold, "vendor is", "vendors are")} at or over the ${vendors.threshold.amount} threshold, and each has a decision and a W-9.`,
    };
  return {
    key: "vendors",
    status: "attention",
    title: "1099 vendors",
    detail: `${vendors.overThreshold} ${plural(vendors.overThreshold, "vendor is", "vendors are")} at or over the ${vendors.threshold.amount} threshold: ${problems.join("; ")}.`,
    href,
  };
}

/** The sales tax account, as a check: whether one is tagged, and whether it and Stripe agree. A book
 * with no tagged account is "could not be checked", never "ok": Rastrata cannot tell whether the
 * business collects sales tax. */
function salesCheck(sales: TaxSalesSummary): TaxCheck {
  const href = "/tax?tab=sales";
  if (sales.accounts.length === 0)
    return {
      key: "sales",
      status: "unknown",
      title: "Sales tax",
      detail:
        "No liability account is tagged tax.sales, so sales tax could not be checked. If you collect sales tax, tag the account that holds it in your chart of accounts. If you do not, there is nothing to do.",
      href: "/accounts",
    };
  const codes = new Set(sales.warnings.map((warning) => warning.code));
  const problems: string[] = [];
  if (codes.has("stripe_differs"))
    problems.push(
      "the account took a different amount from Stripe payouts than Stripe reported on them",
    );
  if (codes.has("negative_balance"))
    problems.push("the account shows more tax paid or returned than collected");
  const missing = sales.stripe.taxNotReported ?? 0;
  if (missing > 0)
    problems.push(
      `${missing} Stripe ${plural(missing, "charge has", "charges have")} no tax figure from Stripe`,
    );
  const figures = `The sales tax account collected ${sales.collected} and paid or returned ${sales.remitted} in this range and holds ${sales.closing} at the end.`;
  return problems.length === 0
    ? {
        key: "sales",
        status: "ok",
        title: "Sales tax",
        detail: `${figures} Rastrata does not know your rates or filing dates.`,
        href,
      }
    : {
        key: "sales",
        status: "attention",
        title: "Sales tax",
        detail: `${figures} Look at this: ${problems.join("; ")}. Rastrata does not know your rates or filing dates.`,
        href,
      };
}

export async function taxChecks(
  context: SliceContext,
  input: {
    readonly state: BookState;
    readonly worksheet: TaxWorksheet;
    readonly today: string;
    readonly booksStartOn: string | null;
    /** The year's 1099 vendor list, when it has been read. */
    readonly vendors?: TaxVendors | undefined;
    /** The year's sales-tax summary, when it has been read. */
    readonly sales?: TaxSalesSummary | undefined;
  },
): Promise<TaxCheck[]> {
  const { state, worksheet, today } = input;
  const checks: TaxCheck[] = [
    periodsCheck(yearClose(state, worksheet.from, worksheet.to, today)),
    await inboxCheck(context, worksheet.from, worksheet.to),
    await reconcileCheck(context, worksheet.to, today),
  ];
  const accounts = new Set(worksheet.unmapped.map((row) => row.accountId)).size;
  checks.push(
    accounts === 0
      ? {
          key: "unmapped",
          status: "ok",
          title: "Tax lines",
          detail: `Every income and expense account with activity has a line on ${worksheet.form.name}.`,
        }
      : {
          key: "unmapped",
          status: "attention",
          title: "Tax lines",
          detail: `${accounts} ${plural(accounts, "account has", "accounts have")} activity and no line from ${worksheet.form.name} (income ${worksheet.unmappedIncome}, expenses ${worksheet.unmappedExpenses}). They are listed as not mapped on the worksheet.`,
          href: "/accounts",
          count: accounts,
        },
  );
  if (input.vendors) checks.push(vendorsCheck(input.vendors));
  if (input.sales) checks.push(salesCheck(input.sales));
  if (worksheet.form.status === "draft")
    checks.push({
      key: "draft",
      status: "attention",
      title: "Form status",
      detail: `The ${worksheet.taxYear} ${worksheet.form.name} is an IRS early-release draft. Confirm the line numbers against the final form.`,
    });
  if (input.booksStartOn && input.booksStartOn > worksheet.from)
    checks.push({
      key: "books_start",
      status: "attention",
      title: "Start of the books",
      detail: `The books start on ${input.booksStartOn}. Activity from ${worksheet.from} until then is in your earlier system, not here.`,
    });
  if (worksheet.to > today)
    checks.push({
      key: "year_not_ended",
      status: "attention",
      title: "Year not over",
      detail: `The range ends on ${worksheet.to}, after today (${today}). These are the figures so far.`,
    });
  return checks;
}
