import { afterEach, expect, test } from "bun:test";
import { learnCapabilities } from "../../src/capabilities";
import { closingTarget, type HomeFacts } from "../../src/routes/home-facts";
import { MAX_ROWS, needsYou } from "../../src/routes/home-needs";
import { shown } from "../support/shown";
import {
  backup,
  changesList,
  checklist,
  failed,
  homeFacts,
  inbox,
  NOW,
  ok,
  period,
  periods,
  verified,
} from "../support/home-facts";

afterEach(() => learnCapabilities(null));

const rows = (facts: HomeFacts) => needsYou(facts).rows;
const ids = (facts: HomeFacts) => rows(facts).map((row) => row.id);

/** The first of the book's months to close: ended, open, and the checklist's say-so. */
const closing = (state: "ready" | "not_yet", blocking = 0, attention = 0) =>
  checklist({
    verdict: {
      state,
      summary: "",
      blocking: Array.from({ length: blocking }, (_, index) => ({ code: `b${index}` })),
      attention: Array.from({ length: attention }, (_, index) => ({ code: `a${index}` })),
    },
  });
const march = { id: "period-03", name: "March 2026", ended: true };

test("where the service keeps the backups itself, a backup that could not be read is not a check that failed", () => {
  const unreadable = homeFacts({ backup: failed("Backups are kept by the platform.") });
  // A service that makes backups says it could not check them.
  expect(needsYou(unreadable).unread).toBe("Backups could not be checked.");
  // One that keeps them itself has nothing to ask.
  learnCapabilities({
    accounts: true,
    connections: false,
    banks: false,
    stripeApp: false,
    billing: false,
    agents: false,
    backups: false,
  });
  expect(needsYou(unreadable).unread).toBeNull();
  expect(needsYou(unreadable).rows).toEqual([]);
});

test("an established book with everything done has nothing that needs a person", () => {
  const needs = needsYou(homeFacts());
  expect(needs.rows).toEqual([]);
  expect(needs.total).toBe(0);
  expect(needs.unread).toBeNull();
  expect(needs.isNew).toBe(false);
});

test("transactions to review are one sentence and the verb Review", () => {
  const [row] = rows(homeFacts({ inbox: inbox({ toReview: 8, new: 8, total: 38 }, "2026-03-23") }));
  expect(row).toEqual({
    id: "review",
    tone: "attention",
    text: "8 transactions to review.",
    verb: "Review",
    href: "/inbox",
  });
  const [one] = rows(homeFacts({ inbox: inbox({ toReview: 1, new: 1, total: 31 }) }));
  expect(one?.text).toBe("1 transaction to review.");
});

test("transactions ready to post are said too, and when they are all there is the verb is Post", () => {
  const both = rows(
    homeFacts({ inbox: inbox({ toReview: 3, postable: 2, drafted: 2, total: 40 }) }),
  );
  expect(both[0]?.text).toBe("3 transactions to review. 2 ready to post.");
  expect(both[0]?.verb).toBe("Review");
  const only = rows(homeFacts({ inbox: inbox({ postable: 2, drafted: 2, total: 40 }) }));
  expect(only[0]?.text).toBe("2 transactions are ready to post.");
  expect(only[0]?.verb).toBe("Post");
});

test("what stands in the way of closing the month, and has no row of its own, is one row that opens Close the books", () => {
  const [row] = rows(homeFacts({ target: march, closing: closing("not_yet", 5) }));
  expect(row).toEqual({
    id: "close",
    tone: "attention",
    text: "5 things stand in the way of closing March 2026.",
    verb: "See what's left",
    href: "/periods",
  });
  expect(rows(homeFacts({ target: march, closing: closing("not_yet", 1) }))[0]?.text).toBe(
    "1 thing stands in the way of closing March 2026.",
  );
});

test("a month that can be closed says so in one sentence, and the verb names the month", () => {
  const [row] = rows(homeFacts({ target: march, closing: closing("ready", 0, 2) }));
  expect(row?.text).toBe("March 2026 is ready to close.");
  expect(row?.verb).toBe("Close March 2026");
  expect(row?.href).toBe("/periods");
});

test("a month that has not ended has no row: the only thing in its way is the date", () => {
  const october = { id: "period-10", name: "October 2026", ended: false };
  expect(ids(homeFacts({ target: october, closing: closing("not_yet", 1) }))).toEqual([]);
  // Nothing to close, or no month to ask about, is no row either.
  expect(ids(homeFacts({ target: march, closing: checklist() }))).toEqual([]);
  expect(ids(homeFacts({ target: null, closing: closing("not_yet", 3) }))).toEqual([]);
});

test("the month to close is the earliest ended month still open, never one before the books began", () => {
  const list = periods([
    period("period-01", "January", "2026-01-01", "2026-01-31", {
      status: "open",
      beforeBooks: true,
    }),
    period("period-02", "February", "2026-02-01", "2026-02-28", {
      status: "open",
      beforeBooks: true,
    }),
    period("period-03", "March", "2026-03-01", "2026-03-31", { status: "open" }),
    period("period-04", "April", "2026-04-01", "2026-04-30", { status: "open" }),
  ]);
  expect(closingTarget(list.ok ? list.value : (null as never), "2026-10-05")).toEqual({
    id: "period-03",
    name: "March 2026",
    ended: true,
    label: "March",
    endsOn: "2026-03-31",
  });
});

test("an ended month nothing was recorded in is not the month to close: a business that began in October is not asked about January", () => {
  const months = [
    period("period-07", "July", "2026-07-01", "2026-07-31", { status: "open", empty: true }),
    period("period-08", "August", "2026-08-01", "2026-08-31", { status: "open", empty: true }),
    period("period-09", "September", "2026-09-01", "2026-09-30", { status: "open" }),
    period("period-10", "October", "2026-10-01", "2026-10-31", { status: "open", ended: false }),
  ];
  const list = periods(months);
  expect(closingTarget(list.ok ? list.value : (null as never), "2026-10-05")?.id).toBe("period-09");
  // With nothing in any ended month, the month today falls in is the one, and it has not ended.
  const idle = periods(
    months.map((month) => (month.id === "period-09" ? { ...month, empty: true } : month)),
  );
  expect(closingTarget(idle.ok ? idle.value : (null as never), "2026-10-05")).toMatchObject({
    id: "period-10",
    ended: false,
  });
});

// ---- An account to reconcile, and the month that waits for the rows above ---------------------------

const marchTarget = { ...march, label: "March", endsOn: "2026-03-31" };
const account = (over: Record<string, unknown> = {}) => ({
  accountId: "a1",
  code: "1000",
  name: "Chase checking",
  hasActivity: true,
  throughPeriodEnd: false,
  unreconciled: null,
  ...over,
});
const waiting = (codes: readonly string[], accounts: readonly ReturnType<typeof account>[]) =>
  checklist({
    verdict: {
      state: "not_yet",
      summary: "",
      blocking: codes.map((code) => ({ code })),
      attention: [],
    },
    accounts,
  });

test("an account whose month has ended and whose transactions are decided is ready to check against its statement", () => {
  const facts = homeFacts({
    target: marchTarget,
    closing: waiting(["never_reconciled"], [account()]),
  });
  expect(rows(facts)).toEqual([
    {
      id: "reconcile",
      tone: "attention",
      text: "Chase checking is ready to check against its March statement.",
      verb: "Reconcile",
      href: "/reconcile?account=a1",
    },
  ]);
  // The month is not named a second time: the row is what stands in its way.
  expect(ids(facts)).not.toContain("close");
});

test("several accounts to reconcile are counted in one row; an account with nothing in it, or reconciled through the month, is not one", () => {
  const facts = homeFacts({
    target: marchTarget,
    closing: waiting(
      ["never_reconciled", "not_through_period"],
      [
        account(),
        account({ accountId: "a2", name: "Chase Ink card" }),
        account({ accountId: "a3", name: "Savings", hasActivity: false }),
        account({ accountId: "a4", name: "Petty cash", throughPeriodEnd: true }),
      ],
    ),
  });
  expect(rows(facts)[0]).toMatchObject({
    id: "reconcile",
    text: "2 accounts are ready to check against their March statements.",
    href: "/reconcile",
  });
});

test("an account with transactions still to decide is not asked to reconcile yet: reviewing them is the step", () => {
  const facts = homeFacts({
    inbox: inbox({ toReview: 4, new: 4, total: 12 }),
    target: marchTarget,
    closing: waiting(
      ["never_reconciled", "inbox_waiting"],
      [account({ unreconciled: { count: 4, oldestOn: "2026-03-02" } })],
    ),
  });
  expect(ids(facts)).toEqual(["review"]);
});

test("a period that is not a month is named by the day it ends", () => {
  const base = homeFacts();
  const facts = homeFacts({
    setup: { ...base.setup, periodModel: "quarterly" } as never,
    target: { id: "q1", name: "Q1 2026", ended: true, label: "Q1", endsOn: "2026-03-31" },
    closing: waiting(["never_reconciled"], [account()]),
  });
  expect(rows(facts)[0]?.text).toBe(
    `Chase checking is ready to reconcile through ${shown.date("2026-03-31")}.`,
  );
});

test("a month that has not ended asks for no reconciliation, and a role that cannot close is not asked", () => {
  const closing = waiting(["never_reconciled"], [account()]);
  expect(ids(homeFacts({ target: { ...marchTarget, ended: false }, closing }))).toEqual([]);
  expect(ids(homeFacts({ role: "member", target: marchTarget, closing }))).toEqual([]);
});

test("the month is named for what no row says: one thing left beside the account to reconcile", () => {
  const facts = homeFacts({
    target: marchTarget,
    closing: waiting(["never_reconciled", "opening_not_posted"], [account()]),
  });
  expect(ids(facts)).toEqual(["reconcile", "close"]);
  expect(rows(facts)[1]?.text).toBe("1 thing stands in the way of closing March 2026.");
});

test("when every ended month is closed the month today falls in is asked about, and it has not ended", () => {
  const list = periods([
    period("period-09", "September", "2026-09-01", "2026-09-30", { status: "closed" }),
    period("period-10", "October", "2026-10-01", "2026-10-31", { status: "open", ended: false }),
  ]);
  expect(closingTarget(list.ok ? list.value : (null as never), "2026-10-05")).toEqual({
    id: "period-10",
    name: "October 2026",
    ended: false,
    label: "October",
    endsOn: "2026-10-31",
  });
  // A month whose close was superseded needs closing again.
  const again = periods([
    period("period-09", "September", "2026-09-01", "2026-09-30", {
      status: "closed",
      closeSuperseded: true,
    }),
  ]);
  expect(closingTarget(again.ok ? again.value : (null as never), "2026-10-05")?.id).toBe(
    "period-09",
  );
  const none = periods([period("period-09", "September", "2026-09-01", "2026-09-30")]);
  expect(closingTarget(none.ok ? none.value : (null as never), "2026-10-05")).toBeNull();
});

test("a book that has never been backed up says so, once there is something to protect", () => {
  const never = backup({
    latest: null,
    latestVerified: null,
    backupCount: 0,
    warnings: [{ code: "never_backed_up", tone: "error", message: "x" }],
  });
  const [row] = rows(homeFacts({ backup: never }));
  expect(row).toEqual({
    id: "backup",
    tone: "attention",
    text: "Your books have never been backed up.",
    verb: "Back up now",
    href: "/settings/backups",
  });
});

test("a backup nobody has checked, a stale one and a failed one are three different sentences", () => {
  const notVerified = backup({
    latestVerified: null,
    warnings: [{ code: "never_verified", tone: "review", message: "x" }],
  });
  expect(rows(homeFacts({ backup: notVerified }))[0]?.text).toBe(
    "No backup of your books has been checked yet.",
  );
  const stale = backup({
    latestVerified: verified("2026-10-02T12:00:00Z"),
    warnings: [{ code: "stale_verification", tone: "review", message: "x" }],
  });
  const [staleRow] = rows(homeFacts({ backup: stale }));
  expect(staleRow?.text).toBe(
    `Your last checked backup was ${shown.age("2026-10-02T12:00:00Z", NOW)}.`,
  );
  expect(staleRow?.tone).toBe("attention");
  const broken = backup({
    warnings: [{ code: "verification_failed", tone: "error", message: "x" }],
  });
  const [brokenRow] = rows(homeFacts({ backup: broken }));
  expect(brokenRow?.text).toBe("Your newest backup did not pass its check.");
  expect(brokenRow?.tone).toBe("problem");
});

test("a backup setting or a note is not a need", () => {
  const notes = backup({
    warnings: [
      { code: "automatic_off", tone: "review", message: "x" },
      { code: "same_disk", tone: "info", message: "x" },
      { code: "scheduler_not_running", tone: "info", message: "x" },
    ],
  });
  expect(ids(homeFacts({ backup: notes }))).toEqual([]);
});

const stripe = (over: Record<string, unknown> = {}, payouts: Record<string, number> = {}) =>
  ok({
    configured: true,
    key: { present: true },
    lastSync: {
      id: "s",
      startedAt: "2026-10-05T10:00:00Z",
      finishedAt: "2026-10-05T10:01:00Z",
      disposition: "complete",
      payouts: 6,
    },
    payouts: {
      known: 6,
      booked: 6,
      waiting: 0,
      mismatched: 0,
      held: 0,
      reversed: 0,
      unmatched: 0,
      overdue: 0,
      oldestOverdueOn: null,
      ...payouts,
    },
    ...over,
  } as never);

test("Stripe is a need only when something is wrong: a failed sync, payouts that do not add up, or a deposit that is overdue", () => {
  expect(ids(homeFacts({ stripe: stripe() }))).toEqual([]);
  const failedSync = stripe({
    lastSync: {
      id: "s",
      startedAt: "2026-10-05T10:00:00Z",
      finishedAt: null,
      disposition: "failed",
      payouts: 0,
    },
  });
  expect(rows(homeFacts({ stripe: failedSync }))[0]).toMatchObject({
    tone: "problem",
    text: "The last Stripe sync did not finish.",
    verb: "Check Stripe",
    href: "/settings/stripe",
  });
  expect(rows(homeFacts({ stripe: stripe({}, { mismatched: 2 }) }))[0]?.text).toBe(
    "2 Stripe payouts do not add up.",
  );
  expect(rows(homeFacts({ stripe: stripe({}, { mismatched: 1 }) }))[0]?.text).toBe(
    "1 Stripe payout does not add up.",
  );
  expect(rows(homeFacts({ stripe: stripe({}, { unmatched: 3, overdue: 1 }) }))[0]).toMatchObject({
    tone: "attention",
    text: "1 Stripe payout has no matching bank deposit.",
  });
});

test("a recent payout with no deposit yet, a payout held, and Stripe not set up are not needs", () => {
  expect(ids(homeFacts({ stripe: stripe({}, { unmatched: 4, waiting: 1, held: 2 }) }))).toEqual([]);
  expect(ids(homeFacts({ stripe: ok({ configured: false } as never) }))).toEqual([]);
  expect(
    ids(
      homeFacts({
        stripe: ok({
          configured: true,
          key: { present: false },
          lastSync: null,
          payouts: { mismatched: 3 },
        } as never),
      }),
    ),
  ).toEqual([]);
});

test("a bank connection that needs its owner is a need; a connection that is simply quiet is not", () => {
  const feed = (over: Record<string, unknown> = {}) =>
    ok({
      connected: true,
      linked: 2,
      unlinked: 0,
      attention: [],
      requests: { pausedUntil: null },
      lastSync: {
        id: "r",
        startedAt: "2026-10-05T10:00:00Z",
        finishedAt: "2026-10-05T10:01:00Z",
        disposition: "complete",
        newLines: 3,
      },
      ...over,
    } as never);
  expect(ids(homeFacts({ bankfeed: feed() }))).toEqual([]);
  expect(ids(homeFacts({ bankfeed: ok({ connected: false } as never) }))).toEqual([]);
  const attention = feed({
    attention: [{ code: "access_refused", severity: "error", message: "x" }],
  });
  expect(rows(homeFacts({ bankfeed: attention }))[0]).toEqual({
    id: "bankfeed",
    tone: "attention",
    text: "Your bank connection needs attention.",
    verb: "Fix it",
    href: "/settings/bankfeed",
  });
  const info = feed({ attention: [{ code: "unlinked", severity: "info", message: "x" }] });
  expect(ids(homeFacts({ bankfeed: info }))).toEqual([]);
  const failedRun = feed({
    lastSync: {
      id: "r",
      startedAt: "2026-10-05T10:00:00Z",
      finishedAt: null,
      disposition: "failed",
      newLines: 0,
    },
  });
  expect(rows(homeFacts({ bankfeed: failedRun }))[0]?.tone).toBe("problem");
});

test("a year that has ended and is not closed is a deadline, said only when no month is the thing to close", () => {
  const ended = periods([], {
    fiscalYears: [
      {
        fiscalYear: 2025,
        startsOn: "2025-01-01",
        endsOn: "2025-12-31",
        periodCount: 12,
        closedCount: 11,
        supersededCount: 0,
        status: "partlyClosed",
        ended: true,
        beforeBooks: false,
        periodsBeforeBooks: 0,
      },
    ],
  });
  expect(rows(homeFacts({ periods: ended }))[0]).toMatchObject({
    id: "year",
    text: "2025 has ended and is not closed.",
    verb: "Close 2025",
    href: "/periods?year=2025&flow=year-end",
  });
  expect(ids(homeFacts({ periods: ended, target: march, closing: closing("not_yet", 2) }))).toEqual(
    ["close"],
  );
  // A year that ended before the books began has nothing to close.
  const before = periods([], {
    fiscalYears: [
      {
        fiscalYear: 2024,
        startsOn: "2024-01-01",
        endsOn: "2024-12-31",
        periodCount: 12,
        closedCount: 0,
        supersededCount: 0,
        status: "open",
        ended: true,
        beforeBooks: true,
        periodsBeforeBooks: 12,
      },
    ],
  });
  expect(ids(homeFacts({ periods: before }))).toEqual([]);
});

test("an agent token that ends within two weeks is a deadline; one with time left, or revoked, is not", () => {
  const token = (expiresAt: string, status = "active") => ({ id: expiresAt, status, expiresAt });
  const soon = ok({
    tokens: [
      token("2026-10-10T00:00:00Z"),
      token("2026-12-30T00:00:00Z"),
      token("2026-10-06T00:00:00Z", "revoked"),
    ],
    ownerAccess: "open",
  } as never);
  expect(rows(homeFacts({ tokens: soon }))[0]).toEqual({
    id: "tokens",
    tone: "attention",
    text: "1 agent stops working within 14 days.",
    verb: "See agents",
    href: "/settings/agent",
  });
  const later = ok({ tokens: [token("2026-12-30T00:00:00Z")], ownerAccess: "open" } as never);
  expect(ids(homeFacts({ tokens: later }))).toEqual([]);
});

test("the rows run: what blocks closing first, then what is wrong, then what is coming due", () => {
  const facts = homeFacts({
    inbox: inbox({ toReview: 4, new: 4, total: 34 }, "2026-09-01"),
    target: march,
    closing: closing("not_yet", 3),
    stripe: stripe({}, { mismatched: 1 }),
    backup: backup({
      latestVerified: null,
      warnings: [{ code: "never_verified", tone: "review", message: "x" }],
    }),
    periods: periods([], { lastDate: "2026-10-20" }),
    tokens: ok({
      tokens: [{ id: "t", status: "active", expiresAt: "2026-10-08T00:00:00Z" }],
      ownerAccess: "open",
    } as never),
  });
  // Five things need a person, and all five are shown; a calendar about to run out is not one of them,
  // since a posting grows it itself.
  expect(ids(facts)).toEqual(["review", "close", "stripe", "backup", "tokens"]);
  expect(needsYou(facts).total).toBe(5);
});

test("a failure leads the problems, because it stays wrong until it is fixed", () => {
  const facts = homeFacts({
    backup: backup({
      latestVerified: null,
      warnings: [{ code: "never_verified", tone: "review", message: "x" }],
    }),
    stripe: stripe({}, { mismatched: 1 }),
  });
  expect(ids(facts)).toEqual(["stripe", "backup"]);
  const brokenBackup = homeFacts({
    backup: backup({ warnings: [{ code: "automatic_failed", tone: "error", message: "x" }] }),
    stripe: stripe({}, { unmatched: 2, overdue: 2 }),
  });
  expect(ids(brokenBackup)).toEqual(["backup", "stripe"]);
});

test("at most five rows are shown, and the rest are counted and said", () => {
  const facts = homeFacts({
    inbox: inbox({ toReview: 4, new: 4, total: 34 }),
    target: march,
    closing: closing("not_yet", 3),
    stripe: stripe({}, { mismatched: 1 }),
    bankfeed: ok({
      connected: true,
      linked: 1,
      unlinked: 0,
      attention: [{ code: "x", severity: "error", message: "x" }],
      requests: { pausedUntil: null },
      lastSync: null,
    } as never),
    backup: backup({
      latestVerified: null,
      warnings: [{ code: "never_verified", tone: "review", message: "x" }],
    }),
    periods: periods([], { lastDate: "2026-10-20" }),
    tokens: ok({
      tokens: [{ id: "t", status: "active", expiresAt: "2026-10-08T00:00:00Z" }],
      ownerAccess: "open",
    } as never),
  });
  const needs = needsYou(facts);
  expect(needs.rows).toHaveLength(MAX_ROWS);
  expect(needs.total).toBe(6);
  expect(needs.hidden).toBe(1);
  // What is left out is the last in order: the deadlines.
  expect(needs.rows.map((row) => row.id)).toEqual([
    "review",
    "close",
    "stripe",
    "bankfeed",
    "backup",
  ]);
});

test("a new book is not a list of warnings: no review, no month to close, no backup, nothing", () => {
  const fresh = homeFacts({
    inbox: inbox({ total: 0, posted: 0, excluded: 0 }),
    closing: checklist({ hasHistory: false, opening: { status: "none" } }),
    backup: backup({
      latest: null,
      latestVerified: null,
      backupCount: 0,
      warnings: [{ code: "never_backed_up", tone: "error", message: "x" }],
    }),
    target: march,
    periods: periods([], { lastDate: "2026-10-20" }),
  });
  const needs = needsYou(fresh);
  expect(needs.isNew).toBe(true);
  expect(needs.rows).toEqual([]);
  expect(needs.total).toBe(0);
});

test("what a person set up themselves can still fail or run out on a new book, and says so", () => {
  const fresh = homeFacts({
    inbox: inbox({ total: 0, posted: 0, excluded: 0 }),
    closing: checklist({ hasHistory: false, opening: { status: "none" } }),
    tokens: ok({
      tokens: [{ id: "t", status: "active", expiresAt: "2026-10-08T00:00:00Z" }],
      ownerAccess: "open",
    } as never),
    stripe: stripe({}, { mismatched: 1 }),
  });
  const needs = needsYou(fresh);
  expect(needs.isNew).toBe(true);
  expect(needs.rows.map((row) => row.id)).toEqual(["stripe", "tokens"]);
});

test("a book with an imported statement is not new, even before anything is posted", () => {
  const facts = homeFacts({
    inbox: inbox({ total: 12, new: 12, toReview: 12, posted: 0, excluded: 0 }),
    closing: checklist({ hasHistory: false, opening: { status: "none" } }),
  });
  expect(needsYou(facts).isNew).toBe(false);
  expect(ids(facts)).toEqual(["review"]);
});

test("a check that could not be read is named, and the rest are still shown; it is never read as all clear", () => {
  const needs = needsYou(homeFacts({ inbox: failed(), backup: failed() }));
  expect(needs.unread).toBe("Transactions to review and backups could not be checked.");
  const one = needsYou(homeFacts({ stripe: failed() }));
  expect(one.unread).toBe("Stripe could not be checked.");
  expect(needsYou(homeFacts()).unread).toBeNull();
});

test("a month to close whose checklist could not be read is named as that", () => {
  const needs = needsYou(homeFacts({ target: march, closing: failed() }));
  expect(needs.unread).toBe("What stands in the way of closing a month could not be checked.");
  // With no month to ask about, the checklist is not a check that failed.
  expect(needsYou(homeFacts({ target: null, closing: failed() })).unread).toBeNull();
});

test("a book that cannot be told apart from a new one (a read failed) is not called new", () => {
  const needs = needsYou(homeFacts({ inbox: failed() }));
  expect(needs.isNew).toBe(false);
});

// What others changed since the person looking last said they looked.
const owner = { kind: "owner", label: "owner" };
const weekly = { kind: "agent", label: "weekly-run", id: "tok_1" };
const accountant = { kind: "person", label: "accountant", id: "user_3" };
const unrecorded = { kind: "unknown", label: "not recorded" };
const service = { kind: "service", label: "control", id: "control" };
const made = (...makers: readonly (readonly [Record<string, unknown>, number])[]) =>
  changesList({
    count: makers.reduce((sum, [, count]) => sum + count, 0),
    actors: makers.map(([by, count]) => ({ by, count })),
  });

test("changes by an agent and another person since the last look are one line that names who made them", () => {
  const [row] = rows(homeFacts({ changes: made([weekly, 5], [accountant, 2]) }));
  expect(row).toEqual({
    id: "changes",
    tone: "info",
    text: "7 changes were made by others since you last looked: 5 by the agent weekly-run, 2 by an accountant.",
    verb: "Look at them",
    href: "/changes",
  });
  const one = rows(homeFacts({ changes: made([weekly, 1]) }))[0];
  expect(one?.text).toBe(
    "1 change was made by others since you last looked: 1 by the agent weekly-run.",
  );
  expect(one?.verb).toBe("Look at it");
});

test("a person's own changes are not a need, and neither are ones nobody can say who made", () => {
  // The owner looking made their own entries.
  expect(ids(homeFacts({ changes: made([owner, 4]) }))).toEqual([]);
  // The books did not record who made these, and the service put a person in the book for the owner.
  expect(ids(homeFacts({ changes: made([unrecorded, 9], [service, 1]) }))).toEqual([]);
  // The same changes are counted for someone they are not the changes of: an accountant looking.
  const forAccountant = changesList({
    caller: accountant,
    count: 6,
    actors: [
      { by: accountant, count: 4 },
      { by: owner, count: 2 },
    ],
  });
  expect(rows(homeFacts({ changes: forAccountant }))[0]?.text).toBe(
    "2 changes were made by others since you last looked: 2 by the owner.",
  );
});

test("only the first three makers are named, and the rest are counted", () => {
  const many = made(
    [weekly, 4],
    [{ kind: "agent", label: "helper", id: "tok_2" }, 3],
    [accountant, 2],
    [{ kind: "person", label: "admin", id: "user_2" }, 1],
    [{ kind: "agent", label: "other", id: "tok_3" }, 1],
  );
  expect(rows(homeFacts({ changes: many }))[0]?.text).toBe(
    "11 changes were made by others since you last looked: 4 by the agent weekly-run, 3 by the agent helper, 2 by an accountant, and 2 others.",
  );
});

test("it is said only to someone who can read all of the list, because only they can say they looked", () => {
  const partial = changesList({
    count: 3,
    actors: [{ by: weekly, count: 3 }],
    sources: [
      { name: "ledger", title: "The books", read: true, reason: null, changes: 3 },
      { name: "access", title: "Who has access", read: false, reason: "No.", changes: 0 },
    ],
  });
  expect(ids(homeFacts({ changes: partial }))).toEqual([]);
  // A part that is not this sign-in's to see (the agent keys are the owner's) is left out and said, not a
  // failure to read; the list is still not all there is, so the row stays away.
  const withheld = changesList({
    count: 3,
    actors: [{ by: weekly, count: 3 }],
    sources: [
      { name: "ledger", title: "The books", read: true, reason: null, changes: 3 },
      {
        name: "access",
        title: "Who has access",
        read: true,
        reason: null,
        withheld: "Changes to agent keys are shown to the owner.",
        changes: 1,
      },
    ],
  });
  expect(ids(homeFacts({ changes: withheld }))).toEqual([]);
  // That For review's explanation could not be read leaves every change in the list.
  const noWhy = changesList({
    count: 3,
    actors: [{ by: weekly, count: 3 }],
    sources: [
      { name: "ledger", title: "The books", read: true, reason: null, changes: 3 },
      { name: "review", title: "For review", read: false, reason: "No.", changes: 0 },
    ],
  });
  expect(ids(homeFacts({ changes: noWhy }))).toEqual(["changes"]);
});

test("a list that could not be read is said, never read as nothing having changed", () => {
  const needs = needsYou(homeFacts({ changes: failed("The service did not answer.") }));
  expect(needs.rows).toEqual([]);
  expect(needs.unread).toBe("What changed could not be checked.");
});

test("it comes after what is wrong and before what is coming due, and a new book has none", () => {
  const facts = homeFacts({
    changes: made([weekly, 2]),
    backup: backup({
      latestVerified: null,
      warnings: [{ code: "never_verified", tone: "review", message: "x" }],
    }),
    tokens: ok({
      tokens: [{ id: "t", status: "active", expiresAt: "2026-10-08T00:00:00Z" }],
      ownerAccess: "open",
    } as never),
  });
  expect(ids(facts)).toEqual(["backup", "changes", "tokens"]);
  const fresh = homeFacts({
    changes: made([weekly, 2]),
    inbox: inbox({ total: 0, posted: 0, excluded: 0 }),
    closing: checklist({ hasHistory: false }),
  });
  expect(needsYou(fresh).isNew).toBe(true);
  expect(ids(fresh)).toEqual([]);
});
