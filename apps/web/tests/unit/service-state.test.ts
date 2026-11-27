import { expect, test } from "bun:test";
import { notReading } from "../../src/access-note";
import { hostedOf, readService, readWarmup, warmupOf } from "../../src/service-state";

const reading = {
  ok: true,
  service: "rastrata",
  version: "0.1.0",
  warming: true,
  warmup: { state: "reading", done: 160, total: 1001, secondsLeft: 41 },
};

test("what the service says about reading its books is read from /health, and nothing else is believed", () => {
  expect(warmupOf(reading)).toEqual({ reading: true, secondsLeft: 41, failure: null });
  // Before the first page has been read there is no time to give.
  expect(warmupOf({ ...reading, warmup: { state: "reading", secondsLeft: null } })).toEqual({
    reading: true,
    secondsLeft: null,
    failure: null,
  });
  expect(
    warmupOf({ ...reading, warmup: { state: "reading", secondsLeft: "soon" } }).secondsLeft,
  ).toBe(null);
  expect(warmupOf({ ...reading, warmup: { state: "reading", secondsLeft: -3 } }).secondsLeft).toBe(
    0,
  );
  // Finished, and failed.
  expect(warmupOf({ ...reading, warming: false, warmup: { state: "ready", entries: 5 } })).toEqual(
    notReading,
  );
  expect(
    warmupOf({ ...reading, warming: false, warmup: { state: "failed", error: "damaged" } }),
  ).toEqual({ reading: false, secondsLeft: null, failure: "damaged" });
  // An older service, a development server, or something else on the port: nothing is claimed.
  for (const body of [
    { ok: true, service: "rastrata", version: "0.1.0" },
    { ok: true, service: "rastrata-web" },
    { service: "other", warmup: { state: "reading", secondsLeft: 5 } },
    "reading",
    null,
    42,
    { service: "rastrata", warmup: null },
  ])
    expect(warmupOf(body)).toEqual(notReading);
});

const answer = (body: unknown, init: ResponseInit = {}) =>
  (async () => Response.json(body, init)) as unknown as typeof fetch;

test("asking the service never fails: a question it cannot answer is not the page's problem", async () => {
  expect(await readWarmup(answer(reading))).toEqual({
    reading: true,
    secondsLeft: 41,
    failure: null,
  });
  expect(await readWarmup(answer({ error: "no" }, { status: 404 }))).toEqual(notReading);
  expect(
    await readWarmup(
      (async () =>
        new Response("<html></html>", {
          headers: { "content-type": "text/html" },
        })) as unknown as typeof fetch,
    ),
  ).toEqual(notReading);
  expect(
    await readWarmup((async () => {
      throw new TypeError("network error");
    }) as unknown as typeof fetch),
  ).toEqual(notReading);
  // It asks for /health on the same origin, not for a cached answer.
  let asked: { url: string; cache: string | undefined } | undefined;
  await readWarmup((async (url: string, init?: RequestInit) => {
    asked = { url, cache: init?.cache };
    return Response.json(reading);
  }) as unknown as typeof fetch);
  expect(asked).toEqual({ url: "/health", cache: "no-store" });
});

test("a hosted service is told from the `hosted` section of its health (a stranger's holds only what the page may offer), and asking once gives the warm-up and that", async () => {
  const hosted = { ok: true, hosted: { book: "rastrata-main", open: false, role: "idle" } };
  expect(hostedOf(hosted)).toBe(true);
  // What a stranger is told is a section too, and is enough.
  expect(hostedOf({ ok: true, hosted: { accounts: true, backups: false } })).toBe(true);
  expect(hostedOf({ ok: true, hosted: {} })).toBe(true);
  // The installed service, the development servers, a stopped one, something else on the port.
  for (const body of [
    reading,
    { ok: true, service: "rastrata-web" },
    { ok: true, hosted: true },
    { ok: true, hosted: null },
    { ok: true, hosted: [] },
    "hosted",
    null,
    42,
  ])
    expect(hostedOf(body)).toBe(false);
  expect(await readService(answer(hosted))).toEqual({
    warmup: notReading,
    hosted: true,
    accounts: false,
    connections: true,
    agents: true,
    backups: true,
  });
  expect(await readService(answer(reading))).toEqual({
    warmup: { reading: true, secondsLeft: 41, failure: null },
    hosted: false,
    accounts: false,
    connections: true,
    agents: true,
    backups: true,
  });
  // A pod with many books says it keeps no connection's credential and takes no agent's token.
  expect(
    await readService(
      answer({
        ok: true,
        hosted: { book: "b", accounts: true, connections: false, agents: false, backups: false },
      }),
    ),
  ).toEqual({
    warmup: notReading,
    hosted: true,
    accounts: true,
    connections: false,
    agents: false,
    backups: false,
  });
  for (const ask of [
    answer({ error: "no" }, { status: 404 }),
    (async () =>
      new Response("<html></html>", {
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch,
    (async () => {
      throw new TypeError("network error");
    }) as unknown as typeof fetch,
  ])
    expect(await readService(ask)).toEqual({
      warmup: notReading,
      hosted: false,
      accounts: false,
      connections: true,
      agents: true,
      backups: true,
    });
});
