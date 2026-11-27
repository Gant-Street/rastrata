import { afterEach, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { configureBankfeedRuntime } from "../../src/slices/bankfeed/runtime.ts";
import { FIXTURE_PASSWORD } from "./fake-bridge.ts";
import {
  DAY_MS,
  HOUR,
  type World,
  advance,
  closeWorlds,
  linkByCode,
  uuid,
  world,
} from "./support.ts";

afterEach(closeWorlds);

const sync = (w: World, input: Record<string, unknown> = {}) =>
  w.call("bankfeed.sync", input, uuid());
const MINUTES = 60_000;

async function ready(startOn = "2026-09-01") {
  const w = await world({ connected: true });
  await linkByCode(w, "ACT-checking-0001", "1000", startOn);
  return w;
}

/** The most requests the Bridge saw in any rolling 24 hours. */
function busiestDay(w: World): number {
  const times = w.bridge.requests("accounts").map((r) => r.at);
  let most = 0;
  for (const start of times)
    most = Math.max(most, times.filter((t) => t >= start && t < start + 86_400).length);
  return most;
}

test("the day's budget stops Rastrata at 20 of the Bridge's 24 requests, however often it is asked", async () => {
  const w = await ready();
  let paused: { reason: string; until: string | null } | null = null;
  // Each sync is half an hour after the last, so each one asks the Bridge what exists and then reads.
  for (let round = 0; round < 40 && paused === null; round++) {
    advance(w, 31 * MINUTES);
    const reply = await sync(w);
    expect(reply.status).toBe(200);
    paused = reply.body.data.paused;
  }
  expect(paused).not.toBeNull();
  expect(paused?.reason).toBe("daily_budget");
  expect(paused?.until).not.toBeNull();
  // Never more than 20 in any 24 hours, and the status says where it stands.
  expect(busiestDay(w)).toBeLessThanOrEqual(20);
  const status = await w.ok("bankfeed.status", {});
  expect(status.requests).toMatchObject({ used: 20, limit: 24, budget: 20 });
  expect(status.lastSync.disposition).toBe("paused");
  expect(status.lastSync.errorCode).toBeNull();

  // Asked again, it makes no request at all.
  const before = w.bridge.log.length;
  advance(w, 31 * MINUTES);
  const again = (await sync(w)).body.data;
  expect(again.paused.reason).toBe("daily_budget");
  expect(w.bridge.log.length).toBe(before);
  // Nor does listing the accounts, which says so and when it can ask again.
  const accounts = await w.call("bankfeed.accounts", {}, uuid());
  expect(accounts.status).toBe(429);
  expect(accounts.body.error.code).toBe("bankfeed_budget_spent");
  expect(accounts.body.error.retryable).toBe(true);
  expect(w.bridge.log.length).toBe(before);

  // A day on, the oldest requests have left the window and syncing carries on.
  advance(w, DAY_MS);
  const later = (await sync(w)).body.data;
  expect(later.paused).toBeNull();
  expect(later.run.disposition).toBe("complete");
  expect(busiestDay(w)).toBeLessThanOrEqual(20);
});

test("the count is kept in the book, so a restart does not forget what was asked", async () => {
  const w = await ready();
  for (let round = 0; round < 3; round++) {
    advance(w, 31 * MINUTES);
    await sync(w);
  }
  const used = (await w.ok("bankfeed.status", {})).requests.used;
  expect(used).toBeGreaterThan(4);
  await w.restart();
  expect((await w.ok("bankfeed.status", {})).requests.used).toBe(used);
});

test("a 429 pauses every request for a day, and says so", async () => {
  const w = await ready();
  w.bridge.respondOnce(429, "slow down", { "retry-after": "60" });
  advance(w, HOUR);
  const reply = (await sync(w)).body.data;
  expect(reply.paused).toMatchObject({ reason: "rate_limited" });
  expect(reply.paused.message).toContain("slow down");
  const status = await w.ok("bankfeed.status", {});
  expect(status.requests.pausedUntil).not.toBeNull();
  expect(status.attention.find((a: { code: string }) => a.code === "rate_limited")).toMatchObject({
    severity: "warning",
  });
  expect(status.attention.find((a: { code: string }) => a.code === "paused")).toBeDefined();
  // Nothing is asked for a day.
  const before = w.bridge.log.length;
  advance(w, 20 * HOUR);
  expect((await sync(w)).body.data.paused.reason).toBe("rate_limited");
  expect((await w.call("bankfeed.accounts", {}, uuid())).body.error.code).toBe(
    "bankfeed_rate_limited",
  );
  expect(w.bridge.log.length).toBe(before);
  // Then it carries on, and the warning goes.
  advance(w, 5 * HOUR);
  const resumed = (await sync(w)).body.data;
  expect(resumed.paused).toBeNull();
  expect(
    (await w.ok("bankfeed.status", {})).attention.map((a: { code: string }) => a.code),
  ).not.toContain("rate_limited");
});

test("a warning from the Bridge about too many requests, in either shape, stops Rastrata asking", async () => {
  const w = await ready();
  w.bridge.warnings = ["You are making more requests than expected. Please slow down."];
  advance(w, HOUR);
  const reply = (await sync(w)).body.data;
  expect(reply.paused?.reason).toBe("rate_limited");
  expect(reply.accounts[0].state).toBe("more");
  const asked = w.bridge.log.length;
  w.bridge.warnings = [];
  advance(w, 2 * HOUR);
  expect((await sync(w)).body.data.paused?.reason).toBe("rate_limited");
  expect(w.bridge.log.length).toBe(asked);
});

test("the Bridge's own range warnings are not a reason to stop", async () => {
  const w = await ready();
  w.bridge.problems = [
    { code: "gen.api", msg: "Requested date range exceeds limit of 90 days and was capped." },
  ];
  advance(w, HOUR);
  const reply = (await sync(w)).body.data;
  expect(reply.paused).toBeNull();
  // It still holds the cursor: the answer may have been cut.
  expect(reply.accounts[0].state).toBe("attention");
});

test("a refused access is reported, kept visible, and a new setup token replaces it", async () => {
  const w = await ready();
  w.bridge.respondOnce(403, {
    errlist: [{ code: "gen.auth", msg: "Forbidden" }],
    accounts: [],
    connections: [],
  });
  advance(w, HOUR);
  const refused = await sync(w);
  expect(refused.status).toBe(424);
  expect(refused.body.error.code).toBe("bankfeed_access_denied");
  expect(refused.body.error.message).toContain("create a new setup token");
  expect(refused.body.error.retryable).toBe(false);
  let status = await w.ok("bankfeed.status", {});
  expect(status.attention[0]).toMatchObject({ code: "access_denied", severity: "error" });
  expect(status.lastSync).toMatchObject({
    disposition: "failed",
    errorCode: "bankfeed_access_denied",
  });
  // The credential file is kept: only the owner decides to remove it.
  expect(statSync(w.credentialPath).isFile()).toBe(true);
  // Replacing a refused connection is allowed; a working one is not replaced.
  w.bridge.claimed = false;
  await w.ok("bankfeed.connect", { setupToken: w.bridge.setupToken() });
  status = await w.ok("bankfeed.status", {});
  expect(status.attention.map((a: { code: string }) => a.code)).not.toContain("access_denied");
  expect(status.linked).toBe(1);
});

test("a lapsed subscription is said plainly, and the secret is not in the message", async () => {
  const w = await ready();
  w.bridge.respondOnce(402, {
    errlist: [{ code: "gen.auth", msg: `Payment required for ${FIXTURE_PASSWORD}` }],
    accounts: [],
  });
  advance(w, HOUR);
  const reply = await sync(w);
  expect(reply.status).toBe(424);
  expect(reply.body.error.code).toBe("bankfeed_payment_required");
  expect(reply.body.error.message).toContain("subscription");
  expect(JSON.stringify(reply.body)).not.toContain(FIXTURE_PASSWORD);
  expect((await w.ok("bankfeed.status", {})).attention[0]).toMatchObject({
    code: "payment_required",
  });
});

test("the Bridge being unreachable is a retryable failure that spends two requests at most and changes nothing", async () => {
  const w = await ready();
  const before = (await w.ok("inbox.summary", {})).counts.total;
  w.bridge.failOnce();
  w.bridge.failOnce();
  advance(w, HOUR);
  const reply = await sync(w);
  expect(reply.status).toBe(502);
  expect(reply.body.error).toMatchObject({ code: "bankfeed_unavailable", retryable: true });
  expect(reply.body.error.message).not.toContain("simplefin.org");
  expect((await w.ok("inbox.summary", {})).counts.total).toBe(before);
  expect((await w.ok("bankfeed.status", {})).lastSync).toMatchObject({ disposition: "failed" });
});

test("a redirect or a broken answer is reported, never followed or half-used", async () => {
  const w = await ready();
  w.bridge.respondOnce(302, "", { location: "https://evil.example/" });
  advance(w, HOUR);
  const redirected = await sync(w);
  expect(redirected.body.error.code).toBe("bankfeed_redirected");
  expect(JSON.stringify(redirected.body)).not.toContain("evil.example");
  w.bridge.respondOnce(200, "<html>maintenance</html>");
  advance(w, HOUR);
  expect((await sync(w)).body.error.code).toBe("bankfeed_bad_response");
  // And once the Bridge is back, the feed is where it was.
  advance(w, HOUR);
  expect((await sync(w)).body.data.accounts[0].state).toBe("complete");
});

test("the listing is not asked for again within half an hour", async () => {
  const w = await ready();
  advance(w, 40 * MINUTES);
  await sync(w);
  const listings = () =>
    w.bridge.requests("accounts").filter((r) => r.query["balances-only"]).length;
  const after = listings();
  advance(w, 10 * MINUTES);
  await sync(w);
  expect(listings()).toBe(after);
  advance(w, 25 * MINUTES);
  await sync(w);
  expect(listings()).toBe(after + 1);
});

test("a sync with nothing connected or nothing linked asks for nothing", async () => {
  const w = await world();
  const refused = await sync(w);
  expect(refused.body.error.code).toBe("bankfeed_not_connected");
  expect(w.bridge.log).toHaveLength(0);
  const connected = await world({ connected: true });
  const before = connected.bridge.log.length;
  advance(connected, HOUR);
  const empty = (await sync(connected)).body.data;
  expect(empty.accounts).toEqual([]);
  expect(empty.run.notes.join(" ")).toContain("No Bridge account is linked");
  // At most the listing was asked.
  expect(connected.bridge.log.length).toBeLessThanOrEqual(before + 1);
});

test("the daily budget is shared by every way of asking", async () => {
  const w = await ready();
  configureBankfeedRuntime(w.service, {});
  let refused = 0;
  for (let round = 0; round < 30; round++) {
    advance(w, 31 * MINUTES);
    const accounts = await w.call("bankfeed.accounts", {}, uuid());
    if (accounts.status === 429) refused += 1;
  }
  expect(refused).toBeGreaterThan(0);
  expect(busiestDay(w)).toBeLessThanOrEqual(20);
});
