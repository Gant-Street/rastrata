import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { Database } from "bun:sqlite";
import worker, { SyntheticNativeBook } from "../src/index.ts";
import type { SqliteStorage } from "@rastrata/ledger";
import { verifySmoke, type Transport } from "../scripts/verify-smoke.ts";
import { remoteTransport } from "../scripts/smoke.ts";
import { verifyNativeSmoke, verifyNativeSave } from "../scripts/verify-native-smoke.ts";

const token = "a".repeat(64);
const bindings = {
  DEPLOYMENT_KIND: "synthetic-development-only",
  DEV_EXPIRES_AT: String(Date.now() + 60_000),
  DEV_ACCESS_TOKEN: token,
};

test("denied requests never route to a book; absent, malformed and expired configuration fail closed", async () => {
  const env = {
    ...bindings,
    BOOKS: {
      idFromName() {
        throw new Error("Must not route unauthorized requests");
      },
      get() {
        throw new Error("Must not route unauthorized requests");
      },
    },
  };
  for (const header of [undefined, "Bearer wrong", `Bearer ${"b".repeat(64)}`]) {
    for (const path of ["/state", "/native/state"]) {
      const response = await worker.fetch(
        new Request(`https://dev.test${path}`, {
          headers: header ? { authorization: header } : {},
        }),
        env,
      );
      expect(response.status).toBe(401);
    }
  }
  for (const overrides of [
    { DEV_ACCESS_TOKEN: "" },
    { DEV_EXPIRES_AT: "0" },
    { DEV_EXPIRES_AT: "NaN" },
    { DEV_EXPIRES_AT: "Infinity" },
    { DEPLOYMENT_KIND: "production" },
  ]) {
    expect(
      (await worker.fetch(new Request("https://dev.test/health"), { ...env, ...overrides })).status,
    ).toBe(503);
  }
  const payload = new Request("https://dev.test/smoke", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: "customer-data",
  });
  expect((await worker.fetch(payload, env)).status).toBe(400);
});

test("remote transport refuses credentials to other origins or insecure endpoints", () => {
  for (const url of [
    "http://rastrata-ledger-dev.example.workers.dev",
    "https://example.com",
    "https://rastrata-ledger-dev.example.workers.dev/path",
  ]) {
    expect(() => remoteTransport(url, token)).toThrow();
  }
  const call = remoteTransport("https://rastrata-ledger-dev.example.workers.dev", token);
  expect(() => call("https://example.com")).toThrow("Cross-origin");
  expect(() => call("//example.com")).toThrow("Cross-origin");
});

test("native development queue is bounded, rechecks expiry and releases slots after failure", async () => {
  const db = new Database(":memory:");
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let statements = 0;
  let wait = true;
  const storage: SqliteStorage = {
    sql: {
      exec: (sql, ...bindings) => {
        statements++;
        return db
          .query(sql)
          .all(
            ...bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)),
          ) as Record<string, unknown>[];
      },
    },
    transactionSync: (operation) => db.transaction(operation)(),
    async sync() {
      if (wait) await gate;
    },
  };
  const env = {
    ...bindings,
    BOOKS: {
      idFromName: () => ({ toString: () => "unused" }),
      get: () => {
        throw new Error("Must not route");
      },
    },
  };
  const object = new SyntheticNativeBook(
    { storage, id: { toString: () => "native-queue-test" } },
    env,
  );
  const request = () =>
    new Request("http://dev.test/native/smoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
  try {
    const pending = Array.from({ length: 16 }, () => object.fetch(request()));
    const settled = Promise.allSettled(pending);
    expect((await object.fetch(request())).status).toBe(429);
    env.DEV_EXPIRES_AT = "0";
    unblock();
    const replies = await settled;
    expect(replies.some((r) => r.status === "rejected")).toBeTrue();
    for (const reply of replies)
      if (reply.status === "fulfilled") expect(reply.value.status).toBe(503);
    expect(statements).toBe(0);
    env.DEV_EXPIRES_AT = String(Date.now() + 60000);
    wait = false;
    const recovered = await object.fetch(request());
    expect(recovered.status).toBe(200);
    expect(((await recovered.json()) as { head: { sequence: string } }).head.sequence).toBe("3");
  } finally {
    unblock();
    db.close();
  }
});

test("deployed entrypoint: real SQLite runtime, concurrent smoke calls, persistent replacement", async () => {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "../src/index.ts")],
    target: "node",
    format: "esm",
    external: ["node:crypto"],
  });
  expect(build.success).toBe(true);
  const output = build.outputs[0];
  if (!output) throw new Error("Missing bundle");
  const directory = mkdtempSync(join(tmpdir(), "rastrata-ledger-dev-"));
  const options = {
    modules: true,
    script: await output.text(),
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      BOOKS: { className: "SyntheticBook", useSQLite: true },
      NATIVE_BOOKS: { className: "SyntheticNativeBook", useSQLite: true },
    },
    durableObjectsPersist: directory,
    bindings,
    cf: false,
  };
  let runtime = new Miniflare(options);
  const call: Transport = (path, method = "GET", authorized = true) =>
    runtime.dispatchFetch(`http://dev.test${path}`, {
      method,
      headers: authorized ? { authorization: `Bearer ${token}` } : {},
    });
  try {
    const [first, second] = await Promise.all([verifySmoke(call), verifySmoke(call)]);
    expect(first).toEqual(second);
    const [nativeFirst, nativeSecond] = await Promise.all([
      verifyNativeSmoke(call),
      verifyNativeSmoke(call),
    ]);
    expect(nativeFirst).toEqual(nativeSecond);
    expect(nativeFirst.head.chainHash).not.toBe((first.head as { chainHash?: string }).chainHash);
    for (const field of ["head", "outcomes", "dispositions"]) {
      const tampered: Transport = async (...args) => {
        const response = await call(...args);
        if (args[0] !== "/native/smoke" || args[1] !== "POST") return response;
        const body = (await response.json()) as Record<string, unknown>;
        body[field] = [];
        return Response.json(body);
      };
      await expect(verifyNativeSmoke(tampered)).rejects.toThrow();
    }
    const forgedHash: Transport = async (...args) => {
      const response = await call(...args);
      if (!["/native/smoke", "/native/state"].includes(args[0])) return response;
      const body = (await response.json()) as { head: { chainHash: string } };
      body.head.chainHash = "0".repeat(64);
      return Response.json(body);
    };
    await expect(verifyNativeSmoke(forgedHash)).rejects.toThrow();
    const [saved, raced] = await Promise.all([verifyNativeSave(call), verifyNativeSave(call)]);
    expect([saved.disposition, raced.disposition].sort()).toEqual(["committed", "replayed"]);
    expect(saved.snapshot).toEqual(raced.snapshot);
    expect(saved.snapshot.outcomes.slice(0, 3)).toEqual(nativeFirst.outcomes);
    for (const field of ["originalResult", "outcomeSequence", "result"]) {
      const tampered: Transport = async (...args) => {
        const response = await call(...args);
        if (args[0] !== "/native/save" || args[1] !== "POST" || args[2] === false) return response;
        const body = (await response.json()) as Record<string, unknown>;
        body[field] = {};
        return Response.json(body);
      };
      await expect(verifyNativeSave(tampered)).rejects.toThrow();
    }
    const payload = await runtime.dispatchFetch("http://dev.test/smoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "customer-data",
    });
    expect(payload.status).toBe(400);
    // Miniflare's pinned declaration bundle mis-resolves this namespace to Request.
    // Describe only the methods exercised here; the actual object is workerd-backed.
    const namespace = (await runtime.getDurableObjectNamespace("BOOKS")) as unknown as {
      idFromName(name: string): unknown;
      get(id: unknown): {
        fetch(url: string, init: { method: string }): Promise<{ status: number }>;
      };
    };
    const stub = namespace.get(namespace.idFromName("unauthorized-direct-call"));
    expect((await stub.fetch("http://dev.test/smoke", { method: "POST" })).status).toBe(401);
    const nativeNamespace = (await runtime.getDurableObjectNamespace(
      "NATIVE_BOOKS",
    )) as unknown as {
      idFromName(name: string): unknown;
      get(id: unknown): {
        fetch(
          url: string,
          init: { method: string; headers?: Record<string, string> },
        ): Promise<{ status: number }>;
      };
    };
    const nativeStub = nativeNamespace.get(nativeNamespace.idFromName("unauthorized-direct-call"));
    expect(
      (await nativeStub.fetch("http://dev.test/native/smoke", { method: "POST" })).status,
    ).toBe(401);
    expect(
      (
        await nativeStub.fetch("http://dev.test/smoke", {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await runtime.dispatchFetch("http://dev.test/native/smoke", {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: "customer-data",
        })
      ).status,
    ).toBe(400);
    for (const field of ["head", "aggregateHash", "acceptedRetry"]) {
      const tampered: Transport = async (...args) => {
        const response = await call(...args);
        if (args[0] !== "/smoke" || args[1] !== "POST") return response;
        const body = (await response.json()) as Record<string, unknown>;
        body[field] = {};
        return Response.json(body);
      };
      await expect(verifySmoke(tampered)).rejects.toThrow();
    }
    await runtime.dispose();
    runtime = new Miniflare(options);
    expect(await verifySmoke(call)).toEqual(first);
    expect(await verifyNativeSmoke(call)).toEqual(saved.snapshot);
    const retry = await verifyNativeSave(call);
    expect(retry.disposition).toBe("replayed");
    expect(retry.snapshot).toEqual(saved.snapshot);
  } finally {
    await runtime.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
