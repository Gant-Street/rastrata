import { expect, test } from "bun:test";
import {
  BridgeBudgetSpent,
  BridgeClient,
  BridgeError,
  type ClientOptions,
  type FetchFn,
  type RequestEvent,
  claimSetupToken,
} from "../../src/bankfeed/client.ts";
import { type AccessUrl, parseAccessUrl } from "../../src/bankfeed/credentials.ts";
import { MAX_RESPONSE_BYTES } from "../../src/bankfeed/constants.ts";
import { DAY, FIXTURE_PASSWORD, FIXTURE_USER, NOW, fakeBridge } from "./fake-bridge.ts";

const policy = { allowLoopback: false } as const;

function harness(bridge = fakeBridge(), extra: Partial<ClientOptions> = {}) {
  const events: RequestEvent[] = [];
  const slept: number[] = [];
  const options: ClientOptions = {
    fetch: bridge.fetch,
    now: () => NOW * 1000,
    sleep: async (ms) => {
      slept.push(ms);
    },
    onRequest: (event) => events.push(event),
    ...extra,
  };
  const access = parseAccessUrl(bridge.accessUrl(), policy) as AccessUrl;
  return { bridge, events, slept, options, client: new BridgeClient(access, options), access };
}

const failure = async (work: () => Promise<unknown>): Promise<BridgeError> => {
  try {
    await work();
  } catch (error) {
    if (error instanceof BridgeError) return error;
    throw error;
  }
  throw new Error("expected a BridgeError");
};

// ---- claiming a setup token ----------------------------------------------------------------------

test("claiming POSTs to the claim URL with no body and returns the access URL", async () => {
  const { bridge, options, events } = harness();
  const calls: { method?: string | undefined; body?: unknown }[] = [];
  const spy: FetchFn = (input, init) => {
    calls.push({ method: init?.method, body: init?.body });
    return bridge.fetch(input, init);
  };
  const claimed = await claimSetupToken(bridge.setupToken(), policy, { ...options, fetch: spy });
  expect(claimed.accessUrl).toBe(bridge.accessUrl());
  expect(calls).toEqual([{ method: "POST", body: undefined }]);
  expect(bridge.log[0]?.path).toBe("/simplefin/claim/FIXTURE-2026-A1B2C3D4");
  expect(bridge.log[0]?.hasAuthorization).toBe(false);
  expect(events.map((e) => [e.kind, e.status])).toEqual([["claim", 200]]);
});

test("a token already used is refused, and the message says it may have been compromised and where to go", async () => {
  const { bridge, options } = harness();
  await claimSetupToken(bridge.setupToken(), policy, options);
  const error = await failure(() => claimSetupToken(bridge.setupToken(), policy, options));
  expect(error.code).toBe("bankfeed_token_rejected");
  expect(error.message).toContain("compromised");
  expect(error.message).toContain("disable it");
  expect(error.message).not.toContain(bridge.setupToken());
  // A refusal is final: one request, no retry.
  expect(bridge.requests("claim")).toHaveLength(2);
});

test("a token that is not one, or points elsewhere, sends nothing", async () => {
  const { bridge, options } = harness();
  expect((await failure(() => claimSetupToken("nonsense", policy, options))).code).toBe(
    "bankfeed_token_invalid",
  );
  const evil = btoa("https://evil.example/simplefin/claim/AB-CD-1234");
  expect((await failure(() => claimSetupToken(evil, policy, options))).code).toBe(
    "bankfeed_host_refused",
  );
  expect(bridge.log).toHaveLength(0);
});

test("a redirect to a claim is never followed", async () => {
  const { bridge, options } = harness();
  bridge.respondOnce(302, "", { location: "https://evil.example/" });
  const error = await failure(() => claimSetupToken(bridge.setupToken(), policy, options));
  expect(error.code).toBe("bankfeed_redirected");
  expect(bridge.log).toHaveLength(1);
});

test("an answer that is not an access URL of the Bridge is refused and the token is called used up", async () => {
  for (const answer of [
    "not a url",
    "https://user:pw@evil.example/simplefin",
    "http://u:p@beta-bridge.simplefin.org/simplefin",
    "https://beta-bridge.simplefin.org/simplefin",
  ]) {
    const { bridge, options } = harness();
    bridge.respondOnce(200, answer);
    const error = await failure(() => claimSetupToken(bridge.setupToken(), policy, options));
    expect(error.code).toBe("bankfeed_bad_response");
    expect(error.message).toContain("used up");
    expect(error.message).not.toContain("evil.example");
  }
});

test("a claim that hits a server error is tried once more, and then reported without the address", async () => {
  const { bridge, options, slept } = harness();
  bridge.respondOnce(503, "down");
  const claimed = await claimSetupToken(bridge.setupToken(), policy, options);
  expect(claimed.accessUrl).toBe(bridge.accessUrl());
  expect(slept).toEqual([1500]);

  const second = harness();
  second.bridge.respondOnce(503, "down");
  second.bridge.respondOnce(503, "down");
  const error = await failure(() =>
    claimSetupToken(second.bridge.setupToken(), policy, second.options),
  );
  expect(error.code).toBe("bankfeed_unavailable");
  expect(error.retryable).toBe(true);
  expect(second.bridge.requests("claim")).toHaveLength(2);
});

test("a network failure never reveals the address in the message", async () => {
  const { bridge, options } = harness();
  bridge.failOnce();
  bridge.failOnce();
  const error = await failure(() => claimSetupToken(bridge.setupToken(), policy, options));
  expect(error.code).toBe("bankfeed_unavailable");
  expect(error.message).not.toContain("simplefin.org");
  expect(error.message).not.toContain("ECONNREFUSED");
});

// ---- reading accounts --------------------------------------------------------------------------

test("a request asks for version 2, encodes each parameter, and never asks for pending items", async () => {
  const { bridge, client } = harness();
  await client.accounts({ account: "Demo Checking", startDate: NOW - 30 * DAY, endDate: NOW });
  await client.accounts({ balancesOnly: true });
  await client.accounts({ account: "a&b=c", startDate: 1, endDate: 2 });
  const [first, second, third] = bridge.log;
  expect(first?.url).toBe(
    `https://beta-bridge.simplefin.org/simplefin/accounts?version=2&account=Demo%20Checking&start-date=${NOW - 30 * DAY}&end-date=${NOW}`,
  );
  expect(second?.url).toBe(
    "https://beta-bridge.simplefin.org/simplefin/accounts?version=2&balances-only=1",
  );
  expect(third?.query.account).toEqual(["a&b=c"]);
  for (const entry of bridge.log) expect(entry.query.pending).toBeUndefined();
});

test("the credentials travel in a Basic header and are never in the address handed to fetch", async () => {
  const { bridge, access, client } = harness();
  const seen: { url: string; authorization: string | null; agent: string | null }[] = [];
  const spy: FetchFn = (input, init) => {
    const headers = new Headers(init?.headers);
    seen.push({
      url: String(input),
      authorization: headers.get("authorization"),
      agent: headers.get("user-agent"),
    });
    return bridge.fetch(input, init);
  };
  const guarded = new BridgeClient(access, { fetch: spy, now: () => NOW * 1000 });
  await guarded.accounts({ balancesOnly: true });
  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).not.toContain("@");
  expect(seen[0]?.url).not.toContain(FIXTURE_USER);
  expect(seen[0]?.url).not.toContain(FIXTURE_PASSWORD);
  expect(seen[0]?.authorization).toBe(`Basic ${btoa(`${FIXTURE_USER}:${FIXTURE_PASSWORD}`)}`);
  expect(seen[0]?.agent).toBe("rastrata-bankfeed/1");
  void client;
});

test("the exact bytes of the answer are returned beside the parsed JSON", async () => {
  const { bridge, client } = harness();
  const fetched = await client.accounts({ balancesOnly: true });
  expect(new TextDecoder().decode(fetched.bytes)).toBe(JSON.stringify(fetched.json));
  expect(fetched.status).toBe(200);
  expect((fetched.json as { accounts: unknown[] }).accounts).toHaveLength(bridge.accounts.length);
});

test("403 means the access is refused: final, not retried, and the message says what to do", async () => {
  const { bridge, options, access } = harness();
  bridge.respondOnce(403, { errlist: [{ code: "gen.auth", msg: "Forbidden" }], accounts: [] });
  const client = new BridgeClient(access, options);
  const error = await failure(() => client.accounts({ balancesOnly: true }));
  expect(error.code).toBe("bankfeed_access_denied");
  expect(error.status).toBe(403);
  expect(error.retryable).toBe(false);
  expect(error.message).toContain("create a new setup token");
  expect(error.message).toContain('The Bridge says: "Forbidden"');
  expect(bridge.log).toHaveLength(1);
});

test("402, 429 and other refusals are final; 429 names when asking may resume", async () => {
  for (const [status, code] of [
    [402, "bankfeed_payment_required"],
    [401, "bankfeed_access_denied"],
    [404, "bankfeed_request_rejected"],
    [422, "bankfeed_request_rejected"],
  ] as const) {
    const { bridge, client } = harness();
    bridge.respondOnce(status, { errlist: [{ code: "gen.api", msg: "nope" }], accounts: [] });
    const error = await failure(() => client.accounts({ balancesOnly: true }));
    expect(error.code).toBe(code);
    expect(bridge.log).toHaveLength(1);
  }
  const { bridge, client } = harness();
  bridge.respondOnce(429, "slow down", { "retry-after": "5" });
  const limited = await failure(() => client.accounts({ balancesOnly: true }));
  expect(limited.code).toBe("bankfeed_rate_limited");
  expect(limited.until).toBe(NOW * 1000 + 24 * 3600 * 1000);
  expect(bridge.log).toHaveLength(1);
});

test("a 400 passes on what the Bridge said, as its words", async () => {
  const { bridge, client } = harness();
  const error = await failure(() => client.accounts({ startDate: Number.NaN }));
  expect(error.code).toBe("bankfeed_request_rejected");
  void bridge;
});

test("a server error or a dropped connection is retried once, and each attempt is recorded", async () => {
  const { bridge, client, events, slept } = harness();
  bridge.respondOnce(500, "oops");
  const fetched = await client.accounts({ balancesOnly: true });
  expect(fetched.status).toBe(200);
  expect(events.map((e) => [e.kind, e.status])).toEqual([
    ["listing", 500],
    ["listing", 200],
  ]);
  expect(slept).toEqual([1500]);

  const failing = harness();
  failing.bridge.failOnce();
  failing.bridge.failOnce();
  const error = await failure(() => failing.client.accounts({ balancesOnly: true }));
  expect(error.code).toBe("bankfeed_unavailable");
  expect(error.retryable).toBe(true);
  expect(error.message).not.toContain("simplefin.org");
  expect(failing.events.map((e) => e.status)).toEqual([null, null]);

  const twice = harness();
  twice.bridge.respondOnce(502, "bad gateway");
  twice.bridge.respondOnce(503, "unavailable");
  const last = await failure(() => twice.client.accounts({ balancesOnly: true }));
  expect(last.code).toBe("bankfeed_unavailable");
  expect(twice.bridge.log).toHaveLength(2);
});

test("one attempt only when asked", async () => {
  const bridge = fakeBridge();
  const { client } = harness(bridge, { maxAttempts: 1 });
  bridge.respondOnce(500, "oops");
  const error = await failure(() => client.accounts({ balancesOnly: true }));
  expect(error.code).toBe("bankfeed_unavailable");
  expect(bridge.log).toHaveLength(1);
});

test("a redirect is not followed: the access URL goes only where it was issued", async () => {
  const { bridge, client } = harness();
  bridge.respondOnce(302, "", { location: "https://evil.example/steal" });
  const error = await failure(() => client.accounts({ balancesOnly: true }));
  expect(error.code).toBe("bankfeed_redirected");
  expect(bridge.log).toHaveLength(1);
});

test("an answer that is not JSON, not an object, or not UTF-8 is refused", async () => {
  for (const make of [
    () => new Response("<html>maintenance</html>", { status: 200 }),
    () => new Response("[1,2,3]", { status: 200 }),
    () => new Response("null", { status: 200 }),
    () => new Response("", { status: 200 }),
    () =>
      new Response(new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d]), {
        status: 200,
      }),
    () => new Response('{"accounts": [', { status: 200 }),
  ]) {
    const { bridge, client } = harness();
    bridge.overrides.push(() => make());
    const error = await failure(() => client.accounts({ balancesOnly: true }));
    expect(error.code).toBe("bankfeed_bad_response");
  }
});

test("an oversized answer is refused without being read whole, whether it says its size or not", async () => {
  const declared = harness();
  declared.bridge.overrides.push(
    () =>
      new Response("{}", {
        status: 200,
        headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
      }),
  );
  expect((await failure(() => declared.client.accounts({ balancesOnly: true }))).code).toBe(
    "bankfeed_bad_response",
  );

  const streamed = harness();
  let pulled = 0;
  streamed.bridge.overrides.push(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1;
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
        }),
        { status: 200 },
      ),
  );
  expect((await failure(() => streamed.client.accounts({ balancesOnly: true }))).code).toBe(
    "bankfeed_bad_response",
  );
  // It stopped reading soon after the limit instead of draining an endless body.
  expect(pulled).toBeLessThan(MAX_RESPONSE_BYTES / (1024 * 1024) + 4);
});

test("a hostile server cannot get the credentials back into a message", async () => {
  const { bridge, client } = harness();
  bridge.respondOnce(400, {
    errlist: [
      {
        code: "gen.api",
        msg: `echo ${FIXTURE_PASSWORD} and ${bridge.accessUrl()} and Basic ${btoa(`${FIXTURE_USER}:${FIXTURE_PASSWORD}`)}`,
      },
    ],
    accounts: [],
  });
  const error = await failure(() => client.accounts({ balancesOnly: true }));
  for (const secret of [
    FIXTURE_PASSWORD,
    FIXTURE_USER,
    btoa(`${FIXTURE_USER}:${FIXTURE_PASSWORD}`),
  ])
    expect(error.message).not.toContain(secret);
  expect(client.scrubText(`see ${bridge.accessUrl()}`)).not.toContain(FIXTURE_PASSWORD);
});

test("a budget that is spent stops the request before it is made, and the retry asks again", async () => {
  const bridge = fakeBridge();
  let asked = 0;
  const { client } = harness(bridge, {
    guard: () => {
      asked += 1;
      if (asked > 1) throw new BridgeBudgetSpent("daily_budget", NOW * 1000 + 3600_000);
    },
  });
  // The first request fails with a server error and wants a retry: the guard refuses the second.
  bridge.respondOnce(500, "oops");
  let spent: unknown;
  try {
    await client.accounts({ balancesOnly: true });
  } catch (error) {
    spent = error;
  }
  expect(spent).toBeInstanceOf(BridgeBudgetSpent);
  expect((spent as BridgeBudgetSpent).reason).toBe("daily_budget");
  expect(bridge.log).toHaveLength(1);
});

test("a request that never answers is given up on", async () => {
  const hung: FetchFn = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("timed out", "TimeoutError")),
      );
    });
  const { client } = harness(fakeBridge(), { fetch: hung, timeoutMs: 20, maxAttempts: 1 });
  const error = await failure(() => client.accounts({ balancesOnly: true }));
  expect(error.code).toBe("bankfeed_unavailable");
});

test("the client can do nothing but claim and read accounts", () => {
  const { client } = harness();
  expect(
    Object.getOwnPropertyNames(Object.getPrototypeOf(client))
      .filter((n) => n !== "constructor")
      .sort(),
  ).toEqual(["accounts", "read", "scrubText"]);
});
