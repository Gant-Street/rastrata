import { expect, test } from "bun:test";
import { currencyExponent, isoCurrency, minorToCents } from "../../src/stripe/amounts.ts";
import { type FetchFn, StripeClient, StripeError } from "../../src/stripe/client.ts";
import {
  addDays,
  dateFromDayNumber,
  dayNumber,
  daysBetween,
  isDate,
  isTimeZone,
  localDate,
  startOfLocalDay,
  utcDate,
} from "../../src/stripe/dates.ts";
import {
  decodeAccount,
  decodeBalance,
  decodeBalanceTransaction,
  decodeBalanceTransactionPage,
  decodePayout,
} from "../../src/stripe/decode.ts";
import { redact, safeText } from "../../src/stripe/redact.ts";
import { ROLE_KINDS, STRIPE_ROLES, isStripeRole } from "../../src/stripe/roles.ts";
import {
  accountObject,
  balanceTransaction,
  fakeKey,
  listOf,
  payoutObject,
  ts,
} from "./fixtures.ts";

const KEY = fakeKey();

test("minor units become exact hundredths, or nothing", () => {
  expect(minorToCents(1912n, "USD")).toBe(1912n);
  expect(minorToCents(-5n, "usd")).toBe(-5n);
  expect(minorToCents(500n, "JPY")).toBe(50_000n);
  expect(minorToCents(1_230n, "KWD")).toBe(123n);
  expect(minorToCents(1_231n, "KWD")).toBeNull();
  // ISK and UGX are still two-decimal in Stripe's API.
  expect(currencyExponent("ISK")).toBe(2);
  expect(currencyExponent("UGX")).toBe(2);
  expect(isoCurrency("usd")).toBe("USD");
  expect(isoCurrency("us")).toBeNull();
  expect(isoCurrency(5)).toBeNull();
});

test("dates are cut in the owner's zone with no drift across daylight saving", () => {
  const instant = ts("2026-03-04T02:30:00Z");
  expect(localDate(instant, "UTC")).toBe("2026-03-04");
  expect(localDate(instant, "America/Denver")).toBe("2026-03-03");
  expect(utcDate(instant)).toBe("2026-03-04");
  // Denver springs forward on 2026-03-08 and falls back on 2026-11-01.
  expect(startOfLocalDay("2026-03-07", "America/Denver")).toBe(ts("2026-03-07T07:00:00Z"));
  expect(startOfLocalDay("2026-03-09", "America/Denver")).toBe(ts("2026-03-09T06:00:00Z"));
  expect(startOfLocalDay("2026-11-02", "America/Denver")).toBe(ts("2026-11-02T07:00:00Z"));
  for (const day of ["2026-03-08", "2026-11-01", "2026-06-15", "2027-01-01"])
    for (const zone of ["America/Denver", "Pacific/Auckland", "UTC", "Asia/Kolkata"])
      expect(localDate(startOfLocalDay(day, zone), zone)).toBe(day);
  expect(isTimeZone("America/Denver")).toBe(true);
  expect(isTimeZone("Not/AZone")).toBe(false);
  expect(isTimeZone("../etc/passwd")).toBe(false);
  expect(isTimeZone("")).toBe(false);
});

test("day arithmetic is exact and never goes through a zone", () => {
  expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
  expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  expect(daysBetween("2026-03-01", "2026-03-04")).toBe(3);
  expect(dateFromDayNumber(dayNumber("2028-02-29"))).toBe("2028-02-29");
  expect(isDate("2026-02-30")).toBe(false);
  expect(isDate("2026-2-3")).toBe(false);
  expect(isDate("2026-03-04")).toBe(true);
  expect(() => dayNumber("tomorrow")).toThrow();
});

test("secrets and control characters are scrubbed from anything that leaves the lane", () => {
  const message = `bad key ${KEY}, header Bearer abcdefgh12345678 and ${"rk_"}test_SOMETHINGELSE12345678`;
  const scrubbed = redact(message, [KEY]);
  expect(scrubbed).not.toContain(KEY);
  expect(scrubbed).not.toContain("abcdefgh12345678");
  expect(scrubbed).not.toContain("SOMETHINGELSE");
  expect(redact("short", ["abc"])).toBe("short");
  const text = safeText(
    `a${String.fromCharCode(0)}b${String.fromCharCode(0x2028)}c\n${"x".repeat(500)}`,
    {
      max: 20,
    },
  );
  expect(text.length).toBeLessThanOrEqual(20);
  expect(text.startsWith("a b c\n")).toBe(true);
  expect(safeText(42)).toBe("");
});

test("seven roles are the contract with the chart lane, the eighth is the lane's own and optional, and each knows its kind of account", () => {
  expect([...STRIPE_ROLES]).toEqual([
    "stripe.balance",
    "stripe.fees",
    "payouts.in-transit",
    "refunds",
    "chargebacks",
    "tax.sales",
    "revenue.sales",
    "stripe.adjustments",
  ]);
  expect(ROLE_KINDS["stripe.balance"]).toEqual(["asset"]);
  expect(ROLE_KINDS["tax.sales"]).toEqual(["liability"]);
  expect(ROLE_KINDS["stripe.adjustments"]).toEqual(["expense", "income"]);
  expect(isStripeRole("refunds")).toBe(true);
  expect(isStripeRole("stripe.adjustments")).toBe(true);
  expect(isStripeRole("cash")).toBe(false);
});

test("decoders refuse what is not Stripe's shape and say where", () => {
  const good = balanceTransaction(1, {
    category: "charge",
    type: "charge",
    amount: 2000,
    fee: 88,
    created: ts("2026-03-02T10:00:00Z"),
    source: "ch_1Fixture00000000000001",
  });
  expect(decodeBalanceTransaction(good).ok).toBe(true);
  const cases: [string, unknown, RegExp][] = [
    ["a string amount", { ...good, amount: "2000" }, /amount is not a whole number/],
    ["a float", { ...good, fee: 88.5 }, /fee is not a whole number/],
    ["a missing net", { ...good, net: undefined }, /net is missing/],
    ["a bad currency", { ...good, currency: "dollars" }, /currency is not a three-letter/],
    ["a hostile type", { ...good, type: "charge; DROP TABLE" }, /type is not a plain identifier/],
    ["the wrong object", { ...good, object: "charge" }, /object is not "balance_transaction"/],
    ["a bad fee list", { ...good, fee_details: "none" }, /fee_details is not an array/],
    ["a bad id", { ...good, id: "../../etc" }, /id is not a recognised/],
    ["a number", 5, /is not an object/],
  ];
  for (const [, input, message] of cases) {
    const result = decodeBalanceTransaction(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toMatch(message);
  }
  expect(decodeBalanceTransactionPage({ object: "list", data: "x", has_more: false }).ok).toBe(
    false,
  );
  expect(
    decodeBalanceTransactionPage(listOf("/v1/balance_transactions", [good, 5], false)).ok,
  ).toBe(false);
  const payout = payoutObject(1, { amount: 100, created: 1, arrival: "2026-03-05", btId: null });
  expect(decodePayout(payout).ok).toBe(true);
  expect(decodePayout({ ...payout, arrival_date: "soon" }).ok).toBe(false);
  expect(
    decodeBalance({ object: "balance", available: [{ amount: 1.5, currency: "usd" }], pending: [] })
      .ok,
  ).toBe(false);
  const account = decodeAccount(accountObject("America/Denver"));
  expect(account.ok && account.value.dashboardTimeZone).toBe("America/Denver");
  expect(
    decodeAccount({ ...accountObject(), settings: { dashboard: { timezone: "../x" } } }),
  ).toMatchObject({
    ok: true,
    value: { dashboardTimeZone: null },
  });
});

const client = (
  fetcher: FetchFn,
  extra: Partial<ConstructorParameters<typeof StripeClient>[0]> = {},
): { client: StripeClient; sleeps: number[] } => {
  const sleeps: number[] = [];
  return {
    sleeps,
    client: new StripeClient({
      key: KEY,
      fetch: fetcher,
      now: () => 1_000_000,
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 0.5,
      ...extra,
    }),
  };
};

test("the client reads only Stripe's /v1/ paths, over https, without following redirects", async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const { client: c } = client((async (input, init) => {
    seen.push({ url: String(input), ...(init ? { init } : {}) });
    return Response.json({ object: "list", data: [], has_more: false, url: "/v1/x" });
  }) as FetchFn);
  await c.get("/v1/balance", [["expand[]", "x"]]);
  expect(seen[0]?.url).toBe("https://api.stripe.com/v1/balance?expand%5B%5D=x");
  expect(seen[0]?.init?.method).toBe("GET");
  expect(seen[0]?.init?.redirect).toBe("error");
  const headers = new Headers(seen[0]?.init?.headers);
  expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
  expect(seen[0]?.url).not.toContain(KEY);
  await expect(c.get("/v2/anything")).rejects.toThrow(/Only Stripe \/v1\/ paths/);
  expect(
    () => new StripeClient({ key: KEY, fetch, now: () => 0, baseUrl: "http://example.com" }),
  ).toThrow(/https/);
  expect(
    () => new StripeClient({ key: KEY, fetch, now: () => 0, baseUrl: "http://127.0.0.1:9" }),
  ).not.toThrow();
});

test("a network failure, even one that mentions the key, becomes a fixed message", async () => {
  const { client: c, sleeps } = client((async () => {
    throw new Error(`connect ECONNREFUSED https://${KEY}@api.stripe.com`);
  }) as FetchFn);
  const error = await c.get("/v1/balance").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(StripeError);
  expect((error as StripeError).message).not.toContain(KEY);
  expect((error as StripeError).code).toBe("stripe_unavailable");
  expect(sleeps.length).toBe(3);
});

test("backoff grows, is jittered within bounds, and honours Retry-After up to a cap", async () => {
  let calls = 0;
  const { client: c, sleeps } = client((async () => {
    calls++;
    return new Response("{}", { status: 503 });
  }) as FetchFn);
  await c.get("/v1/balance").catch(() => undefined);
  expect(calls).toBe(4);
  // 250, 500, 1000 ms exponential with half jitter at random = 0.5: 187, 375, 750.
  expect(sleeps).toEqual([188, 375, 750]);
  const limited = client(
    (async () => new Response("{}", { status: 429, headers: { "retry-after": "999" } })) as FetchFn,
  );
  await limited.client.get("/v1/balance").catch(() => undefined);
  expect(limited.sleeps.every((ms) => ms === 10_000)).toBe(true);
  const odd = client(
    (async () =>
      new Response("{}", { status: 429, headers: { "retry-after": "soon" } })) as FetchFn,
  );
  await odd.client.get("/v1/balance").catch(() => undefined);
  expect(odd.sleeps.every((ms) => ms <= 8000)).toBe(true);
});

test("a deadline stops new work and never waits past it", async () => {
  const budget = { deadline: 1_000_000 + 100, maxRequests: 100, used: 0 };
  const { client: c, sleeps } = client(
    (async () => new Response("{}", { status: 503 })) as FetchFn,
    {
      budget,
    },
  );
  const error = await c.get("/v1/balance").catch((e: unknown) => e);
  expect((error as Error).name).toBe("BudgetExhausted");
  expect(sleeps).toEqual([]);
});

test("a body that is not valid UTF-8 JSON, or is far too large, is refused", async () => {
  const bad = client((async () => new Response(new Uint8Array([0xff, 0xfe, 0x7b]))) as FetchFn);
  expect(((await bad.client.get("/v1/balance").catch((e: unknown) => e)) as StripeError).code).toBe(
    "stripe_bad_response",
  );
  const large = client((async () => new Response(new Uint8Array(17 * 1024 * 1024))) as FetchFn);
  expect(
    ((await large.client.get("/v1/balance").catch((e: unknown) => e)) as StripeError).message,
  ).toMatch(/larger than expected/);
});
