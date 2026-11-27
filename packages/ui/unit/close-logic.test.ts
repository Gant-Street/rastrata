import { describe, expect, test } from "bun:test";
import type { PeriodView } from "../src/calendar/types";
import {
  closedMonths,
  closedThrough,
  closeLeft,
  closeLook,
  closeReady,
  closeTargets,
  closeThrough,
  monthRange,
  monthsToClose,
  type CloseLinks,
} from "../src/accounting/close-logic";
import type { ChecklistAccountView, ChecklistView } from "../src/shadow/types";
import { shown } from "../tests/support/shown";

const MONTHS = ["January", "February", "March", "April", "May", "June"] as const;
const endOf = [31, 28, 31, 30, 31, 30] as const;

/** Six months of 2026. `closed` and `before` say which are closed and which end before the books began;
 * `empty` which hold nothing, and `notEnded` which are still under way. */
function periods(
  options: {
    closed?: readonly number[];
    before?: readonly number[];
    superseded?: readonly number[];
    empty?: readonly number[];
    notEnded?: readonly number[];
  } = {},
): PeriodView[] {
  return MONTHS.map((label, index) => {
    const month = String(index + 1).padStart(2, "0");
    const closed =
      (options.closed ?? []).includes(index) || (options.superseded ?? []).includes(index);
    return {
      id: `period-${month}`,
      label,
      startsOn: `2026-${month}-01`,
      endsOn: `2026-${month}-${endOf[index]}`,
      status: closed ? "closed" : "open",
      closeSuperseded: (options.superseded ?? []).includes(index),
      ended: !(options.notEnded ?? []).includes(index),
      closingReportHref: null,
      closingRevision: null,
      supersedes: [],
      beforeBooks: (options.before ?? []).includes(index),
      empty: (options.empty ?? []).includes(index),
    } satisfies PeriodView;
  });
}

describe("how far the books are closed", () => {
  test("the end of the newest month in an unbroken run of closed months", () => {
    const result = closedThrough(periods({ closed: [0, 1, 2] }));
    expect(result).toEqual({ through: "2026-03-31", label: "March" });
  });

  test("a gap ends the run: April closed while March is open is not 'closed through April'", () => {
    expect(closedThrough(periods({ closed: [0, 1, 3] })).through).toBe("2026-02-28");
  });

  test("months before the books began are left out of the run, not counted as open", () => {
    // The books began in March: January and February hold nothing, March is closed.
    const result = closedThrough(periods({ before: [0, 1], closed: [2] }));
    expect(result.through).toBe("2026-03-31");
    // With nothing closed after them, nothing is closed.
    expect(closedThrough(periods({ before: [0, 1] })).through).toBeNull();
  });

  test("a close that no longer matches the books does not count", () => {
    expect(closedThrough(periods({ closed: [0], superseded: [1] })).through).toBe("2026-01-31");
  });

  test("nothing closed says so", () => {
    expect(closedThrough(periods())).toEqual({ through: null, label: null });
    expect(closedThrough([])).toEqual({ through: null, label: null });
  });
});

describe("which months are shown", () => {
  const today = "2026-04-18";
  test("the open months that have begun, in order, and none before the books began or still to come", () => {
    const list = periods({ before: [0, 1], closed: [2] });
    expect(monthsToClose(list, today).map((period) => period.label)).toEqual(["April"]);
    const all = periods({ before: [0, 1] });
    expect(monthsToClose(all, today).map((period) => period.label)).toEqual(["March", "April"]);
  });

  test("a month that has begun but not ended is listed", () => {
    expect(monthsToClose(periods({ closed: [0, 1, 2] }), "2026-04-02").map((p) => p.label)).toEqual(
      ["April"],
    );
  });

  test("closed months come newest first", () => {
    const list = periods({ before: [0, 1], closed: [2, 3] });
    expect(closedMonths(list).map((period) => period.label)).toEqual(["April", "March"]);
  });

  test("the card is about months that have ended and hold something: the earliest and the latest", () => {
    // January to March hold nothing, April and May do, June is under way.
    const list = periods({ empty: [0, 1, 2], notEnded: [5] });
    const { first, last } = closeTargets(list, "2026-06-20");
    expect(first?.label).toBe("April");
    expect(last?.label).toBe("May");
    // One month behind, they are the same month.
    const one = closeTargets(periods({ closed: [0, 1, 2, 3], notEnded: [5] }), "2026-06-20");
    expect(one.first?.label).toBe("May");
    expect(one.last?.label).toBe("May");
  });

  test("a month nothing was recorded in is never asked for, nor a month still under way", () => {
    // A business that began in June: nothing before it, and June has not ended.
    expect(closeTargets(periods({ empty: [0, 1, 2, 3, 4], notEnded: [5] }), "2026-06-20")).toEqual({
      first: null,
      last: null,
    });
    // Empty months after the last month that holds something are not the target either.
    const trailing = closeTargets(periods({ empty: [3, 4], notEnded: [5] }), "2026-06-20");
    expect(trailing.last?.label).toBe("March");
    // Nor months before the books began, or closed ones.
    expect(closeTargets(periods({ before: [0, 1], closed: [2, 3, 4, 5] }), today).first).toBeNull();
  });

  test("closing through a month closes every open month up to it, the empty ones among them", () => {
    const list = periods({ closed: [0], empty: [1, 2], notEnded: [5] });
    expect(closeThrough(list, "2026-06-20", "period-04").map((period) => period.label)).toEqual([
      "February",
      "March",
      "April",
    ]);
    expect(closeThrough(list, "2026-06-20", "period-05").map((period) => period.label)).toEqual([
      "February",
      "March",
      "April",
      "May",
    ]);
    // A month that is closed, or not in the book, closes nothing.
    expect(closeThrough(list, "2026-06-20", "period-01")).toEqual([]);
    expect(closeThrough(list, "2026-06-20", "nowhere")).toEqual([]);
  });

  test("a run of months is one phrase, with the year said once when it is the same", () => {
    expect(monthRange("February 2026", "November 2026")).toBe("February to November 2026");
    expect(monthRange("November 2026", "January 2027")).toBe("November 2026 to January 2027");
    expect(monthRange("Q2 2026", "Q4 2026")).toBe("Q2 to Q4 2026");
    expect(monthRange("February 2026", "February 2026")).toBe("February 2026");
  });
});

// ---- what is left for a month ------------------------------------------------------------------------

const account = (
  over: Partial<ChecklistAccountView> & { id: string; name: string },
): ChecklistAccountView => ({
  code: over.id,
  kind: "bank",
  status: "blocked",
  bookBalance: "100.00",
  last: null,
  throughPeriodEnd: false,
  draft: null,
  waiting: null,
  uncleared: { count: 0, total: "0.00", oldestOn: null },
  reasons: [],
  ...over,
});

function view(over: Partial<ChecklistView> = {}): ChecklistView {
  return {
    asOf: "2026-04-18",
    currency: "USD",
    cutover: { date: "2026-03-01", basis: "recorded" },
    opening: "posted",
    period: {
      id: "period-03",
      label: "March",
      startsOn: "2026-03-01",
      endsOn: "2026-03-31",
      status: "open",
      ended: true,
    },
    verdict: { state: "not_yet", summary: "", blocking: [], attention: [] },
    accounts: [],
    otherAccounts: [],
    stripe: null,
    inbox: { available: true, waiting: 0, oldestOn: null, toReview: 0 },
    backups: {
      available: true,
      reason: null,
      verifiedAt: "2026-04-10T12:00:00.000Z",
      ageHours: 24,
      limitHours: 48,
      drill: null,
    },
    openPeriods: [],
    shadowRun: null,
    unavailable: [],
    ...over,
  };
}

const links: CloseLinks = {
  reconcile: (id) => `/reconcile?account=${id}`,
  inbox: "/inbox",
  opening: "/opening",
  stripe: "/settings/stripe",
  backups: "/settings/backups",
};

const reason = (code: string, section: string, message: string, accountId?: string) => ({
  code,
  section: section as ChecklistView["verdict"]["blocking"][number]["section"],
  message,
  ...(accountId ? { accountId } : {}),
});

const notYet = (blocking: ChecklistView["verdict"]["blocking"]): ChecklistView["verdict"] => ({
  state: "not_yet",
  summary: "",
  blocking,
  attention: [],
});

describe("what is left before the books can be closed through a month", () => {
  test("one line for each thing the service says stands in the way, in the page's words, each with its one place", () => {
    const left = closeLeft(
      view({
        verdict: notYet([
          reason("not_through_period", "accounts", "1000 is reconciled through Mar 20.", "1000"),
          reason("never_reconciled", "accounts", "1010 has not been reconciled.", "1010"),
          reason("inbox_waiting", "inbox", "8 Inbox lines still need a decision."),
          reason("no_verified_backup", "backups", "No backup of your books has been verified."),
        ]),
        accounts: [
          account({
            id: "1000",
            name: "Business checking",
            last: { date: "2026-03-20", balance: "10.00" },
          }),
          account({ id: "1010", name: "Business savings" }),
          account({
            id: "2000",
            name: "Business credit card",
            status: "ready",
            throughPeriodEnd: true,
          }),
        ],
        inbox: { available: true, waiting: 8, oldestOn: "2026-03-23", toReview: 8 },
        backups: {
          available: true,
          reason: null,
          verifiedAt: null,
          ageHours: null,
          limitHours: 48,
          drill: null,
        },
      }),
      links,
    );
    // Transactions first (an account is reconciled once its transactions are decided), then the accounts.
    expect(left.map((line) => line.id)).toEqual([
      "review",
      "reconcile-1000",
      "reconcile-1010",
      "backup",
    ]);
    expect(left[0]).toEqual({
      id: "review",
      text: "8 transactions to review.",
      action: { label: "Review", href: "/inbox", name: "Review transactions" },
    });
    expect(left[1]).toEqual({
      id: "reconcile-1000",
      text: `Business checking is not reconciled through ${shown.date("2026-03-31")}.`,
      action: {
        label: "Reconcile",
        href: "/reconcile?account=1000",
        name: "Reconcile Business checking",
      },
    });
    expect(left[2]?.action).toMatchObject({ name: "Reconcile Business savings" });
    expect(left[3]).toEqual({
      id: "backup",
      text: "No backup of your books has been checked yet.",
      action: { label: "Back up now", href: "/settings/backups", name: "Back up now" },
    });
    // What is done is not listed: the card is only what a person still has to do.
    expect(left.some((line) => line.id === "reconcile-2000")).toBe(false);
  });

  test("the service's verdict alone says whether the month can close", () => {
    const ready = view({ verdict: { state: "ready", summary: "", blocking: [], attention: [] } });
    expect(closeReady(ready)).toBe(true);
    expect(closeLeft(ready, links)).toEqual([]);
    expect(closeReady(view({ verdict: notYet([reason("inbox_waiting", "inbox", "x")]) }))).toBe(
      false,
    );
  });

  test("a reason the page has no words for is said as the service says it, never left out", () => {
    const left = closeLeft(
      view({
        verdict: notYet([
          reason("section_unavailable", "stripe", "Stripe could not be reached."),
          reason("period_not_ended", "periods", "April ends on 2026-04-30."),
          reason("never_reconciled", "accounts", "9999 has not been reconciled.", "9999"),
        ]),
      }),
      links,
    );
    expect(left.map((line) => line.text)).toEqual([
      "Stripe could not be reached.",
      "April ends on 2026-04-30.",
      // An account the page was not given is still said.
      "9999 has not been reconciled.",
    ]);
    expect(left.every((line) => line.action === undefined)).toBe(true);
  });

  test("a reconciliation already in progress is where Reconcile goes", () => {
    const left = closeLeft(
      view({
        verdict: notYet([reason("never_reconciled", "accounts", "x", "1000")]),
        accounts: [
          account({
            id: "1000",
            name: "Business checking",
            draft: { href: "/reconcile/abc", statementDate: "2026-03-31", difference: "12.00" },
          }),
        ],
      }),
      links,
    );
    expect(left[0]?.action?.href).toBe("/reconcile/abc");
  });

  test("opening balances, Stripe and backups each have their line and their place", () => {
    const stripe: NonNullable<ChecklistView["stripe"]> = {
      status: "blocked",
      compared: true,
      ties: false,
      difference: "12.00",
      unpaid: null,
      inTransit: null,
      readAt: null,
      stale: false,
      explanation: "",
      payouts: { known: 3, booked: 1, waiting: 0, mismatched: 2, held: 0, unmatched: 0 },
      reasons: [],
    };
    const left = closeLeft(
      view({
        verdict: notYet([
          reason("backup_too_old", "backups", "The newest verified backup is 90 hours old."),
          reason("drill_failed", "backups", "The last restore drill failed."),
          reason("opening_not_posted", "opening", "The opening balances have not been posted."),
          reason("stripe_payouts_mismatched", "stripe", "2 Stripe payouts do not add up."),
          reason("stripe_differs", "stripe", "Stripe holds 12.00 that has not been imported."),
        ]),
        stripe,
      }),
      links,
    );
    expect(left.map((line) => [line.id, line.text, line.action?.label, line.action?.href])).toEqual(
      [
        [
          "stripe-payouts",
          "2 Stripe payouts do not add up.",
          "Look at payouts",
          "/settings/stripe",
        ],
        [
          "stripe",
          "Stripe holds money that is not in your books.",
          "Open Stripe",
          "/settings/stripe",
        ],
        ["opening", "Your opening balances are not posted.", "Post opening balances", "/opening"],
        [
          "backup",
          `Your last checked backup was on ${shown.date("2026-04-10")}.`,
          "Back up now",
          "/settings/backups",
        ],
        ["backup-drill", "The last restore drill failed.", "Open backups", "/settings/backups"],
      ],
    );
  });

  test("a line whose screen is not in this version has no link, rather than a link to nowhere", () => {
    const left = closeLeft(
      view({
        verdict: notYet([reason("inbox_waiting", "inbox", "x")]),
        inbox: { available: true, waiting: 2, oldestOn: null, toReview: 2 },
      }),
      { ...links, inbox: undefined },
    );
    expect(left[0]).toEqual({ id: "review", text: "2 transactions to review." });
  });

  test("what is worth a look and does not stand in the way is said as the service says it", () => {
    expect(
      closeLook(
        view({
          verdict: {
            state: "ready",
            summary: "",
            blocking: [],
            attention: [reason("drill_never_run", "backups", "A restore drill has not been run.")],
          },
        }),
      ),
    ).toEqual(["A restore drill has not been run."]);
  });
});
