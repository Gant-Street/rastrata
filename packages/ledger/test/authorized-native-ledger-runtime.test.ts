import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { authorizationFixture } from "./authorization-fixtures.ts";
import { encodeBookCommand, executeBookCommand } from "@rastrata/kernel";
import { genesis, activation, posting } from "./fixtures.ts";

test("signed authorization and revoked authority survive actual workerd replacement", async () => {
  const f = await authorizationFixture(Date.now());
  const bundle = await Bun.build({
    entrypoints: [join(import.meta.dir, "runtime-authorized-ledger-worker.ts")],
    target: "node",
    format: "esm",
    external: ["node:crypto"],
  });
  expect(bundle.success).toBe(true);
  if (!bundle.outputs[0]) throw new Error("Missing authorized runtime bundle");
  const directory = mkdtempSync(join(tmpdir(), "rastrata-authorized-runtime-"));
  const options = {
    modules: true,
    script: await bundle.outputs[0].text(),
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { BOOKS: { className: "AuthorizedLedgerObject", useSQLite: true } },
    durableObjectsPersist: directory,
    r2Buckets: ["ARCHIVE"],
    r2Persist: join(directory, "r2"),
    bindings: { AUTH_CONFIGURATION: f.configuration },
    cf: false,
  };
  let runtime = new Miniflare(options);
  const call = (path: string, token?: string) =>
    runtime.dispatchFetch(`http://authorized.test${path}`, {
      method: "POST",
      headers: token ? { authorization: token } : {},
    });
  const json = async (path: string, token: string) => {
    const response = await call(path, token);
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()) as Record<string, unknown>;
  };
  try {
    const objectId = await (await call("/test-object-id")).text();
    const scope = { ...f.scope, objectId };
    const token = await f.token({ scope });
    expect((await call("/provision")).status).toBe(401);
    expect((await call("/provision", await f.token())).status).toBe(403);
    expect(await json("/provision", token)).toEqual({ provisioned: true });
    expect(await json("/archive/initialize", token)).toEqual({ initialized: true });
    const scheduled = await json("/archive/alarm", token);
    expect(typeof scheduled.scheduledAt).toBe("number");
    const saved = await json("/post", token);
    expect(saved.disposition).toBe("committed");
    expect(saved.sequence).toBe("2");
    expect(await json("/archive/alarm", token)).toEqual(scheduled);
    const reader = await f.token({ scope, permissions: ["read"] });
    expect((await call("/post", reader)).status).toBe(403);
    expect(await json("/read", reader)).toEqual({ count: 2, sequence: "2" });
    const lost = await call("/revoke?lost=1", token);
    expect(lost.status).toBe(500);
    expect(await lost.text()).toContain("injected authorization lost acknowledgement");
    await runtime.dispose();
    runtime = new Miniflare(options);
    // Durable scheduling survives object/runtime replacement, not just a cache.
    const renewed = await f.token({ scope, authorizationRevision: "1" });
    expect(await json("/archive/alarm", renewed)).toEqual(scheduled);
    expect((await call("/post", token)).status).toBe(403);
    expect((await call("/read", token)).status).toBe(403);
    const fresh = await f.token({ scope, authorizationRevision: "1" });
    const retry = await json("/post", fresh);
    expect(retry.disposition).toBe("replayed");
    expect(retry.original).toEqual(saved.original);
    expect(retry.sequence).toBe("2");
    expect(await json("/revoke", fresh)).toEqual({
      requestId: "revoke",
      actorId: "actor",
      expectedRevision: "0",
      authorizationRevision: "1",
    });
    expect(await json("/read", fresh)).toEqual({ count: 2, sequence: "2" });
    const command = posting("http-command", 2n);
    await json("/archive/fail", fresh);
    const submit = () =>
      runtime.dispatchFetch("http://authorized.test/api/commands", {
        method: "POST",
        headers: { authorization: fresh, "content-type": "application/json" },
        body: encodeBookCommand(command),
      });
    const submitted = await submit();
    expect(submitted.status).toBe(200);
    const body = (await submitted.json()) as {
      result: { disposition: string; resultHash: unknown; observedBookRevision: string };
      originalResult: unknown;
    };
    expect(body.result.disposition).toBe("committed");
    await json("/archive/arm", fresh);
    let retryScheduled = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const alarm = await json("/archive/alarm", fresh);
      if (typeof alarm.scheduledAt === "number" && alarm.scheduledAt > Date.now()) {
        retryScheduled = true;
        break;
      }
    }
    expect(retryScheduled).toBe(true);
    await json("/archive/recover", fresh);
    let oracle = genesis();
    for (const input of [activation(), posting("one")]) {
      const next = executeBookCommand(oracle.state, oracle.protocol, input);
      oracle = { state: next.state, protocol: next.protocol };
    }
    const expected = executeBookCommand(oracle.state, oracle.protocol, command);
    expect(body.result.resultHash).toEqual(expected.result.resultHash);
    expect(body.result.observedBookRevision).toBe("3");
    await runtime.dispose();
    runtime = new Miniflare(options);
    const repeated = await submit();
    expect(repeated.status).toBe(200);
    const repeatedBody = (await repeated.json()) as typeof body;
    expect(repeatedBody.result.disposition).toBe("replayed");
    expect(repeatedBody.originalResult).toEqual(body.originalResult);
    await json("/archive/arm", fresh);
    let archived: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const response = await call("/archive/inspect", fresh);
      if (response.ok) {
        archived = (await response.json()) as Record<string, unknown>;
        if (archived.through === "3") break;
      }
    }
    expect(archived).toEqual({ through: "3", count: 3 });
    expect((await json("/read", fresh)).sequence).toBe("3");
    const finalSave = await runtime.dispatchFetch("http://authorized.test/api/commands", {
      method: "POST",
      headers: { authorization: fresh, "content-type": "application/json" },
      body: encodeBookCommand(posting("final-before-retirement", 3n)),
    });
    expect(finalSave.status).toBe(200);
    const finalHead = ((await finalSave.json()) as { head: unknown }).head;
    const retirement = await call("/retire?lost=1", fresh);
    expect(retirement.status).toBe(500);
    expect(await retirement.text()).toContain("injected authorization lost acknowledgement");
    await runtime.dispose();
    runtime = new Miniflare(options);
    const retired = await json("/retire", fresh);
    expect(retired.head).toEqual(finalHead);
    expect(retired.fence).toBe("1");
    expect((await submit()).status).toBe(409);
    const refusedRead = await runtime.dispatchFetch("http://authorized.test/api/outcomes", {
      method: "POST",
      headers: { authorization: fresh, "content-type": "application/json" },
      body: JSON.stringify({ after: null, limit: 1 }),
    });
    expect(refusedRead.status).toBe(409);
    // Retirement excludes normal requests, not the owner's final archive drain.
    await json("/archive/arm", fresh);
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const response = await call("/archive/inspect", fresh);
      if (response.ok) {
        archived = (await response.json()) as Record<string, unknown>;
        if (archived.through === "4") break;
      }
    }
    expect(archived).toEqual({ through: "4", count: 4 });
    expect(await json("/retire", fresh)).toEqual(retired);
  } finally {
    await runtime.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}, 60000);
