import { afterEach, expect, test } from "bun:test";
import { ingestPort } from "../../src/slices/ingest/port.ts";
import { checking, day, savings } from "./fake-bridge.ts";
import { HOUR, type World, advance, closeWorlds, uuid, world } from "./support.ts";

afterEach(closeWorlds);

/** The chart's account ids by code. */
async function chart(w: World): Promise<Record<string, string>> {
  const accounts = await w.ok("accounts.list", {});
  return Object.fromEntries(
    accounts.accounts.map((a: { code: string; id: string }) => [a.code, a.id]),
  );
}

const link = (w: World, accountId: string, ledgerAccountId: string, startOn?: string) =>
  w.call("bankfeed.link", { accountId, ledgerAccountId, ...(startOn ? { startOn } : {}) }, uuid());

test("accounts asks the Bridge once, shows every account as unlinked, and never links one by itself", async () => {
  const w = await world({ connected: true });
  const before = w.bridge.requests("accounts").length;
  const reply = await w.ok("bankfeed.accounts", {});
  expect(w.bridge.requests("accounts")).toHaveLength(before + 1);
  expect(w.bridge.log.at(-1)?.query["balances-only"]).toEqual(["1"]);
  expect(reply.accounts.map((a: { id: string; state: string }) => [a.id, a.state])).toEqual([
    ["ACT-checking-0001", "unlinked"],
    ["ACT-savings-0002", "unlinked"],
  ]);
  expect(reply.requests).toMatchObject({ used: 2, limit: 24, budget: 20 });
  // An answer shows balances and the bank, as reported.
  expect(reply.accounts[0]).toMatchObject({
    bank: "Example Bank",
    balance: "4021.35",
    balanceOn: "2026-10-04",
    isoCurrency: "USD",
    foreignCurrency: false,
  });
});

test("a repeated identity returns the first answer without asking the Bridge again", async () => {
  const w = await world({ connected: true });
  const operationId = uuid();
  const first = await w.call("bankfeed.accounts", {}, operationId);
  const asked = w.bridge.requests("accounts").length;
  const again = await w.call("bankfeed.accounts", {}, operationId);
  expect(again.body).toEqual(first.body);
  expect(w.bridge.requests("accounts")).toHaveLength(asked);
});

test("an account that appears later is shown unlinked and is never fetched or linked", async () => {
  const w = await world({ connected: true });
  const ids = await chart(w);
  await w.ok("bankfeed.link", { accountId: "ACT-checking-0001", ledgerAccountId: ids["1000"] });
  // A third account shows up at the bank.
  w.bridge.accounts.push(
    savings({
      id: "ACT-new-0003",
      name: "Brand New Account",
      balance: "50.00",
      transactions: [
        { id: "N-1", posted: day("2026-10-02"), amount: "50.00", description: "OPENING DEPOSIT" },
      ],
    }),
  );
  // The next sync asks the Bridge what exists (an hour later, so the last listing is not fresh).
  advance(w, HOUR);
  await w.ok("bankfeed.sync", {});
  const status0 = await w.ok("bankfeed.status", {});
  const accounts = { accounts: status0.accounts };
  const states = Object.fromEntries(
    accounts.accounts.map((a: { id: string; state: string }) => [a.id, a.state]),
  );
  expect(states).toEqual({
    "ACT-checking-0001": "linked",
    "ACT-new-0003": "unlinked",
    "ACT-savings-0002": "unlinked",
  });
  // Nothing was ever asked for the unlinked accounts' transactions, and none of their lines arrived.
  for (const request of w.bridge.requests("accounts"))
    if (request.query["balances-only"] === undefined)
      expect(request.query.account).toEqual(["ACT-checking-0001"]);
  const lines = await w.ok("inbox.list", { filter: { provider: "simplefin" }, pageSize: 100 });
  expect(
    lines.items.every(
      (i: { line: { accountKey: string } }) => i.line.accountKey === "simplefin:ACT-checking-0001",
    ),
  ).toBe(true);
  const status = await w.ok("bankfeed.status", {});
  expect(status.unlinked).toBe(2);
  expect(
    status.attention.find((a: { code: string }) => a.code === "unlinked_accounts").severity,
  ).toBe("info");
});

test("linking records the choice, tells the Inbox where the account is booked, and starts on the cutover date when there is one", async () => {
  const w = await world({ connected: true });
  const ids = await chart(w);
  await w.ok("cutover.set", { cutoverDate: "2026-09-15", accountIds: [ids["1000"]] });
  const reply = await w.ok("bankfeed.link", {
    accountId: "ACT-checking-0001",
    ledgerAccountId: ids["1000"],
  });
  expect(reply.account.state).toBe("linked");
  expect(reply.account.link).toMatchObject({
    ledgerAccountId: ids["1000"],
    ledgerAccount: "1000 Business Checking",
    startOn: "2026-09-15",
    sourceStartOn: "2026-09-15",
    through: null,
    feedBalance: null,
  });
  const sources = await w.ok("inbox.sources", {});
  const source = sources.sources.find((s: { provider: string }) => s.provider === "simplefin");
  expect(source).toMatchObject({
    accountKey: "simplefin:ACT-checking-0001",
    ledgerAccountId: ids["1000"],
    startOn: "2026-09-15",
  });
  // The cutover screen sees it as a source that manages its own first day, and leaves it alone.
  const cutover = await w.ok("cutover.get", {});
  expect(cutover.sources.find((s: { provider: string }) => s.provider === "simplefin").action).toBe(
    "managed",
  );
});

test("with no cutover the first day is the first day of the book, and the owner may choose another", async () => {
  const w = await world({ connected: true });
  const ids = await chart(w);
  const first = await w.ok("bankfeed.link", {
    accountId: "ACT-checking-0001",
    ledgerAccountId: ids["1000"],
  });
  expect(first.account.link.startOn).toBe("2026-01-01");
  const chosen = await w.ok("bankfeed.link", {
    accountId: "ACT-savings-0002",
    ledgerAccountId: ids["1100"],
    startOn: "2026-10-01",
  });
  expect(chosen.account.link.startOn).toBe("2026-10-01");
  const bad = await link(w, "ACT-checking-0001", ids["1000"] as string, "2026-02-30");
  expect(bad.status).toBe(400);
  expect(bad.body.error.code).toBe("invalid_date");
});

test("only an open bank, card or loan account can be linked, never a Stripe account, and one chart account has one feed", async () => {
  const w = await world({ connected: true });
  const ids = await chart(w);
  const cases: [string, number, string][] = [
    ["4000", 422, "account_role_invalid"],
    ["3000", 422, "account_role_invalid"],
    ["5000", 422, "account_role_invalid"],
    ["1300", 422, "account_is_stripe"],
  ];
  for (const [code, status, error] of cases) {
    const reply = await link(w, "ACT-checking-0001", ids[code] as string);
    expect(reply.status, code).toBe(status);
    expect(reply.body.error.code, code).toBe(error);
  }
  expect((await link(w, "ACT-checking-0001", "999999")).body.error.code).toBe("account_not_found");
  // A card is a liability and is allowed.
  expect((await link(w, "ACT-savings-0002", ids["2000"] as string)).status).toBe(200);
  // One chart account, one feed account.
  await w.ok("bankfeed.link", { accountId: "ACT-checking-0001", ledgerAccountId: ids["1000"] });
  const second = await link(w, "ACT-savings-0002", ids["1000"] as string);
  expect(second.status).toBe(409);
  expect(second.body.error.code).toBe("bankfeed_ledger_account_taken");
});

test("an account the Bridge did not list, or one that cannot be booked, is refused with the reason", async () => {
  const w = await world({
    connected: false,
    accounts: [
      checking(),
      savings({ id: "ACT-points", name: "Rewards", currency: "https://example.invalid/points" }),
      checking({ id: "dup", name: "First" }),
      checking({ id: "dup", name: "Second" }),
    ],
  });
  await w.ok("bankfeed.connect", { setupToken: w.bridge.setupToken() });
  const ids = await chart(w);
  const unknown = await link(w, "ACT-nope", ids["1000"] as string);
  expect(unknown.status).toBe(404);
  expect(unknown.body.error.code).toBe("bankfeed_account_unknown");
  const points = await link(w, "ACT-points", ids["1100"] as string);
  expect(points.status).toBe(422);
  expect(points.body.error.message).toContain("custom currency");
  const dup = await link(w, "dup", ids["1100"] as string);
  expect(dup.status).toBe(422);
  expect(dup.body.error.message).toContain("same id");
  const status = await w.ok("bankfeed.status", {});
  // Two accounts with one id are one row, flagged: neither can be asked for on its own.
  expect(
    status.accounts
      .filter((a: { state: string }) => a.state === "unsupported")
      .map((a: { id: string }) => a.id)
      .sort(),
  ).toEqual(["ACT-points", "dup"]);
});

test("an account in another currency can be linked and the reply says its lines are held, never converted", async () => {
  const w = await world({
    connected: false,
    accounts: [
      checking(),
      savings({ id: "ACT-euro", name: "Euro Account", currency: "EUR", balance: "900.00" }),
    ],
  });
  await w.ok("bankfeed.connect", { setupToken: w.bridge.setupToken() });
  const ids = await chart(w);
  const reply = await w.ok("bankfeed.link", {
    accountId: "ACT-euro",
    ledgerAccountId: ids["1200"],
  });
  expect(reply.account.foreignCurrency).toBe(true);
  expect(reply.notes.join(" ")).toContain("does not convert currencies");
  expect(reply.notes.join(" ")).toContain("EUR");
});

test("linking an account that statement files already feed warns about queuing the same transactions twice", async () => {
  const w = await world({ connected: true });
  const ids = await chart(w);
  // A statement import for the same chart account, through the real pipeline.
  const port = ingestPort(w.service);
  const raw = port.archive(new TextEncoder().encode("statement"), "text/csv", "statement.csv");
  port.submit({
    provider: "csv",
    sourceKey: "csv:1000",
    raw,
    lines: [
      {
        kind: "bankLine",
        provider: "csv",
        accountKey: "csv:1000",
        rawIndex: 0,
        postedOn: "2026-09-10",
        amount: "-5.00",
        currency: "USD",
        description: "OLD LINE",
      },
      {
        kind: "bankLine",
        provider: "csv",
        accountKey: "csv:1000",
        rawIndex: 1,
        postedOn: "2026-09-20",
        amount: "-6.00",
        currency: "USD",
        description: "NEWER LINE",
      },
    ],
    balances: [],
    fetchedAt: new Date(w.clock.ms).toISOString(),
    ledgerAccountId: ids["1000"] as string,
  });
  const reply = await w.ok("bankfeed.link", {
    accountId: "ACT-checking-0001",
    ledgerAccountId: ids["1000"],
  });
  const note = reply.notes.join(" ");
  expect(note).toContain("separate sources");
  expect(note).toContain("queued twice");
  expect(note).toContain("2026-09-21");
});

test("relinking the same account moves its first day through the Inbox, and a retried link changes nothing", async () => {
  const w = await world({ connected: true });
  const ids = await chart(w);
  const operationId = uuid();
  const first = await w.call(
    "bankfeed.link",
    { accountId: "ACT-checking-0001", ledgerAccountId: ids["1000"], startOn: "2026-09-01" },
    operationId,
  );
  const again = await w.call(
    "bankfeed.link",
    { accountId: "ACT-checking-0001", ledgerAccountId: ids["1000"], startOn: "2026-09-01" },
    operationId,
  );
  expect(again.body).toEqual(first.body);
  await w.ok("bankfeed.link", {
    accountId: "ACT-checking-0001",
    ledgerAccountId: ids["1000"],
    startOn: "2026-10-01",
  });
  const sources = await w.ok("inbox.sources", {});
  expect(
    sources.sources.find((s: { provider: string }) => s.provider === "simplefin").startOn,
  ).toBe("2026-10-01");
  const status = await w.ok("bankfeed.status", {});
  expect(status.accounts[0].link.startOn).toBe("2026-10-01");
  // The first link date is kept: linking again is not a new link.
  expect(status.accounts[0].link.linkedAt).toBe(first.body.data.account.link.linkedAt);
});

test("unlinking stops the account being read and keeps every line it brought", async () => {
  const w = await world({ connected: true });
  const ids = await chart(w);
  await w.ok("bankfeed.link", { accountId: "ACT-checking-0001", ledgerAccountId: ids["1000"] });
  await w.ok("bankfeed.sync", {});
  const reply = await w.ok("bankfeed.unlink", { accountId: "ACT-checking-0001" });
  expect(reply.unlinked).toBe(true);
  expect(reply.account.state).toBe("unlinked");
  expect(reply.account.link).toBeNull();
  const asked = w.bridge.requests("accounts").length;
  const sync = await w.ok("bankfeed.sync", {});
  expect(sync.accounts).toEqual([]);
  expect(sync.run.notes.join(" ")).toContain("No Bridge account is linked");
  // Only the listing may have been asked, and only if it was not fresh.
  expect(w.bridge.requests("accounts").length).toBeLessThanOrEqual(asked + 1);
  expect((await w.ok("inbox.list", { filter: { provider: "simplefin" } })).count).toBe(5);
  // The chart account can now be linked to another feed account.
  expect((await link(w, "ACT-savings-0002", ids["1000"] as string)).status).toBe(200);
  expect((await w.ok("bankfeed.unlink", { accountId: "ACT-nothing" })).unlinked).toBe(false);
});

test("an account the Bridge stops listing is flagged, still linked, and never read", async () => {
  const w = await world({ connected: true });
  const ids = await chart(w);
  await w.ok("bankfeed.link", { accountId: "ACT-checking-0001", ledgerAccountId: ids["1000"] });
  await w.ok("bankfeed.sync", {});
  w.bridge.accounts = [savings()];
  await w.ok("bankfeed.accounts", {});
  const status = await w.ok("bankfeed.status", {});
  const gone = status.accounts.find((a: { id: string }) => a.id === "ACT-checking-0001");
  expect(gone.state).toBe("gone");
  expect(gone.link).not.toBeNull();
  expect(status.attention.find((a: { code: string }) => a.code === "account_gone").severity).toBe(
    "error",
  );
  const sync = await w.ok("bankfeed.sync", {});
  expect(sync.accounts[0]).toMatchObject({ state: "skipped" });
});
