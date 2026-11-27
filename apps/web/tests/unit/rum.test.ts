import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { API_VERSION } from "@rastrata/application/client-contracts";
import { type Beacon, parseBeacon } from "@rastrata/telemetry/web";
import { BrowserApplicationClient, type ApplicationFetch } from "../../src/application-client";
import {
  flush,
  resetRum,
  rumSample,
  startRum,
  takeBeacon,
  timeAction,
  type VitalsLibrary,
} from "../../src/rum";
import {
  outcomeOfError,
  serviceAsksForRum,
  timeAction as hookedTimeAction,
} from "../../src/rum-hook";

// The unit tests run without a DOM, so the few browser globals the measurement touches are stand-ins.
const scope = globalThis as unknown as Record<string, unknown>;
const timing = performance as unknown as { getEntriesByType: unknown };
const real = {
  getEntriesByType: timing.getEntriesByType,
  addEventListener: scope.addEventListener,
  requestAnimationFrame: scope.requestAnimationFrame,
  document: scope.document,
};
type Handler = (event: { timeStamp?: number }) => void;
const listeners = new Map<string, Handler[]>();
let serverTiming: { name: string; description: string }[] = [];
let page = { visibilityState: "visible" };

beforeEach(() => {
  listeners.clear();
  serverTiming = [];
  page = { visibilityState: "visible" };
  timing.getEntriesByType = (type: string) => (type === "navigation" ? [{ serverTiming }] : []);
  scope.addEventListener = (type: string, handler: Handler) => {
    listeners.set(type, [...(listeners.get(type) ?? []), handler]);
  };
  scope.requestAnimationFrame = (run: () => void) => setTimeout(run, 0);
  scope.document = page;
});
afterEach(() => {
  resetRum();
  timing.getEntriesByType = real.getEntriesByType;
  scope.addEventListener = real.addEventListener;
  scope.requestAnimationFrame = real.requestAnimationFrame;
  scope.document = real.document;
});
const fire = (type: string, event: { timeStamp?: number } = {}) => {
  for (const handler of listeners.get(type) ?? []) handler(event);
};

function fakeVitals() {
  const reports: Record<string, (metric: { value: number }) => void> = {};
  const library: VitalsLibrary = {
    onLCP: (report) => {
      reports.lcp = report;
    },
    onINP: (report) => {
      reports.inp = report;
    },
    onTTFB: (report) => {
      reports.ttfb = report;
    },
    onCLS: (report) => {
      reports.cls = report;
    },
  };
  return { library, reports };
}
function recorder() {
  const sent: { url: string; init: RequestInit; body: Beacon }[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    sent.push({ url, init, body: JSON.parse(String(init.body)) as Beacon });
    return new Response(null, { status: 204 });
  };
  return { sent, fetcher };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

describe("whether the service asks for it", () => {
  test("only a Server-Timing entry called rum in the document's headers does", () => {
    expect(serviceAsksForRum()).toBe(false);
    expect(rumSample()).toBeUndefined();
    serverTiming = [{ name: "cfRequestDuration", description: "12" }];
    expect(serviceAsksForRum()).toBe(false);
    serverTiming = [
      { name: "cf", description: "" },
      { name: "rum", description: "0.25" },
    ];
    expect(serviceAsksForRum()).toBe(true);
    expect(rumSample()).toBe(0.25);
    for (const odd of ["0", "2", "abc", "-1", ""]) {
      serverTiming = [{ name: "rum", description: odd }];
      expect(rumSample(), odd).toBeUndefined();
    }
  });

  test("a browser that cannot say never starts it", async () => {
    timing.getEntriesByType = () => {
      throw new Error("no navigation timing");
    };
    expect(serviceAsksForRum()).toBe(false);
    expect(await startRum()).toBe(false);
  });
});

describe("starting", () => {
  test("a service that did not ask: nothing is installed, listened to, loaded or timed", async () => {
    let loaded = 0;
    const started = await startRum({
      loadVitals: async () => {
        loaded += 1;
        return fakeVitals().library;
      },
    });
    expect(started).toBe(false);
    expect(loaded).toBe(0);
    expect(listeners.size).toBe(0);
    expect(timeAction("operations.commit")).toBeUndefined();
    expect(hookedTimeAction("operations.commit")).toBeUndefined();
  });

  test("a page view outside the share does nothing either", async () => {
    serverTiming = [{ name: "rum", description: "0.1" }];
    let loaded = 0;
    const started = await startRum({
      random: () => 0.9,
      loadVitals: async () => {
        loaded += 1;
        return fakeVitals().library;
      },
    });
    expect(started).toBe(false);
    expect(loaded).toBe(0);
    expect(hookedTimeAction("inbox.accept")).toBeUndefined();
  });

  test("a page view inside the share loads the library and listens", async () => {
    serverTiming = [{ name: "rum", description: "0.5" }];
    const { library } = fakeVitals();
    const started = await startRum({
      random: () => 0.1,
      loadVitals: async () => library,
      fetcher: recorder().fetcher,
    });
    expect(started).toBe(true);
    expect([...listeners.keys()].sort()).toEqual([
      "keydown",
      "pagehide",
      "pointerdown",
      "visibilitychange",
    ]);
    // Starting twice is once.
    expect(await startRum({ random: () => 0.1, loadVitals: async () => library })).toBe(false);
  });
});

describe("what is sent", () => {
  async function started() {
    serverTiming = [{ name: "rum", description: "1" }];
    const vitals = fakeVitals();
    const net = recorder();
    await startRum({
      random: () => 0,
      loadVitals: async () => vitals.library,
      fetcher: net.fetcher,
    });
    return { ...vitals, ...net };
  }

  test("the vitals, once, when the page is hidden, in the shape the service accepts", async () => {
    const { reports, sent } = await started();
    reports.lcp?.({ value: 1830.4 });
    reports.inp?.({ value: 96 });
    reports.ttfb?.({ value: 120 });
    reports.cls?.({ value: 0.0312345 });
    fire("visibilitychange");
    expect(sent).toHaveLength(0); // still visible
    page.visibilityState = "hidden";
    fire("visibilitychange");
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("/telemetry/web");
    expect(sent[0]?.init).toMatchObject({
      method: "POST",
      keepalive: true,
      credentials: "same-origin",
    });
    expect(sent[0]?.body).toEqual({
      v: 1,
      vitals: { lcp: 1830.4, inp: 96, ttfb: 120, cls: 0.031 },
    });
    // The service takes exactly what the page sends.
    expect(parseBeacon(String(sent[0]?.init.body)).ok).toBe(true);
    // Hidden again with nothing new: nothing is sent.
    fire("pagehide");
    await settle();
    expect(sent).toHaveLength(1);
  });

  test("an odd value is brought into range so it cannot make the service refuse the rest", async () => {
    const { reports, sent } = await started();
    reports.lcp?.({ value: 9_999_999 });
    reports.inp?.({ value: Number.NaN });
    reports.cls?.({ value: 500 });
    reports.ttfb?.({ value: -5 });
    fire("pagehide");
    await settle();
    expect(sent[0]?.body).toEqual({ v: 1, vitals: { lcp: 120000, cls: 100 } });
    expect(parseBeacon(String(sent[0]?.init.body)).ok).toBe(true);
  });

  test("a key action is timed from the click to the frame after the result, and only key actions are", async () => {
    const { sent } = await started();
    expect(hookedTimeAction("accounts.list")).toBeUndefined();
    expect(hookedTimeAction("reports.get")).toBeUndefined();
    const before = performance.now();
    fire("pointerdown", { timeStamp: before - 40 });
    const done = hookedTimeAction("inbox.accept");
    expect(done).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    done?.("ok");
    await settle();
    fire("pagehide");
    await settle();
    const action = sent[0]?.body.actions?.[0];
    expect(action?.a).toBe("accept");
    expect(action?.o).toBe("ok");
    // 40 ms before the call, 20 ms of waiting, and a frame: more than 60.
    expect(action?.ms).toBeGreaterThanOrEqual(58);
    expect(action?.ms).toBeLessThan(500);
    expect(parseBeacon(String(sent[0]?.init.body)).ok).toBe(true);
  });

  test("with no click shortly before, the time runs from the call", async () => {
    const { sent } = await started();
    fire("pointerdown", { timeStamp: performance.now() - 5_000 });
    const done = hookedTimeAction("operations.commit");
    await new Promise((resolve) => setTimeout(resolve, 10));
    done?.("server_error");
    await settle();
    fire("pagehide");
    await settle();
    const action = sent[0]?.body.actions?.[0];
    expect(action).toMatchObject({ a: "post", o: "server_error" });
    expect(action?.ms).toBeLessThan(200);
  });

  test("a Post of the quick entry is one request, timed as a post from the click to the confirmation", async () => {
    const { sent } = await started();
    fire("pointerdown", { timeStamp: performance.now() - 30 });
    const done = hookedTimeAction("journal.post");
    expect(done).toBeDefined();
    done?.("ok");
    await settle();
    fire("pagehide");
    await settle();
    expect(sent[0]?.body.actions?.map((timing) => timing.a)).toEqual(["post"]);
  });

  test("an action begun on a hidden page, or on a page hidden while it waits, is not timed", async () => {
    const { sent } = await started();
    // Begun while hidden: nobody is waiting, so there is no timer at all.
    page.visibilityState = "hidden";
    fire("visibilitychange");
    expect(hookedTimeAction("drafts.save")).toBeUndefined();
    // Begun visible, and hidden before the result is on the screen (the browser holds back the frame a
    // hidden page would be timed to, so the time would be seconds nobody waited).
    page.visibilityState = "visible";
    const done = hookedTimeAction("inbox.post");
    expect(done).toBeDefined();
    page.visibilityState = "hidden";
    fire("visibilitychange");
    page.visibilityState = "visible";
    fire("visibilitychange");
    done?.("ok");
    await settle();
    // Hidden at the moment the result arrives.
    const again = hookedTimeAction("inbox.post");
    page.visibilityState = "hidden";
    again?.("ok");
    await settle();
    page.visibilityState = "visible";
    fire("pagehide");
    await settle();
    expect(sent.flatMap((message) => message.body.actions ?? [])).toEqual([]);
    // A page that stays visible is timed as before.
    const kept = hookedTimeAction("inbox.post");
    kept?.("ok");
    await settle();
    fire("pagehide");
    await settle();
    expect(sent.at(-1)?.body.actions?.map((timing) => timing.a)).toEqual(["post"]);
  });

  test("a full batch of actions is sent at once, and more than a batch wait for the next", async () => {
    const { sent } = await started();
    for (let index = 0; index < 11; index += 1) hookedTimeAction("drafts.save")?.("ok");
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.actions).toHaveLength(8);
    fire("pagehide");
    await settle();
    expect(sent[1]?.body.actions).toHaveLength(3);
  });

  test("sending that fails changes nothing for the page", async () => {
    serverTiming = [{ name: "rum", description: "1" }];
    const vitals = fakeVitals();
    await startRum({
      random: () => 0,
      loadVitals: async () => vitals.library,
      fetcher: async () => {
        throw new Error("offline");
      },
    });
    vitals.reports.lcp?.({ value: 1 });
    fire("pagehide");
    await settle();
    expect(takeBeacon()).toBeUndefined();
    page.visibilityState = "hidden";
    expect(() => flush()).not.toThrow();
  });
});

describe("the write path", () => {
  const store = () => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
  };
  const input = { draftId: "d", expectedVersion: 1, data: {} } as never;
  const answering = (status = 200, code = "x") =>
    (async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { operationId: string };
      return status === 200
        ? Response.json({
            version: API_VERSION,
            bookId: "local-book",
            ok: true,
            operationId: request.operationId,
            data: { id: "d", version: 2, status: "draft", data: {} },
          })
        : Response.json(
            {
              version: API_VERSION,
              bookId: "local-book",
              ok: false,
              operationId: request.operationId,
              error: { code, message: "no", details: [], retryable: false },
            },
            { status },
          );
    }) as ApplicationFetch;

  test("with the measurement off a write is untouched", async () => {
    const client = new BrowserApplicationClient(store(), answering());
    const data = await client.write("drafts.save", input, "journal");
    expect((data as { id: string }).id).toBe("d");
  });

  test("a save that works and one that fails are timed, with how each ended", async () => {
    serverTiming = [{ name: "rum", description: "1" }];
    const net = recorder();
    await startRum({
      random: () => 0,
      loadVitals: async () => fakeVitals().library,
      fetcher: net.fetcher,
    });
    await new BrowserApplicationClient(store(), answering()).write("drafts.save", input, "journal");
    await expect(
      new BrowserApplicationClient(store(), answering(503, "service_unavailable")).write(
        "drafts.save",
        input,
        "journal",
      ),
    ).rejects.toThrow();
    await expect(
      new BrowserApplicationClient(store(), answering(409, "draft_version_conflict")).write(
        "drafts.save",
        input,
        "journal",
      ),
    ).rejects.toThrow();
    await settle();
    fire("pagehide");
    await settle();
    const actions = net.sent[0]?.body.actions ?? [];
    expect(actions.map((item) => `${item.a}:${item.o}`)).toEqual([
      "save:ok",
      "save:server_error",
      "save:client_error",
    ]);
  });

  test("how a failure reads", () => {
    expect(outcomeOfError({ code: "service_unavailable" })).toBe("server_error");
    expect(outcomeOfError({ code: "operation_unresolved" })).toBe("server_error");
    expect(outcomeOfError({ code: "plan_hash_conflict" })).toBe("client_error");
    expect(outcomeOfError({ code: "request_failed", uncertain: true })).toBe("other");
    expect(outcomeOfError(new Error("boom"))).toBe("other");
    expect(outcomeOfError(null)).toBe("other");
  });
});
