import { expect, test } from "bun:test";
import {
  emptyFilters,
  type InboxCountsView,
  type InboxSourceView,
} from "@rastrata/ui/ingest/types";
import {
  addressFor,
  addressForTab,
  scopedCounts,
  serverFilter,
  viewFromAddress,
} from "../../src/routes/ingest/view";

// What the For review view of Transactions asks the service for, and how it reads its address. The same
// filter drives the list, "select all matching" and "Accept N suggested", so each of them means what the
// list shows. (What is posted is the list of all transactions, the other page; the views of this one are
// what waits for review, what is ready to post and what was set aside.)

const counts = (patch: Partial<InboxCountsView> = {}): InboxCountsView => ({
  total: 0,
  new: 0,
  proposed: 0,
  drafted: 0,
  posted: 0,
  excluded: 0,
  toReview: 0,
  covered: 0,
  postable: 0,
  beforeCutover: 0,
  ...patch,
});

const source = (
  provider: string,
  ledgerAccountId: string | null,
  patch: Partial<InboxCountsView>,
): InboxSourceView => ({
  provider,
  accountKey: `${provider}:${ledgerAccountId ?? "x"}`,
  ledgerAccountId,
  startOn: null,
  counts: counts(patch),
});

test("each view asks for the statuses it holds, and For review leaves out what a payout books", () => {
  expect(serverFilter("review", emptyFilters)).toEqual({
    status: ["new", "proposed"],
    covered: false,
  });
  expect(serverFilter("ready", emptyFilters)).toEqual({ status: ["drafted"], covered: false });
  expect(serverFilter("excluded", emptyFilters)).toEqual({ status: ["excluded"] });
});

test("the transactions one payout books are listed whatever has become of them", () => {
  expect(serverFilter("review", { ...emptyFilters, coveredBy: "item_9" })).toEqual({
    coveredBy: "item_9",
  });
});

test("the account the strip chose narrows by chart account, and Stripe by provider", () => {
  expect(serverFilter("review", { ...emptyFilters, account: "acc_1000" })).toMatchObject({
    ledgerAccountId: "acc_1000",
  });
  const stripe = serverFilter("review", { ...emptyFilters, account: "provider:stripe" });
  expect(stripe).toMatchObject({ provider: "stripe" });
  expect(stripe.ledgerAccountId).toBeUndefined();
  // Every account sends neither.
  const every = serverFilter("review", emptyFilters);
  expect(every.ledgerAccountId).toBeUndefined();
  expect(every.provider).toBeUndefined();
});

test("search text, dates and a provider account are sent as the service filters them", () => {
  const filter = serverFilter("review", {
    ...emptyFilters,
    text: "  github ",
    from: "2026-03-01",
    to: "2026-03-31",
    source: "csv\u0000csv:1000",
  });
  expect(filter).toEqual({
    status: ["new", "proposed"],
    covered: false,
    text: "github",
    from: "2026-03-01",
    to: "2026-03-31",
    provider: "csv",
    accountKey: "csv:1000",
  });
});

test("the screen offers no amount, direction or proposer filter, and sends none (an agent still can)", () => {
  const filter = serverFilter("review", emptyFilters);
  for (const key of ["minAmount", "maxAmount", "direction", "proposer"])
    expect(Object.keys(filter), key).not.toContain(key);
});

test("the counts of a chosen account are those of the provider accounts booked to it", () => {
  const sources = [
    source("csv", "a1", { total: 31, toReview: 8, posted: 23, proposed: 4, new: 4 }),
    source("simplefin", "a1", { total: 5, toReview: 2, new: 2 }),
    source("csv", "a2", { total: 3, toReview: 0, posted: 3 }),
    source("stripe", null, { total: 9, toReview: 3, covered: 6, proposed: 3 }),
  ];
  const book = counts({ total: 48, toReview: 13 });
  expect(scopedCounts(book, sources, "")).toBe(book);
  expect(scopedCounts(book, sources, "a1")).toMatchObject({
    total: 36,
    toReview: 10,
    posted: 23,
    proposed: 4,
    new: 6,
  });
  expect(scopedCounts(book, sources, "a2")).toMatchObject({ total: 3, toReview: 0, posted: 3 });
  expect(scopedCounts(book, sources, "provider:stripe")).toMatchObject({
    total: 9,
    toReview: 3,
    covered: 6,
  });
  // An account nothing was imported into has no counts, and says zero rather than the book's.
  expect(scopedCounts(book, sources, "a9")).toMatchObject({ total: 0, toReview: 0 });
});

test("the address can name an account, Stripe and a stage, and anything else is ignored", () => {
  expect(viewFromAddress("")).toEqual({ tab: "review", filters: emptyFilters });
  expect(viewFromAddress("?account=a1")).toMatchObject({
    tab: "review",
    filters: { account: "a1" },
  });
  expect(viewFromAddress("?provider=stripe&tab=ready")).toMatchObject({
    tab: "ready",
    filters: { account: "provider:stripe" },
  });
  expect(viewFromAddress("?tab=nonsense&item=it_1").tab).toBe("review");
  // An address from before the two lists became one page opens what waits for review.
  expect(viewFromAddress("?tab=posted").tab).toBe("review");
  expect(viewFromAddress("?tab=all").tab).toBe("review");
  expect(viewFromAddress("?tab=excluded").tab).toBe("excluded");
});

test("the address for a view leaves out the one that is the page itself, and lets go of a named transaction", () => {
  expect(addressForTab("", "review")).toBe("");
  expect(addressForTab("", "ready")).toBe("?tab=ready");
  expect(addressForTab("?tab=ready&account=a1&item=it_1", "excluded")).toBe(
    "?account=a1&tab=excluded",
  );
  expect(addressForTab("?tab=ready&account=a1", "review")).toBe("?account=a1");
});

test("the chosen account goes into the address without disturbing the rest of it", () => {
  expect(addressFor("", "a1")).toBe("?account=a1");
  expect(addressFor("?account=a1", "")).toBe("");
  expect(addressFor("?account=a1&tab=ready", "provider:stripe")).toBe("?tab=ready&provider=stripe");
  expect(addressFor("?item=it_1", "a b&c")).toBe("?item=it_1&account=a+b%26c");
  // And back: what was written is read as it was.
  expect(viewFromAddress(addressFor("", "a b&c")).filters.account).toBe("a b&c");
});
