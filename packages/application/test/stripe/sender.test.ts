import { afterEach, expect, test } from "bun:test";
import { sliceState } from "../../src/slices/state.ts";
import {
  PullError,
  type PullReply,
  type SenderDeps,
  instantOf,
  pullStripe,
  stripeGetter,
} from "../../src/agent/index.ts";
import { BUNDLE_UPLOAD } from "./bundle.ts";
import type { FakeStripe } from "./fake-stripe.ts";
import { KEY, type World, acceptAndPost, journals, linesOf, uuid, world } from "./slice-support.ts";
import { yearOfActivity } from "./year.ts";

/** The sender that is not the command line: the control Worker's loop, in TypeScript, holding the same protocol. These tests hold it to what the sync books, as the command line's are
 * held, and to the rules a sender keeps: it makes only the requests the lane makes, sends its key to Stripe alone, and carries on from where a stopped pull was. */

const open: World[] = [];
afterEach(() => {
  for (const w of open.splice(0)) w.close();
});
async function fresh(options: Parameters<typeof world>[0] = {}): Promise<World> {
  const w = await world({ realPort: true, ...options });
  open.push(w);
  await w.call("stripe.configure", { timeZone: "America/Denver" }, uuid());
  return w;
}
const keyless = (options: Parameters<typeof world>[0] = {}) =>
  fresh({ key: null, senderFetches: true, ...options });

class Refused extends Error {
  readonly retryable: boolean;
  constructor(
    readonly code: string,
    retryable = false,
  ) {
    super(code);
    this.retryable = retryable;
  }
}

/** The workspace as the control Worker reaches it: the same two doors the command line uses, called in-process. */
function depsFor(w: World, stripe: FakeStripe = w.stripe, key: string = KEY): SenderDeps {
  return {
    async receive(input) {
      const reply = await w.call("stripe.receive", input, uuid());
      if (!reply.body.ok) throw new Refused(reply.body.error.code);
      return reply.body.data as PullReply;
    },
    async upload(bundle) {
      const stored = await w.upload(bundle, BUNDLE_UPLOAD);
      if (stored.status !== 200) throw new Refused(stored.body.error?.code ?? "upload_failed");
      return stored.body.data.sha256 as string;
    },
    get: stripeGetter({ key, fetch: stripe.fetch, sleep: async () => {} }),
    now: () => w.clock.ms,
    sleep: async () => {},
  };
}

const asOfOf = (w: World): string => instantOf(w.clock.ms);

async function booked(w: World): Promise<string[]> {
  await acceptAndPost(w);
  return (await journals(w))
    .map((j) => `${j.isoDate} ${j.reference} ${j.amount} | ${linesOf(j).join("; ")}`)
    .sort();
}

const inboxLines = async (w: World): Promise<string[]> => {
  const out: string[] = [];
  for (let page = 1; page < 100; page++) {
    const reply = await w.call("inbox.list", { pageSize: 200, page });
    const items = reply.body.data.items as { line: unknown }[];
    out.push(...items.map((item) => JSON.stringify(item.line)));
    if (out.length >= reply.body.data.count || items.length === 0) break;
  }
  return out.sort();
};

test("a pull by this sender books exactly what a sync books: the same journals, the same evidence", async () => {
  const synced = await fresh();
  expect((await synced.call("stripe.sync", {}, uuid())).body.data.run.payouts).toBe(6);

  const pulled = await keyless();
  const summary = await pullStripe(depsFor(pulled), {
    asOf: asOfOf(pulled),
    livemode: true,
  });
  expect(summary.finished).toBe(true);
  expect(summary.stopped).toBeNull();
  expect(summary.payouts).toBe(6);
  expect(await inboxLines(pulled)).toEqual(await inboxLines(synced));
  const expected = await booked(synced);
  expect(expected.length).toBeGreaterThan(0);
  expect(await booked(pulled)).toEqual(expected);
  const status = (await pulled.call("stripe.status")).body.data;
  expect(status.mode).toBe("live");
  expect(status.balance).toMatchObject({ difference: "0.00", ties: true });
});

test("lists of many pages are read on unasked, and land the same books as the sync", async () => {
  const synced = await fresh({ maxLimit: 7 });
  await synced.call("stripe.sync", { budgetSeconds: 25 }, uuid());
  const pulled = await keyless({ maxLimit: 7 });
  const summary = await pullStripe(depsFor(pulled), { asOf: asOfOf(pulled), livemode: true });
  expect(summary.finished).toBe(true);
  expect(await booked(pulled)).toEqual(await booked(synced));
});

test("the sender asks Stripe for what the workspace named, with the key in a header and nowhere else, and only reads", async () => {
  const w = await keyless();
  await pullStripe(depsFor(w), { asOf: asOfOf(w), livemode: true });
  expect(w.stripe.seen.length).toBeGreaterThan(0);
  for (const seen of w.stripe.seen) {
    expect(seen.method).toBe("GET");
    expect(seen.authorised).toBe(true);
    expect(seen.keyInUrl).toBe(false);
    expect(seen.stripeVersion).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[a-z]+)?$/);
  }
});

test("a request the lane does not make is never made, whoever asks", async () => {
  const w = await keyless();
  const deps = depsFor(w);
  const asked: string[] = [];
  const hostile: SenderDeps = {
    ...deps,
    async receive() {
      return {
        more: true,
        needs: ["/v1/customers?limit=100"],
        apiVersion: "2026-09-30.endive",
        run: { payouts: 0, newLines: 0, duplicateLines: 0, heldLines: 0, through: null, notes: [] },
      };
    },
    async get(request, version) {
      asked.push(request);
      return deps.get(request, version);
    },
  };
  const outcome = await pullStripe(hostile, { asOf: asOfOf(w), livemode: true }).catch(
    (error) => error,
  );
  expect(outcome).toBeInstanceOf(PullError);
  expect((outcome as PullError).code).toBe("request_refused");
  expect(asked).toEqual([]);
  expect(w.stripe.seen).toEqual([]);
});

test("a pull with a budget stops before it makes its requests, and the same pull carries on in the next attempt and lands the same books", async () => {
  const scenario = yearOfActivity();
  const make = async (options: Parameters<typeof world>[0]) => {
    const w = await fresh({ scenario, ...options });
    w.clock.ms = Date.parse("2027-01-02T13:00:00Z");
    await w.call("stripe.configure", { syncFrom: "2026-01-01" }, uuid());
    return w;
  };
  const synced = await make({});
  for (let more = true, calls = 0; more && calls < 100; calls++)
    more = (await synced.call("stripe.sync", { budgetSeconds: 25 }, uuid())).body.data.more;

  const pulled = await make({ key: null, senderFetches: true });
  // One instant for the whole pull, kept between attempts: the workspace holds what it was delivered for this pull, and asks for the rest.
  const asOf = asOfOf(pulled);
  let attempts = 0;
  let stripeRequests = 0;
  let booked = 0;
  for (;;) {
    attempts += 1;
    const summary = await pullStripe(depsFor(pulled), {
      asOf,
      livemode: true,
      maxStripeRequests: 25,
    });
    stripeRequests += summary.stripeRequests;
    booked += summary.payouts;
    if (summary.finished) break;
    expect(summary.stopped).toBe("requests");
    expect(attempts).toBeLessThan(30);
  }
  // It took several attempts, and each made progress: the whole year, and no payout twice.
  expect(attempts).toBeGreaterThan(2);
  expect(booked).toBe(scenario.payouts.length);
  expect(await inboxLines(pulled)).toEqual(await inboxLines(synced));
  const status = (await pulled.call("stripe.status")).body.data;
  expect(status.payouts).toMatchObject({
    known: scenario.payouts.length,
    booked: scenario.payouts.length,
    mismatched: 0,
    waiting: 0,
  });
  expect(status.balance).toMatchObject({ difference: "0.00", ties: true });
  console.info(
    `stripe sender: ${scenario.entries.length} balance transactions, ${scenario.payouts.length} payouts in ${attempts} attempts of at most 25 requests, ${stripeRequests} requests made of Stripe`,
  );
}, 600_000);

test("a workspace that forgot the pull between attempts (another pod took the book) is delivered it again, and the pull still finishes", async () => {
  const scenario = yearOfActivity();
  const make = async (options: Parameters<typeof world>[0]) => {
    const w = await fresh({ scenario, ...options });
    w.clock.ms = Date.parse("2027-01-02T13:00:00Z");
    await w.call("stripe.configure", { syncFrom: "2026-01-01" }, uuid());
    return w;
  };
  const pulled = await make({ key: null, senderFetches: true });
  const asOf = asOfOf(pulled);
  let attempts = 0;
  for (;;) {
    attempts += 1;
    // The first three attempts each find the workspace without what the one before delivered; after that it keeps it.
    if (attempts <= 3)
      sliceState(pulled.service, "stripe.delivered", () => ({ current: null })).current = null;
    const summary = await pullStripe(depsFor(pulled), {
      asOf,
      livemode: true,
      maxStripeRequests: 900,
    });
    if (summary.finished) break;
    expect(attempts).toBeLessThan(20);
  }
  const status = (await pulled.call("stripe.status")).body.data;
  expect(status.payouts).toMatchObject({
    known: scenario.payouts.length,
    booked: scenario.payouts.length,
  });
  expect(status.balance).toMatchObject({ difference: "0.00", ties: true });
}, 600_000);

test("a pull that is out of time stops without making a request it could not deliver", async () => {
  const w = await keyless();
  const summary = await pullStripe(depsFor(w), {
    asOf: asOfOf(w),
    livemode: true,
    deadline: w.clock.ms - 1,
  });
  expect(summary.finished).toBe(false);
  expect(summary.stopped).toBe("time");
  expect(summary.stripeRequests).toBe(0);
  expect(w.stripe.seen).toEqual([]);
});

test("a workspace that says it is busy is asked again after a wait, and the pull finishes", async () => {
  const w = await keyless();
  const deps = depsFor(w);
  let refusals = 0;
  const waits: number[] = [];
  const busy: SenderDeps = {
    ...deps,
    async receive(input) {
      if (refusals < 2) {
        refusals += 1;
        throw new Refused("rate_limited", true);
      }
      return deps.receive(input);
    },
    async sleep(ms) {
      waits.push(ms);
    },
  };
  const summary = await pullStripe(busy, { asOf: asOfOf(w), livemode: true });
  expect(summary.finished).toBe(true);
  expect(refusals).toBe(2);
  // The wait grows with each try.
  expect(waits.length).toBeGreaterThanOrEqual(2);
  expect(waits[1]).toBeGreaterThan(waits[0] as number);
});

test("a refusal that asking again will not change ends the pull, and says what it was", async () => {
  const w = await keyless();
  const deps = depsFor(w);
  const refused: SenderDeps = {
    ...deps,
    async receive() {
      throw new Refused("stripe_mode_changed");
    },
  };
  const error = await pullStripe(refused, { asOf: asOfOf(w), livemode: true }).catch((e) => e);
  expect((error as Refused).code).toBe("stripe_mode_changed");
});

test("the sender says which mode its answers are, in every call", async () => {
  const w = await keyless();
  const deps = depsFor(w);
  const modes: boolean[] = [];
  const watching: SenderDeps = {
    ...deps,
    async receive(input) {
      modes.push(input.livemode);
      return deps.receive(input);
    },
  };
  await pullStripe(watching, { asOf: asOfOf(w), livemode: true });
  expect(modes.length).toBeGreaterThan(1);
  expect(modes.every((mode) => mode)).toBe(true);
});

// ----- the one read of Stripe -----

const answerOf = (status: number, body = "{}", headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers });

test("a read of Stripe is tried again when Stripe is limiting requests or has a fault, and then given up", async () => {
  const waits: number[] = [];
  let calls = 0;
  const flaky: typeof fetch = (async () => {
    calls += 1;
    return calls < 3
      ? answerOf(calls === 1 ? 429 : 503, "{}", { "retry-after": "2" })
      : answerOf(200, '{"ok":1}');
  }) as unknown as typeof fetch;
  const get = stripeGetter({ key: KEY, fetch: flaky, sleep: async (ms) => void waits.push(ms) });
  const got = await get("/v1/balance", "2026-09-30.endive");
  expect(got.status).toBe(200);
  expect(new TextDecoder().decode(got.body)).toBe('{"ok":1}');
  expect(calls).toBe(3);
  // Stripe's own Retry-After is honoured.
  expect(waits).toContain(2000);

  const down = (async () => answerOf(500)) as unknown as typeof fetch;
  const error = await stripeGetter({ key: KEY, fetch: down, sleep: async () => {} })(
    "/v1/balance",
    "2026-09-30.endive",
  ).catch((e) => e);
  expect(error).toBeInstanceOf(PullError);
  expect((error as PullError).code).toBe("stripe_unreachable");
  expect((error as PullError).message).not.toContain(KEY);
});

test("a refusal by Stripe is returned as it is, for the workspace to say what it means", async () => {
  const refusing: typeof fetch = (async () =>
    answerOf(403, '{"error":{"message":"The key lacks a permission"}}')) as unknown as typeof fetch;
  const got = await stripeGetter({ key: KEY, fetch: refusing })("/v1/balance", "2026-09-30.endive");
  expect(got.status).toBe(403);
});

test("the account a read acts for is named in a header, the key is sent as a bearer, and redirects are never followed", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const watching: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = { url: String(input), init: init as RequestInit };
    return answerOf(200);
  }) as unknown as typeof fetch;
  await stripeGetter({ key: KEY, account: "acct_1Customer0001", fetch: watching })(
    "/v1/balance_transactions?limit=100",
    "2026-09-30.endive",
  );
  expect(seen).not.toBeNull();
  const { url, init } = seen as unknown as { url: string; init: RequestInit };
  expect(url).toBe("https://api.stripe.com/v1/balance_transactions?limit=100");
  expect(url).not.toContain(KEY);
  const headers = init.headers as Record<string, string>;
  expect(headers.authorization).toBe(`Bearer ${KEY}`);
  expect(headers["stripe-account"]).toBe("acct_1Customer0001");
  expect(headers["stripe-version"]).toBe("2026-09-30.endive");
  expect(init.method).toBe("GET");
  expect(init.redirect).toBe("error");
});

test("a read outside the lane is refused before anything is sent", async () => {
  let calls = 0;
  const watching = (async () => {
    calls += 1;
    return answerOf(200);
  }) as unknown as typeof fetch;
  const get = stripeGetter({ key: KEY, fetch: watching });
  for (const request of [
    "/v1/customers",
    "//evil.example/v1/balance",
    "https://evil.example/v1/balance",
    "/v1/payouts/po_1/refunds",
    "/v1/payment_intents",
  ])
    expect(await get(request, "2026-09-30.endive").catch((e) => e)).toBeInstanceOf(PullError);
  expect(calls).toBe(0);
});
