// The page's side of accounts: the calls to the control plane and the token of the workspace that is open (src/account.ts), the fetch that carries it
// (src/ambient.ts), the client's retained writes kept apart by workspace, and the page's start (src/boot.ts). The control plane is a stand-in that answers as
// the real one does (apps/control-worker); its own tests are in that package.
import { afterEach, expect, test } from "bun:test";
import { API_VERSION } from "@rastrata/application/client-contracts";
import {
  Account,
  FORGET_WAIT_MS,
  REFRESH_BEFORE_MS,
  WAIT_BELOW_MS,
  WORKSPACE_KEY,
} from "../../src/account";
import { ambientFetch, authorizationScope, installAuthorizer } from "../../src/ambient";
import { BrowserApplicationClient } from "../../src/application-client";
import { bootAccounts, currentAccount, START_PATH } from "../../src/boot";
import { capabilities, has, learnCapabilities } from "../../src/capabilities";
import { fromOpening, openingRead, resetOpening } from "../../src/opening";
import { accountsOf, agentsOf, backupsOf, connectionsOf } from "../../src/service-state";

afterEach(() => {
  installAuthorizer(null);
  learnCapabilities(null);
});

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** A control plane that answers by path, and keeps what it was asked. */
function controlPlane(
  answers: Record<string, (seen: Seen) => Response | Promise<Response>>,
  seen: Seen[] = [],
) {
  const ask = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: Seen = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    seen.push(request);
    const answer = answers[`${request.method} ${request.url}`];
    if (!answer)
      return new Response(JSON.stringify({ message: "Not found.", code: "not_found" }), {
        status: 404,
      });
    return answer(request);
  }) as unknown as typeof fetch;
  return { ask, seen };
}

const token = (n: number, expiresIn = 600) => Response.json({ token: `token-${n}`, expiresIn });
const refusal = (
  status: number,
  code: string,
  message = "No.",
  headers: Record<string, string> = {},
) => Response.json({ message, code }, { status, headers });

test("each call goes to its path with its method and body, the bot check's token travels in a header of its own, and nothing is cached", async () => {
  const { ask, seen } = controlPlane({
    "GET /auth/config": () =>
      Response.json({ captcha: { provider: "turnstile", siteKey: "site" } }),
    "POST /auth/email-otp/send-verification-otp": () => Response.json({ success: true }),
    "POST /auth/sign-in/email-otp": () => Response.json({ token: "t" }),
    "POST /auth/hint": () => Response.json({ ok: true }),
    "POST /auth/sign-out": () => Response.json({ success: true }),
    "GET /auth/workspaces": () => Response.json({ workspaces: [] }),
    "POST /auth/workspaces": () => Response.json({ workspace: { id: "wsp_x" } }, { status: 201 }),
    "POST /auth/workspaces/delete": () =>
      Response.json({ workspace: { id: "wsp_x", state: "deleting" } }),
    "POST /auth/workspaces/restore": () =>
      Response.json({ workspace: { id: "wsp_x", state: "ready" } }),
    "GET /auth/workspaces/wsp_x%2Fy": () => Response.json({ workspace: {}, members: [] }),
    "POST /auth/invitations": () => Response.json({ invitation: { id: "inv_1" } }, { status: 201 }),
    "POST /auth/invitations/revoke": () => Response.json({ ok: true }),
    "POST /auth/invitations/peek": () => Response.json({ invitation: { workspace: "Acme" } }),
    "POST /auth/invitations/accept": () => Response.json({ workspace: { id: "wsp_x" } }),
    "POST /auth/members/role": () => Response.json({ member: {} }),
    "POST /auth/members/remove": () => Response.json({ ok: true }),
  });
  const account = new Account({ ask, storage: storage() });
  await account.config();
  await account.askForCode("  Ann@Example.com ", "captcha-token");
  await account.askForCode("ann@example.com", null);
  await account.signInWithCode(" ann@example.com", "123 456");
  await account.restoreHint();
  expect(await account.signOut()).toBe(true);
  await account.workspaces();
  await account.createWorkspace("Acme", "11111111-1111-4111-8111-111111111111");
  await account.workspace("wsp_x/y");
  expect(await account.deleteWorkspace("wsp_x", "Acme")).toMatchObject({ ok: true });
  expect(await account.restoreWorkspace("wsp_x")).toMatchObject({ ok: true });
  await account.invite("wsp_x", " bob@example.com ", "accountant");
  await account.revokeInvitation("inv_1");
  await account.peekInvitation("secret");
  await account.acceptInvitation("secret");
  await account.changeRole("wsp_x", "user_1", "admin");
  await account.removeMember("wsp_x", "user_1");
  expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
    "GET /auth/config",
    "POST /auth/email-otp/send-verification-otp",
    "POST /auth/email-otp/send-verification-otp",
    "POST /auth/sign-in/email-otp",
    "POST /auth/hint",
    "POST /auth/sign-out",
    "GET /auth/workspaces",
    "POST /auth/workspaces",
    "GET /auth/workspaces/wsp_x%2Fy",
    "POST /auth/workspaces/delete",
    "POST /auth/workspaces/restore",
    "POST /auth/invitations",
    "POST /auth/invitations/revoke",
    "POST /auth/invitations/peek",
    "POST /auth/invitations/accept",
    "POST /auth/members/role",
    "POST /auth/members/remove",
  ]);
  const body = (index: number) => seen[index]?.body;
  expect(body(1)).toEqual({ email: "Ann@Example.com", type: "sign-in" });
  expect(seen[1]?.headers["x-captcha-response"]).toBe("captcha-token");
  expect(seen[2]?.headers).not.toHaveProperty("x-captcha-response");
  expect(body(3)).toEqual({ email: "ann@example.com", otp: "123456" });
  // Signing out says nothing, but in JSON: the library answers 415 to a request without a body and the session goes on.
  expect(body(5)).toEqual({});
  expect(seen[5]?.headers["content-type"]).toBe("application/json");
  expect(body(7)).toEqual({ name: "Acme", requestId: "11111111-1111-4111-8111-111111111111" });
  expect(body(9)).toEqual({ workspace: "wsp_x", confirm: "Acme" });
  expect(body(10)).toEqual({ workspace: "wsp_x" });
  expect(body(11)).toEqual({ workspace: "wsp_x", email: "bob@example.com", role: "accountant" });
  expect(body(15)).toEqual({ workspace: "wsp_x", userId: "user_1", role: "admin" });
  expect(
    seen
      .filter((s) => s.method === "POST" && s.body !== undefined)
      .every((s) => s.headers["content-type"] === "application/json"),
  ).toBe(true);
});

test("an answer is the value or what went wrong in the control plane's own words with its status, its code and the wait it asks for; a call that does not come back is not a refusal", async () => {
  const { ask } = controlPlane({
    "POST /auth/email-otp/send-verification-otp": () =>
      refusal(
        429,
        "too_many_codes",
        "Too many codes have been asked for this address. Try again later.",
        { "retry-after": "1800" },
      ),
    "GET /auth/workspaces": () => new Response("<html>bad gateway</html>", { status: 502 }),
    "POST /auth/hint": () => Promise.reject(new Error("offline")),
    "GET /auth/get-session": () => Response.json(null),
  });
  const account = new Account({ ask, storage: storage() });
  const limited = await account.askForCode("ann@example.com", "t");
  expect(limited).toEqual({
    ok: false,
    status: 429,
    code: "too_many_codes",
    message: "Too many codes have been asked for this address. Try again later.",
    retryAfter: 1800,
  });
  const gateway = await account.workspaces();
  expect(gateway).toMatchObject({ ok: false, status: 502, code: "http_502", retryAfter: null });
  expect((gateway as { message: string }).message).toContain("Try again in a moment");
  expect(await account.restoreHint()).toMatchObject({ ok: false, status: 0, code: "unreachable" });
  // Nobody is signed in: not a failure, and not a person.
  expect(await account.session()).toEqual({ ok: true, value: null });
});

test("an accepted answer whose body never arrives, or is not the control plane's, is a call that did not come back and never a success with nothing in it", async () => {
  // The status came and the connection dropped, or the page was left while the body was being read.
  const cut = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("the connection was lost"));
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const { ask } = controlPlane({
    "GET /auth/workspaces": cut,
    "GET /auth/workspaces/w1": cut,
    // A network's own sign-in page, answered with a good status.
    "GET /auth/config": () => new Response("<html>Sign in to the hotel's network</html>"),
    // Accepted with nothing to say is still accepted.
    "POST /auth/passkey/delete-passkey": () => new Response(null, { status: 200 }),
  });
  const account = new Account({ ask, storage: storage() });
  const unreachable = { ok: false, status: 0, code: "unreachable", retryAfter: null };
  expect(await account.workspaces()).toMatchObject(unreachable);
  expect(await account.workspace("w1")).toMatchObject(unreachable);
  expect(await account.config()).toMatchObject(unreachable);
  expect(await account.removePasskey("p1")).toEqual({ ok: true, value: null });
});

test("the session is the person's id and address, and a control plane that cannot be reached is a failure and not a sign-out", async () => {
  const { ask } = controlPlane({
    "GET /auth/get-session": () =>
      Response.json({ user: { id: "user_1", email: "ann@example.com" }, session: {} }),
  });
  const account = new Account({ ask, storage: storage() });
  expect(await account.session()).toEqual({
    ok: true,
    value: { id: "user_1", email: "ann@example.com" },
  });
  const down = new Account({
    ask: controlPlane({ "GET /auth/get-session": () => Promise.reject(new Error("x")) }).ask,
    storage: storage(),
  });
  expect(await down.session()).toMatchObject({ ok: false, status: 0 });
});

const settle = () => new Promise((done) => setTimeout(done, 0));

test("the token is asked for once, kept in memory only, and reused; with under three minutes left it still goes out and a new one is asked for behind it, and with under half a minute it is waited for", async () => {
  let clock = 1_000_000;
  let issued = 0;
  const notes = storage();
  const { ask, seen } = controlPlane({ "POST /auth/workspace-token": () => token(++issued) });
  const account = new Account({ ask, storage: notes, now: () => clock });
  // No workspace open: nothing is asked and nothing is given.
  expect(await account.authorization()).toBeNull();
  expect(seen).toHaveLength(0);
  account.select("wsp_aaaa");
  expect(notes.values.get(WORKSPACE_KEY)).toBe("wsp_aaaa");
  expect(account.scope()).toBe("wsp_aaaa");
  expect(await account.authorization()).toBe("Bearer token-1");
  expect(seen[0]?.body).toEqual({ workspace: "wsp_aaaa" });
  clock += 400_000;
  expect(await account.authorization()).toBe("Bearer token-1");
  await settle();
  expect(issued).toBe(1);
  // Under three minutes left: the request goes with the token it has, at once, and a new one is asked for behind it, once however many requests find it.
  clock += 600_000 - 400_000 - REFRESH_BEFORE_MS + 1;
  const found = await Promise.all([account.authorization(), account.authorization()]);
  expect(found).toEqual(["Bearer token-1", "Bearer token-1"]);
  await settle();
  expect(issued).toBe(2);
  // The next request has the new one.
  expect(await account.authorization()).toBe("Bearer token-2");
  expect(issued).toBe(2);
  // Under half a minute left (a person who came back after a pause): a new one is waited for, and never the one that is about to run out.
  clock += 600_000 - WAIT_BELOW_MS + 1;
  expect(await account.authorization()).toBe("Bearer token-3");
  expect(issued).toBe(3);
  // Asked for a new one at once, as after a refusal.
  expect(await account.authorization(true)).toBe("Bearer token-4");
  // The token is nowhere in the browser's storage.
  expect([...notes.values.values()].join(" ")).not.toContain("token-");
  // Another workspace has its own token, and the one before is not given for it.
  account.select("wsp_bbbb");
  expect(await account.authorization()).toBe("Bearer token-5");
  expect(seen.at(-1)?.body).toEqual({ workspace: "wsp_bbbb" });
});

test("a refill behind a request that finds the token near its end that is refused ends the session as a waiting one does, and the request that found it is not held up", async () => {
  let clock = 1_000_000;
  let status = 200;
  const ended: string[] = [];
  const { ask } = controlPlane({
    "POST /auth/workspace-token": () => (status === 200 ? token(1) : refusal(status, "x")),
  });
  const account = new Account({
    ask,
    storage: storage(),
    now: () => clock,
    onEnded: (why) => void ended.push(why),
  });
  account.select("wsp_aaaa");
  expect(await account.authorization()).toBe("Bearer token-1");
  clock += 600_000 - REFRESH_BEFORE_MS + 1;
  status = 401;
  // The request that finds the token near its end goes with it; the refill that was asked for behind it is what hears the session has ended.
  expect(await account.authorization()).toBe("Bearer token-1");
  await settle();
  expect(ended).toEqual(["session_ended"]);
  // A control plane that cannot be reached behind a request ends nothing: the token goes on until it is too old, and then the wait is the page's.
  const quiet: string[] = [];
  let reachable = true;
  const flaky = new Account({
    ask: controlPlane({
      "POST /auth/workspace-token": () =>
        reachable ? token(7) : Promise.reject(new Error("offline")),
    }).ask,
    storage: storage(),
    now: () => clock,
    sleep: async () => {},
    onEnded: (why) => void quiet.push(why),
  });
  flaky.select("wsp_aaaa");
  expect(await flaky.authorization()).toBe("Bearer token-7");
  // Near its end: it goes out, and the refill that is asked for behind it cannot be had.
  clock += 600_000 - REFRESH_BEFORE_MS + 1;
  reachable = false;
  expect(await flaky.authorization()).toBe("Bearer token-7");
  await settle();
  // Still good for longer than the page would wait for a new one: it goes on.
  clock += REFRESH_BEFORE_MS - WAIT_BELOW_MS - 1_000;
  expect(await flaky.authorization()).toBe("Bearer token-7");
  // Too near its end to be sent: the wait is the page's, and nothing was ended.
  clock += 2_000;
  expect(await flaky.authorization()).toBeNull();
  expect(quiet).toEqual([]);
});

test("many requests waiting for a token ask for one", async () => {
  let issued = 0;
  const { ask } = controlPlane({
    "POST /auth/workspace-token": async () => {
      issued += 1;
      await new Promise((done) => setTimeout(done, 5));
      return token(issued);
    },
  });
  const account = new Account({ ask, storage: storage() });
  account.select("wsp_aaaa");
  const all = await Promise.all(Array.from({ length: 12 }, () => account.authorization()));
  expect(new Set(all)).toEqual(new Set(["Bearer token-1"]));
  expect(issued).toBe(1);
});

test("a workspace still being prepared is waited for, as long as the control plane says, a few times, and then the page gives up without leaving", async () => {
  const waits: number[] = [];
  let calls = 0;
  const ended: string[] = [];
  const { ask } = controlPlane({
    "POST /auth/workspace-token": () => {
      calls += 1;
      return calls < 3
        ? refusal(409, "workspace_not_ready", "Preparing.", { "retry-after": "3" })
        : token(calls);
    },
  });
  const account = new Account({
    ask,
    storage: storage(),
    sleep: async (ms) => void waits.push(ms),
    onEnded: (why) => void ended.push(why),
  });
  account.select("wsp_aaaa");
  expect(await account.authorization()).toBe("Bearer token-3");
  expect(waits).toEqual([3000, 3000]);
  // For ever not ready: six tries, then null, and the page is not told it has to leave.
  const stuck = new Account({
    ask: controlPlane({ "POST /auth/workspace-token": () => refusal(409, "workspace_not_ready") })
      .ask,
    storage: storage(),
    sleep: async () => {},
    onEnded: (why) => void ended.push(why),
  });
  stuck.select("wsp_aaaa");
  expect(await stuck.authorization()).toBeNull();
  // A control plane that cannot be reached is waited for in the same way, and a wait is never longer than ten seconds.
  const waited: number[] = [];
  const far = new Account({
    ask: controlPlane({
      "POST /auth/workspace-token": () =>
        refusal(409, "workspace_not_ready", "x", { "retry-after": "999" }),
    }).ask,
    storage: storage(),
    sleep: async (ms) => void waited.push(ms),
  });
  far.select("wsp_aaaa");
  await far.authorization();
  expect(Math.max(...waited)).toBe(10_000);
  expect(ended).toEqual([]);
});

test("a session that has ended, and a workspace the person is no longer in, are told to the page, which gets no token", async () => {
  const ended: string[] = [];
  const asking = (status: number) =>
    new Account({
      ask: controlPlane({ "POST /auth/workspace-token": () => refusal(status, "x") }).ask,
      storage: storage(),
      onEnded: (why) => void ended.push(why),
    });
  const gone = asking(401);
  gone.select("wsp_aaaa");
  expect(await gone.authorization()).toBeNull();
  const removed = asking(404);
  removed.select("wsp_aaaa");
  expect(await removed.authorization()).toBeNull();
  expect(ended).toEqual(["session_ended", "workspace_gone"]);
  // A workspace that is being deleted is closed to everyone: waiting for it would not change that, so it is the same as one the person is not in (and not a wait).
  const closed = new Account({
    ask: controlPlane({
      "POST /auth/workspace-token": () => refusal(409, "workspace_deleting", "Being deleted."),
    }).ask,
    storage: storage(),
    sleep: async () => {
      throw new Error("it waited for a workspace that is being deleted");
    },
    onEnded: (why) => void ended.push(why),
  });
  closed.select("wsp_aaaa");
  expect(await closed.authorization()).toBeNull();
  expect(ended).toEqual(["session_ended", "workspace_gone", "workspace_gone"]);
  ended.pop();
  // Anything else the control plane says is not the end of anything.
  const odd = asking(400);
  odd.select("wsp_aaaa");
  expect(await odd.authorization()).toBeNull();
  expect(ended).toHaveLength(2);
});

test("the fetch for the application carries the token, asks for a new one and sends once more when the service refuses it, and says the session is over if it refuses again", async () => {
  const calls: { token: string | null }[] = [];
  let refuse = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ token: new Headers(init?.headers).get("authorization") });
    return refuse-- > 0 ? new Response("{}", { status: 401 }) : new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  try {
    let issued = 0;
    let endedCount = 0;
    installAuthorizer({
      authorization: async () => `Bearer token-${++issued}`,
      scope: () => "wsp_aaaa",
      ended: () => {
        endedCount += 1;
      },
    });
    expect((await ambientFetch("/v1/book.get", { method: "POST", body: "{}" })).status).toBe(200);
    expect(calls).toEqual([{ token: "Bearer token-1" }]);
    // Refused once: a new token and one more try.
    refuse = 1;
    expect((await ambientFetch("/v1/book.get", { method: "POST", body: "{}" })).status).toBe(200);
    expect(calls.slice(1).map((c) => c.token)).toEqual(["Bearer token-2", "Bearer token-3"]);
    expect(endedCount).toBe(0);
    // Refused twice: over.
    refuse = 2;
    expect((await ambientFetch("/v1/book.get", { method: "POST", body: "{}" })).status).toBe(401);
    expect(endedCount).toBe(1);
    // A body that cannot be sent twice is not retried.
    refuse = 1;
    const stream = new ReadableStream({
      start: (c) => {
        c.enqueue(new Uint8Array([1]));
        c.close();
      },
    });
    const before = calls.length;
    expect(
      (
        await ambientFetch("/v1/uploads", {
          method: "POST",
          body: stream,
          duplex: "half",
        } as RequestInit)
      ).status,
    ).toBe(401);
    expect(calls.length - before).toBe(1);
    // With nothing installed, the request goes as it is, with no header.
    installAuthorizer(null);
    calls.length = 0;
    await ambientFetch("/v1/book.get", { method: "POST", body: "{}" });
    expect(calls).toEqual([{ token: null }]);
    expect(authorizationScope()).toBe("");
  } finally {
    globalThis.fetch = original;
  }
});

test("a person taken out of the workspace, or a workspace deleted, while the page is open: the book's refusal asks for a new token, which tells the page; any other 403 is just an answer; a fresh token the book still refuses is the person's to see and not a sign-out", async () => {
  const original = globalThis.fetch;
  let answer: () => Response = () => new Response("{}", { status: 200 });
  const calls: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Headers(init?.headers).get("authorization") ?? "");
    return answer();
  }) as unknown as typeof fetch;
  const refusal = (status: number, code: string) => () =>
    Response.json({ ok: false, error: { code, message: "No." } }, { status });
  try {
    let issued = 0;
    let ended = 0;
    let next: () => Promise<string | null> = async () => `Bearer token-${++issued}`;
    installAuthorizer({
      authorization: async (force) => (force ? next() : `Bearer token-${++issued}`),
      scope: () => "wsp_aaaa",
      ended: () => {
        ended += 1;
      },
    });
    // Not a member, or the book is closed (being deleted) or gone: a new token is asked for, and sent once more. When the control plane gives one all the same (a removal or a
    // deletion it has not told the book of yet, or a restore the book has not heard of), the book's answer is the person's to see, and the page does not sign them out.
    for (const [status, code] of [
      [403, "not_a_member"],
      [410, "book_retired"],
      [410, "book_deleted"],
    ] as const) {
      calls.length = 0;
      answer = refusal(status, code);
      expect((await ambientFetch("/v1/book.get", { method: "POST", body: "{}" })).status).toBe(
        status,
      );
      expect(calls, code).toHaveLength(2);
    }
    expect(ended).toBe(0);
    // The control plane refuses a token (the authorizer tells the page itself): nothing is sent twice and nothing more is ended here.
    calls.length = 0;
    next = async () => null;
    expect((await ambientFetch("/v1/book.get", { method: "POST", body: "{}" })).status).toBe(410);
    expect(calls).toHaveLength(1);
    expect(ended).toBe(0);
    // A 403 or a 410 for another reason (a role that may not do this, a thing that is gone) is the answer; a body that is not JSON is too.
    calls.length = 0;
    answer = refusal(403, "forbidden");
    expect((await ambientFetch("/v1/entries.post", { method: "POST", body: "{}" })).status).toBe(
      403,
    );
    answer = refusal(410, "gone_for_another_reason");
    expect((await ambientFetch("/v1/entries.post", { method: "POST", body: "{}" })).status).toBe(
      410,
    );
    answer = () => new Response("<html>", { status: 403 });
    expect((await ambientFetch("/v1/entries.post", { method: "POST", body: "{}" })).status).toBe(
      403,
    );
    expect(calls).toHaveLength(3);
    expect(ended).toBe(0);
    // A new token that is itself refused with 401 is the session's end.
    next = async () => `Bearer token-${++issued}`;
    answer = () => new Response("{}", { status: 401 });
    expect((await ambientFetch("/v1/book.get", { method: "POST", body: "{}" })).status).toBe(401);
    expect(ended).toBe(1);
    // A control plane that cannot be reached when a new token is asked for does not end the session: the refusal is the answer and the person can try again.
    calls.length = 0;
    next = async () => null;
    expect((await ambientFetch("/v1/book.get", { method: "POST", body: "{}" })).status).toBe(401);
    expect(calls).toHaveLength(1);
    expect(ended).toBe(1);
  } finally {
    globalThis.fetch = original;
  }
});

test("a write waiting in one workspace is not seen from another, and without accounts the keys are what they always were", async () => {
  const notes = storage();
  let opened = "wsp_aaaa";
  const refuse503 = (async () =>
    new Response(
      JSON.stringify({
        version: API_VERSION,
        bookId: "local-book",
        operationId: "x",
        ok: false,
        error: { code: "service_limit", message: "Busy", retryable: true, details: [] },
      }),
      { status: 503 },
    )) as unknown as typeof fetch;
  const client = () => new BrowserApplicationClient(notes, refuse503);
  // Without accounts: the key has no workspace in it.
  installAuthorizer(null);
  await client()
    .write(
      "drafts.create",
      { data: { date: "2026-01-01", reference: "r", narration: "n", lines: [] } } as never,
      "flow",
    )
    .catch(() => {});
  expect([...notes.values.keys()]).toEqual([`rastrata:${API_VERSION}:local-book:flow:pending`]);
  expect(client().pending("flow")).not.toBeNull();
  notes.values.clear();
  // With accounts: the key names the workspace, and another workspace does not find it.
  installAuthorizer({ authorization: async () => null, scope: () => opened, ended: () => {} });
  await client()
    .write(
      "drafts.create",
      { data: { date: "2026-01-01", reference: "r", narration: "n", lines: [] } } as never,
      "flow",
    )
    .catch(() => {});
  expect([...notes.values.keys()]).toEqual([
    `rastrata:${API_VERSION}:local-book:wsp_aaaa:flow:pending`,
  ]);
  expect(client().pending("flow")).not.toBeNull();
  opened = "wsp_bbbb";
  expect(client().pending("flow")).toBeNull();
  opened = "wsp_aaaa";
  expect(client().pending("flow")).not.toBeNull();
});

test("the service says whether people sign in with accounts", () => {
  expect(accountsOf({ hosted: { book: "b", accounts: true } })).toBe(true);
  for (const body of [
    null,
    "x",
    {},
    { hosted: null },
    { hosted: { book: "b" } },
    { hosted: { accounts: "yes" } },
    { hosted: { accounts: false } },
  ])
    expect(accountsOf(body)).toBe(false);
});

test("the service says whether it makes backups: it does unless it says it does not", () => {
  expect(backupsOf({ hosted: { book: "b", backups: false } })).toBe(false);
  for (const body of [
    null,
    "x",
    {},
    { hosted: null },
    { hosted: { book: "b" } },
    { hosted: { backups: true } },
  ])
    expect(backupsOf(body)).toBe(true);
});

test("the service says whether it takes an agent's token: it does unless it says it does not", () => {
  expect(agentsOf({ hosted: { book: "b", agents: false } })).toBe(false);
  for (const body of [
    null,
    "x",
    {},
    { hosted: null },
    { hosted: { book: "b" } },
    { hosted: { agents: true } },
  ])
    expect(agentsOf(body)).toBe(true);
});

test("the service says whether it can keep a bank or Stripe credential: it can unless it says it cannot", () => {
  expect(connectionsOf({ hosted: { book: "b", connections: false } })).toBe(false);
  for (const body of [
    null,
    "x",
    {},
    { hosted: null },
    { hosted: { book: "b" } },
    { hosted: { connections: true } },
    { hosted: { connections: "no" } },
  ])
    expect(connectionsOf(body)).toBe(true);
});

test("signing out is told: ended, ended already, or not ended, so that a page never says a person is out when they are not", async () => {
  for (const [answer, ended] of [
    [() => Response.json({ success: true }), true],
    [() => refusal(401, "unauthorized"), true],
    [() => refusal(503, "unavailable"), false],
  ] as const) {
    const { ask } = controlPlane({ "POST /auth/sign-out": answer });
    expect(await new Account({ ask, storage: storage() }).signOut()).toBe(ended);
  }
  const unreachable = (async () => {
    throw new TypeError("offline");
  }) as unknown as typeof fetch;
  expect(await new Account({ ask: unreachable, storage: storage() }).signOut()).toBe(false);
});

test("the page starts as it always did on a service without accounts, and on one with accounts it needs a workspace open or it goes to /start", async () => {
  const health = (accounts: boolean, connections = true) =>
    (async () =>
      Response.json(
        {
          service: "rastrata",
          hosted: {
            book: "b",
            ...(accounts ? { accounts: true } : {}),
            ...(connections ? {} : { connections: false }),
          },
        },
        { headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
  const went: string[] = [];
  const go = (path: string) => void went.push(path);
  // Without accounts: nothing is installed.
  const plain = await bootAccounts({ ask: health(false), go, storage: storage() });
  expect(plain).toEqual({ redirecting: false, account: null });
  expect(capabilities()).toEqual({
    accounts: false,
    connections: true,
    banks: false,
    stripeApp: false,
    billing: false,
    agents: true,
    backups: true,
  });
  expect(currentAccount()).toBeNull();
  expect(authorizationScope()).toBe("");
  expect(went).toEqual([]);
  // With accounts and no workspace open: on its way to /start, and the application is not drawn.
  const none = await bootAccounts({ ask: health(true), go, storage: storage() });
  expect(none.redirecting).toBe(true);
  expect(went).toEqual([START_PATH]);
  expect(START_PATH).toBe("/start");
  // What the service cannot do is learned with the rest: a pod with many books keeps no connection's credential.
  await bootAccounts({ ask: health(true, false), go: () => {}, storage: storage() });
  expect(capabilities()).toEqual({
    accounts: true,
    connections: false,
    banks: false,
    stripeApp: false,
    billing: false,
    agents: true,
    backups: true,
  });
  // With one open: the authorizer is installed and the workspace is the scope of every retained write.
  const notes = storage();
  notes.setItem(WORKSPACE_KEY, "wsp_aaaa");
  const open = await bootAccounts({ ask: health(true), go, storage: notes });
  expect(open.redirecting).toBe(false);
  expect(open.account).toBe(currentAccount());
  expect(authorizationScope()).toBe("wsp_aaaa");
  expect(went).toEqual([START_PATH]);
});

test("where the workspace stands is asked for beside the service's config and not after it, and the answer is used only on a service that charges", async () => {
  for (const billing of [true, false]) {
    resetOpening();
    const notes = storage();
    notes.setItem(WORKSPACE_KEY, "wsp_aaaa");
    const seen: string[] = [];
    let release: () => void = () => {};
    const slow = new Promise<void>((done) => {
      release = done;
    });
    const ask = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      seen.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/health")
        return Response.json({ service: "rastrata", hosted: { book: "b", accounts: true } });
      if (path === "/auth/config") {
        await slow;
        return Response.json({ billing });
      }
      if (path === "/auth/workspaces/wsp_aaaa")
        return Response.json({ workspace: { id: "wsp_aaaa", state: "ready" } });
      return Response.json({ success: true });
    }) as unknown as typeof fetch;
    const booting = bootAccounts({
      ask,
      go: () => {},
      storage: notes,
      readBook: async () => ({}),
    });
    // The config has not answered, and the workspace has been asked for already: the page does not spend the config's time and then the workspace's.
    await new Promise((done) => setTimeout(done, 20));
    expect(seen).toContain("GET /auth/workspaces/wsp_aaaa");
    release();
    await booting;
    await openingRead();
    const standing = fromOpening<unknown>("standing", async () => "asked again");
    expect(standing.initial).toEqual(billing ? { id: "wsp_aaaa", state: "ready" } : null);
    expect(seen.filter((line) => line === "GET /auth/config")).toHaveLength(1);
    expect(seen.filter((line) => line === "GET /auth/workspaces/wsp_aaaa")).toHaveLength(1);
  }
  resetOpening();
});

test("a session that ends while the page is open signs out properly and goes to /start; a workspace the person is removed from is forgotten and goes to /start", async () => {
  const seen: string[] = [];
  const asks = (status: number) =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      seen.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/health")
        return Response.json(
          { service: "rastrata", hosted: { book: "b", accounts: true } },
          { headers: { "content-type": "application/json" } },
        );
      if (path === "/auth/workspace-token") return refusal(status, "x");
      return Response.json({ success: true });
    }) as unknown as typeof fetch;
  for (const [status, remembered] of [
    [401, "wsp_aaaa"],
    [404, null],
  ] as const) {
    seen.length = 0;
    const notes = storage();
    notes.setItem(WORKSPACE_KEY, "wsp_aaaa");
    const went: string[] = [];
    const booted = await bootAccounts({
      ask: asks(status),
      go: (path) => void went.push(path),
      storage: notes,
    });
    expect(await booted.account?.authorization()).toBeNull();
    await new Promise((done) => setTimeout(done, 5));
    expect(went).toEqual([START_PATH]);
    expect(notes.getItem(WORKSPACE_KEY)).toBe(remembered);
    expect(seen.includes("POST /auth/sign-out")).toBe(status === 401);
  }
});

test("signing out of every browser sends an empty body and is over when the control plane says so, or says nobody is signed in; a refusal is not", async () => {
  const seen: { url: string; method: string; body: unknown }[] = [];
  const answers = [
    new Response("{}", { status: 200 }),
    new Response(
      JSON.stringify({ message: "Sign in to continue.", code: "authentication_required" }),
      {
        status: 401,
        headers: { "content-type": "application/json" },
      },
    ),
    new Response("{}", { status: 503 }),
  ];
  const account = new Account({
    ask: (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return answers.shift() as Response;
    }) as typeof fetch,
    storage: null,
  });
  expect(await account.signOutEverywhere()).toBe(true);
  expect(await account.signOutEverywhere()).toBe(true);
  expect(await account.signOutEverywhere()).toBe(false);
  expect(seen).toEqual(
    Array.from({ length: 3 }, () => ({
      url: "/auth/account/sign-out-everywhere",
      method: "POST",
      body: {},
    })),
  );
});

test("agent keys: the list is asked for by workspace, a key is made with a trimmed name and its scopes and shows its secret in the answer, and ending one sends the note only when there is one", async () => {
  const { ask, seen } = controlPlane({
    "GET /auth/agent-keys?workspace=wsp_x": () =>
      Response.json({
        keys: [],
        grantable: ["read", "draft"],
        defaultExpiryDays: 90,
        maxExpiryDays: 365,
      }),
    "GET /auth/agent-keys?workspace=wsp_x%2Fy": () =>
      Response.json({ keys: [], grantable: ["read"], defaultExpiryDays: 90, maxExpiryDays: 365 }),
    "POST /auth/agent-keys": () =>
      Response.json(
        { key: { id: "0123456789abcdef", name: "Claude" }, secret: "rsa_x" },
        { status: 201 },
      ),
    "POST /auth/agent-keys/revoke": () => Response.json({ ok: true }),
  });
  const account = new Account({ ask, storage: storage() });
  const listed = await account.agentKeys("wsp_x");
  expect(listed.ok && listed.value.grantable).toEqual(["read", "draft"]);
  expect((await account.agentKeys("wsp_x/y")).ok).toBe(true);
  const made = await account.createAgentKey(
    "wsp_x",
    "  Claude on my laptop ",
    ["read", "draft"],
    30,
  );
  expect(made.ok && made.value.secret).toBe("rsa_x");
  expect(seen.find((request) => request.url === "/auth/agent-keys")?.body).toEqual({
    workspace: "wsp_x",
    name: "Claude on my laptop",
    scopes: ["read", "draft"],
    expiresInDays: 30,
  });
  expect((await account.revokeAgentKey("0123456789abcdef")).ok).toBe(true);
  expect((await account.revokeAgentKey("0123456789abcdef", "laptop lost")).ok).toBe(true);
  const revokes = seen.filter((request) => request.url === "/auth/agent-keys/revoke");
  expect(revokes.map((request) => request.body)).toEqual([
    { id: "0123456789abcdef" },
    { id: "0123456789abcdef", reason: "laptop lost" },
  ]);
  // Nothing is cached, and the secret is nowhere in what the account layer keeps.
  expect(JSON.stringify(account)).not.toContain("rsa_x");
});

test("a code that connects an agent is asked for with the workspace and what the agent may do, and nothing else", async () => {
  const { ask, seen } = controlPlane({
    "POST /auth/agent-codes": () =>
      Response.json(
        { code: "R7K2-9QDM-4XHT", expiresAt: "2026-11-17T17:10:00.000Z", scopes: ["read"] },
        { status: 201 },
      ),
  });
  const account = new Account({ ask, storage: storage() });
  const made = await account.createAgentCode("wsp_x", ["read", "draft"]);
  expect(made.ok && made.value).toMatchObject({
    code: "R7K2-9QDM-4XHT",
    expiresAt: "2026-11-17T17:10:00.000Z",
  });
  expect(seen.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
    {
      url: "/auth/agent-codes",
      method: "POST",
      body: { workspace: "wsp_x", scopes: ["read", "draft"] },
    },
  ]);
});

test("a service with accounts that has agent keys is not told it takes none: a stranger reads no word about agents, and the page keeps the Agents route", () => {
  expect(
    agentsOf({ ok: true, hosted: { accounts: true, backups: false, connections: false } }),
  ).toBe(true);
  expect(agentsOf({ ok: true, hosted: { backups: false, agents: false } })).toBe(false);
});

test("the page learns from the control plane that Stripe can be connected with the button, and not from the service", async () => {
  const ask = (stripeApp: boolean) =>
    (async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/health")
        return Response.json(
          { service: "rastrata", hosted: { book: "b", accounts: true, connections: false } },
          { headers: { "content-type": "application/json" } },
        );
      if (path === "/auth/config") return Response.json({ captcha: null, stripeApp });
      return Response.json({ token: "t", expiresIn: 600 });
    }) as unknown as typeof fetch;
  const notes = storage();
  notes.setItem(WORKSPACE_KEY, "wsp_aaaa");
  await bootAccounts({ ask: ask(true), go: () => {}, storage: notes });
  expect(capabilities()).toMatchObject({ connections: false, stripeApp: true });
  expect(has(capabilities(), "stripe")).toBe(true);
  await bootAccounts({ ask: ask(false), go: () => {}, storage: notes });
  expect(capabilities().stripeApp).toBe(false);
  expect(has(capabilities(), "stripe")).toBe(false);
});

test("a bank or Stripe that the control plane reads or stops has changed the book behind the page: what the page holds is let go once the action is over, whether it went through, was refused or never came back", async () => {
  const letGo: string[] = [];
  const { ask, seen } = controlPlane({
    "POST /auth/bank/sync": () => Response.json({ ok: true }),
    "POST /auth/bank/disconnect": () => refusal(403, "forbidden", "Only an owner can do that."),
    "POST /auth/stripe-app/sync": () => Response.json({ ok: true }),
    "POST /auth/stripe-app/disconnect": () => Promise.reject(new Error("offline")),
    "GET /auth/stripe-app/connection?workspace=wsp_aaaa": () => Response.json({ connected: false }),
    "GET /auth/bank/accounts?workspace=wsp_aaaa": () => Response.json({ accounts: [] }),
  });
  const account = new Account({
    ask,
    storage: storage(),
    bookChanged: () => void letGo.push(`after ${seen.length} calls`),
  });
  expect(await account.bankReadNow("wsp_aaaa")).toMatchObject({ ok: true });
  expect(letGo).toEqual(["after 1 calls"]);
  expect(await account.bankDisconnect("wsp_aaaa", "fca_1")).toMatchObject({
    ok: false,
    status: 403,
  });
  expect(letGo).toHaveLength(2);
  expect(await account.stripeAppReadNow("wsp_aaaa")).toMatchObject({ ok: true });
  expect(letGo).toHaveLength(3);
  expect(await account.stripeAppDisconnect("wsp_aaaa")).toMatchObject({
    ok: false,
    code: "unreachable",
  });
  expect(letGo).toHaveLength(4);
  // Looking is not changing.
  await account.stripeAppConnection("wsp_aaaa");
  await account.bankConnections("wsp_aaaa");
  expect(letGo).toHaveLength(4);
});

test("the page's start lets go of what it holds of the book when the control plane changes it", async () => {
  const held = await import("../../src/held");
  const notes = storage();
  notes.setItem(WORKSPACE_KEY, "wsp_aaaa");
  const ask = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/health")
      return Response.json(
        { service: "rastrata", hosted: { book: "b", accounts: true, connections: false } },
        { headers: { "content-type": "application/json" } },
      );
    if (path === "/auth/config") return Response.json({ captcha: null });
    if (path === "/auth/bank/sync") return Response.json({ ok: true });
    return Response.json({ token: "t", expiresIn: 600 });
  }) as unknown as typeof fetch;
  const { account } = await bootAccounts({ ask, go: () => {}, storage: notes });
  const before = held.currentEpoch();
  await account?.bankReadNow("wsp_aaaa");
  expect(held.currentEpoch()).toBeGreaterThan(before);
});

test("what the page keeps on the device is deleted when a session ends, by signing out, out of every browser or deleting the account, and the page does not wait long for a device that does not say it has", async () => {
  const forgot: string[] = [];
  const { ask, seen } = controlPlane({
    "POST /auth/sign-out": () => Response.json({ success: true }),
    "POST /auth/account/sign-out-everywhere": () => Response.json({ ok: true }),
    "POST /auth/account/delete": (request) =>
      (request.body as { confirm?: string }).confirm === "ann@example.com"
        ? Response.json({ ok: true })
        : refusal(400, "confirmation_mismatch", "Not that address."),
  });
  const account = new Account({
    ask,
    storage: storage(),
    sleep: async () => {},
    copy: {
      unlock: () => {},
      giveUp: () => {},
      forget: async () => void forgot.push(`after ${seen.length} calls`),
    },
  });
  expect(await account.signOut()).toBe(true);
  expect(await account.signOutEverywhere()).toBe(true);
  // Before the request that ends the session, so that nothing is left if the request is cut off.
  expect(forgot).toEqual(["after 0 calls", "after 1 calls"]);
  // A refused deletion deletes nothing here; one that went through does.
  expect((await account.deleteAccount("someone@example.com")).ok).toBe(false);
  expect(forgot).toHaveLength(2);
  expect((await account.deleteAccount("ann@example.com")).ok).toBe(true);
  expect(forgot).toHaveLength(3);

  // A device that never answers: the session is ended all the same, and the wait is over when the page says (here, at once).
  const waits: number[] = [];
  const stuck = new Account({
    ask,
    storage: storage(),
    sleep: async (ms) => void waits.push(ms),
    copy: { unlock: () => {}, giveUp: () => {}, forget: () => new Promise<void>(() => {}) },
  });
  const before = seen.length;
  expect(await stuck.signOut()).toBe(true);
  expect(await stuck.signOutEverywhere()).toBe(true);
  expect(seen.length - before).toBe(2);
  expect(waits).toEqual([FORGET_WAIT_MS, FORGET_WAIT_MS]);
  // One that fails is no reason not to sign out either.
  const failing = new Account({
    ask,
    storage: storage(),
    sleep: async () => {},
    copy: {
      unlock: () => {},
      giveUp: () => {},
      forget: () => Promise.reject(new Error("blocked")),
    },
  });
  expect(await failing.signOut()).toBe(true);
});
