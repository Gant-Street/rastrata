import { afterEach, expect, test } from "bun:test";
import { learnCapabilities } from "../../src/capabilities";
import type { HomeFacts } from "../../src/routes/home-facts";
import { bankConnected, homeStart } from "../../src/routes/home-start";
import { checklist, failed, homeFacts, inbox, ok } from "../support/home-facts";

afterEach(() => learnCapabilities(null));

/** A book nobody has put anything in: nothing imported, nothing posted, no opening entry. */
const fresh = (over: Partial<HomeFacts> = {}) =>
  homeFacts({
    inbox: inbox({ total: 0, posted: 0, excluded: 0 }),
    closing: checklist({ hasHistory: false, opening: { status: "none" } }),
    ...over,
  });

const hosted = (over: Record<string, boolean> = {}) =>
  learnCapabilities({
    accounts: true,
    connections: false,
    banks: true,
    stripeApp: true,
    billing: true,
    agents: true,
    backups: false,
    ...over,
  });

test("a new book is one thing to do: add the bank, with a statement file as the other way in", () => {
  hosted();
  expect(homeStart(fresh())).toEqual({
    title: "Add your bank to start",
    text: "Its transactions come in for you to review.",
    action: { label: "Connect a bank", href: "/settings/banks" },
    alt: { label: "Import a statement", href: "/import" },
    lines: [
      {
        id: "mover",
        text: "Moving from another system",
        action: "Bring in your books",
        href: "/settings/bring-in",
      },
      {
        id: "agent",
        text: "For the agent you already use",
        action: "Connect an agent",
        href: "/settings/agent",
      },
    ],
  });
});

test("where no bank can be connected, the statement file is the way in and there is no second way", () => {
  hosted({ banks: false });
  const start = homeStart(fresh());
  expect(start).toMatchObject({
    title: "Import a statement to start",
    action: { label: "Import a statement", href: "/import" },
  });
  expect(start?.alt).toBeUndefined();
});

test("a service that keeps a bank's credential itself connects the bank on its own page", () => {
  // The installed application: no accounts, a credential can be kept.
  expect(homeStart(fresh())?.action).toEqual({
    label: "Connect a bank",
    href: "/settings/bankfeed",
  });
});

test("a book with something in it has no start: a transaction imported or an entry posted", () => {
  expect(homeStart(homeFacts())).toBeNull();
  expect(
    homeStart(fresh({ inbox: inbox({ total: 3, new: 3, toReview: 3, posted: 0 }) })),
  ).toBeNull();
  expect(
    homeStart(fresh({ closing: checklist({ hasHistory: true, opening: { status: "none" } }) })),
  ).toBeNull();
  // What could not be read is not called new.
  expect(homeStart(fresh({ inbox: failed() }))).toBeNull();
});

test("a connected bank ends the start: its transactions are on their way, and the bank is not asked for again", () => {
  const feed = fresh({ bankfeed: ok({ connected: true } as never) });
  expect(bankConnected(feed)).toBe(true);
  expect(homeStart(feed)).toBeNull();
  // A bank connected in Stripe's window counts once it is booked to an account of the books.
  const booked = (booking: unknown) =>
    fresh({ banks: ok({ accounts: [{ id: "b1", booking }], held: [], heldCount: 0 } as never) });
  expect(homeStart(booked({ ledgerAccountId: "1000" }))).toBeNull();
  expect(homeStart(booked(null))).not.toBeNull();
  // A connection that could not be read is not taken as one.
  expect(homeStart(fresh({ bankfeed: failed() }))).not.toBeNull();
});

test("each quiet line is for the person it is for", () => {
  hosted();
  const lines = (facts: HomeFacts) => homeStart(facts)?.lines.map((line) => line.id);
  // The books were brought in (an opening entry posted, or a history imported): no line for a mover.
  expect(
    lines(fresh({ closing: checklist({ hasHistory: false, opening: { status: "posted" } }) })),
  ).toEqual(["agent"]);
  expect(
    lines(
      fresh({
        closing: checklist({
          hasHistory: false,
          opening: { status: "none" },
          historyImported: true,
        }),
      }),
    ),
  ).toEqual(["agent"]);
  // The agent keys are the owner's to make; an accountant posts, so the mover's line is theirs too.
  expect(lines(fresh({ role: "accountant" }))).toEqual(["mover"]);
  // A member drafts: the start is theirs, and neither line is.
  expect(lines(fresh({ role: "member" }))).toEqual([]);
  // A service that takes no agent's token has no line for one.
  hosted({ agents: false });
  expect(lines(fresh())).toEqual(["mover"]);
});
