import { expect, test } from "bun:test";
import { decodeAccountSet, duplicateIds } from "../../src/bankfeed/decode.ts";
import { MAX_ACCOUNTS } from "../../src/bankfeed/constants.ts";
import { listedAccounts } from "../../src/bankfeed/listing.ts";

// The answer is read in both shapes the Bridge sends, and never trusted.

const v2 = {
  errlist: [{ code: "con.auth", msg: "Please sign in again.", conn_id: "CON-1" }],
  connections: [
    {
      conn_id: "CON-1",
      name: "Example Bank (business)",
      org_id: "bank.invalid",
      org_name: "Example Bank",
      sfin_url: "https://x.simplefin.org/simplefin",
    },
  ],
  accounts: [
    {
      id: "ACT-1",
      name: "Checking",
      conn_id: "CON-1",
      currency: "USD",
      balance: "10.00",
      "balance-date": 1791158400,
      transactions: [{ id: "t1", posted: 1791100800, amount: "-1.00", description: "x" }],
    },
  ],
  "x-api-message": ["Provide a 'start-date' parameter to receive transactions prior to yesterday"],
};

const v1 = {
  errors: ["Connection to Example Bank may need attention"],
  accounts: [
    {
      org: {
        name: "Example Bank",
        domain: "bank.invalid",
        "sfin-url": "https://x.simplefin.org/simplefin",
        id: "bank.invalid",
      },
      id: "ACT-1",
      name: "Checking",
      currency: "USD",
      balance: "10.00",
      "balance-date": 1791158400,
      transactions: [],
    },
  ],
};

test("version 2: errlist, connections, conn_id and the Bridge's own notes", () => {
  const decoded = decodeAccountSet(v2);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) return;
  const set = decoded.value;
  expect(set.shape).toBe("v2");
  expect(set.problems).toEqual([
    { code: "con.auth", message: "Please sign in again.", connId: "CON-1", accountId: null },
  ]);
  expect(set.connections).toEqual([
    {
      id: "CON-1",
      name: "Example Bank (business)",
      orgId: "bank.invalid",
      orgName: "Example Bank",
    },
  ]);
  expect(set.accounts).toHaveLength(1);
  expect(set.accounts[0]).toMatchObject({
    id: "ACT-1",
    name: "Checking",
    connId: "CON-1",
    orgName: "Example Bank",
    orgId: "bank.invalid",
    currency: "USD",
    balance: "10.00",
    balanceDate: 1791158400,
  });
  expect(set.accounts[0]?.transactions).toHaveLength(1);
  expect(set.messages).toEqual([
    "Provide a 'start-date' parameter to receive transactions prior to yesterday",
  ]);
});

test("version 1: errors are bare strings and the bank is named on the account", () => {
  const decoded = decodeAccountSet(v1);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) return;
  expect(decoded.value.shape).toBe("v1");
  expect(decoded.value.problems).toEqual([
    {
      code: null,
      message: "Connection to Example Bank may need attention",
      connId: null,
      accountId: null,
    },
  ]);
  expect(decoded.value.accounts[0]).toMatchObject({
    orgName: "Example Bank",
    orgId: "bank.invalid",
    connId: null,
  });
});

test("a version 2 answer that also carries warnings in `errors` (how the Bridge warns about requests) reads both", () => {
  const decoded = decodeAccountSet({
    ...v2,
    errors: ["You are making more requests than expected."],
  });
  expect(decoded.ok && decoded.value.problems.map((p) => p.message)).toEqual([
    "Please sign in again.",
    "You are making more requests than expected.",
  ]);
});

test("the answer to a refusal has an empty account list and its errors", () => {
  const decoded = decodeAccountSet({
    errlist: [{ code: "gen.auth", msg: "Forbidden" }],
    accounts: [],
    connections: [],
  });
  expect(decoded.ok && decoded.value.accounts).toEqual([]);
  expect(decoded.ok && decoded.value.problems[0]?.code).toBe("gen.auth");
});

test("what is not an answer is refused with a reason", () => {
  for (const bad of [null, 5, "text", [], true]) {
    const decoded = decodeAccountSet(bad);
    expect(decoded.ok).toBe(false);
  }
  expect(decodeAccountSet({}).ok).toBe(false);
  expect(decodeAccountSet({ accounts: "no" }).ok).toBe(false);
  expect(decodeAccountSet({ accounts: { a: 1 } }).ok).toBe(false);
  // No list, but the Bridge explained: that is a legitimate empty answer.
  expect(decodeAccountSet({ errlist: [{ code: "gen.auth", msg: "Forbidden" }] }).ok).toBe(true);
});

test("an answer with more accounts than Rastrata reads is refused whole", () => {
  const accounts = Array.from({ length: MAX_ACCOUNTS + 1 }, (_, i) => ({
    id: `A${i}`,
    name: "x",
    currency: "USD",
    balance: "0.00",
    "balance-date": 1,
  }));
  const decoded = decodeAccountSet({ errlist: [], accounts });
  expect(decoded.ok).toBe(false);
});

test("one malformed account does not cost the others", () => {
  const decoded = decodeAccountSet({
    errlist: [],
    accounts: [
      "not an object",
      { name: "no id", currency: "USD" },
      { id: "ACT-2", name: "no currency" },
      { id: "x".repeat(200), name: "id too long", currency: "USD" },
      { id: "ACT-3", name: "bad list", currency: "USD", transactions: "no" },
      { id: "ACT-4", name: "fine", currency: "USD", balance: "1.00", "balance-date": 1791158400 },
    ],
  });
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) return;
  expect(decoded.value.accounts.map((a) => a.id)).toEqual(["ACT-4"]);
  expect(decoded.value.rejected.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
});

test("text from the Bridge is bounded and stripped of control characters", () => {
  const decoded = decodeAccountSet({
    errlist: [
      { code: "act.failed", msg: `bad\u0000\u001b[31m${"x".repeat(1000)}`, account_id: "ACT-1" },
    ],
    accounts: [{ id: "ACT-1", name: `Name\u0007${"y".repeat(500)}`, currency: "USD" }],
  });
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) return;
  const message = decoded.value.problems[0]?.message ?? "";
  expect(message.length).toBeLessThanOrEqual(300);
  expect(message).not.toContain("\u0000");
  expect(message).not.toContain("\u001b");
  expect((decoded.value.accounts[0]?.name ?? "").length).toBeLessThanOrEqual(120);
  expect(decoded.value.accounts[0]?.name).not.toContain("\u0007");
});

test("an access URL echoed in the Bridge's text is scrubbed", () => {
  const secret =
    "https://fx-user-4f9c2a81:fx-pass-7d1e0b66a9c3@beta-bridge.simplefin.org/simplefin";
  const decoded = decodeAccountSet(
    {
      errlist: [{ code: "gen.api", msg: `look at ${secret} and Basic ZnhfdXNlcjpmeHBhc3M=` }],
      accounts: [],
    },
    ["fx-pass-7d1e0b66a9c3"],
  );
  const text = JSON.stringify(decoded);
  expect(text).not.toContain("fx-pass-7d1e0b66a9c3");
  expect(text).not.toContain("fx-user-4f9c2a81");
  expect(text).not.toContain("ZnhfdXNlcjpmeHBhc3M=");
});

test("accounts that share an id are found, and the listing refuses to link them", () => {
  const decoded = decodeAccountSet({
    errlist: [],
    connections: [],
    accounts: [
      { id: "same", name: "A", currency: "USD", balance: "1.00", "balance-date": 1791158400 },
      { id: "same", name: "B", currency: "USD", balance: "2.00", "balance-date": 1791158400 },
      {
        id: "other",
        name: "C",
        currency: "https://example.invalid/points",
        balance: "3.00",
        "balance-date": 1791158400,
      },
      {
        id: "Demo Checking",
        name: "D",
        currency: "usd",
        balance: "4.00",
        "balance-date": 1791158400,
      },
    ],
  });
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) return;
  expect([...duplicateIds(decoded.value.accounts)]).toEqual(["same"]);
  const listed = listedAccounts(decoded.value);
  expect(listed.map((a) => [a.id, a.support])).toEqual([
    ["same", "ambiguous"],
    ["same", "ambiguous"],
    ["other", "custom_currency"],
    ["Demo Checking", "ok"],
  ]);
  // An id with a space is a safe, stable key, and the currency is read in capitals.
  expect(listed[3]).toMatchObject({
    key: "simplefin:Demo%20Checking",
    isoCurrency: "USD",
    balance: "4.00",
    balanceOn: "2026-10-05",
  });
});
