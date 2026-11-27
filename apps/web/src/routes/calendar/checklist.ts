import type {
  CutoverChecklist,
  InboxSummary,
  ReconcileStatus,
  YearEndReview,
} from "@rastrata/application/client-contracts";
import type { ChecklistItem as YearEndChecklistItem } from "@rastrata/ui/calendar/types";
import { formatDate } from "@rastrata/ui/format";
import { listAccountLabel } from "@rastrata/ui/entries/display";

/** The year-end checklist. The books' own checks come with the review; reconciliation, the month-end
 * checklist and the Inbox belong to other parts of Rastrata and are read through their own
 * operations, so this screen states nothing about them that they have not said. A read that failed or
 * has not arrived is shown as exactly that: never as fine. */
export type Read<T> =
  | { readonly state: "loading" }
  | { readonly state: "failed" }
  | { readonly state: "ready"; readonly value: T };

export interface ChecklistInput {
  readonly review: Read<YearEndReview>;
  readonly reconcile: Read<ReconcileStatus>;
  readonly cutover: Read<CutoverChecklist>;
  readonly inbox: Read<InboxSummary>;
  /** The last day of the fiscal year being closed. */
  readonly endsOn: string;
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);
const MOST_NAMED = 4;

function unread(
  id: string,
  label: string,
  read: { readonly state: "loading" | "failed" },
  what: string,
): YearEndChecklistItem {
  return {
    id,
    label,
    detail: read.state === "loading" ? "" : `${what} could not be read.`,
    state: read.state === "loading" ? "loading" : "unavailable",
  };
}

function bookChecks(review: Read<YearEndReview>): YearEndChecklistItem[] {
  if (review.state !== "ready")
    return [unread("books", "The books' own checks", review, "The year's books")];
  return review.value.checks.map((check) => ({
    id: check.id,
    label: check.label,
    detail: check.detail,
    state: check.status === "pass" ? ("ready" as const) : ("attention" as const),
  }));
}

/** Tracked bank and card accounts with lines dated on or before the year's end that are not on a
 * reconciliation. A line dated after the year does not matter for closing it. */
function reconciliation(read: Read<ReconcileStatus>, endsOn: string): YearEndChecklistItem {
  const label = "Bank and card accounts are reconciled";
  if (read.state !== "ready") return unread("reconcile", label, read, "Reconciliation");
  const tracked = read.value.accounts.filter((account) => account.tracked);
  if (tracked.length === 0)
    return {
      id: "reconcile",
      label,
      detail:
        "No account is tracked for reconciliation yet, so nothing here shows the books agree with a bank or card statement.",
      state: "attention",
      href: "/reconcile",
      hrefLabel: "Open Reconcile",
    };
  const behind = tracked.filter(
    (account) =>
      account.unclearedCount > 0 &&
      account.oldestUnclearedDate !== null &&
      account.oldestUnclearedDate <= endsOn,
  );
  if (behind.length === 0)
    return {
      id: "reconcile",
      label,
      detail: `${tracked.length} tracked ${plural(tracked.length, "account has", "accounts have")} no transaction dated on or before ${formatDate(endsOn)} that is off a reconciliation.`,
      state: "ready",
      href: "/reconcile",
      hrefLabel: "Open Reconcile",
    };
  const named = behind
    .slice(0, MOST_NAMED)
    .map(
      (account) =>
        `${listAccountLabel(account.account.name, account.account.code)} has ${account.unclearedCount} ${plural(account.unclearedCount, "transaction", "transactions")}${account.oldestUnclearedDate ? `, the oldest dated ${formatDate(account.oldestUnclearedDate)}` : ""}`,
    )
    .join(". ");
  const more = behind.length - MOST_NAMED;
  return {
    id: "reconcile",
    label,
    detail: `${named}${more > 0 ? `. ${more} more ${plural(more, "account has", "accounts have")} transactions too` : ""}. Outstanding items are normal; unexpected ones are worth finding before the books are closed.`,
    state: "attention",
    href: "/reconcile",
    hrefLabel: "Open Reconcile",
  };
}

function monthEnd(read: Read<CutoverChecklist>, lastPeriodLabel: string): YearEndChecklistItem {
  const label = `The month-end checklist for ${lastPeriodLabel}`;
  if (read.state !== "ready") return unread("month-end", label, read, "The month-end checklist");
  const verdict = read.value.verdict;
  const reasons = verdict.blocking
    .slice(0, 3)
    .map((reason) => reason.message)
    .join(" ");
  return {
    id: "month-end",
    label,
    detail:
      verdict.state === "not_yet"
        ? `${verdict.summary}${reasons ? ` ${reasons}` : ""}`
        : verdict.summary,
    state: verdict.state === "not_yet" ? "attention" : "ready",
  };
}

function inbox(read: Read<InboxSummary>, endsOn: string): YearEndChecklistItem {
  const label = "Nothing from this year is waiting for review";
  if (read.state !== "ready")
    return unread("inbox", label, read, "The transactions waiting for review");
  const { counts, oldestToReviewOn } = read.value;
  const waiting = oldestToReviewOn !== null && oldestToReviewOn <= endsOn && counts.toReview > 0;
  return {
    id: "inbox",
    label,
    detail: waiting
      ? `${counts.toReview} imported ${plural(counts.toReview, "transaction is", "transactions are")} waiting to be reviewed, the oldest dated ${formatDate(oldestToReviewOn)}.`
      : counts.toReview > 0
        ? `${counts.toReview} imported ${plural(counts.toReview, "transaction is", "transactions are")} waiting, none dated in or before this year.`
        : "No imported transaction is waiting to be reviewed.",
    state: waiting ? "attention" : "ready",
    href: "/inbox",
    hrefLabel: "Open For review",
  };
}

export function buildChecklist(
  input: ChecklistInput & { readonly lastPeriodLabel: string },
): YearEndChecklistItem[] {
  return [
    ...bookChecks(input.review),
    reconciliation(input.reconcile, input.endsOn),
    monthEnd(input.cutover, input.lastPeriodLabel),
    inbox(input.inbox, input.endsOn),
  ];
}

/** Whether every line has been answered (nothing is still loading). */
export const checklistSettled = (items: readonly YearEndChecklistItem[]): boolean =>
  items.every((item) => item.state !== "loading");
