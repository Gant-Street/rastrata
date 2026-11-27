import { expect, test } from "bun:test";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { encodeBookCommand, encodeDurableBook } from "@rastrata/kernel";
import type { CompleteBookScope, NativeCatalogSnapshot } from "@rastrata/ledger";
import { BOOK, activation, genesis, issuer, posting } from "./fixtures.ts";

test("production configuration budgets period maintenance without enabling public access", async () => {
  const config = await Bun.file(join(import.meta.dir, "../wrangler.jsonc")).json();
  expect(config.limits).toEqual({ cpu_ms: 300000 });
  expect(config.workers_dev).toBe(false);
  expect(config.preview_urls).toBe(false);
  expect(config.vars.BOOK_AUTHORIZATION.publicKeys.keys).toEqual([]);
  expect(config.vars.RECOVERY_AUTHORIZATION.publicKeys.keys).toEqual([]);
});

test("acceptance harness is expiring, operator-gated, and cannot erase active books", async () => {
  const signer = await issuer();
  const bundled = await Bun.build({
    entrypoints: [join(import.meta.dir, "../scripts/acceptance-worker.ts")],
    target: "node",
    format: "esm",
    external: ["node:crypto", "cloudflare:workers"],
  });
  if (!bundled.success || !bundled.outputs[0]) throw new Error("Acceptance bundle failed");
  const key = "ab".repeat(32);
  const options = {
    modules: true,
    script: await bundled.outputs[0].text(),
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      BOOKS: { className: "LedgerBook", useSQLite: true },
      CATALOGS: { className: "LedgerCatalog", useSQLite: true },
    },
    r2Buckets: ["ARCHIVE"],
    cf: false,
    bindings: {
      BOOK_AUTHORIZATION: signer.configuration,
      LEDGER_NAMESPACE_ID: "rastrata-ledger-acceptance-v1",
      ACCEPTANCE_KEY: key,
      ACCEPTANCE_EXPIRES_AT: String(Date.now() + 300_000),
      ACCEPTANCE_TENANT: "acceptance-test",
      ACCEPTANCE_LOCATION_HINT: "wnam",
    },
  };
  let runtime = new Miniflare(options);
  const control = async (method: string, args: unknown[], operatorKey = key) => {
    const body = JSON.stringify({ method, args });
    return runtime.dispatchFetch("https://acceptance.test/acceptance", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(body).byteLength),
        "x-acceptance-key": operatorKey,
        connection: "close",
      },
      body,
    });
  };
  const rpc = async <T>(method: string, ...args: unknown[]) => {
    const response = await control(method, args);
    const value = await response.json();
    if (!response.ok) throw new Error((value as { error: string }).error);
    return value as T;
  };
  const save = (token: string) =>
    runtime.dispatchFetch("https://acceptance.test/commands", {
      method: "POST",
      headers: { authorization: token, "content-type": "application/json", connection: "close" },
      body: encodeBookCommand(posting()),
    });
  try {
    const denied = await control("resolveIdentity", ["acceptance-test", BOOK], "cd".repeat(32));
    expect(denied.status).toBe(403);
    await denied.arrayBuffer();
    const otherTenant = await control("resolveIdentity", ["other", BOOK]);
    expect(otherTenant.status).toBe(500);
    await otherTenant.arrayBuffer();
    const scope = await rpc<CompleteBookScope>("resolveIdentity", "acceptance-test", BOOK);
    const token = await signer.token(scope);
    const readiness = await rpc<Record<string, { result: string; deploymentTenant: string }>>(
      "tokenDiagnostic",
      scope,
      token,
    );
    for (const component of ["gateway", "book", "catalog"]) {
      expect(readiness[component]?.result).toBe("verified");
      expect(readiness[component]?.deploymentTenant).toBe("acceptance-test");
    }
    const foreignSigner = await issuer();
    const staleKeys = await rpc<Record<string, { result: string }>>(
      "tokenDiagnostic",
      scope,
      await foreignSigner.token(scope),
    );
    for (const component of ["gateway", "book", "catalog"])
      expect(staleKeys[component]?.result).toBe("ERR_JWS_SIGNATURE_VERIFICATION_FAILED");
    const { catalog: active } = await rpc<{ catalog: NativeCatalogSnapshot }>(
      "provision",
      token,
      encodeDurableBook(genesis()),
      encodeBookCommand(activation()),
      "provision",
    );
    const saved = await save(token);
    expect(saved.status).toBe(200);
    expect(Number(saved.headers.get("x-acceptance-book-wall-ms"))).toBeGreaterThanOrEqual(0);
    const profile = JSON.parse(saved.headers.get("x-acceptance-book-profile") ?? "null");
    expect(profile.verifications).toBe(1);
    expect(profile.sqlCalls).toBe(8);
    expect(profile.syncMs).toHaveLength(2);
    expect(profile.transactions).toBe(1);
    expect(profile.rowsWritten).toBeGreaterThan(0);
    const receipt = (await saved.json()) as {
      outcomeSequence: string;
      result: { resultHash: unknown };
    };
    expect(receipt.outcomeSequence).toBe("2");
    for (const mode of [
      "edge",
      "noop",
      "read",
      "write-1k",
      "write-1k-gated",
      "write-16k",
      "write-64k",
    ]) {
      const deniedLayer = await control("latencyProbe", [scope, mode, 0], "cd".repeat(32));
      expect(deniedLayer.status).toBe(403);
      await deniedLayer.arrayBuffer();
      const layer = await rpc<{ mode: string; round: number; bookMs: number; workerMs: number }>(
        "latencyProbe",
        scope,
        mode,
        0,
      );
      expect(layer).toMatchObject({ mode, round: 0 });
      expect(layer.bookMs).toBeGreaterThanOrEqual(0);
      expect(layer.workerMs).toBeGreaterThanOrEqual(0);
    }
    for (const args of [
      [scope, "unknown", 0],
      [scope, "write-64k", 256],
      [{ ...scope, tenantId: "other" }, "edge", 0],
    ]) {
      const refused = await control("latencyProbe", args);
      expect(refused.status).toBe(500);
      await refused.arrayBuffer();
    }
    expect((await rpc<{ outcomes: number }>("inspect", scope)).outcomes).toBe(2);
    const refusedProbe = await control("durabilityProbe", [scope], "cd".repeat(32));
    expect(refusedProbe.status).toBe(403);
    await refusedProbe.arrayBuffer();
    const probe = await rpc<{ milliseconds: number[] }>("durabilityProbe", scope);
    expect(probe.milliseconds).toHaveLength(32);
    expect(probe.milliseconds.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
    const singleProbe = await rpc<{ milliseconds: number[] }>("durabilityProbe", scope, 1);
    expect(singleProbe.milliseconds).toHaveLength(1);
    const invalidProbe = await control("durabilityProbe", [scope, 2]);
    expect(invalidProbe.status).toBe(500);
    await invalidProbe.arrayBuffer();
    expect((await rpc<{ outcomes: number }>("inspect", scope)).outcomes).toBe(2);
    const premature = await control("loss", [scope, token]);
    expect(premature.status).toBe(500);
    await premature.arrayBuffer();
    const unplannedDenied = await control("unexpectedLoss", [scope]);
    expect(unplannedDenied.status).toBe(500);
    await unplannedDenied.arrayBuffer();
    expect((await rpc<{ outcomes: number }>("inspect", scope)).outcomes).toBe(2);
    for (const action of ["activeBookmark", "bookmark", "damage", "restore", "inspect"]) {
      const refused = await control("pitr", [scope, action, "fake-bookmark"]);
      expect(refused.status).toBe(500);
      await refused.arrayBuffer();
    }
    const retried = await save(token);
    expect(((await retried.json()) as typeof receipt).result.resultHash).toEqual(
      receipt.result.resultHash,
    );
    const maintenance = await rpc<NativeCatalogSnapshot>(
      "control",
      token,
      "beginMaintenance",
      active,
      "maintenance",
    );
    const retired = await rpc<NativeCatalogSnapshot>(
      "control",
      token,
      "retireWriter",
      maintenance,
      "retire",
    );
    await rpc("alarm", scope);
    const sealed = await rpc<NativeCatalogSnapshot>(
      "control",
      token,
      "sealArchive",
      retired,
      "seal",
    );
    let approved: NativeCatalogSnapshot | undefined;
    for (let step = 0; step < 10 && !approved; step++) {
      try {
        approved = await rpc<NativeCatalogSnapshot>(
          "control",
          token,
          "approveRestore",
          sealed,
          "approve",
        );
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "native_catalog_projection_pending")
          throw error;
      }
    }
    if (!approved) throw new Error("Source audit did not finish");
    const replacement = await signer.token(scope, { writerFence: "1" });
    const loss = await control("loss", [scope, replacement]);
    expect(loss.status).toBe(500); // ctx.abort deliberately loses the reply.
    await loss.arrayBuffer();
    expect((await rpc<{ ledgerTables: number }>("storageStatus", scope)).ledgerTables).toBe(0);
    let phase = "";
    for (let step = 0; step < 40 && phase !== "verified"; step++)
      phase = (await rpc<{ phase: string }>("restoreStep", replacement)).phase;
    expect(phase).toBe("verified");
    await rpc("control", replacement, "finishRestore", approved, "resume");
    await rpc("activateRestoredWriter", replacement);
    const recovered = await save(replacement);
    expect(((await recovered.json()) as typeof receipt).result.resultHash).toEqual(
      receipt.result.resultHash,
    );
    const activeLoss = await control("loss", [scope, replacement]);
    expect(activeLoss.status).toBe(500);
    await activeLoss.arrayBuffer();
    await runtime.dispose();
    runtime = new Miniflare({
      ...options,
      bindings: { ...options.bindings, ACCEPTANCE_EXPIRES_AT: String(Date.now() - 1) },
    });
    const expired = await control("resolveIdentity", ["acceptance-test", BOOK]);
    expect(expired.status).toBe(410);
    await expired.arrayBuffer();
    const expiredSave = await save(token);
    expect(expiredSave.status).toBe(410);
    await expiredSave.arrayBuffer();
  } finally {
    await runtime.dispose();
  }
});

test("unexpected-loss injection requires explicit opt-in and exact isolated scope", async () => {
  const signer = await issuer();
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "../scripts/acceptance-worker.ts")],
    target: "node",
    format: "esm",
    external: ["node:crypto", "cloudflare:workers"],
  });
  if (!built.success || !built.outputs[0]) throw new Error("Acceptance bundle failed");
  const key = "ef".repeat(32);
  const runtime = new Miniflare({
    modules: true,
    script: await built.outputs[0].text(),
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    cf: false,
    durableObjects: {
      BOOKS: { className: "LedgerBook", useSQLite: true },
      CATALOGS: { className: "LedgerCatalog", useSQLite: true },
    },
    r2Buckets: ["ARCHIVE"],
    bindings: {
      BOOK_AUTHORIZATION: signer.configuration,
      LEDGER_NAMESPACE_ID: "rastrata-ledger-acceptance-v1",
      ACCEPTANCE_KEY: key,
      ACCEPTANCE_EXPIRES_AT: String(Date.now() + 300_000),
      ACCEPTANCE_TENANT: "acceptance-loss-test",
      ACCEPTANCE_ALLOW_ACTIVE_LOSS: "true",
    },
  });
  const control = async (method: string, args: unknown[], operatorKey = key) => {
    const body = JSON.stringify({ method, args });
    return runtime.dispatchFetch("https://acceptance.test/acceptance", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(body).byteLength),
        "x-acceptance-key": operatorKey,
        connection: "close",
      },
      body,
    });
  };
  const rpc = async <T>(method: string, ...args: unknown[]) => {
    const response = await control(method, args);
    const value = await response.json();
    if (!response.ok) throw new Error((value as { error: string }).error);
    return value as T;
  };
  try {
    const scope = await rpc<CompleteBookScope>("resolveIdentity", "acceptance-loss-test", BOOK);
    await rpc(
      "provision",
      await signer.token(scope),
      encodeDurableBook(genesis()),
      encodeBookCommand(activation()),
      "provision",
    );
    const denied = await control("unexpectedLoss", [scope], "00".repeat(32));
    expect(denied.status).toBe(403);
    await denied.arrayBuffer();
    const foreign = await control("unexpectedLoss", [{ ...scope, tenantId: "other" }]);
    expect(foreign.status).toBe(500);
    await foreign.arrayBuffer();
    expect((await rpc<{ outcomes: number }>("inspect", scope)).outcomes).toBe(1);
    const lost = await control("unexpectedLoss", [scope]);
    expect(lost.status).toBe(500); // Deliberate abort after durable deletion.
    await lost.arrayBuffer();
    expect((await rpc<{ ledgerTables: number }>("storageStatus", scope)).ledgerTables).toBe(0);
  } finally {
    await runtime.dispose();
  }
});
