/** "Needs you": what a person has to do, and nothing else. At most five rows, each one sentence and one
 * verb, in this order: what stands between you and closing the month, then what is wrong, then what is
 * coming due. The first row is the next step, so a book that is still being set up has no list of steps
 * beside this one: transactions to review, then an account to check against its statement, then the
 * month to close. A count, a setting or a fact is not a need, so rules, the last import, the feed's
 * state, Stripe's settings, Cutover and Periods are not here (the tiles and Settings carry them). A new
 * book has nothing to check yet and gets no warnings. A read that failed is said, never read as "all
 * clear". Pure: the facts go in, the rows come out. */
import { isCaller, makerName } from "@rastrata/ui/changes/logic";
import type { NeedRowView } from "@rastrata/ui/home-types";
import { homeWords } from "@rastrata/ui/home-words";
import { formatAge, formatDate } from "@rastrata/ui/format";
import { capabilities } from "../capabilities";
import { may } from "../role";
import { cardSummary as bankfeedSummary } from "./bankfeed/controller";
import { yearEndHref } from "./calendar/location";
import type { HomeFacts, Read } from "./home-facts";
import { cardSummary as stripeSummary } from "./stripe/controller";

/** Five rows is what fits beside the chart without a scroll, and what a person will read. */
export const MAX_ROWS = 5;
/** How many days ahead a deadline is said (an ending calendar, an expiring token). */
export const TOKEN_WARNING_DAYS = 14;

type Kind = "close" | "problem" | "look" | "deadline";
const KIND_RANK: Readonly<Record<Kind, number>> = { close: 0, problem: 1, look: 2, deadline: 3 };

/** How many makers are named in the line about changes; the rest are counted. */
export const CHANGES_NAMED = 3;

interface Candidate extends NeedRowView {
  readonly kind: Kind;
  /** Sorts within its kind: lower comes first. */
  readonly order: number;
}

export interface Needs {
  /** At most `MAX_ROWS`, in order. */
  readonly rows: readonly NeedRowView[];
  /** How many things need a person, shown or not. */
  readonly total: number;
  /** How many are not shown. */
  readonly hidden: number;
  /** What could not be checked, in words, or null when every check was read. */
  readonly unread: string | null;
  /** The book has nothing in it yet, so there is nothing to check. */
  readonly isNew: boolean;
}

/** A book is new until something has been posted or imported: nothing to review, close or back up. If
 * that cannot be told (a read failed), it is not called new. */
export function isNewBook(facts: Pick<HomeFacts, "inbox" | "closing">): boolean {
  return (
    facts.inbox.ok &&
    facts.closing.ok &&
    facts.inbox.value.counts.total === 0 &&
    !facts.closing.value.hasHistory
  );
}

function reviewRow(facts: HomeFacts): Candidate | null {
  if (!facts.inbox.ok) return null;
  const { counts } = facts.inbox.value;
  const ready = counts.postable ?? counts.drafted;
  if (counts.toReview === 0 && ready === 0) return null;
  const words = homeWords.needs.review;
  return {
    id: "review",
    kind: "close",
    order: 10,
    tone: "attention",
    text: words.text(counts.toReview, ready),
    verb: counts.toReview > 0 ? words.reviewVerb : words.postVerb,
    href: "/inbox",
  };
}

/** "Chase checking is ready to check against its October statement": once the month has ended, each
 * bank and card account with something in it is reconciled through the month's last day. An account is
 * named when that is the next thing to do for it: its transactions dated in the month are all decided
 * (until then the row about reviewing them is the step), and it is not reconciled that far yet. One
 * account is named and its row opens that account; several are counted. */
function reconcileRow(facts: HomeFacts): Candidate | null {
  const { target, closing } = facts;
  if (target === null || !target.ended || !closing.ok) return null;
  const ready = closing.value.accounts.filter(
    (account) =>
      account.hasActivity && !account.throughPeriodEnd && (account.unreconciled?.count ?? 0) === 0,
  );
  const [first] = ready;
  if (!first) return null;
  const words = homeWords.needs.reconcile;
  // A month is called by its name; a quarter or a year by the day it ends.
  const month =
    facts.setup.periodModel === "monthly" && target.label !== undefined ? target.label : null;
  const through = target.endsOn === undefined ? target.name : formatDate(target.endsOn);
  return {
    id: "reconcile",
    kind: "close",
    order: 15,
    tone: "attention",
    text:
      ready.length === 1
        ? words.one(first.name, month, through)
        : words.many(ready.length, month, through),
    verb: words.verb,
    href:
      ready.length === 1
        ? `/reconcile?account=${encodeURIComponent(first.accountId)}`
        : "/reconcile",
  };
}

/** What stands in the way of a month and already has a row of its own here: the row is the thing to do,
 * so the month is not named for it a second time. */
const SAID_BY: Readonly<Record<string, readonly string[]>> = {
  inbox_waiting: ["review"],
  // An account that is not reconciled through the month either still has transactions to decide, or
  // is ready to reconcile.
  never_reconciled: ["review", "reconcile"],
  not_through_period: ["review", "reconcile"],
  no_verified_backup: ["backup"],
  backup_too_old: ["backup"],
  drill_failed: ["backup"],
  stripe_differs: ["stripe"],
};

/** "October 2026 is ready to close": a month is named when it can be closed. While something stands in
 * its way, the rows above say what (transactions to review, an account to reconcile, a backup, Stripe),
 * and the month is named only for what none of them says, with the way to see it. A month that has not
 * ended has one thing in the way (the date), which is not something a person can do, so it gets no row. */
function closeRow(facts: HomeFacts, said: ReadonlySet<string>): Candidate | null {
  const { target, closing } = facts;
  if (target === null || !target.ended || !closing.ok) return null;
  const { verdict } = closing.value;
  const words = homeWords.needs.close;
  if (verdict.state === "not_yet") {
    const unsaid = verdict.blocking.filter(
      (reason) => !(SAID_BY[reason.code] ?? []).some((row) => said.has(row)),
    );
    if (unsaid.length === 0) return null;
    return {
      id: "close",
      kind: "close",
      order: 20,
      tone: "attention",
      text: words.blocked(unsaid.length, target.name),
      verb: words.blockedVerb,
      // Close the books says what is left for the month, each thing with its button.
      href: "/periods",
    };
  }
  if (verdict.state === "ready")
    return {
      id: "close",
      kind: "close",
      order: 20,
      tone: "attention",
      text: words.ready(target.name),
      verb: words.readyVerb(target.name),
      href: "/periods",
    };
  return null;
}

function backupRow(facts: HomeFacts): Candidate | null {
  if (!facts.backup.ok) return null;
  const status = facts.backup.value;
  const codes = new Set(status.warnings.map((warning) => warning.code));
  const words = homeWords.needs.backup;
  const row = (tone: "attention" | "problem", text: string, verb: string): Candidate => ({
    id: "backup",
    kind: "problem",
    order: 30,
    tone,
    text,
    verb,
    href: "/settings/backups",
  });
  if (
    ["verification_failed", "backup_file_missing", "automatic_failed", "drill_failed"].some(
      (code) => codes.has(code),
    )
  )
    return row("problem", words.failed, words.failedVerb);
  if (codes.has("never_backed_up")) return row("attention", words.never, words.neverVerb);
  if (codes.has("never_verified"))
    return row("attention", words.notVerified, words.notVerifiedVerb);
  const verified = status.latestVerified?.verification;
  if (codes.has("stale_verification") && verified)
    return row(
      "attention",
      words.stale(formatAge(verified.verifiedAt, facts.now)),
      words.staleVerb,
    );
  return null;
}

function stripeRow(facts: HomeFacts): Candidate | null {
  if (!facts.stripe.ok || !facts.stripe.value.configured) return null;
  const status = facts.stripe.value;
  const summary = stripeSummary(status);
  if (summary.stage !== "ready") return null;
  const words = homeWords.needs.stripe;
  const row = (tone: "attention" | "problem", text: string, verb: string): Candidate => ({
    id: "stripe",
    kind: "problem",
    order: 10,
    tone,
    text,
    verb,
    href: "/settings/stripe",
  });
  if (summary.lastSync?.ok === false) return row("problem", words.syncFailed, words.syncFailedVerb);
  if (summary.mismatched > 0)
    return row("problem", words.mismatched(summary.mismatched), words.mismatchedVerb);
  // A payout sent in the last day or two has no deposit yet, and that is normal; one whose deposit
  // should have arrived is a need. Payouts held for a person are in the review count already.
  if (status.payouts.overdue > 0)
    return row("attention", words.overdue(status.payouts.overdue), words.overdueVerb);
  return null;
}

function bankfeedRow(facts: HomeFacts): Candidate | null {
  if (!facts.bankfeed.ok || !facts.bankfeed.value.connected) return null;
  const summary = bankfeedSummary(facts.bankfeed.value, facts.now);
  const failed = summary.lastSync?.ok === false;
  if (summary.needsYou === 0 && !failed) return null;
  const words = homeWords.needs.bankfeed;
  return {
    id: "bankfeed",
    kind: "problem",
    order: 20,
    tone: failed ? "problem" : "attention",
    text: words.attention,
    verb: words.verb,
    href: "/settings/bankfeed",
  };
}

/** A fiscal year that has ended and is not closed. Its months come first (the "Close" row), so this is
 * said only when no month is. */
function yearRow(facts: HomeFacts, monthWaits: boolean): Candidate | null {
  if (monthWaits || !facts.periods.ok) return null;
  const year = facts.periods.value.calendar.fiscalYears.find(
    (row) => row.ended && row.status !== "closed" && !row.beforeBooks,
  );
  if (!year) return null;
  const words = homeWords.needs.year;
  return {
    id: "year",
    kind: "deadline",
    order: 20,
    tone: "attention",
    text: words.toClose(year.fiscalYear),
    verb: words.verb(year.fiscalYear),
    href: yearEndHref(year.fiscalYear),
  };
}

function tokenRow(facts: HomeFacts): Candidate | null {
  if (!facts.tokens.ok) return null;
  const limit = TOKEN_WARNING_DAYS * 86_400_000;
  const expiring = facts.tokens.value.tokens.filter(
    (token) =>
      token.status === "active" && Date.parse(token.expiresAt) - facts.now.getTime() <= limit,
  ).length;
  if (expiring === 0) return null;
  const words = homeWords.needs.tokens;
  return {
    id: "tokens",
    kind: "deadline",
    order: 30,
    tone: "attention",
    text: words.expiring(expiring, TOKEN_WARNING_DAYS),
    verb: words.verb,
    href: "/settings/agent",
  };
}

/** "7 changes were made by others since you last looked": what an agent or another person did that the
 * person looking has not said they looked at. Their own changes are not here (they made them), and neither
 * are changes whose maker the books did not record or that the service made on their behalf (putting a
 * person in the book): those are in the list on Changes. It is said only to someone who can read all of
 * the list, because only they can say they have looked at it. */
function changesRow(facts: HomeFacts): Candidate | null {
  if (!facts.changes.ok) return null;
  const list = facts.changes.value;
  // A source that could not be read, or a part of one that is not this sign-in's to see (the agent keys are
  // the owner's), means the list is not all there is: no row, since they could not say they looked.
  if (
    list.sources.some(
      (source) => (!source.read || (source.withheld ?? null) !== null) && source.name !== "review",
    )
  )
    return null;
  const others = list.actors.filter(
    (actor) =>
      (actor.by.kind === "agent" || actor.by.kind === "person" || actor.by.kind === "owner") &&
      !isCaller(actor.by, list.caller),
  );
  const total = others.reduce((sum, actor) => sum + actor.count, 0);
  if (total === 0) return null;
  const words = homeWords.needs.changes;
  const named = others
    .slice(0, CHANGES_NAMED)
    .map((actor) => words.by(actor.count, makerName(actor.by)));
  const rest = others.length - named.length;
  return {
    id: "changes",
    kind: "look",
    order: 10,
    tone: "info",
    text: words.text(total, rest > 0 ? [...named, words.more(rest)] : named),
    verb: words.verb(total),
    href: "/changes",
  };
}

/** The checks that could not be read, named. A check with nothing to ask (no month to close) is not
 * counted as unread, and neither is one this sign-in may not make: it is not theirs to check. */
function unreadChecks(facts: HomeFacts): string[] {
  const sources = homeWords.needs.sources;
  const failed: [Read<unknown>, string, boolean][] = [
    [facts.inbox, sources.inbox, true],
    [facts.closing, sources.checklist, facts.target !== null],
    [facts.backup, sources.backup, capabilities().backups],
    [facts.periods, sources.periods, true],
    [facts.stripe, sources.stripe, true],
    [facts.bankfeed, sources.bankfeed, true],
    [facts.banks, sources.bankfeed, true],
    [facts.tokens, sources.tokens, true],
    [facts.changes, sources.changes, true],
  ];
  // Two reads share a name (the bank connection is read in two places): it is said once.
  return [
    ...new Set(
      failed.flatMap(([read, name, asked]) => (asked && !read.ok && !read.denied ? [name] : [])),
    ),
  ];
}

/** The permission a row's verb needs, for the rows whose verb is a change to the books. */
const NEEDS: Readonly<Record<string, string>> = {
  review: "draft",
  reconcile: "close",
  close: "close",
  year: "close",
  backup: "configure",
  calendar: "configure",
};

export function needsYou(facts: HomeFacts): Needs {
  const isNew = isNewBook(facts);
  const unreadNames = unreadChecks(facts);
  const unread = unreadNames.length > 0 ? homeWords.needs.unread(unreadNames) : null;
  // What the month waits for, row by row; the month's own row then says only what none of them does.
  const steps = [
    reviewRow(facts),
    reconcileRow(facts),
    stripeRow(facts),
    bankfeedRow(facts),
    backupRow(facts),
  ];
  const close = closeRow(facts, new Set(steps.flatMap((row) => (row === null ? [] : [row.id]))));
  // The year is said only when no month is: one that can be closed, or one that waits for the rows above.
  const monthWaits =
    close !== null ||
    (facts.target?.ended === true &&
      facts.closing.ok &&
      facts.closing.value.verdict.state === "not_yet");
  // A new book has nothing to review, close or back up, and a calendar it has only just been given is
  // not a warning. What the person set up themselves (a Stripe or bank connection, an agent's token) can
  // still fail or run out, and says so.
  const candidates = (
    isNew
      ? [stripeRow(facts), bankfeedRow(facts), tokenRow(facts)]
      : [...steps, close, yearRow(facts, monthWaits), tokenRow(facts), changesRow(facts)]
  )
    .filter((row): row is Candidate => row !== null)
    // A thing only another role can do is not this person's to be asked for: a member is not sent to
    // close a month. What is wrong with a connection, or what others changed, is for anyone to see.
    .filter((row) => {
      const need = NEEDS[row.id];
      return need === undefined || may(facts.role, need);
    });
  const sorted = [...candidates].sort(
    (left, right) =>
      KIND_RANK[left.kind] - KIND_RANK[right.kind] ||
      // A failure leads its kind: it stays wrong until it is fixed, and a decision can wait a moment.
      Number(right.tone === "problem") - Number(left.tone === "problem") ||
      left.order - right.order,
  );
  const shown = sorted.slice(0, MAX_ROWS);
  return {
    rows: shown.map(({ id, tone, text, verb, href }) => ({ id, tone, text, verb, href })),
    total: sorted.length,
    hidden: sorted.length - shown.length,
    unread,
    isNew,
  };
}
