import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import type { NativeCatalogSnapshot } from "../src/native-ledger-catalog.ts";
import { authorizationFixture } from "./authorization-fixtures.ts";

test("separate native catalog and book Durable Objects reconcile lost retirement replies across actual runtime replacement", async () => {
  const f = await authorizationFixture(Date.now());
  const bundle = await Bun.build({
    entrypoints: [join(import.meta.dir, "runtime-authorized-ledger-worker.ts")],
    target: "node",
    format: "esm",
    external: ["node:crypto"],
  });
  expect(bundle.success).toBe(true);
  if (!bundle.outputs[0]) throw new Error("Missing catalog runtime bundle");
  const directory = mkdtempSync(join(tmpdir(), "rastrata-native-catalog-runtime-"));
  const options = {
    modules: true,
    script: await bundle.outputs[0].text(),
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      BOOKS: { className: "AuthorizedLedgerObject", useSQLite: true },
      CATALOGS: { className: "NativeCatalogObject", useSQLite: true },
    },
    durableObjectsPersist: directory,
    r2Buckets: ["ARCHIVE"],
    r2Persist: join(directory, "r2"),
    bindings: { AUTH_CONFIGURATION: f.configuration },
    cf: false as const,
  };
  let runtime = new Miniflare(options);
  try {
    const objectId = await (
      await runtime.dispatchFetch("http://catalog.test/test-object-id")
    ).text();
    const catalogId = await (
      await runtime.dispatchFetch("http://catalog.test/test-catalog-id")
    ).text();
    expect(catalogId).not.toBe(objectId);
    let token = await f.token({ scope: { ...f.scope, objectId } });
    const call = (path: string, expected?: NativeCatalogSnapshot, operationId?: string) =>
      runtime.dispatchFetch(`http://catalog.test${path}`, {
        method: "POST",
        headers: { authorization: token, "content-type": "application/json" },
        ...(expected === undefined ? {} : { body: JSON.stringify({ expected, operationId }) }),
      });
    const control = async (
      path: string,
      expected?: NativeCatalogSnapshot,
      operationId?: string,
    ) => {
      const response = await call(path, expected, operationId);
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()) as NativeCatalogSnapshot;
    };
    const reserved = await control("/control/reserve");
    expect(reserved.status).toBe("reserved");
    expect((await call("/provision")).status).toBe(200);
    expect((await call("/archive/initialize")).status).toBe(200);
    const active = await control("/control/activate", reserved, "activate");
    expect(active.status).toBe("active");
    expect((await call("/post")).status).toBe(200);
    const pending = await control("/control/quiesce", active, "cutover");
    const lostSource = await call("/control/retire?sourceLost=1", pending, "record-retirement");
    expect(lostSource.status).toBe(500);
    expect(await lostSource.text()).toContain("injected authorization lost acknowledgement");
    await runtime.dispose();
    runtime = new Miniflare(options);
    expect(await control("/control/read")).toEqual(pending);
    const oldWriter = await call("/post");
    expect(oldWriter.status).toBe(500);
    expect(await oldWriter.text()).toBe("native_ledger_writer_retired");
    const lostCatalog = await call("/control/retire?lost=1", pending, "record-retirement");
    expect(lostCatalog.status).toBe(500);
    expect(await lostCatalog.text()).toBe("lost catalog commit reply");
    await runtime.dispose();
    runtime = new Miniflare(options);
    const stopped = await control("/control/read");
    expect(stopped.status).toBe("maintenance");
    expect(stopped.fence).toBe("1");
    expect(stopped.retirement?.head.sequence).toBe("2");
    expect(stopped.retirement?.requestId).toBe("cutover");
    expect(await control("/control/retire", pending, "record-retirement")).toEqual(stopped);
    expect(await control("/control/reserve")).toEqual(stopped);
    const lagging = await call("/control/seal", stopped, "seal");
    expect(lagging.status).toBe(500);
    expect(await lagging.text()).toBe("native_archive_cutoff_incomplete");
    expect((await call("/archive/arm")).status).toBe(200);
    let archived: unknown;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      archived = await (await call("/archive/inspect")).json();
      if ((archived as { through: string }).through === "2") break;
    }
    expect(archived).toEqual({ through: "2", count: 2 });
    const lostSeal = await call("/control/seal?lost=1", stopped, "seal");
    expect(lostSeal.status).toBe(500);
    expect(await lostSeal.text()).toBe("lost catalog commit reply");
    await runtime.dispose();
    runtime = new Miniflare(options);
    const sealed = await control("/control/seal", stopped, "seal");
    expect(sealed.status).toBe("maintenance");
    expect(sealed.sealed?.head).toEqual(stopped.retirement?.head);
    expect(sealed.sealed?.fence).toBe("1");
    expect((await call("/archive/arm")).status).toBe(200);
    let scheduled: unknown;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      scheduled = await (await call("/archive/alarm")).json();
      if ((scheduled as { scheduledAt: number | null }).scheduledAt === null) break;
    }
    expect(scheduled).toEqual({ scheduledAt: null });
    expect((await control("/control/read")).sealed).toEqual(sealed.sealed);
    const staleActivation = await call("/control/activate", reserved, "activate");
    expect(staleActivation.status).toBe(500);
    expect(await staleActivation.text()).toBe("native_catalog_head_conflict");
    let approval = sealed;
    for (let attempt = 0; attempt < 16; attempt++) {
      try {
        approval = await control("/control/restore", sealed, "restore-book");
        break;
      } catch (error) {
        expect((error as Error).message).toBe("native_catalog_projection_pending");
      }
    }
    expect(approval.restore?.approvedBy).toBe("actor");
    const before = await (await call("/restore/evidence")).json();
    const loss = await call("/restore/loss");
    if (!loss.ok) throw new Error(await loss.text());
    expect(((await loss.json()) as { phase: string }).phase).toBe("scan");
    let finished = false,
      lostRestoreReply = false;
    for (let step = 0; step < 12; step++) {
      await runtime.dispose();
      runtime = new Miniflare(options);
      expect(await control("/control/read")).toEqual(approval);
      expect((await call("/provision")).status).toBe(500);
      const response = await call(`/restore/step${lostRestoreReply ? "" : "?lost=1"}`);
      if (!response.ok) {
        expect(await response.text()).toBe("injected authorization lost acknowledgement");
        lostRestoreReply = true;
        continue;
      }
      if (((await response.json()) as { phase: string }).phase === "verified") {
        finished = true;
        break;
      }
    }
    expect(lostRestoreReply).toBe(true);
    expect(finished).toBe(true);
    expect(await (await call("/restore/evidence")).json()).toEqual(before);
    expect((await control("/control/read")).status).toBe("maintenance");
    const lostResume = await call("/control/resume?lost=1", approval, "resume-book");
    expect(lostResume.status).toBe(500);
    expect(await lostResume.text()).toBe("lost catalog commit reply");
    await runtime.dispose();
    // Explicit test fixture configuration, not production routing implementation.
    runtime = new Miniflare({ ...options, bindings: { ...options.bindings, WRITER_FENCE: "1" } });
    const oldToken = token;
    token = await f.token({ scope: { ...f.scope, objectId }, writerFence: "1" });
    const inactive = await call("/post-next");
    expect(inactive.status).toBe(500);
    expect(await inactive.text()).toBe("native_ledger_writer_inactive");
    const resumed = await control("/control/resume", approval, "resume-book");
    expect(resumed.status).toBe("active");
    expect((await call("/restore/activate")).status).toBe(200);
    await runtime.dispose();
    runtime = new Miniflare({ ...options, bindings: { ...options.bindings, WRITER_FENCE: "1" } });
    const oldRead = await runtime.dispatchFetch("http://catalog.test/read", {
      method: "POST",
      headers: { authorization: oldToken },
    });
    expect(oldRead.status).toBe(403);
    expect(await oldRead.text()).toBe("ledger_forbidden");
    const originalRetry = await call("/post");
    expect(originalRetry.status).toBe(200);
    expect(((await originalRetry.json()) as { disposition: string }).disposition).toBe("replayed");
    const fresh = await call("/post-next");
    expect(fresh.status).toBe(200);
    expect(((await fresh.json()) as { sequence: string }).sequence).toBe("3");
    expect((await call("/restore/activate")).status).toBe(200);
    expect(await control("/control/resume", approval, "resume-book")).toEqual(resumed);
  } finally {
    await runtime.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
