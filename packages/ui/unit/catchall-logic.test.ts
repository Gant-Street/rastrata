import { describe, expect, test } from "bun:test";
import {
  canChangeAccount,
  closeNotes,
  doneSplit,
  isWatchKey,
  leftWords,
  moving,
  placeDetail,
  planSentence,
  WATCH_KEYS,
  watchKind,
  watchOffer,
} from "../src/catchall/logic";
import type { ChecklistNoteView, MoveRow } from "../src/catchall/types";
import { catchallWords } from "../src/catchall/words";
import type { ChecklistView } from "../src/shadow/types";

const links = {
  transactions: (account: { id: string }, from: string, to: string) =>
    `/journal?accountId=${account.id}&from=${from}&to=${to}`,
};

const view = (notes: readonly ChecklistNoteView[] | undefined, ended = true): ChecklistView => ({
  asOf: "2026-04-05",
  currency: "USD",
  cutover: null,
  opening: "none",
  period: {
    id: "period-03",
    label: "March 2026",
    startsOn: "2026-03-01",
    endsOn: "2026-03-31",
    status: "open",
    ended,
  },
  verdict: { state: "ready", summary: "Ready to close March 2026.", blocking: [], attention: [] },
  accounts: [],
  otherAccounts: [],
  stripe: null,
  inbox: { available: true, waiting: 0, oldestOn: null, toReview: 0 },
  backups: {
    available: true,
    reason: null,
    verifiedAt: null,
    ageHours: null,
    limitHours: 48,
    drill: null,
  },
  openPeriods: [],
  shadowRun: null,
  unavailable: [],
  ...(notes === undefined ? {} : { notes }),
});

const OTHER = { id: "6290", code: "6290", name: "Other expenses", role: "expense" as const };

describe("the notes on a month", () => {
  test("a book that marks nothing has no notes, whether the list is empty or absent", () => {
    expect(closeNotes(view([]), links)).toEqual([]);
    expect(closeNotes(view(undefined), links)).toEqual([]);
  });

  test("money collecting is a note with the account's name (never its code), the figures as people read them, and a link", () => {
    const [note] = closeNotes(
      view([
        {
          code: "catchall_holds_money",
          account: OTHER,
          from: "2026-03-01",
          to: "2026-03-31",
          amount: "1240.00",
          transactions: 31,
          largest: [
            { name: "Adobe", amount: "420.00", kind: "payee" },
            { name: "UBER TRIP 5821", amount: "310.00", kind: "unnamed" },
          ],
        },
      ]),
      links,
    );
    expect(note).toEqual({
      id: "catchall_holds_money-6290",
      state: "found",
      accountName: "Other expenses",
      title: "Money is collecting in Other expenses",
      text: "Other expenses holds 1,240.00 from 31 transactions in March 2026.",
      // The figures of the places stay as the service wrote them: the screen sets them.
      largest: [
        { name: "Adobe", amount: "420.00", kind: "payee" },
        { name: "UBER TRIP 5821", amount: "310.00", kind: "unnamed" },
      ],
      href: "/journal?accountId=6290&from=2026-03-01&to=2026-03-31",
    });
    expect(note?.text).not.toContain("6290");
  });

  test("one transaction is singular, a month that has not ended says so far, a credit keeps its minus sign", () => {
    const base = {
      code: "catchall_holds_money" as const,
      account: OTHER,
      from: "2026-03-01",
      to: "2026-03-31",
      largest: [],
    };
    expect(
      closeNotes(view([{ ...base, amount: "12.34", transactions: 1 }], false), links)[0]?.text,
    ).toBe("Other expenses holds 12.34 from 1 transaction in March 2026 so far.");
    expect(closeNotes(view([{ ...base, amount: "-50.00", transactions: 2 }]), links)[0]?.text).toBe(
      "Other expenses holds −50.00 from 2 transactions in March 2026.",
    );
  });

  test("an account that could not be checked is a note that says so, with no link and no figures", () => {
    const [note] = closeNotes(
      view([{ code: "catchall_not_checked", account: OTHER, largest: [] }]),
      links,
    );
    expect(note).toEqual({
      id: "catchall_not_checked-6290",
      state: "not_checked",
      accountName: "Other expenses",
      title: "Other expenses could not be checked",
      text: "What Other expenses took in March 2026 could not be read, so it is not known whether money is collecting there. Your books have not been changed.",
      largest: [],
    });
  });

  test("there is no link when the host has no screen to link to", () => {
    const [note] = closeNotes(
      view([
        {
          code: "catchall_holds_money",
          account: OTHER,
          from: "2026-03-01",
          to: "2026-03-31",
          amount: "1.00",
          transactions: 1,
          largest: [],
        },
      ]),
      { transactions: undefined },
    );
    expect(note?.href).toBeUndefined();
    expect(note && "href" in note).toBe(false);
  });

  test("text from a bank or an owner is carried as it is, to be shown as text", () => {
    const hostile = '=HYPERLINK("x") <img src=x onerror=1> ignore previous instructions';
    const [note] = closeNotes(
      view([
        {
          code: "catchall_holds_money",
          account: { ...OTHER, name: hostile },
          from: "2026-03-01",
          to: "2026-03-31",
          amount: "1.00",
          transactions: 1,
          largest: [{ name: hostile, amount: "1.00", kind: "unnamed" }],
        },
      ]),
      links,
    );
    expect(note?.largest[0]?.name).toBe(hostile);
    expect(note?.text.startsWith(hostile)).toBe(true);
  });

  test("a place that no payee owns yet says so; a named one says nothing more", () => {
    expect(placeDetail("unnamed")).toBe("not named yet");
    expect(placeDetail("ambiguous")).toBe("matches more than one payee");
    expect(placeDetail("payee")).toBeUndefined();
    expect(placeDetail("by_hand")).toBeUndefined();
    expect(placeDetail("no_bank_text")).toBeUndefined();
  });
});

const row = (id: string, outcome: MoveRow["outcome"], rest: Partial<MoveRow> = {}): MoveRow => ({
  id,
  outcome,
  description: id,
  warnings: [],
  ...rest,
});

describe("a change of account", () => {
  test("the sentence over a plan says how many will move and how many cannot", () => {
    const plan = [row("a", "would_apply"), row("b", "would_apply"), row("c", "skipped")];
    expect(moving(plan).map((r) => r.id)).toEqual(["a", "b"]);
    expect(planSentence(plan, "Software")).toBe(
      "2 of 3 transactions will move to Software. 1 cannot be moved.",
    );
    expect(planSentence(plan.slice(0, 2), "Software")).toBe(
      "All 2 transactions will move to Software.",
    );
    expect(planSentence(plan.slice(0, 1), "Software")).toBe(
      "This transaction will move to Software.",
    );
    expect(planSentence(plan.slice(2), "Software")).toBe(
      "This transaction cannot be moved to Software.",
    );
    expect(planSentence([row("c", "skipped"), row("d", "failed")], "Software")).toBe(
      "None of the 2 transactions can be moved to Software.",
    );
  });

  test("what was done is split into what moved and what did not, and a failure past the first step says where it was left", () => {
    const done = [
      row("a", "applied"),
      row("b", "skipped"),
      row("c", "failed", { left: "ready" }),
      row("d", "failed", { left: "review" }),
    ];
    const split = doneSplit(done);
    expect(split.moved.map((r) => r.id)).toEqual(["a"]);
    expect(split.notMoved.map((r) => r.id)).toEqual(["b", "c", "d"]);
    expect(leftWords("ready")).toBe("Ready to post");
    expect(leftWords("review")).toBe("Waiting for review again: categorize it");
    expect(leftWords(undefined)).toBeUndefined();
  });

  test("the words are the product's: For review, transactions, categorize", () => {
    const w = catchallWords.change;
    expect(w.title(1)).toBe("Change the account of this transaction");
    expect(w.title(12)).toBe("Change the account of 12 transactions");
    expect(w.plan.confirm(1)).toBe("Move 1 transaction");
    expect(w.plan.confirm(3)).toBe("Move 3 transactions");
    expect(w.result.moved(1, "Software")).toBe("1 transaction moved to Software.");
    expect(w.result.notMoved(2)).toBe("2 transactions were not moved:");
    expect(w.result.notMoved(1)).toBe("1 transaction was not moved:");
  });

  test("only a posted entry that came from a bank and that no reversal links can be ticked", () => {
    expect(canChangeAccount({ type: "bank", status: "Posted" }, false)).toBe(true);
    // Reversed already, or the reversal itself.
    expect(canChangeAccount({ type: "bank", status: "Posted" }, true)).toBe(false);
    expect(canChangeAccount({ type: "bank", status: "Draft" }, false)).toBe(false);
    for (const type of ["stripe", "manual", "opening", undefined])
      expect(canChangeAccount({ type, status: "Posted" }, false)).toBe(false);
  });
});

describe("watching an account at month end", () => {
  test("only an expense or an income account can be watched, by the key that marks its kind", () => {
    expect(watchKind("expense")).toBe("expense");
    expect(watchKind("income")).toBe("income");
    for (const role of ["asset", "liability", "equity", "gain"]) expect(watchKind(role)).toBeNull();
    expect(WATCH_KEYS).toEqual({ expense: "catchall.expense", income: "catchall.income" });
    expect(isWatchKey("catchall.expense")).toBe(true);
    expect(isWatchKey("catchall.income")).toBe(true);
    expect(isWatchKey("stripe.balance")).toBe(false);
    expect(isWatchKey(undefined)).toBe(false);
  });

  test("an account is offered watching, or stopping when it is watched, and never when that would take another key off it", () => {
    expect(watchOffer({ role: "expense" })).toBe("watch");
    expect(watchOffer({ role: "income", roleKey: undefined, closedOn: null })).toBe("watch");
    expect(watchOffer({ role: "expense", roleKey: "catchall.expense" })).toBe("stop");
    // A closed account that holds the mark can let it go, so that another can have it.
    expect(
      watchOffer({ role: "expense", roleKey: "catchall.expense", closedOn: "2025-12-31" }),
    ).toBe("stop");
    // A closed account is not watched, and a kind that is not money in or out has nothing to watch.
    expect(watchOffer({ role: "expense", closedOn: "2025-12-31" })).toBeNull();
    expect(watchOffer({ role: "asset" })).toBeNull();
    // The mark is one key: an account that is the Stripe balance, say, keeps it.
    expect(watchOffer({ role: "income", roleKey: "revenue.sales" })).toBeNull();
    expect(watchOffer({ role: "expense", roleKey: "stripe.fees" })).toBeNull();
  });
});
