import { expect, test } from "bun:test";
import type {
  AccountList,
  AccountRow,
  BankfeedStatus,
  InboxBalanceCheck,
  InboxCounts,
  InboxSource,
  InboxSummary,
  ReconcileAccountStatus,
  ReconcileStatus,
  StripeStatus,
} from "@rastrata/application/client-contracts";
import { bankTileLinks, buildBanking, type BankingReads } from "../../src/routes/ingest/summary";

// The tiles say what the books hold beside what the bank says, so every figure is checked in the
// orientation it is shown in: asset positive, a card that owes money negative.

const counts = (patch: Partial<InboxCounts> = {}): InboxCounts => ({
  total: 0,
  new: 0,
  proposed: 0,
  drafted: 0,
  posted: 0,
  excluded: 0,
  toReview: 0,
  beforeCutover: 0,
  ...patch,
});

const account = (
  id: string,
  code: string,
  name: string,
  role: AccountRow["role"],
  balance: string,
  roleKey?: string,
): AccountRow => ({
  id,
  code,
  name,
  role,
  parentId: null,
  openedOn: "2026-01-01",
  closedOn: null,
  balance,
  ...(roleKey ? { tags: { roleKey } } : {}),
});

const chart = (...accounts: AccountRow[]): AccountList => ({
  currency: "USD",
  configurationRevision: "1",
  suggestedEffectiveOn: "2026-03-21",
  accounts,
});

const tracked = (
  id: string,
  code: string,
  name: string,
  side: "debit" | "credit",
  patch: Partial<ReconcileAccountStatus> = {},
): ReconcileAccountStatus => ({
  account: { id, code, name, role: side === "debit" ? "asset" : "liability", normalSide: side },
  tracked: true,
  lastReconciledDate: null,
  lastReconciledBalance: null,
  lastReconciliationId: null,
  openReconciliationId: null,
  unclearedCount: 0,
  unclearedTotal: "0.00",
  oldestUnclearedDate: null,
  bookBalance: "0.00",
  ...patch,
});

const source = (
  provider: string,
  ledgerAccountId: string | null,
  patch: Partial<InboxCounts> = {},
): InboxSource => ({
  provider,
  accountKey: `${provider}:${ledgerAccountId ?? "none"}`,
  ledgerAccountId,
  startOn: null,
  counts: counts(patch),
  firstLineOn: null,
  lastLineOn: null,
  batches: 1,
  lastSubmittedAt: null,
});

const summary = (sources: InboxSource[], toReview = 0): InboxSummary => ({
  counts: counts({ toReview }),
  sources,
  unmapped: 0,
  oldestToReviewOn: null,
  lastSubmittedAt: null,
});

const check = (
  provider: string,
  ledgerAccountId: string,
  asOf: string,
  reported: string,
): InboxBalanceCheck => ({
  provider,
  accountKey: `${provider}:${ledgerAccountId}`,
  asOf,
  reported,
  ledgerAccountId,
  ledger: null,
  waiting: null,
  excluded: null,
  difference: null,
  batchId: "batch",
});

const reads = (patch: Partial<BankingReads> & Pick<BankingReads, "accounts">): BankingReads => ({
  inbox: summary([]),
  checks: [],
  status: { bookRevision: "1", accounts: [] },
  ...patch,
});

const demo = (): BankingReads =>
  reads({
    accounts: chart(
      account("a1", "1000", "Business checking", "asset", "20729.65"),
      account("a2", "1010", "Business savings", "asset", "6000.00"),
      account("a3", "2000", "Business credit card", "liability", "-1250.00"),
      account("a9", "6000", "Software", "expense", "480.00"),
    ),
    status: {
      bookRevision: "1",
      accounts: [
        tracked("a1", "1000", "Business checking", "debit", {
          lastReconciledDate: "2026-02-28",
          lastReconciledBalance: "18200.40",
          bookBalance: "20729.65",
        }),
        tracked("a2", "1010", "Business savings", "debit", { bookBalance: "6000.00" }),
        tracked("a3", "2000", "Business credit card", "credit", {
          lastReconciledDate: "2026-02-28",
          lastReconciledBalance: "900.00",
          bookBalance: "1250.00",
        }),
      ],
    },
    inbox: summary(
      [
        source("csv", "a1", { total: 31, toReview: 8, posted: 23 }),
        source("csv", "a3", { total: 4, posted: 4 }),
      ],
      8,
    ),
    checks: [check("csv", "a1", "2026-03-20", "20729.65")],
  });

test("one tile for each tracked bank and card account, in chart order, and none for anything else", () => {
  const { tiles } = buildBanking(demo());
  expect(tiles.map((tile) => [tile.code, tile.name, tile.kind])).toEqual([
    ["1000", "Business checking", "bank"],
    ["1010", "Business savings", "bank"],
    ["2000", "Business credit card", "card"],
  ]);
});

test("a tile holds the books' balance as the chart carries it: a card that owes money is negative", () => {
  const { tiles } = buildBanking(demo());
  expect(tiles.map((tile) => tile.bookBalance)).toEqual(["20729.65", "6000.00", "-1250.00"]);
});

test("the balance of the last reconciled statement is turned from the statement's way to the books' way", () => {
  const { tiles } = buildBanking(demo());
  // A statement prints what a card owes as a positive 900.00; the books carry it as -900.00.
  expect(tiles[2]?.lastReconciled).toEqual({ date: "2026-02-28", balance: "-900.00" });
  expect(tiles[0]?.lastReconciled).toEqual({ date: "2026-02-28", balance: "18200.40" });
  // An account nobody has reconciled has no such line, and is never called reconciled.
  expect(tiles[1]?.lastReconciled).toBeUndefined();
});

test("the count to review follows the account, and says whether anything was imported at all", () => {
  const { tiles, toReview } = buildBanking(demo());
  expect(tiles.map((tile) => [tile.toReview, tile.imported])).toEqual([
    [8, true],
    [0, false],
    [0, true],
  ]);
  expect(toReview).toBe(8);
});

test("a count adds up every source that feeds the account, and the total counts lines no account owns yet", () => {
  const input = demo();
  const { tiles, toReview } = buildBanking({
    ...input,
    inbox: summary(
      [
        source("csv", "a1", { total: 10, toReview: 2 }),
        source("simplefin", "a1", { total: 5, toReview: 3 }),
        source("csv", null, { total: 4, toReview: 4 }),
      ],
      9,
    ),
  });
  expect(tiles[0]?.toReview).toBe(5);
  expect(toReview).toBe(9);
});

test("the statement line is the newest balance anyone reported, and says who", () => {
  const input = demo();
  const both = buildBanking({
    ...input,
    checks: [
      check("csv", "a1", "2026-03-20", "20729.65"),
      check("simplefin", "a1", "2026-10-04", "19000.00"),
    ],
  }).tiles[0];
  expect(both).toMatchObject({
    statementBalance: "19000.00",
    statementAsOf: "2026-10-04",
    statementSource: "feed",
  });
  // The file is the statement; the reconciled one is older than both and loses.
  const file = buildBanking(input).tiles[0];
  expect(file).toMatchObject({
    statementBalance: "20729.65",
    statementAsOf: "2026-03-20",
    statementSource: "statement",
  });
});

test("on one date a reconciled statement outranks a file, and a file outranks a feed", () => {
  const input = demo();
  const reconciled = buildBanking({
    ...input,
    status: {
      bookRevision: "1",
      accounts: [
        tracked("a1", "1000", "Business checking", "debit", {
          lastReconciledDate: "2026-03-20",
          lastReconciledBalance: "20729.65",
        }),
      ],
    },
    checks: [
      check("simplefin", "a1", "2026-03-20", "20730.00"),
      check("csv", "a1", "2026-03-20", "20729.65"),
    ],
  }).tiles[0];
  expect(reconciled?.statementSource).toBe("reconciliation");
  const fileOverFeed = buildBanking({
    ...input,
    checks: [
      check("simplefin", "a1", "2026-03-20", "20730.00"),
      check("csv", "a1", "2026-03-20", "20729.65"),
    ],
  }).tiles[0];
  expect(fileOverFeed).toMatchObject({
    statementSource: "statement",
    statementBalance: "20729.65",
  });
});

test("a provider that is not a statement file is a feed, so a new aggregator is never called a statement", () => {
  const input = demo();
  const tile = buildBanking({
    ...input,
    checks: [check("plaid", "a1", "2026-10-04", "1.00")],
  }).tiles[0];
  expect(tile?.statementSource).toBe("feed");
});

test("another account's balance never lands on a tile", () => {
  const input = demo();
  const tiles = buildBanking({
    ...input,
    checks: [check("csv", "a2", "2026-03-20", "6000.00")],
  }).tiles;
  // The checking account keeps the reconciled statement's balance; the savings account's file is its own.
  expect(tiles[0]?.statementBalance).toBe("18200.40");
  expect(tiles[1]?.statementBalance).toBe("6000.00");
  expect(tiles[2]?.statementBalance).toBe("-900.00");
});

test("an account the chart does not list falls back to the reconciliation's book balance, in the books' way", () => {
  const input = demo();
  const tiles = buildBanking({ ...input, accounts: chart() }).tiles;
  expect(tiles.map((tile) => tile.bookBalance)).toEqual(["20729.65", "6000.00", "-1250.00"]);
});

test("an account that is not tracked has no tile", () => {
  const input = demo();
  const status: ReconcileStatus = {
    bookRevision: "1",
    accounts: [{ ...tracked("a4", "1020", "Petty cash", "debit"), tracked: false }],
  };
  expect(buildBanking({ ...input, status }).tiles).toEqual([]);
});

// ---- Connections ----------------------------------------------------------------------------------

const feed = (patch: {
  connected?: boolean;
  lastError?: boolean;
  lastOkAt?: string | null;
}): BankfeedStatus =>
  ({
    connected: patch.connected ?? true,
    accounts: [
      {
        id: "feed-1",
        link: {
          ledgerAccountId: "a1",
          lastSyncAt: "2026-10-04T08:00:00.000Z",
          lastOkAt: patch.lastOkAt === undefined ? "2026-10-04T08:00:00.000Z" : patch.lastOkAt,
          lastError: patch.lastError ? { code: "x", message: "y" } : null,
        },
      },
    ],
  }) as unknown as BankfeedStatus;

test("a linked bank feed is connected, with when it last read", () => {
  const tile = buildBanking({ ...demo(), feed: feed({}) }).tiles[0];
  expect(tile?.connection).toEqual({
    kind: "feed",
    state: "connected",
    syncedAt: "2026-10-04T08:00:00.000Z",
  });
});

test("a feed with an error, or one whose credential is gone, needs attention", () => {
  expect(
    buildBanking({ ...demo(), feed: feed({ lastError: true }) }).tiles[0]?.connection?.state,
  ).toBe("attention");
  expect(
    buildBanking({ ...demo(), feed: feed({ connected: false }) }).tiles[0]?.connection?.state,
  ).toBe("attention");
});

test("an account with no feed says nothing about one, and a feed that could not be read says nothing either", () => {
  expect(buildBanking({ ...demo(), feed: null }).tiles[0]?.connection).toBeUndefined();
  expect(buildBanking(demo()).tiles[1]?.connection).toBeUndefined();
  expect(buildBanking({ ...demo(), feed: feed({}) }).tiles[1]?.connection).toBeUndefined();
});

const stripe = (patch: {
  present?: boolean;
  problem?: string | null;
  configured?: boolean;
  disposition?: "complete" | "failed";
  total?: string | null;
}): StripeStatus =>
  ({
    configured: patch.configured ?? true,
    key: { present: patch.present ?? true, problem: patch.problem ?? null },
    roles: [{ role: "stripe.balance", accountId: "a5", code: "1100" }],
    lastSync: {
      finishedAt: "2026-10-04T09:12:00.000Z",
      disposition: patch.disposition ?? "complete",
    },
    balance: {
      snapshot:
        patch.total === null
          ? null
          : { total: patch.total ?? "2431.17", readAt: "2026-10-04T09:12:00.000Z" },
    },
  }) as unknown as StripeStatus;

const withStripeAccount = (): BankingReads => ({
  ...demo(),
  accounts: chart(
    account("a1", "1000", "Business checking", "asset", "20729.65"),
    account("a2", "1010", "Business savings", "asset", "6000.00"),
    account("a3", "2000", "Business credit card", "liability", "-1250.00"),
    account("a5", "1100", "Stripe balance", "asset", "12.00", "stripe.balance"),
  ),
});

test("a book with no Stripe in it is not offered a Stripe tile", () => {
  const kinds = (input: BankingReads) => buildBanking(input).tiles.map((tile) => tile.kind);
  // Nothing read, or nothing there: no key, no Stripe account in the chart, nothing imported.
  expect(kinds({ ...demo(), stripe: null })).not.toContain("stripe");
  expect(
    kinds({ ...demo(), stripe: { ...stripe({ present: false }), roles: [] } as StripeStatus }),
  ).not.toContain("stripe");
  // A key, a Stripe account in the chart, or lines that came from Stripe: each is reason enough.
  expect(kinds({ ...demo(), stripe: stripe({}) })).toContain("stripe");
  expect(kinds({ ...withStripeAccount(), stripe: stripe({ present: false }) })).toContain("stripe");
  expect(
    kinds({ ...demo(), inbox: summary([source("stripe", null, { total: 2 })]), stripe: null }),
  ).toContain("stripe");
});

test("Stripe with the book's accounts but no key is not connected, and the tile says only that", () => {
  const tile = buildBanking({
    ...withStripeAccount(),
    stripe: stripe({ present: false }),
  }).tiles.at(-1);
  expect(tile).toMatchObject({
    kind: "stripe",
    name: "Stripe",
    accountId: "a5",
    connection: { kind: "stripe", state: "not_connected" },
  });
});

test("connected Stripe: the books' balance, what Stripe reports, when it last synced", () => {
  const tile = buildBanking({ ...withStripeAccount(), stripe: stripe({}) }).tiles.at(-1);
  expect(tile).toMatchObject({
    kind: "stripe",
    bookBalance: "12.00",
    statementBalance: "2431.17",
    statementAsOf: "2026-10-04T09:12:00.000Z",
    connection: { state: "connected", syncedAt: "2026-10-04T09:12:00.000Z" },
  });
});

test("Stripe needs attention when its key has a problem or its last sync failed, and is only 'set up' when a working key has no accounts chosen yet", () => {
  const state = (patch: Parameters<typeof stripe>[0]) =>
    buildBanking({ ...withStripeAccount(), stripe: stripe(patch) }).tiles.at(-1)?.connection?.state;
  expect(state({ problem: "The key is not read-only" })).toBe("attention");
  expect(state({ disposition: "failed" })).toBe("attention");
  // The next step, not a fault: the tile does not say the connection needs attention.
  expect(state({ configured: false })).toBe("setup");
  // A key with a problem is a fault whether or not the accounts are set up.
  expect(state({ configured: false, problem: "The key is not read-only" })).toBe("attention");
  expect(state({})).toBe("connected");
});

test("Stripe lines waiting in For review count on its tile and nowhere else", () => {
  const input = withStripeAccount();
  const { tiles } = buildBanking({
    ...input,
    inbox: summary(
      [
        source("csv", "a1", { total: 3, toReview: 1 }),
        source("stripe", null, { total: 9, toReview: 3 }),
      ],
      4,
    ),
    stripe: stripe({}),
  });
  expect(tiles.at(-1)).toMatchObject({ kind: "stripe", toReview: 3, imported: true });
  expect(tiles[0]?.toReview).toBe(1);
});

test("a Stripe tile with no Stripe account in the chart has no books' balance, and is not given one", () => {
  const tile = buildBanking({
    ...demo(),
    stripe: { ...stripe({}), roles: [] } as StripeStatus,
  }).tiles.at(-1);
  expect(tile).toMatchObject({ kind: "stripe", accountId: "", bookBalance: null });
});

// ---- Links ----------------------------------------------------------------------------------------

test("a tile opens the account: its own transactions, and Stripe its own page", () => {
  const tile = buildBanking(demo()).tiles[0];
  if (!tile) throw new Error("no tile");
  expect(bankTileLinks.open(tile)).toBe("/ledger?accountId=a1");
  const stripeTile = buildBanking({ ...withStripeAccount(), stripe: stripe({}) }).tiles.at(-1);
  if (!stripeTile) throw new Error("no stripe tile");
  expect(bankTileLinks.open(stripeTile)).toBe("/settings/stripe");
  expect(bankTileLinks.connect(stripeTile)).toBe("/settings/stripe");
});

test("an account id with characters that matter in an address is encoded", () => {
  const tile = buildBanking(demo()).tiles[0];
  if (!tile) throw new Error("no tile");
  expect(bankTileLinks.open({ ...tile, accountId: "a b&c=d" })).toBe(
    "/ledger?accountId=a%20b%26c%3Dd",
  );
});
