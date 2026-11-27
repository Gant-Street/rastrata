import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueOwnerKey } from "@rastrata/application/agent";
import { APPLICATION_API_VERSION } from "@rastrata/application/schema";
import { recordTelemetry } from "@rastrata/telemetry/testing";
import { BEACON_MAX_BYTES, BEACON_PATH } from "@rastrata/telemetry/web";
import { startLocalApplicationServer } from "../src/server.ts";

// biome-ignore lint/suspicious/noExplicitAny: decoded JSON in a test
type Json = Record<string, any>;

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const work of cleanup.splice(0).reverse()) await work();
});

const setup = {
  name: "Telemetry Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Cash", role: "asset" },
    { code: "3000", name: "Capital", role: "equity" },
  ],
};

async function start(
  options: { ownerKey?: string; env?: Record<string, string>; telemetry?: false } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-api-telemetry-"));
  const started = await startLocalApplicationServer({
    path: join(directory, "book.sqlite"),
    port: 0,
    ...(options.ownerKey ? { ownerKey: options.ownerKey } : {}),
    telemetry: options.telemetry === false ? false : { env: options.env ?? {} },
  });
  cleanup.push(async () => {
    await started.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const port = started.server.port as number;
  const base = `http://127.0.0.1:${port}`;
  const call = async (name: string, input: unknown, credential?: string, operationId?: string) => {
    const response = await fetch(`${base}/v1/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: "local-book",
        input,
        ...(operationId ? { operationId } : {}),
      }),
    });
    return { status: response.status, body: (await response.json()) as Json };
  };
  const beacon = (
    body: unknown,
    headers: Record<string, string> = {},
    raw: string | undefined = undefined,
  ) => {
    const text = raw ?? JSON.stringify(body);
    return fetch(`${base}${BEACON_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: text,
    });
  };
  return { base, port, call, beacon, started };
}

/** Send a request's head, and none of its body, over a bare socket; resolve with the first line the
 * server answers, or "no answer" if it waited for a body that never came. */
function headOnly(port: number, head: string): Promise<string> {
  return new Promise((resolve) => {
    let answered = false;
    const timer = setTimeout(() => {
      if (!answered) resolve("no answer");
    }, 1500);
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write(`${head}\r\n\r\n`);
        },
        data(socket, data) {
          answered = true;
          clearTimeout(timer);
          resolve(new TextDecoder().decode(data).split("\r\n")[0] ?? "");
          socket.end();
        },
        error() {
          resolve("error");
        },
      },
    });
  });
}

const POST = (port: number, extra: string[] = []) =>
  [
    `POST ${BEACON_PATH} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Content-Type: application/json",
    "Content-Length: 40",
    "Connection: close",
    ...extra,
  ].join("\r\n");

describe("the request span", () => {
  test("every request is an http.request span with a route, never a path", async () => {
    const telemetry = recordTelemetry();
    try {
      const { base } = await start();
      await fetch(`${base}/health`);
      await fetch(`${base}/v1/book.get`, { method: "POST" });
      await fetch(`${base}/assets/some/very/secret/book-4417/path`);
      const routes = telemetry
        .spansNamed("http.request")
        .map((span) => [span.attributes["http.route"], span.attributes["http.request.method"]]);
      expect(routes).toContainEqual(["/health", "GET"]);
      expect(routes).toContainEqual(["/v1/:operation", "POST"]);
      expect(routes).toContainEqual(["static", "GET"]);
      expect(JSON.stringify(telemetry.spans)).not.toContain("book-4417");
      for (const span of telemetry.spansNamed("http.request"))
        expect(typeof span.attributes["http.response.status_code"]).toBe("number");
    } finally {
      telemetry.stop();
    }
  });

  test("an operation is a child of its request, and the caller's trace is continued", async () => {
    const telemetry = recordTelemetry();
    try {
      const { call, base } = await start();
      const trace = "0af7651916cd43dd8448eb211c80319c";
      await fetch(`${base}/v1/book.get`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          traceparent: `00-${trace}-b7ad6b7169203331-01`,
        },
        body: JSON.stringify({ version: APPLICATION_API_VERSION, bookId: "local-book", input: {} }),
      });
      const request = telemetry.spansNamed("http.request").find((span) => span.traceId === trace);
      expect(request?.parentSpanId).toBe("b7ad6b7169203331");
      expect(request?.remoteParent).toBe(true);
      const operation = telemetry.spansNamed("operation").find((span) => span.traceId === trace);
      expect(operation?.parentSpanId).toBe(request?.spanId);
      // A bad header only starts a new trace.
      await fetch(`${base}/health`, { headers: { traceparent: "00-garbage" } });
      expect((await call("book.get", {})).status).toBe(200);
    } finally {
      telemetry.stop();
    }
  });

  test("the browser routes are counted as the legacy class", async () => {
    const telemetry = recordTelemetry();
    try {
      const { base } = await start();
      expect((await fetch(`${base}/api/book`)).status).toBe(200);
      expect(telemetry.sum("requests", { operation_class: "legacy", outcome: "ok" })).toBe(1);
      expect(telemetry.stats("request.duration", { operation_class: "legacy" }).count).toBe(1);
    } finally {
      telemetry.stop();
    }
  });
});

describe("/health", () => {
  test("says nothing about telemetry when it is off", async () => {
    const { base } = await start({ telemetry: false });
    const health = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    expect(health.ok).toBe(true);
    expect("telemetry" in health).toBe(false);
    expect("rum" in health).toBe(false);
  });

  test("when it is on, says whether it is getting through, and no more", async () => {
    const telemetry = recordTelemetry();
    try {
      const { base } = await start();
      const health = (await (await fetch(`${base}/health`)).json()) as Json;
      expect(health.telemetry).toMatchObject({ enabled: true, backingOff: false });
      expect(Object.keys(health.telemetry).sort()).toEqual([
        "backingOff",
        "dropped",
        "enabled",
        "exported",
        "failed",
        "lastSuccessAt",
        "queued",
      ]);
      expect("rum" in health).toBe(false);
    } finally {
      telemetry.stop();
    }
  });
});

describe("the browser beacon", () => {
  const report = {
    v: 1,
    vitals: { lcp: 1830, inp: 96, ttfb: 120, cls: 0.03 },
    actions: [{ a: "accept", ms: 180, o: "ok" }],
  };

  test("does not exist unless telemetry AND RASTRATA_RUM are on: not found, and the body is never read", async () => {
    // Telemetry on, RUM not asked for.
    const telemetry = recordTelemetry();
    try {
      const { port, beacon } = await start();
      expect((await beacon(report)).status).toBe(404);
      expect(await headOnly(port, POST(port))).toContain("404");
    } finally {
      telemetry.stop();
    }
    // RUM asked for, telemetry off: the same.
    const { port: second, beacon: again } = await start({ env: { RASTRATA_RUM: "on" } });
    expect((await again(report)).status).toBe(404);
    expect(await headOnly(second, POST(second))).toContain("404");
    expect(
      ((await (await fetch(`http://127.0.0.1:${second}/health`)).json()) as Record<string, unknown>)
        .rum,
    ).toBeUndefined();
  });

  test("tells the page it may report, and how often, only when it exists", async () => {
    const telemetry = recordTelemetry();
    try {
      const { base } = await start({ env: { RASTRATA_RUM: "on", RASTRATA_RUM_SAMPLE: "0.25" } });
      const health = (await (await fetch(`${base}/health`)).json()) as Json;
      expect(health.rum).toEqual({ sample: 0.25 });
    } finally {
      telemetry.stop();
    }
  });

  test("asks a page to report through the headers of its own document, and no other response", async () => {
    const telemetry = recordTelemetry();
    try {
      const { base } = await start({ env: { RASTRATA_RUM: "on", RASTRATA_RUM_SAMPLE: "0.25" } });
      const page = await fetch(`${base}/`, { headers: { "sec-fetch-dest": "document" } });
      expect(page.headers.get("server-timing")).toBe('rum;desc="0.25"');
      const guess = await fetch(`${base}/`, { headers: { accept: "text/html" } });
      expect(guess.headers.get("server-timing")).toBe('rum;desc="0.25"');
      for (const path of ["/health", "/v1/book.get", "/api/book", "/assets/app.js"]) {
        const other = await fetch(`${base}${path}`, { headers: { "sec-fetch-dest": "empty" } });
        expect(other.headers.get("server-timing"), path).toBeNull();
      }
      expect((await fetch(`${base}/`, { method: "POST" })).headers.get("server-timing")).toBeNull();
    } finally {
      telemetry.stop();
    }
    // Without RASTRATA_RUM a document request carries nothing about it.
    const quiet = recordTelemetry();
    try {
      const { base } = await start();
      const page = await fetch(`${base}/`, { headers: { "sec-fetch-dest": "document" } });
      expect(page.headers.get("server-timing")).toBeNull();
    } finally {
      quiet.stop();
    }
  });

  test("takes nothing without credentials, even from an open service, and reads no body to find out", async () => {
    const telemetry = recordTelemetry();
    try {
      const { port, beacon } = await start({ env: { RASTRATA_RUM: "on" } });
      const open = await beacon(report);
      expect(open.status).toBe(401);
      expect(((await open.json()) as { code: string }).code).toBe("authentication_required");
      expect(await headOnly(port, POST(port))).toContain("401");
      expect(telemetry.series("web.lcp")).toEqual([]);
      expect(telemetry.sum("web.beacons", { web_beacon: "rejected" })).toBeGreaterThanOrEqual(2);

      const locked = await start({ ownerKey: issueOwnerKey(), env: { RASTRATA_RUM: "on" } });
      expect((await locked.beacon(report)).status).toBe(401);
      expect((await locked.beacon(report, { authorization: "Bearer junk" })).status).toBe(401);
    } finally {
      telemetry.stop();
    }
  });

  test("records what a signed-in page sends, as the catalog's metrics under the book's size, and nothing else", async () => {
    const telemetry = recordTelemetry();
    try {
      const key = issueOwnerKey();
      const { call, beacon } = await start({ ownerKey: key, env: { RASTRATA_RUM: "on" } });
      const auth = { authorization: `Bearer ${key}` };
      await call("book.setup", setup, key, crypto.randomUUID());
      // Until a read has told the service how big the book is, a report cannot be put in a bucket.
      const early = await beacon(report, auth);
      expect(early.status).toBe(204);
      expect(telemetry.series("web.lcp")).toEqual([]);
      await call("reports.get", { asOf: "2026-12-31" }, key);

      const sent = await beacon(report, {
        ...auth,
        // Everything a browser adds on its own: none of it may be kept.
        "user-agent": "Mozilla/5.0 (Customer Laptop 4417)",
        referer: "https://app.example.com/books/book-4417/accounts",
        "x-forwarded-for": "203.0.113.77",
        cookie: "session=secret-session-4417",
      });
      expect(sent.status).toBe(204);
      expect(await sent.text()).toBe("");
      expect(telemetry.values("web.lcp", { size_bucket: "xs" })).toEqual([1.83]);
      expect(telemetry.values("web.inp", { size_bucket: "xs" })).toEqual([0.096]);
      expect(
        telemetry.values("web.action.duration", { web_action: "accept", size_bucket: "xs" }),
      ).toEqual([0.18]);
      expect(telemetry.sum("web.actions", { web_action: "accept", outcome: "ok" })).toBe(1);
      expect(telemetry.sum("web.beacons", { web_beacon: "accepted" })).toBe(1);
      const everything = JSON.stringify([
        telemetry.spans,
        [
          "web.lcp",
          "web.inp",
          "web.ttfb",
          "web.cls",
          "web.action.duration",
          "web.actions",
          "web.beacons",
        ].map((name) => telemetry.series(name as never)),
      ]);
      // Not the bare number 4417: the spans carry random hexadecimal ids, and four digits turn up in them by
      // chance now and then, which failed the gate. The planted words around it cannot be in an id.
      for (const secret of [
        "Laptop",
        "book-4417",
        "session-4417",
        "203.0.113",
        "Mozilla",
        "example.com",
        "session=",
      ])
        expect(everything).not.toContain(secret);
      expect(telemetry.invalid).toEqual([]);
    } finally {
      telemetry.stop();
    }
  });

  test("a token may report, a revoked one may not, and each credential has its own rate limit", async () => {
    const telemetry = recordTelemetry();
    try {
      const key = issueOwnerKey();
      const { call, beacon } = await start({ ownerKey: key, env: { RASTRATA_RUM: "on" } });
      await call("book.setup", setup, key, crypto.randomUUID());
      await call("reports.get", { asOf: "2026-12-31" }, key);
      const make = async (label: string) =>
        (await call("tokens.create", { label, permissions: ["read"] }, key, crypto.randomUUID()))
          .body.data as { secret: string; token: { id: string } };
      const reader = (await make("Reader")).secret;
      const revoked = await make("Revoked");
      await call("tokens.revoke", { tokenId: revoked.token.id }, key, crypto.randomUUID());
      const as = (secret: string) => ({ authorization: `Bearer ${secret}` });
      expect((await beacon(report, as(revoked.secret))).status).toBe(401);
      expect((await beacon(report, as(reader))).status).toBe(204);
      // The owner exhausts its allowance (20 at once) and is told when to come back; the token is not affected.
      const statuses: number[] = [];
      let retryAfter: string | null = null;
      for (let index = 0; index < 25; index += 1) {
        const response = await beacon(report, as(key));
        statuses.push(response.status);
        retryAfter = response.headers.get("retry-after") ?? retryAfter;
      }
      expect(statuses.filter((status) => status === 204)).toHaveLength(20);
      expect(statuses.slice(20).every((status) => status === 429)).toBe(true);
      expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
      expect((await beacon(report, as(reader))).status).toBe(204);
    } finally {
      telemetry.stop();
    }
  });

  test("refuses a body over the cap from its Content-Length without reading it, and a wrong kind of request", async () => {
    const telemetry = recordTelemetry();
    try {
      const key = issueOwnerKey();
      const { port, beacon, base } = await start({ ownerKey: key, env: { RASTRATA_RUM: "on" } });
      const auth = { authorization: `Bearer ${key}` };
      // Declared too big: answered at once, though the body never comes.
      const big = POST(port, [`Authorization: Bearer ${key}`]).replace(
        "Content-Length: 40",
        `Content-Length: ${BEACON_MAX_BYTES + 1}`,
      );
      expect(await headOnly(port, big)).toContain("413");
      // No length declared: refused, not guessed.
      const none = POST(port, [`Authorization: Bearer ${key}`]).replace(
        "Content-Length: 40\r\n",
        "",
      );
      expect(await headOnly(port, none)).toMatch(/411|413|400/);
      expect((await beacon(report, { ...auth, "content-type": "text/plain" })).status).toBe(415);
      expect((await fetch(`${base}${BEACON_PATH}`, { headers: auth })).status).toBe(405);
      // A body longer than it declared, or one over the cap, is not taken.
      const padded = JSON.stringify({ ...report, pad: "x".repeat(BEACON_MAX_BYTES) });
      expect((await beacon(undefined, auth, padded)).status).toBe(413);
    } finally {
      telemetry.stop();
    }
  });

  test("refuses anything outside the closed sets, whole, without repeating it", async () => {
    const telemetry = recordTelemetry();
    try {
      const key = issueOwnerKey();
      const { call, beacon } = await start({ ownerKey: key, env: { RASTRATA_RUM: "on" } });
      await call("book.setup", setup, key, crypto.randomUUID());
      await call("reports.get", { asOf: "2026-12-31" }, key);
      const auth = { authorization: `Bearer ${key}` };
      const bad = [
        { v: 1, vitals: { lcp: 1 }, url: "https://app.example.com/books/CANARY-4417" },
        { v: 1, actions: [{ a: "CANARY-4417", ms: 1, o: "ok" }] },
        { v: 1, vitals: { lcp: -5 } },
        { v: 2, vitals: { lcp: 1 } },
        { v: 1 },
      ];
      for (const body of bad) {
        const response = await beacon(body, auth);
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).not.toContain("CANARY");
        expect(text).toContain("invalid_report");
      }
      expect((await beacon(undefined, auth, "{not json")).status).toBe(400);
      expect(telemetry.series("web.lcp")).toEqual([]);
      expect(telemetry.series("web.action.duration")).toEqual([]);
      expect(telemetry.sum("web.beacons", { web_beacon: "rejected" })).toBe(6);
    } finally {
      telemetry.stop();
    }
  });
});
