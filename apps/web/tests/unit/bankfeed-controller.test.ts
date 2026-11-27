import { expect, test } from "bun:test";
import { shown } from "../support/shown";
import type {
  AccountRow,
  BankfeedAccount,
  BankfeedRun,
  BankfeedStatus,
} from "@rastrata/application/client-contracts";
import {
  accountView,
  attentionView,
  cardSummary,
  chartOptions,
  linkKey,
  messageOf,
  pauseFromStatus,
  runView,
  saidBy,
  syncBlocked,
  unlinkKey,
} from "../../src/routes/bankfeed/controller";

// The rules of the Bank feed screen that need no browser: which chart accounts may take a feed, how
// the service's accounts and runs are shown, why syncing is blocked, and what the Home line says.

const NOW = new Date("2026-10-04T13:00:00.000Z");

const chartAccount = (
  over: Partial<AccountRow> & Pick<AccountRow, "id" | "code" | "role">,
): AccountRow => ({
  name: `Account ${over.code}`,
  parentId: null,
  openedOn: "2026-01-01",
  closedOn: null,
  balance: "0.00",
  ...over,
});

const bridgeAccount = (over: Partial<BankfeedAccount> = {}): BankfeedAccount => ({
  id: "ACT-1",
  name: "Business Checking",
  bank: "Example Bank",
  currency: "USD",
  isoCurrency: "USD",
  foreignCurrency: false,
  balance: "100.00",
  balanceOn: "2026-10-04",
  support: "ok",
  state: "unlinked",
  link: null,
  ...over,
});

const run = (over: Partial<BankfeedRun> = {}): BankfeedRun => ({
  id: "run-1",
  startedAt: "2026-10-04T12:00:00.000Z",
  finishedAt: "2026-10-04T12:00:05.000Z",
  disposition: "complete",
  trigger: "manual",
  requests: 2,
  accounts: 1,
  windows: 1,
  newLines: 3,
  duplicateLines: 0,
  pendingSkipped: 0,
  heldLines: 0,
  errorCode: null,
  errorMessage: null,
  notes: [],
  ...over,
});

const status = (over: Partial<BankfeedStatus> = {}): BankfeedStatus => ({
  connected: true,
  credential: { present: true, host: "beta-bridge.simplefin.org", problem: null },
  bookCurrency: "USD",
  accounts: [],
  linked: 1,
  unlinked: 0,
  attention: [],
  problems: [],
  messages: [],
  requests: { used: 3, limit: 24, budget: 20, freesAt: null, pausedUntil: null },
  settings: { dailySync: false, dailyAt: "06:17" },
  lastSync: null,
  history: [],
  held: [],
  heldCount: 0,
  scheduler: true,
  ...over,
});

test("only an open asset or liability that is not a Stripe account may take a feed", () => {
  const options = chartOptions([
    chartAccount({ id: "a", code: "1000", role: "asset", name: "Business Checking" }),
    chartAccount({ id: "b", code: "2000", role: "liability", name: "Company Card" }),
    chartAccount({ id: "c", code: "3000", role: "equity" }),
    chartAccount({ id: "d", code: "4000", role: "income" }),
    chartAccount({ id: "e", code: "1900", role: "asset", closedOn: "2026-06-30" }),
    chartAccount({ id: "f", code: "1300", role: "asset", tags: { roleKey: "stripe.balance" } }),
    chartAccount({ id: "g", code: "1310", role: "asset", tags: { roleKey: "payouts.in-transit" } }),
    chartAccount({ id: "h", code: "1100", role: "asset", tags: { roleKey: "cash" } }),
  ]);
  expect(options).toEqual([
    { value: "a", label: "1000 · Business Checking" },
    { value: "b", label: "2000 · Company Card" },
    { value: "h", label: "1100 · Account 1100" },
  ]);
});

test("an account is shown as the Bridge lists it, with the reason one cannot be linked", () => {
  expect(accountView(bridgeAccount()).unsupported).toBeNull();
  for (const support of ["custom_currency", "bad_id", "ambiguous"] as const) {
    const reason = accountView(bridgeAccount({ support, state: "unsupported" })).unsupported;
    expect(reason, support).toBeTruthy();
    expect(reason, support).toMatch(/cannot|will not/i);
  }
  const linked = accountView(
    bridgeAccount({
      state: "linked",
      link: {
        ledgerAccountId: "a",
        ledgerAccount: "1000 Business Checking",
        startOn: "2026-09-01",
        sourceStartOn: "2026-09-01",
        linkedAt: "2026-10-01T00:00:00.000Z",
        through: "2026-10-04",
        lastSyncAt: "2026-10-04T12:00:05.000Z",
        lastOkAt: "2026-10-04T12:00:05.000Z",
        lastError: { code: "bankfeed_account_gone", message: "The Bridge no longer lists this." },
        feedBalance: {
          asOf: "2026-10-04",
          reported: "100.00",
          ledger: "0.00",
          waiting: "100.00",
          excluded: "0.00",
          difference: "0.00",
        },
      },
    }),
  );
  expect(linked.link).toMatchObject({
    ledgerAccount: "1000 Business Checking",
    startOn: "2026-09-01",
    through: "2026-10-04",
    lastError: "The Bridge no longer lists this.",
    feedBalance: { reported: "100.00", difference: "0.00" },
  });
});

test("a run is shown with what it found and why it failed, and nothing is invented", () => {
  expect(runView(run({ disposition: "failed", errorCode: "bankfeed_unavailable" }))).toMatchObject({
    disposition: "failed",
    errorCode: "bankfeed_unavailable",
    newLines: 3,
    trigger: "manual",
  });
  expect(attentionView([{ code: "stale", severity: "warning", message: "Out of date." }])).toEqual([
    { code: "stale", severity: "warning", message: "Out of date." },
  ]);
});

test("the Bridge's own words are listed once each, and a blank one is left out", () => {
  const problem = (said: string) => ({
    kind: "api" as const,
    code: null,
    bank: null,
    account: null,
    message: "A sentence that says what to do.",
    said,
  });
  expect(saidBy([problem("Try again later"), problem(""), problem("Try again later")])).toEqual([
    "Try again later",
  ]);
});

test("syncing is blocked until there is a connection and a link, and while the Bridge asked for peace", () => {
  expect(syncBlocked(status({ connected: false }), NOW)).toBe("Connect your bank first.");
  expect(syncBlocked(status({ linked: 0 }), NOW)).toContain("Link an account first");
  expect(syncBlocked(status(), NOW)).toBeNull();
  const paused = status({
    requests: {
      used: 3,
      limit: 24,
      budget: 20,
      freesAt: null,
      pausedUntil: "2026-10-05T13:00:00.000Z",
    },
  });
  expect(syncBlocked(paused, NOW)).toContain(shown.instant("2026-10-05T13:00:00.000Z"));
  // A pause that has ended blocks nothing.
  expect(syncBlocked(paused, new Date("2026-10-05T13:00:01.000Z"))).toBeNull();
  expect(pauseFromStatus(paused, NOW)?.until).toBe("2026-10-05T13:00:00.000Z");
  expect(pauseFromStatus(status(), NOW)).toBeNull();
});

test("the Home line is calm only when something was synced and nothing needs the owner", () => {
  expect(cardSummary(status({ connected: false, linked: 0 }), NOW).stage).toBe("not-connected");
  expect(cardSummary(status({ linked: 0, unlinked: 2 }), NOW)).toMatchObject({
    stage: "no-links",
    unlinked: 2,
  });
  const synced = cardSummary(status({ lastSync: run({ newLines: 11 }) }), NOW);
  expect(synced).toMatchObject({
    stage: "ready",
    needsYou: 0,
    paused: false,
    lastSync: { ok: true, newLines: 11, at: "2026-10-04T12:00:05.000Z" },
  });
  // Good-to-know lines are not things that need the owner; errors and warnings are.
  const noted = cardSummary(
    status({
      lastSync: run(),
      attention: [
        { code: "unlinked_accounts", severity: "info", message: "1 account is not linked." },
        { code: "stale", severity: "warning", message: "Out of date." },
        { code: "access_denied", severity: "error", message: "Refused." },
      ],
    }),
    NOW,
  );
  expect(noted.needsYou).toBe(2);
  expect(cardSummary(status({ lastSync: run({ disposition: "failed" }) }), NOW).lastSync?.ok).toBe(
    false,
  );
  // A run still counts as synced when it stopped part-way or was paused: it did not fail.
  expect(cardSummary(status({ lastSync: run({ disposition: "paused" }) }), NOW).lastSync?.ok).toBe(
    true,
  );
});

test("a failed request says what the service said, or a plain sentence when it was not the service", () => {
  expect(messageOf(new Error("The setup token is spent."), "x")).toBe("The setup token is spent.");
  expect(messageOf(new Error(""), "A plain sentence.")).toBe("A plain sentence.");
  expect(messageOf("not an error", "A plain sentence.")).toBe("A plain sentence.");
});

test("each write is kept under a name of its own, so two accounts never wait on one another", () => {
  expect(linkKey("ACT-1")).not.toBe(linkKey("ACT-2"));
  expect(linkKey("ACT-1")).not.toBe(unlinkKey("ACT-1"));
});
