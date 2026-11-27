// The first lines of the app's page (index.html) ask for what the page needs first, before the page's code has arrived: whether the service has accounts, and, for a person who has a
// workspace open, the token for it, which the service also takes as the word to open the book (src/early.ts, docs/reference/program/performance.md, "Under 100 ms"). The lines are
// inline so that they run before the code does; this runs the page's own text, with stand-ins for the storage, for fetch and for the window.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Account, WORKSPACE_KEY } from "../../src/account";
import { takeEarlyService, takeEarlyToken } from "../../src/early";
import { readService } from "../../src/service-state";

const html = readFileSync(join(import.meta.dir, "..", "..", "index.html"), "utf8");
const head = html.slice(0, html.indexOf("</head>"));
const SCRIPT = /<script(?![^>]*\ssrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
const scripts = [...head.matchAll(SCRIPT)];
const early = scripts.find((script) => (script[1] ?? "").includes("__rastrataEarly"));

afterEach(() => {
  delete (globalThis as { __rastrataEarly?: unknown }).__rastrataEarly;
});

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}
interface Window {
  __rastrataEarly?: {
    service?: Promise<Response>;
    token?: { workspace: string; response: Promise<Response> };
  };
}

/** Run the page's text as the browser does, with `localStorage`, `fetch` and `window` as given. */
function run(storage: unknown, fetcher: unknown, window: Window = {}): Window {
  new Function(
    "localStorage",
    "fetch",
    "window",
    early?.[1] ?? "throw new Error('no such script')",
  )(storage, fetcher, window);
  return window;
}
const remembering = (value: string | null) => ({
  getItem: (key: string) => (key === WORKSPACE_KEY ? value : null),
});
function recorder(answer: () => Promise<unknown> = async () => new Response("{}")) {
  const calls: Call[] = [];
  return {
    calls,
    fetcher: (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return answer();
    },
  };
}

test("the lines are a script of their own in the page's head, before the title, the styles and the page's code", () => {
  expect(early).toBeDefined();
  const at = early?.index ?? -1;
  for (const later of ["<title>", '<link rel="stylesheet"', '<script type="module"'])
    expect(head.indexOf(later), later).toBeGreaterThan(at);
  // Two inline scripts, the theme's and this one, and nothing else inline: the pod allows each by its hash.
  expect(scripts).toHaveLength(2);
});

test("a page that remembers a workspace asks for the service's health and the workspace's token, once each, as the page's own requests, and leaves them for the page's code", () => {
  const { calls, fetcher } = recorder();
  const window = run(remembering("wsp_0000000001"), fetcher);
  expect(calls.map((call) => call.url)).toEqual(["/health", "/auth/workspace-token"]);
  const [health, token] = calls as [Call, Call];
  // The same request the page's code makes for the health (service-state.ts), so that its answer can stand in for it.
  expect(health.init).toEqual({ headers: { accept: "application/json" }, cache: "no-store" });
  expect(token.init?.method).toBe("POST");
  expect(token.init?.headers).toEqual({ "content-type": "application/json" });
  expect(JSON.parse(String(token.init?.body))).toEqual({ workspace: "wsp_0000000001" });
  expect(token.init?.cache).toBe("no-store");
  // Its own origin and the person's cookies are what fetch does with a path and no other say; nothing is added.
  expect(token.init?.credentials).toBeUndefined();
  expect(token.init?.mode).toBeUndefined();
  expect(token.init?.keepalive).toBeUndefined();
  expect(window.__rastrataEarly?.service).toBeInstanceOf(Promise);
  expect(window.__rastrataEarly?.token?.workspace).toBe("wsp_0000000001");
});

test("it asks for the workspace by the key the page remembers it by, so the two cannot drift apart", () => {
  const { calls, fetcher } = recorder();
  const asked: string[] = [];
  run(
    {
      getItem: (key: string) => {
        asked.push(key);
        return "wsp_0000000002";
      },
    },
    fetcher,
  );
  expect(asked).toEqual([WORKSPACE_KEY]);
  expect(calls).toHaveLength(2);
});

test("a page that remembers no workspace (a first visit, a signed-out browser, a service with no accounts) asks for the health only", () => {
  for (const value of [null, ""]) {
    const { calls, fetcher } = recorder();
    const window = run(remembering(value), fetcher);
    expect(
      calls.map((call) => call.url),
      String(value),
    ).toEqual(["/health"]);
    expect(window.__rastrataEarly?.token).toBeUndefined();
  }
});

test("blocked storage, a missing fetch and a fetch that throws are none of the page's business: nothing is thrown", () => {
  const blocked = recorder();
  const window = run(
    {
      getItem: () => {
        throw new Error("storage is blocked");
      },
    },
    blocked.fetcher,
  );
  // The health was asked for before the storage was read, and is left for the page's code.
  expect(blocked.calls.map((call) => call.url)).toEqual(["/health"]);
  expect(window.__rastrataEarly?.token).toBeUndefined();

  expect(() => run(remembering("wsp_0000000001"), undefined)).not.toThrow();
  expect(() =>
    run(remembering("wsp_0000000001"), () => {
      throw new Error("no network");
    }),
  ).not.toThrow();
});

test("a request that is refused or never leaves leaves no rejection unhandled: a process that ran the lines ends well after them, though nothing took the answer", async () => {
  // An unhandled rejection ends a Bun process with status 1, which is how this is told apart from a handled one.
  const code = `
    const localStorage = { getItem: () => "wsp_0000000001" };
    const fetch = () => Promise.reject(new Error("offline"));
    const window = {};
    (function (localStorage, fetch, window) {${early?.[1] ?? ""}})(localStorage, fetch, window);
    setTimeout(() => process.exit(0), 50);
  `;
  const child = Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" });
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(stderr).toBe("");
  expect(status).toBe(0);
});

test("each request is taken once, the token only for the workspace it was made for, and nothing is taken when the lines did not run", () => {
  expect(takeEarlyService()).toBeNull();
  expect(takeEarlyToken("wsp_0000000001")).toBeNull();
  const { fetcher } = recorder();
  run(remembering("wsp_0000000001"), fetcher, globalThis as Window);
  expect(takeEarlyService()).toBeInstanceOf(Promise);
  expect(takeEarlyService()).toBeNull();
  // The person changed workspace between the lines and the code: the request is not theirs, and is not kept for later either.
  expect(takeEarlyToken("wsp_0000000002")).toBeNull();
  expect(takeEarlyToken("wsp_0000000001")).toBeNull();
  run(remembering("wsp_0000000001"), fetcher, globalThis as Window);
  expect(takeEarlyToken("wsp_0000000001")).toBeInstanceOf(Promise);
  expect(takeEarlyToken("wsp_0000000001")).toBeNull();
});

const health = (body: unknown) => async () =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

test("the page's code takes the health the first lines asked for and does not ask again; asked with a fetch of its own, or when there was none, it asks", async () => {
  const { fetcher: first } = recorder(health({ service: "rastrata", hosted: { accounts: true } }));
  run(remembering(null), first, globalThis as Window);
  const own = recorder(health({ service: "rastrata", hosted: { accounts: false } }));
  expect((await readService()).accounts).toBe(true);
  expect(own.calls).toHaveLength(0);
  // The next read is a read of its own.
  const again = recorder(health({ service: "rastrata", hosted: { accounts: false } }));
  expect((await readService(again.fetcher as typeof fetch)).accounts).toBe(false);
  expect(again.calls.map((call) => call.url)).toEqual(["/health"]);
  // With a fetch given, the lines' answer is not what is asked for.
  run(remembering(null), first, globalThis as Window);
  expect((await readService(again.fetcher as typeof fetch)).accounts).toBe(false);
  expect(takeEarlyService()).toBeInstanceOf(Promise);
  // A request that failed is no answer: the service is "not reading" and the page goes on.
  run(remembering(null), () => Promise.reject(new Error("offline")), globalThis as Window);
  expect((await readService()).accounts).toBe(false);
});

// ---- the account layer's first token -----------------------------------------------------------------

const notes = () => {
  const values = new Map<string, string>([[WORKSPACE_KEY, "wsp_aaaa"]]);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
};
const tokenAnswer = (token: string, status = 200) =>
  new Response(JSON.stringify(status === 200 ? { token, expiresIn: 600 } : { code: "x" }), {
    status,
    headers: { "content-type": "application/json" },
  });

function earlyToken(response: Promise<Response>, workspace = "wsp_aaaa") {
  (globalThis as { __rastrataEarly?: unknown }).__rastrataEarly = {
    token: { workspace, response },
  };
}

test("the first token is the answer to the request the first lines made, and the page's code asks for no other", async () => {
  const asked: string[] = [];
  earlyToken(Promise.resolve(tokenAnswer("early")));
  const account = new Account({
    ask: async (path) => {
      asked.push(String(path));
      return tokenAnswer("later");
    },
    storage: notes(),
  });
  expect(await account.authorization()).toBe("Bearer early");
  expect(asked).toEqual([]);
  // It was taken once: a token asked for after it, with force as after a refusal, is the page's own.
  expect(await account.authorization(true)).toBe("Bearer later");
  expect(asked).toEqual(["/auth/workspace-token"]);
});

test("the first lines' request is answered as the page's own would be: a session that has ended and a workspace that is gone are told to the page, and a preparing workspace is waited for", async () => {
  const ended: string[] = [];
  const answering = (status: number) => {
    earlyToken(Promise.resolve(tokenAnswer("", status)));
    return new Account({
      ask: async () => tokenAnswer("never"),
      storage: notes(),
      onEnded: (why) => void ended.push(why),
    });
  };
  expect(await answering(401).authorization()).toBeNull();
  expect(await answering(404).authorization()).toBeNull();
  expect(ended).toEqual(["session_ended", "workspace_gone"]);
  // Preparing (409): waited for as long as the control plane says, and then asked for again by the page's code.
  earlyToken(Promise.resolve(tokenAnswer("", 409)));
  const waits: number[] = [];
  const preparing = new Account({
    ask: async () => tokenAnswer("after"),
    storage: notes(),
    sleep: async (ms) => void waits.push(ms),
  });
  expect(await preparing.authorization()).toBe("Bearer after");
  expect(waits).toEqual([2000]);
});

test("a request of the first lines that never came back is asked again at once and not after a wait, and one for another workspace is not used", async () => {
  for (const failed of [
    Promise.reject(new Error("offline")),
    Promise.resolve(tokenAnswer("", 503)),
  ]) {
    earlyToken(failed);
    const waits: number[] = [];
    const account = new Account({
      ask: async () => tokenAnswer("own"),
      storage: notes(),
      sleep: async (ms) => void waits.push(ms),
    });
    expect(await account.authorization()).toBe("Bearer own");
    expect(waits).toEqual([]);
  }
  earlyToken(Promise.resolve(tokenAnswer("not-yours")), "wsp_bbbb");
  const other = new Account({ ask: async () => tokenAnswer("own"), storage: notes() });
  expect(await other.authorization()).toBe("Bearer own");
});
