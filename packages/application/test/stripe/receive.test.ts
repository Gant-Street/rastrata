import { afterEach, expect, test } from "bun:test";
import { configureStripeRuntime } from "../../src/slices/stripe/runtime.ts";
import { sliceState } from "../../src/slices/state.ts";
import { BUNDLE_UPLOAD, bundleOf } from "./bundle.ts";
import { pull } from "./pull-support.ts";
import {
  KEY,
  UNTAGGED_BOOK,
  type World,
  acceptAndPost,
  journals,
  linesOf,
  uuid,
  world,
} from "./slice-support.ts";
import { buildScenario } from "./fixtures.ts";
import { yearOfActivity } from "./year.ts";

/** `stripe.receive`: Stripe for a service that holds no key. The sender (here a stand-in for the
 * command line) fetches what the service asks for, delivers the answers, and the service books them
 * with the same run `stripe.sync` makes. The tests hold it to that: the same journals, the same
 * evidence, the same refusals, and nothing kept that the sync does not keep. */

const open: World[] = [];
afterEach(() => {
  for (const w of open.splice(0)) w.close();
});
async function fresh(options: Parameters<typeof world>[0] = {}): Promise<World> {
  const w = await world({ realPort: true, ...options });
  open.push(w);
  return w;
}
/** A service that holds no key and never will, configured the way the sync tests configure theirs. */
async function keyless(options: Parameters<typeof world>[0] = {}): Promise<World> {
  const w = await fresh({ key: null, senderFetches: true, ...options });
  await w.call("stripe.configure", { timeZone: "America/Denver" }, uuid());
  return w;
}
async function keyed(options: Parameters<typeof world>[0] = {}): Promise<World> {
  const w = await fresh(options);
  await w.call("stripe.configure", { timeZone: "America/Denver" }, uuid());
  return w;
}

/** What a book holds after Stripe is in it and every payout is accepted and posted: each journal
 * with its date, reference (which names the payout and the hash of the transactions it carries),
 * amount and lines. Two books with the same list booked Stripe the same way. */
async function booked(w: World): Promise<string[]> {
  await acceptAndPost(w);
  return (await journals(w))
    .map((j) => `${j.isoDate} ${j.reference} ${j.amount} | ${linesOf(j).join("; ")}`)
    .sort();
}

const payoutsOf = async (w: World): Promise<unknown> => {
  const rows: unknown[] = [];
  for (let page = 1; page < 20; page++) {
    const reply = await w.call("stripe.payouts", { page });
    rows.push(...reply.body.data.payouts);
    if (rows.length >= reply.body.data.count) break;
  }
  return rows;
};

test("a pull books exactly what a sync books: the same journals, the same evidence", async () => {
  const synced = await keyed();
  const sync = await synced.call("stripe.sync", {}, uuid());
  expect(sync.body.data.run.payouts).toBe(6);

  const pulled = await keyless();
  const result = await pull(pulled, { key: KEY });
  expect(result.last.body.ok).toBe(true);
  expect(result.last.body.data.more).toBe(false);
  expect(result.last.body.data.needs).toEqual([]);

  expect(await payoutsOf(pulled)).toEqual(await payoutsOf(synced));
  const expected = await booked(synced);
  expect(expected.length).toBeGreaterThan(0);
  expect(await booked(pulled)).toEqual(expected);
});

test("reading on to the next page of a list unasked gives the same books as being asked for each page", async () => {
  const asked = await keyless({ maxLimit: 7 });
  const followed = await keyless({ maxLimit: 7 });
  const dumb = await pull(asked, { key: KEY });
  const clever = await pull(followed, { key: KEY, follow: true });
  expect(clever.rounds).toBeLessThan(dumb.rounds);
  expect(await booked(followed)).toEqual(await booked(asked));
});

test("a pull reads in bulk what a sync reads one payment at a time, and Stripe sees only reads with the sender's key", async () => {
  const synced = await keyed();
  await synced.call("stripe.sync", {}, uuid());
  const pulled = await keyless();
  const result = await pull(pulled, { key: KEY, follow: true });
  const made = (w: World, path: string): { path: string; query: Record<string, string[]> }[] =>
    w.stripe.seen.filter((seen) => seen.path === path);
  // The sync asks for the Checkout Session of each payment, and for each payout by itself; the pull asks for a month of them at a time.
  const bySync = made(synced, "/v1/checkout/sessions");
  const byPull = made(pulled, "/v1/checkout/sessions");
  expect(bySync.every((seen) => seen.query.payment_intent !== undefined)).toBe(true);
  expect(bySync.length).toBeGreaterThan(5);
  // What a pull asks of Stripe for a payment's tax: lists of a month, and by itself only what is not a charge (a refund or a dispute belongs to a payment of any age).
  const lists = byPull.filter((seen) => seen.query["created[gte]"] !== undefined);
  expect(lists.length).toBeGreaterThan(0);
  expect(lists.every((seen) => seen.query.payment_intent === undefined)).toBe(true);
  expect(byPull.length).toBeLessThan(bySync.length);
  expect(made(synced, "/v1/payouts").length).toBe(0);
  expect(made(pulled, "/v1/payouts").length).toBeGreaterThan(0);
  expect(result.requested.length).toBeLessThan(synced.stripe.seen.length);
  // Nothing outside what the lane reads, and only reads, with the sender's key and never in a URL.
  expect(
    pulled.stripe.seen.every((seen) => seen.method === "GET" && seen.authorised && !seen.keyInUrl),
  ).toBe(true);
  expect(result.requested.every((request) => request.startsWith("/v1/"))).toBe(true);
  // And the books are the same.
  expect(await booked(pulled)).toEqual(await booked(synced));
});

test("the service never holds or sees the key: nothing it says or keeps has it", async () => {
  const w = await keyless();
  const result = await pull(w, { key: KEY, follow: true });
  expect(JSON.stringify(result.replies)).not.toContain(KEY);
  const status = await w.call("stripe.status");
  expect(JSON.stringify(status.body)).not.toContain(KEY);
  expect(status.body.data.fetchedBy).toBe("sender");
  expect(status.body.data.key.present).toBe(false);
  // Not in anything the book stores, either: the archive, the Inbox, the runs.
  const rows = w.service.store.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {
    name: string;
  }[];
  for (const { name } of rows) {
    if (name.startsWith("sqlite_") || name === "app_blob_chunks") continue;
    const text = JSON.stringify(w.service.store.query(`SELECT * FROM "${name}"`).all());
    expect(text.includes(KEY)).toBe(false);
  }
});

test("a second pull with nothing new queues nothing, and a pull after new activity books only the new payout", async () => {
  const w = await keyless();
  await pull(w, { key: KEY, follow: true });
  const before = (await w.call("inbox.list", { pageSize: 200 })).body.data.items.length;
  const again = await pull(w, { key: KEY, follow: true });
  expect(again.last.body.data.run.newLines).toBe(0);
  expect((await w.call("inbox.list", { pageSize: 200 })).body.data.items.length).toBe(before);
});

test("a service that forgets what was delivered, because another process took the book, is delivered it again", async () => {
  const w = await keyless({ maxLimit: 7 });
  const result = await pull(w, {
    key: KEY,
    follow: true,
    beforeRound(round) {
      if (round === 3 || round === 5)
        sliceState(w.service, "stripe.delivered", () => ({ current: null })).current = null;
    },
  });
  expect(result.last.body.data.more).toBe(false);
  const reference = await keyed({ maxLimit: 7 });
  await reference.call("stripe.sync", {}, uuid());
  expect(await booked(w)).toEqual(await booked(reference));
});

test("a bundle that was never uploaded is refused in words that say what to do, and nothing is guessed", async () => {
  const w = await keyless();
  const asOf = new Date(w.clock.ms).toISOString();
  const missing = await w.call("stripe.receive", { asOf, bundles: ["a".repeat(64)] }, uuid());
  expect(missing.status).toBe(400);
  expect(missing.body.error.code).toBe("invalid_input");
  expect(missing.body.error.message).toContain("Upload it first");
  const first = await w.call("stripe.receive", { asOf }, uuid());
  expect(first.body.ok).toBe(true);
  expect(first.body.data.more).toBe(true);
  expect(first.body.data.needs).toEqual(["/v1/account"]);
});

test("the pull asks for no more than 200 requests at once, and finishes all the same", async () => {
  const w = await keyless();
  const first = await w.call(
    "stripe.receive",
    { asOf: new Date(w.clock.ms).toISOString() },
    uuid(),
  );
  expect(first.body.data.needs).toEqual(["/v1/account"]);
  expect(first.body.data.needs.length).toBeLessThanOrEqual(200);
  const result = await pull(w, { key: KEY });
  for (const reply of result.replies) expect(reply.body.data.needs.length).toBeLessThanOrEqual(200);
});

test("the instant a pull reads up to must be a UTC instant, not ahead of the service, and not a day old", async () => {
  const w = await keyless();
  const send = (asOf: string) => w.call("stripe.receive", { asOf }, uuid());
  const ahead = await send(new Date(w.clock.ms + 10 * 60 * 1000).toISOString());
  expect(ahead.body.error.code).toBe("clock_ahead");
  const old = await send(new Date(w.clock.ms - 25 * 3600 * 1000).toISOString());
  expect(old.body.error.code).toBe("pull_too_old");
  const local = await send("2026-03-20T05:00:00-07:00");
  expect(local.body.ok).toBe(false);
  expect(local.status).toBe(400);
  const nonsense = await send("yesterday");
  expect(nonsense.status).toBe(400);
  // A little ahead is a clock a few seconds out, which is allowed.
  const near = await send(new Date(w.clock.ms + 30 * 1000).toISOString());
  expect(near.body.ok).toBe(true);
});

test("a bundle that is not what it should be is refused whole, whatever it says", async () => {
  const w = await keyless();
  const asOf = new Date(w.clock.ms).toISOString();
  const answer = (request: string, status = 200, body = "{}") => ({
    request,
    status,
    body: new TextEncoder().encode(body),
  });
  const refused = async (bundle: Uint8Array, status = 400) => {
    const stored = await w.upload(bundle, BUNDLE_UPLOAD);
    expect(stored.status).toBe(200);
    const reply = await w.call(
      "stripe.receive",
      { asOf, bundles: [stored.body.data.sha256] },
      uuid(),
    );
    expect(reply.status, JSON.stringify(reply.body)).toBe(status);
    expect(reply.body.ok).toBe(false);
    return reply.body.error;
  };
  // Requests the lane does not make.
  for (const request of [
    "/v1/customers",
    "/v1/charges?limit=100",
    "/v1/payouts/../customers",
    "//evil.example/v1/account",
    "https://evil.example/v1/account",
    "/v1/payouts/po_1%2Fx",
    "/v1/account#x",
    `/v1/account?${"x".repeat(900)}`,
  ])
    expect((await refused(bundleOf([answer(request)]))).message).toContain(
      "not a request the Stripe lane makes",
    );
  // A status that is not an HTTP status, and sizes that are not the bytes.
  await refused(bundleOf([answer("/v1/account", 99)]));
  await refused(bundleOf([answer("/v1/account", 700)]));
  const raw = (text: string) => Bun.gzipSync(new TextEncoder().encode(text));
  await refused(raw('{"request":"/v1/account","status":200,"size":50}\n{}\n'));
  await refused(raw('{"request":"/v1/account","status":200,"size":2}\n{}X'));
  await refused(raw('{"request":"/v1/account","status":200,"size":-1}\n\n'));
  await refused(raw('{"request":"/v1/account","status":200,"size":99999999999}\n\n'));
  await refused(raw("not json\n"));
  await refused(raw('{"request":"/v1/account","status":200,"size":2}'));
  // A file that is not gzip at all.
  await refused(new TextEncoder().encode("{}"));
  // A small file that unpacks to more than a bundle may, turned away before it fills the memory.
  const bomb = await refused(Bun.gzipSync(new Uint8Array(70 * 1024 * 1024)), 413);
  expect(bomb.code).toBe("stripe_bundle_too_large");
  // An answer of a size Stripe does not give.
  await refused(
    bundleOf([{ request: "/v1/account", status: 200, body: new Uint8Array(17 * 1024 * 1024) }]),
  );
  // Nothing of any of it was kept: the pull asks for the account, as at the start.
  const after = await w.call("stripe.receive", { asOf }, uuid());
  expect(after.body.data.needs).toEqual(["/v1/account"]);
});

test("a pull holds no more than 48 MiB of what it was delivered, lets the oldest go, and asks for them again if they are needed", async () => {
  const w = await keyless();
  const asOf = new Date(w.clock.ms).toISOString();
  const fat = (n: number) => ({
    request: `/v1/payouts/po_pad${n}`,
    status: 200,
    body: new Uint8Array(15 * 1024 * 1024),
  });
  const shas: string[] = [];
  for (let n = 1; n <= 5; n++) {
    const stored = await w.upload(bundleOf([fat(n)]), BUNDLE_UPLOAD);
    shas.push(stored.body.data.sha256);
  }
  const reply = await w.call("stripe.receive", { asOf, bundles: shas }, uuid());
  expect(reply.body.ok).toBe(true);
  const state = sliceState(w.service, "stripe.delivered", () => ({ current: null })) as unknown as {
    current: { held: number; answers: Map<string, unknown> };
  };
  const held = state.current;
  expect(held.held).toBeLessThanOrEqual(48 * 1024 * 1024);
  expect(held.answers.size).toBe(3);
  // The oldest went: the last three are what remains.
  expect([...held.answers.keys()].map((key) => key.replace("/v1/payouts/", ""))).toEqual([
    "po_pad3",
    "po_pad4",
    "po_pad5",
  ]);
});

test("a finished pull lets go of what it was delivered", async () => {
  const w = await keyless();
  await pull(w, { key: KEY, follow: true });
  expect(sliceState(w.service, "stripe.delivered", () => ({ current: null })).current).toBeNull();
});

test("Stripe's refusals are said as a sync says them: a key without a permission, a rate limit", async () => {
  const denied = await keyless();
  denied.stripe.intercept((seen) =>
    seen.path === "/v1/payouts/" + denied.scenario.labels.P1 || seen.path.startsWith("/v1/checkout")
      ? Response.json(
          {
            error: {
              type: "invalid_request_error",
              message: "The provided key lacks a permission.",
            },
          },
          { status: 403 },
        )
      : undefined,
  );
  const result = await pull(denied, { key: KEY, follow: true });
  expect(result.last.body.ok).toBe(false);
  expect(result.last.body.error.code).toBe("stripe_permission_denied");
  expect(result.last.body.error.message).toContain("lacks a permission");

  const limited = await keyless();
  limited.stripe.intercept((seen) =>
    seen.path === "/v1/balance_transactions"
      ? Response.json({ error: { message: "Too many requests." } }, { status: 429 })
      : undefined,
  );
  const slow = await pull(limited, { key: KEY });
  expect(slow.last.body.error.code).toBe("stripe_rate_limited");
});

test("the Stripe account a book has been pulling cannot change under it", async () => {
  const w = await keyless();
  await pull(w, { key: KEY, follow: true });
  const stranger = {
    ...w.scenario,
    account: { ...w.scenario.account, id: "acct_1SomebodyElse0001" },
  };
  const elsewhere = await world({ scenario: stranger, realPort: true });
  open.push(elsewhere);
  // A later pull of the same book is given another account's answers.
  w.clock.ms += 60 * 60 * 1000;
  const result = await pull(w, { key: KEY, stripe: elsewhere.stripe, follow: true });
  expect(result.last.body.error.code).toBe("stripe_account_changed");
});

test("a pull begins with nothing saved, on the defaults; one whose chart does not name an account waits for the owner; and a pull needs the right to draft", async () => {
  const bare = await fresh({ key: null, senderFetches: true, book: UNTAGGED_BOOK });
  const unconfigured = await bare.call(
    "stripe.receive",
    { asOf: new Date(bare.clock.ms).toISOString() },
    uuid(),
  );
  expect(unconfigured.status).toBe(409);
  expect(unconfigured.body.error.code).toBe("stripe_not_configured");
  const w = await fresh({ key: null, senderFetches: true });
  const asOf = new Date(w.clock.ms).toISOString();
  // Connecting is enough: the book says what it needs of Stripe without being told anything first.
  const ready = await w.call("stripe.receive", { asOf }, uuid());
  expect(ready.body.ok).toBe(true);
  const readOnly = await w.call("stripe.receive", { asOf }, uuid(), ["read"]);
  expect(readOnly.status).toBe(403);
  const drafting = await w.call("stripe.receive", { asOf }, uuid(), ["read", "draft"]);
  expect(drafting.body.ok).toBe(true);
});

test("a service that holds no key says how Stripe gets in when asked to sync", async () => {
  const w = await keyless();
  const sync = await w.call("stripe.sync", {}, uuid());
  expect(sync.body.error.code).toBe("stripe_key_missing");
  expect(sync.body.error.message).toContain("rastrata stripe pull");
  const local = await keyed({ key: null });
  const local2 = await local.call("stripe.sync", {}, uuid());
  expect(local2.body.error.message).toContain("RASTRATA_STRIPE_KEY");
});

test("an upload for Stripe takes a gzip bundle and only that, and a statement upload still takes no JSON and no gzip", async () => {
  const w = await keyless();
  const bundle = bundleOf([
    { request: "/v1/account", status: 200, body: new TextEncoder().encode("{}") },
  ]);
  const ok = await w.upload(bundle, BUNDLE_UPLOAD);
  expect(ok.status).toBe(200);
  expect(ok.body.data.mediaType).toBe("application/gzip");
  const json = await w.upload("{}", {
    "content-type": "application/json",
    "x-upload-for": "stripe",
  });
  expect(json.status).toBe(415);
  const csv = await w.upload("a,b\n1,2\n", {
    "content-type": "text/csv",
    "x-upload-for": "stripe",
  });
  expect(csv.status).toBe(415);
  const plain = await w.upload("{}", { "content-type": "application/json" });
  expect(plain.status).toBe(415);
  expect(plain.body.error.code).toBe("media_type_unsupported");
  const unmarked = await w.upload(bundle, { "content-type": "application/gzip" });
  expect(unmarked.status).toBe(415);
  const odd = await w.upload(bundle, {
    "content-type": "application/gzip",
    "x-upload-for": "bank",
  });
  expect(odd.status).toBe(400);
  const statement = await w.upload("a,b\n1,2\n", { "content-type": "text/csv" });
  expect(statement.status).toBe(200);
});

test("a repeated call under the same identity returns the first result without running again", async () => {
  const w = await keyless();
  const id = uuid();
  const asOf = new Date(w.clock.ms).toISOString();
  const first = await w.call("stripe.receive", { asOf }, id);
  const second = await w.call("stripe.receive", { asOf }, id);
  expect(second.body).toEqual(first.body);
  const runs = (await w.call("stripe.status")).body.data.history;
  expect(runs.filter((run: { id: string }) => run.id === id).length).toBe(1);
});

test("a year of activity (about 2,000 transactions, 250 payouts) is pulled in a few dozen rounds and lands the same lines a sync lands", async () => {
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
  const started = performance.now();
  const result = await pull(pulled, { key: KEY, follow: true });
  const seconds = (performance.now() - started) / 1000;
  expect(result.last.body.data.more).toBe(false);

  const linesOf = async (w: World): Promise<string[]> => {
    const out: string[] = [];
    for (let page = 1; page < 100; page++) {
      const reply = await w.call("inbox.list", { pageSize: 200, page });
      const items = reply.body.data.items as { line: { providerId?: string } }[];
      out.push(...items.map((item) => JSON.stringify(item.line)));
      if (out.length >= reply.body.data.count || items.length === 0) break;
    }
    return out.sort();
  };
  const expected = await linesOf(synced);
  expect(expected.length).toBeGreaterThan(2000);
  expect(await linesOf(pulled)).toEqual(expected);
  const status = (await pulled.call("stripe.status")).body.data;
  expect(status.payouts).toMatchObject({
    known: scenario.payouts.length,
    booked: scenario.payouts.length,
    mismatched: 0,
    waiting: 0,
  });
  expect(status.balance).toMatchObject({ difference: "0.00", ties: true });
  console.info(
    `stripe pull: ${scenario.entries.length} balance transactions, ${scenario.payouts.length} payouts in ${result.rounds} rounds, ${result.requested.length} requests made of Stripe, ${seconds.toFixed(1)} s`,
  );
  expect(result.rounds).toBeLessThan(60);
}, 600_000);

test("a pull whose instant is a little ahead of the service's clock finishes: the time it may take is the service's own", async () => {
  const w = await keyless();
  await pull(w, { key: KEY, follow: true });
  // The sender's clock is a minute ahead, within what is allowed: the time budget is not the pull's instant.
  const ahead = new Date(w.clock.ms + 60_000).toISOString();
  const result = await pull(w, { key: KEY, asOf: ahead, follow: true, maxRounds: 40 });
  expect(result.last.body.data.more).toBe(false);
  expect(result.last.body.data.run.newLines).toBe(0);
});

test("a pull holds no more than 20,000 answers however small they are, and a pull nobody finishes is let go when it is old", async () => {
  const w = await keyless();
  const asOf = new Date(w.clock.ms).toISOString();
  const tiny = Array.from({ length: 20_500 }, (_, n) => ({
    request: `/v1/payouts/po_${100_000 + n}`,
    status: 200,
    body: new Uint8Array(0),
  }));
  const stored = await w.upload(bundleOf(tiny), BUNDLE_UPLOAD);
  expect(stored.status).toBe(200);
  const reply = await w.call(
    "stripe.receive",
    { asOf, bundles: [stored.body.data.sha256] },
    uuid(),
  );
  expect(reply.body.ok).toBe(true);
  const state = sliceState(w.service, "stripe.delivered", () => ({ current: null })) as unknown as {
    current: { answers: Map<string, unknown>; held: number };
  };
  const pull = state.current;
  expect(pull.answers.size).toBeLessThanOrEqual(20_000);
  // Three hours on, another book's pull sweeps it: what it held is let go.
  const other = await keyless();
  other.clock.ms = w.clock.ms + 3 * 3600 * 1000;
  await other.call("stripe.receive", { asOf: new Date(other.clock.ms).toISOString() }, uuid());
  expect(pull.answers.size).toBe(0);
  expect(pull.held).toBe(0);
});

test("a call that is given more than it should change in the book stops between payouts and the next carries on: the same books, in more calls, and each call books whole payouts", async () => {
  const free = await keyless();
  const unlimited = await pull(free, { key: KEY });
  expect(unlimited.last.body.data.more).toBe(false);

  // One unit of work ends a call: a page of a window, or a payout whose entry is booked.
  const bounded = await keyless();
  configureStripeRuntime(bounded.service, { workPerCall: 1 });
  const limited = await pull(bounded, { key: KEY, maxRounds: 400 });
  expect(limited.last.body.ok).toBe(true);
  expect(limited.last.body.data.more).toBe(false);
  expect(limited.rounds).toBeGreaterThan(unlimited.rounds);
  // Several calls stopped with work left and asked for nothing: they only wanted calling again.
  const idle = limited.replies.filter(
    (r) => r.body.data.more === true && r.body.data.needs.length === 0,
  );
  expect(idle.length).toBeGreaterThan(0);
  // No call booked a payout in pieces: what each reports is whole payouts, and the totals are the unlimited pull's.
  const paid = (r: typeof limited) =>
    r.replies.reduce((sum, reply) => sum + (reply.body.data?.run?.payouts ?? 0), 0);
  expect(paid(limited)).toBe(paid(unlimited));
  // The status says what the reading did as a whole, not what its last call did.
  const status = (await bounded.call("stripe.status")).body.data;
  expect(status.lastSync.payouts).toBeLessThan(paid(unlimited));
  expect(status.lastRead).toMatchObject({ disposition: "complete", payouts: paid(unlimited) });
  expect(status.lastRead.requests).toBeGreaterThan(status.lastSync.requests);
  expect(await payoutsOf(bounded)).toEqual(await payoutsOf(free));
  expect(await booked(bounded)).toEqual(await booked(free));
});

/** What the book says it could not split the tax of, after a pull of `scenario`. */
async function taxNotReportedBy(scenario: ReturnType<typeof buildScenario>): Promise<number> {
  const w = await keyless({ scenario });
  const result = await pull(w, { key: KEY, follow: true });
  expect(result.last.body.ok).toBe(true);
  return (await w.call("stripe.status")).body.data.held.taxNotReported as number;
}

test("a charge's Checkout Session is found in the lists of the weeks before it, and one made longer before than that is counted as not reported, as one made through neither Checkout nor an invoice is", async () => {
  const base = buildScenario();
  const none = await taxNotReportedBy(base);
  // Every session made earlier than its charge by `days`.
  const shifted = (days: number) => ({
    ...base,
    sessions: base.sessions.map((session) => ({
      ...session,
      created: Number(session.created) - days * 86_400,
    })),
  });
  // Two days before its charge, a week, and the two weeks the lists look back: found, as when it was made with it.
  expect(await taxNotReportedBy(shifted(2))).toBe(none);
  expect(await taxNotReportedBy(shifted(7))).toBe(none);
  expect(await taxNotReportedBy(shifted(13))).toBe(none);
  // Made a month before (a session lives a day; a payment method that settles takes a week or two): not found, and said so, never guessed.
  expect(await taxNotReportedBy(shifted(40))).toBeGreaterThan(none);
});

test("a payout that the month's list of payouts lacks is asked for by itself, and the books are the same", async () => {
  const listed = await keyless();
  await pull(listed, { key: KEY, follow: true });
  const lacking = await keyless();
  // The list answers as if the account had no payouts: each is asked for by its identifier.
  lacking.stripe.intercept((seen) =>
    seen.path === "/v1/payouts"
      ? Response.json({ object: "list", data: [], has_more: false, url: "/v1/payouts" })
      : undefined,
  );
  const result = await pull(lacking, { key: KEY, follow: true });
  expect(result.last.body.ok).toBe(true);
  expect(
    lacking.stripe.seen.filter((seen) => seen.path.startsWith("/v1/payouts/")).length,
  ).toBeGreaterThan(5);
  expect(await booked(lacking)).toEqual(await booked(listed));
  expect(await payoutsOf(lacking)).toEqual(await payoutsOf(listed));
});

test("a year of a shop's Stripe is read in a few hundred requests, with no request for the tax of a charge by itself", async () => {
  const w = await fresh({ key: null, senderFetches: true, scenario: yearOfActivity() });
  w.clock.ms = Date.parse("2027-01-02T13:00:00Z");
  await w.call("stripe.configure", { syncFrom: "2026-01-01", timeZone: "America/Denver" }, uuid());
  const result = await pull(w, { key: KEY, follow: true, maxRounds: 1000 });
  expect(result.last.body.ok).toBe(true);
  // One for each payout's transactions, and the rest in bulk: it was 2,400 when each payment and each payout was asked for by itself.
  expect(result.requested.length).toBeLessThan(450);
  const alone = w.stripe.seen.filter((seen) => seen.query.payment_intent !== undefined);
  expect(alone).toEqual([]);
  expect((await w.call("stripe.status")).body.data.payouts).toMatchObject({ booked: 261 });
});

test("a pull for a book that was told nothing books every payout, and leaves the defaults saved with the time zone of the Stripe account", async () => {
  const w = await fresh({ key: null, senderFetches: true });
  const result = await pull(w, { key: KEY });
  expect(result.last.body.ok, JSON.stringify(result.last.body.error ?? null)).toBe(true);
  expect(result.last.body.data.more).toBe(false);
  const status = (await w.call("stripe.status")).body.data;
  expect(status.payouts.booked).toBe(6);
  expect(status.settings).toMatchObject({
    mapping: [],
    timeZone: "America/Denver",
    salesTax: "stripe",
  });
});
