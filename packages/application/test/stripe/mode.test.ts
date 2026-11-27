import { afterEach, expect, test } from "bun:test";
import { ApplicationHttp } from "../../src/http.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../../src/schema.ts";
import { configureStripeRuntime } from "../../src/slices/stripe/runtime.ts";
import { BUNDLE_UPLOAD, bundleOf } from "./bundle.ts";
import type { FakeStripe } from "./fake-stripe.ts";
import { ACCOUNT_ID } from "./fixtures.ts";
import { pull } from "./pull-support.ts";
import { KEY, type World, uuid, world } from "./slice-support.ts";

/** Test data and real data are never in the same books, and the Stripe account the control plane connected for a workspace is told to the books, which turn away another at once.
 * The fake Stripe is a live account (its key is a live key and its objects say `livemode: true`); `practice` makes it answer a test key with the same objects labelled as Stripe
 * labels test mode. */

const open: World[] = [];
afterEach(() => {
  for (const w of open.splice(0)) w.close();
});

const TEST_KEY = ["rk", "test", "MODETestThisIsNotARealKey000"].join("_");

async function fresh(options: Parameters<typeof world>[0] = {}): Promise<World> {
  const w = await world({ realPort: true, ...options });
  open.push(w);
  await w.call("stripe.configure", { timeZone: "America/Denver" }, uuid());
  return w;
}

/** The same Stripe, as its test mode answers: a test key, and every object labelled `livemode: false`. */
function practiceStripe(stripe: FakeStripe): FakeStripe {
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${KEY}`);
    const answer = await stripe.fetch(input, { ...init, headers });
    const text = (await answer.text()).replaceAll('"livemode":true', '"livemode":false');
    return new Response(text, { status: answer.status, headers: answer.headers });
  }) as typeof fetch;
  return { ...stripe, fetch: fetcher };
}

/** The service reads Stripe's test mode from now on, with a test key. */
function readTestMode(w: World): void {
  configureStripeRuntime(w.service, {
    keySource: { read: () => ({ key: TEST_KEY, source: "environment" }) },
    fetch: practiceStripe(w.stripe).fetch,
  });
}

const modeOf = async (w: World): Promise<unknown> => (await w.call("stripe.status")).body.data.mode;

/** The lines of every provider in the Inbox, through the real pipeline. */
const linesIn = async (w: World): Promise<number> => {
  const page = (await w.call("inbox.list", { pageSize: 200 })).body.data;
  return (page.total ?? page.count ?? page.items.length) as number;
};

test("the books keep the mode of the first Stripe data they took: a test key cannot follow a live one", async () => {
  const w = await fresh();
  expect((await w.call("stripe.status")).body.data.mode).toBeNull();
  expect((await w.call("stripe.sync", {}, uuid())).body.ok).toBe(true);
  expect(await modeOf(w)).toBe("live");
  const lines = await linesIn(w);
  const requests = w.stripe.seen.length;

  readTestMode(w);
  const refused = await w.call("stripe.sync", {}, uuid());
  expect(refused.body.ok).toBe(false);
  expect(refused.status).toBe(409);
  expect(refused.body.error.code).toBe("stripe_mode_changed");
  expect(refused.body.error.message).toContain("live mode (real sales)");
  // Nothing was asked of Stripe and nothing was queued.
  expect(w.stripe.seen.length).toBe(requests);
  expect(await linesIn(w)).toBe(lines);
  expect(await modeOf(w)).toBe("live");
});

test("and a live key cannot follow a test one: real sales belong in a workspace of their own", async () => {
  const w = await fresh();
  readTestMode(w);
  expect((await w.call("stripe.sync", {}, uuid())).body.ok).toBe(true);
  expect(await modeOf(w)).toBe("test");
  const lines = await linesIn(w);

  configureStripeRuntime(w.service, {
    keySource: { read: () => ({ key: KEY, source: "environment" }) },
    fetch: w.stripe.fetch,
  });
  const refused = await w.call("stripe.sync", {}, uuid());
  expect(refused.body.error.code).toBe("stripe_mode_changed");
  expect(refused.body.error.message).toContain("only ever read Stripe's test mode");
  expect(refused.body.error.message).toContain("workspace of their own");
  expect(await linesIn(w)).toBe(lines);
});

test("Stripe's own label on a payout is believed over the word of the key, and nothing is queued", async () => {
  const w = await fresh();
  // The key says live; Stripe says this payout is practice data.
  for (const payout of w.scenario.payouts) (payout as Record<string, unknown>).livemode = false;
  const refused = await w.call("stripe.sync", {}, uuid());
  expect(refused.body.ok).toBe(false);
  expect(refused.body.error.code).toBe("stripe_mode_mismatch");
  expect(refused.body.error.message).toContain("live mode");
  expect(refused.body.error.message).toContain("test mode");
  expect(await linesIn(w)).toBe(0);
});

test("a pull says which mode its answers are, and the books keep to it", async () => {
  const w = await fresh({ key: null, senderFetches: true });
  const first = await pull(w, { key: KEY, follow: true, livemode: true });
  expect(first.last.body.ok).toBe(true);
  expect(await modeOf(w)).toBe("live");
  const lines = await linesIn(w);
  expect(lines).toBeGreaterThan(0);

  const second = await pull(w, {
    key: TEST_KEY,
    stripe: practiceStripe(w.stripe),
    follow: true,
    livemode: false,
  });
  expect(second.last.body.ok).toBe(false);
  expect(second.last.body.error.code).toBe("stripe_mode_changed");
  expect(await linesIn(w)).toBe(lines);
});

test("a pull that says nothing of its mode takes it from the first label Stripe puts on a payout, and keeps to it", async () => {
  const w = await fresh({ key: null, senderFetches: true });
  expect((await pull(w, { key: KEY, follow: true })).last.body.ok).toBe(true);
  expect(await modeOf(w)).toBe("live");
  const lines = await linesIn(w);

  // Practice data arrives under a new instant, with nothing said of its mode: Stripe's label on the first payout turns it away.
  const refused = await pull(w, {
    key: TEST_KEY,
    stripe: practiceStripe(w.stripe),
    follow: true,
    asOf: new Date(w.clock.ms + 1000).toISOString(),
  });
  expect(refused.last.body.ok).toBe(false);
  expect(refused.last.body.error.code).toBe("stripe_mode_changed");
  expect(await linesIn(w)).toBe(lines);
});

test("a sender that declares a mode its payouts contradict is turned away, not believed", async () => {
  const w = await fresh({ key: null, senderFetches: true });
  const lied = await pull(w, { key: KEY, follow: true, livemode: false });
  expect(lied.last.body.ok).toBe(false);
  expect(lied.last.body.error.code).toBe("stripe_mode_mismatch");
  expect(await linesIn(w)).toBe(0);
});

// ----- the control plane's word of the account the owner connected -----

// biome-ignore lint/suspicious/noExplicitAny: tests inspect JSON responses loosely.
type Loose = any;

const control = (w: World) => {
  const http = new ApplicationHttp(w.service, {
    bookId: w.service.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  const access = http.serviceAccess("control");
  const call = async (name: string, input: unknown = {}) => {
    const response = await http.fetch(
      new Request(`http://127.0.0.1:4010/v1/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: w.service.bookId,
          input,
          operationId: uuid(),
        }),
      }),
      access,
    );
    return { status: response.status, body: (await response.json()) as never as Loose };
  };
  const upload = async (body: Uint8Array | string, headers: Record<string, string>) => {
    const response = await http.fetch(
      new Request("http://127.0.0.1:4010/v1/uploads", {
        method: "POST",
        headers,
        body: typeof body === "string" ? body : (body as unknown as BodyInit),
      }),
      access,
    );
    return { status: response.status, body: (await response.json()) as never as Loose };
  };
  return { call, upload };
};

test("only the control plane may say which Stripe account was connected", async () => {
  const w = await fresh({ key: null, senderFetches: true });
  const asOwner = await w.call(
    "stripe.link",
    { account: { id: ACCOUNT_ID, livemode: true } },
    uuid(),
  );
  expect(asOwner.body.ok).toBe(false);
  expect(asOwner.body.error.code).toBe("service_only");
  expect((await w.call("stripe.status")).body.data.link).toBeNull();
});

test("a connected account is told to the books, shown in the status, and can be taken away again", async () => {
  const w = await fresh({ key: null, senderFetches: true });
  const c = control(w);
  const linked = await c.call("stripe.link", { account: { id: ACCOUNT_ID, livemode: true } });
  expect(linked.body.ok).toBe(true);
  expect(linked.body.data).toEqual({ linked: true, reason: null });
  const status = (await w.call("stripe.status")).body.data;
  expect(status.link).toEqual({
    accountId: ACCOUNT_ID,
    livemode: true,
    since: new Date(w.clock.ms).toISOString(),
  });
  // The words say who reads Stripe, and do not send the owner to a command line.
  expect(status.balance.explanation).toContain("Rastrata reads the connected Stripe account");
  const sync = await w.call("stripe.sync", {}, uuid());
  expect(sync.body.error.code).toBe("stripe_key_missing");
  expect(sync.body.error.message).toContain("Stripe app the owner connected");

  const gone = await c.call("stripe.link", { account: null });
  expect(gone.body.data).toEqual({ linked: false, reason: null });
  expect((await w.call("stripe.status")).body.data.link).toBeNull();
});

test("books that have been reading one Stripe account turn another away when it is connected, not when the first read fails", async () => {
  const w = await fresh();
  expect((await w.call("stripe.sync", {}, uuid())).body.ok).toBe(true);
  const c = control(w);
  const other = await c.call("stripe.link", {
    account: { id: "acct_1SomebodyElse0001", livemode: true },
  });
  expect(other.body.data).toEqual({ linked: false, reason: "account_changed" });
  expect((await w.call("stripe.status")).body.data.link).toBeNull();
  const same = await c.call("stripe.link", { account: { id: ACCOUNT_ID, livemode: true } });
  expect(same.body.data.linked).toBe(true);
});

test("books that have read live data turn a practice connection away, and the other way round", async () => {
  const w = await fresh();
  expect((await w.call("stripe.sync", {}, uuid())).body.ok).toBe(true);
  const c = control(w);
  const practice = await c.call("stripe.link", { account: { id: ACCOUNT_ID, livemode: false } });
  expect(practice.body.data).toEqual({ linked: false, reason: "mode_changed" });

  const v = await fresh();
  readTestMode(v);
  expect((await v.call("stripe.sync", {}, uuid())).body.ok).toBe(true);
  const live = await control(v).call("stripe.link", {
    account: { id: ACCOUNT_ID, livemode: true },
  });
  expect(live.body.data).toEqual({ linked: false, reason: "mode_changed" });
});

test("the control plane may deliver Stripe's answers and nothing else of a draft: not a sync, not a statement", async () => {
  const w = await fresh({ key: null, senderFetches: true });
  const c = control(w);
  // It cannot sync (it holds no key and has no such operation), and cannot call any other operation that drafts.
  const sync = await c.call("stripe.sync", {});
  expect(sync.body.error.code).toBe("permission_denied");
  const configure = await c.call("stripe.configure", {});
  expect(configure.body.error.code).toBe("permission_denied");
  // It can upload a bundle for Stripe, and call stripe.receive with it.
  const stored = await c.upload(bundleOf([]), BUNDLE_UPLOAD);
  expect(stored.status).toBe(200);
  const received = await c.call("stripe.receive", {
    asOf: new Date(w.clock.ms).toISOString(),
    bundles: [stored.body.data.sha256],
    livemode: true,
  });
  expect(received.body.ok).toBe(true);
  // It cannot upload a statement file.
  const statement = await c.upload("date,amount\n2026-01-01,1.00\n", {
    "content-type": "text/csv",
  });
  expect(statement.status).toBe(403);
  expect(statement.body.error.code).toBe("permission_denied");
});
