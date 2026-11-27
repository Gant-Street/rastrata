import { afterEach, expect, test } from "bun:test";
import type { BusinessPermission } from "../../src/schema.ts";
import {
  DAY_MS,
  HOUR,
  advance,
  chartIds,
  closeWorlds,
  linkByCode,
  uuid,
  world,
} from "./support.ts";

afterEach(closeWorlds);

const READ: readonly BusinessPermission[] = ["read"];
const DRAFT: readonly BusinessPermission[] = ["read", "draft"];
const CONFIGURE: readonly BusinessPermission[] = ["read", "configure"];

// ---- what each permission may do ---------------------------------------------------------------------

test("each operation needs the permission its weight deserves, and nothing is reachable without one", async () => {
  const w = await world({ connected: true });
  const ids = await chartIds(w);
  const token = w.bridge.setupToken("ANOTHER-CODE-0009");
  const inputs: Record<string, unknown> = {
    "bankfeed.connect": { setupToken: token },
    "bankfeed.accounts": {},
    "bankfeed.link": { accountId: "ACT-checking-0001", ledgerAccountId: ids["1000"] },
    "bankfeed.unlink": { accountId: "ACT-checking-0001" },
    "bankfeed.sync": {},
    "bankfeed.status": {},
    "bankfeed.settings": { dailySync: true },
    "bankfeed.disconnect": {},
  };
  const needs: Record<string, BusinessPermission> = {
    "bankfeed.connect": "configure",
    "bankfeed.accounts": "draft",
    "bankfeed.link": "configure",
    "bankfeed.unlink": "configure",
    "bankfeed.sync": "draft",
    "bankfeed.status": "read",
    "bankfeed.settings": "configure",
    "bankfeed.disconnect": "configure",
  };
  for (const [name, permission] of Object.entries(needs)) {
    const withoutAny = await w.call(name, inputs[name], uuid(), []);
    expect(withoutAny.status, `${name} with no permission`).toBe(403);
    // Holding every other permission is not enough.
    const others = (
      ["read", "draft", "post", "configure", "correct", "close"] as BusinessPermission[]
    ).filter((p) => p !== permission);
    const wrong = await w.call(name, inputs[name], uuid(), others);
    expect(wrong.status, `${name} without ${permission}`).toBe(403);
    expect(wrong.body.error.code).toBe("permission_denied");
  }
  // A read-only agent can see the state and nothing else.
  expect((await w.call("bankfeed.status", {}, undefined, READ)).status).toBe(200);
  expect((await w.call("bankfeed.sync", {}, uuid(), READ)).status).toBe(403);
  // A drafting agent can bring money in, and cannot connect, link, disconnect or schedule.
  expect((await w.call("bankfeed.accounts", {}, uuid(), DRAFT)).status).toBe(200);
  expect((await w.call("bankfeed.sync", {}, uuid(), DRAFT)).status).toBe(200);
  for (const name of [
    "bankfeed.connect",
    "bankfeed.link",
    "bankfeed.unlink",
    "bankfeed.settings",
    "bankfeed.disconnect",
  ])
    expect((await w.call(name, inputs[name], uuid(), DRAFT)).status, name).toBe(403);
  // Configuring allows the owner's own decisions, and still not bringing money in.
  expect((await w.call("bankfeed.settings", { dailySync: true }, uuid(), CONFIGURE)).status).toBe(
    200,
  );
  expect((await w.call("bankfeed.sync", {}, uuid(), CONFIGURE)).status).toBe(403);
});

test("an effectful operation needs an identity, and input is checked strictly", async () => {
  const w = await world({ connected: true });
  const ids = await chartIds(w);
  for (const [name, input] of [
    ["bankfeed.accounts", {}],
    ["bankfeed.sync", {}],
    ["bankfeed.settings", { dailySync: false }],
    ["bankfeed.link", { accountId: "ACT-checking-0001", ledgerAccountId: ids["1000"] }],
    ["bankfeed.disconnect", {}],
  ] as const) {
    const reply = await w.call(name, input);
    expect(reply.status, name).toBe(400);
    expect(reply.body.error.code).toBe("operation_id_required");
  }
  const cases: [string, unknown][] = [
    ["bankfeed.sync", { budgetSeconds: 0 }],
    ["bankfeed.sync", { budgetSeconds: 26 }],
    ["bankfeed.sync", { budgetSeconds: "5" }],
    ["bankfeed.sync", { unknown: true }],
    ["bankfeed.sync", { accountId: 5 }],
    ["bankfeed.link", { accountId: "ACT-checking-0001" }],
    ["bankfeed.link", { ledgerAccountId: ids["1000"] }],
    ["bankfeed.link", { accountId: "A", ledgerAccountId: "not an id!" }],
    ["bankfeed.link", { accountId: "A", ledgerAccountId: ids["1000"], startOn: "tomorrow" }],
    ["bankfeed.connect", { setupToken: 5 }],
    ["bankfeed.connect", {}],
    ["bankfeed.connect", { setupToken: "x", extra: 1 }],
    ["bankfeed.settings", { dailySync: "yes" }],
    ["bankfeed.settings", { dailyAt: 6 }],
    ["bankfeed.status", { books: "no" }],
    ["bankfeed.accounts", { surprise: 1 }],
  ];
  for (const [name, input] of cases) {
    const reply = await w.call(name, input, uuid());
    expect(reply.status, `${name} ${JSON.stringify(input)}`).toBe(400);
  }
});

// ---- settings ------------------------------------------------------------------------------------------

test("the daily sync is off until the owner turns it on, and its time is a local HH:MM", async () => {
  const w = await world();
  expect((await w.ok("bankfeed.status", {})).settings).toEqual({
    dailySync: false,
    dailyAt: "06:17",
  });
  expect(await w.ok("bankfeed.settings", { dailySync: true })).toEqual({
    dailySync: true,
    dailyAt: "06:17",
  });
  expect(await w.ok("bankfeed.settings", { dailyAt: "23:41" })).toEqual({
    dailySync: true,
    dailyAt: "23:41",
  });
  for (const bad of ["24:00", "6:17", "06:60", "06:7", "0617", "06:17 ", "ab:cd", ""]) {
    const reply = await w.call("bankfeed.settings", { dailyAt: bad }, uuid());
    expect(reply.status, bad).toBe(400);
    expect(reply.body.error.code).toBe("invalid_input");
  }
  // Refused input changed nothing, and the choice survives a restart.
  await w.restart();
  expect((await w.ok("bankfeed.status", {})).settings).toEqual({
    dailySync: true,
    dailyAt: "23:41",
  });
  expect(await w.ok("bankfeed.settings", { dailySync: false })).toEqual({
    dailySync: false,
    dailyAt: "23:41",
  });
});

// ---- what the status says ---------------------------------------------------------------------------------

test("a book that never connected has nothing to say, and nothing needs attention", async () => {
  const w = await world();
  const status = await w.ok("bankfeed.status", {});
  expect(status).toMatchObject({
    connected: false,
    credential: { present: false, host: null, problem: null },
    bookCurrency: "USD",
    accounts: [],
    linked: 0,
    unlinked: 0,
    attention: [],
    problems: [],
    lastSync: null,
    history: [],
    held: [],
    heldCount: 0,
    scheduler: false,
  });
  expect(status.requests).toEqual({
    used: 0,
    limit: 24,
    budget: 20,
    freesAt: null,
    pausedUntil: null,
  });
  expect(w.bridge.log).toHaveLength(0);
});

test("the status makes no request to the Bridge, and a quick one reads nothing from the ledger", async () => {
  const w = await world({ connected: true });
  await linkByCode(w, "ACT-checking-0001", "1000", "2026-09-01");
  await w.ok("bankfeed.sync", {});
  const asked = w.bridge.log.length;
  const full = await w.ok("bankfeed.status", {});
  const quick = await w.ok("bankfeed.status", { books: false });
  expect(w.bridge.log).toHaveLength(asked);
  expect(full.accounts[0].link).toMatchObject({
    ledgerAccount: "1000 Business Checking",
    sourceStartOn: "2026-09-01",
  });
  expect(full.accounts[0].link.feedBalance).not.toBeNull();
  expect(quick.accounts[0].link).toMatchObject({
    ledgerAccount: null,
    sourceStartOn: null,
    feedBalance: null,
  });
  // The rest is the same.
  expect(quick.linked).toBe(full.linked);
  expect(quick.lastSync).toEqual(full.lastSync);
});

test("a feed that has not synced for three days is called stale, and a sync clears it", async () => {
  const w = await world({ connected: true });
  await linkByCode(w, "ACT-checking-0001", "1000", "2026-09-01");
  await w.ok("bankfeed.sync", {});
  advance(w, 2 * DAY_MS);
  expect(
    (await w.ok("bankfeed.status", {})).attention.map((a: { code: string }) => a.code),
  ).not.toContain("stale");
  advance(w, 2 * DAY_MS);
  const stale = (await w.ok("bankfeed.status", {})).attention.find(
    (a: { code: string }) => a.code === "stale",
  );
  expect(stale.severity).toBe("warning");
  expect(stale.message).toContain("4 days ago");
  await w.ok("bankfeed.sync", {});
  expect(
    (await w.ok("bankfeed.status", {})).attention.map((a: { code: string }) => a.code),
  ).not.toContain("stale");
});

test("connected with nothing linked is flagged as unfinished setup, most important first", async () => {
  const w = await world({ connected: true });
  const status = await w.ok("bankfeed.status", {});
  expect(
    status.attention.map((a: { code: string; severity: string }) => [a.code, a.severity]),
  ).toEqual([["no_links", "warning"]]);
  // Severity orders the list: an error comes before a warning.
  w.bridge.problems = [{ code: "con.auth", msg: "Sign in again.", conn_id: "CON-bank-a" }];
  advance(w, HOUR);
  await w.ok("bankfeed.accounts", {});
  const worse = await w.ok("bankfeed.status", {});
  expect(worse.attention.map((a: { severity: string }) => a.severity)).toEqual([
    "error",
    "warning",
  ]);
});

test("a transaction list is paged by the Inbox, so the status stays small however much was imported", async () => {
  const transactions = Array.from({ length: 300 }, (_, i) => ({
    id: `BULK-${i}`,
    posted: Date.UTC(2026, 9, 1, 8) / 1000 + i * 60,
    amount: `-${(i % 90) + 1}.00`,
    description: `LINE ${i}`,
  }));
  const w = await world({
    accounts: [
      {
        id: "ACT-checking-0001",
        name: "Business Checking",
        balance: "1.00",
        balanceDate: Date.UTC(2026, 9, 4, 12) / 1000,
        connId: "CON-bank-a",
        transactions,
      },
    ],
    connected: true,
  });
  await linkByCode(w, "ACT-checking-0001", "1000", "2026-09-01");
  const reply = (await w.ok("bankfeed.sync", {})).run;
  expect(reply.newLines).toBe(300);
  const status = await w.ok("bankfeed.status", {});
  expect(JSON.stringify(status).length).toBeLessThan(20_000);
});
