import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { encodeBookCommand, encodeDurableBook, executeBookCommand } from "@rastrata/kernel";
import type {
  CompleteBookScope,
  NativeCatalogSnapshot,
  NativeRecoveryEvidence,
} from "@rastrata/ledger";
import type { CatalogOperation } from "../src/catalog.ts";
import { BOOK, activation, genesis, issuer, posting } from "./fixtures.ts";

interface ServiceRpc {
  resolveIdentity(tenantId: string, bookId: string): Promise<CompleteBookScope>;
  provision(
    token: string,
    genesis: string,
    command: string,
    requestId: string,
  ): Promise<{ catalog: NativeCatalogSnapshot }>;
  control(
    token: string,
    operation: CatalogOperation,
    expected: NativeCatalogSnapshot,
    requestId: string,
  ): Promise<NativeCatalogSnapshot>;
}

for (const { nativeSnapshot, recoveryRestart } of [
  { nativeSnapshot: false, recoveryRestart: false },
  { nativeSnapshot: true, recoveryRestart: false },
  { nativeSnapshot: true, recoveryRestart: true },
])
  test(`real service routing, private provisioning, durable revocation and ${nativeSnapshot ? "native snapshot" : "archive"} fencing survive cold restart; disaster recovery ${recoveryRestart ? "cold" : "warm"}`, async () => {
    const signer = await issuer();
    const recoverySigner = await issuer();
    const bundle = await Bun.build({
      entrypoints: [join(import.meta.dir, "service-worker.ts")],
      target: "node",
      format: "esm",
      external: ["node:crypto", "cloudflare:workers"],
    });
    expect(bundle.success).toBe(true);
    if (!bundle.outputs[0]) throw new Error("Missing service bundle");
    const driver = await Bun.build({
      entrypoints: [join(import.meta.dir, "control-worker.ts")],
      target: "node",
      format: "esm",
      external: ["node:crypto"],
    });
    if (!driver.success || !driver.outputs[0]) throw new Error("Missing test driver bundle");
    const directory = mkdtempSync(join(tmpdir(), "rastrata-service-"));
    const options = {
      workers: [
        {
          name: "ledger",
          modules: true,
          script: await bundle.outputs[0].text(),
          compatibilityDate: "2026-07-30",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            BOOKS: { className: "LedgerBook", useSQLite: true },
            CATALOGS: { className: "LedgerCatalog", useSQLite: true },
          },
          r2Buckets: ["ARCHIVE"],
          bindings: {
            BOOK_AUTHORIZATION: signer.configuration,
            RECOVERY_AUTHORIZATION: recoverySigner.configuration,
            LEDGER_NAMESPACE_ID: "service-test",
          },
        },
        {
          name: "driver",
          modules: true,
          script: await driver.outputs[0].text(),
          compatibilityDate: "2026-07-30",
          compatibilityFlags: ["nodejs_compat"],
          serviceBindings: { LEDGER: "ledger" },
          durableObjects: {
            BOOKS: { className: "LedgerBook", scriptName: "ledger", useSQLite: true },
          },
        },
      ],
      durableObjectsPersist: directory,
      r2Persist: join(directory, "r2"),
      cf: false,
    };
    let runtime = new Miniflare(options);
    const invoke = async (method: string, ...args: unknown[]) => {
      const response = await (await runtime.getWorker("driver")).fetch("http://driver.test", {
        method: "POST",
        body: JSON.stringify({ method, args }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error((result as { error: string }).error);
      return result;
    };
    const rpc = async (): Promise<ServiceRpc> => ({
      resolveIdentity: async (...args) =>
        (await invoke("resolveIdentity", ...args)) as CompleteBookScope,
      provision: async (...args) =>
        (await invoke("provision", ...args)) as { catalog: NativeCatalogSnapshot },
      control: async (...args) => (await invoke("control", ...args)) as NativeCatalogSnapshot,
    });
    const call = async (
      path: string,
      token?: string,
      body = "{}",
      headers: Record<string, string> = {},
    ) => {
      const response = await runtime.dispatchFetch(`http://ledger.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Bun's Miniflare transport can reuse a socket just closed after an
          // early body rejection. These correctness tests do not measure network
          // latency and intentionally use a fresh local connection per request.
          connection: "close",
          ...(token ? { authorization: token } : {}),
          ...headers,
        },
        body,
      });
      // Drain every response before reusing the local HTTP connection, including
      // assertions interested only in a rejection's status.
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: response.headers,
      });
    };
    try {
      const api = await rpc();
      const scope = JSON.parse(
        JSON.stringify(await api.resolveIdentity("tenant-A", BOOK)),
      ) as CompleteBookScope;
      const foreign = JSON.parse(
        JSON.stringify(await api.resolveIdentity("tenant-B", BOOK)),
      ) as CompleteBookScope;
      expect(scope.objectId).not.toBe(foreign.objectId);
      const token = await signer.token(scope);
      expect((await call("/commands")).status).toBe(401);
      expect((await call("/provision", token)).status).toBe(404);
      expect((await call("/internal/restore", token)).status).toBe(404);
      expect((await call("/commands?token=anything", token)).status).toBe(404);
      expect(
        (await call("/commands", await signer.token({ ...scope, namespaceId: "other" }))).status,
      ).toBe(403);
      expect(
        (await call("/commands", await signer.token(scope, { permissions: ["read"] }))).status,
      ).toBe(403);
      const provisioned = JSON.parse(
        JSON.stringify(
          await api.provision(
            token,
            encodeDurableBook(genesis()),
            encodeBookCommand(activation()),
            "initialize",
          ),
          (_, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
        ),
      ) as { catalog: NativeCatalogSnapshot };
      expect(provisioned.catalog.status).toBe("active");
      expect(await invoke("archiveStatus", token)).toEqual({
        status: "caughtUp",
        writerFence: "0",
        archivedSequence: "1",
        observedSequence: "1",
        pendingOutcomes: "0",
      });
      expect((await call("/archive-status", token)).status).toBe(404);
      await expect(
        invoke("archiveStatus", await signer.token(scope, { permissions: ["read"] })),
      ).rejects.toThrow("ledger_forbidden");
      const command = posting();
      const encodedRequest = await call("/commands", token, encodeBookCommand(command), {
        "content-encoding": "gzip",
      });
      expect(encodedRequest.status).toBe(415);
      expect(await encodedRequest.json()).toMatchObject({ error: "ledger_media_type_unsupported" });
      const saved = await call("/commands", token, encodeBookCommand(command), {
        "x-tenant-id": "tenant-B",
      });
      expect(saved.status).toBe(200);
      const body = (await saved.json()) as {
        result: { disposition: string; resultHash: unknown };
        originalResult: unknown;
        outcomeSequence: string;
      };
      const active = executeBookCommand(genesis().state, genesis().protocol, activation());
      const oracle = executeBookCommand(active.state, active.protocol, command);
      expect(body.result.disposition).toBe("committed");
      expect(body.result.resultHash).toEqual(oracle.result.resultHash);
      expect(body.outcomeSequence).toBe("2");
      expect(await invoke("archiveStatus", token)).toMatchObject({
        status: "pending",
        archivedSequence: "1",
        observedSequence: "2",
        pendingOutcomes: "1",
      });
      const collision = await call("/commands", token, encodeBookCommand(posting("post", 2n)));
      expect(collision.status).toBe(200);
      const conflict = (await collision.json()) as {
        result: { disposition: string; diagnostics: { code: string }[] };
      };
      expect(conflict.result.disposition).toBe("rejected");
      expect(conflict.result.diagnostics.map((item) => item.code)).toEqual([
        "command_identity_conflict",
      ]);
      expect(
        (await call("/outcomes", token, JSON.stringify({ after: null, limit: 1 }))).status,
      ).toBe(200);
      expect(
        (
          await call(
            "/outcomes",
            await signer.token(foreign),
            JSON.stringify({ after: null, limit: 1 }),
          )
        ).status,
      ).toBe(503);
      const revoke = await call(
        "/authorization",
        token,
        JSON.stringify({ requestId: "revoke", expectedRevision: "0" }),
      );
      expect(revoke.status).toBe(200);
      await expect(invoke("archiveStatus", token)).rejects.toThrow("ledger_forbidden");
      expect((await call("/commands", token, encodeBookCommand(command))).status).toBe(403);
      await expect(
        async () =>
          await api.control(token, "beginMaintenance", provisioned.catalog, "stale-revocation"),
      ).toThrow("ledger_forbidden");
      await runtime.dispose();
      runtime = new Miniflare(options);
      const fresh = await signer.token(scope, { authorizationRevision: "1" });
      const replay = await call("/commands", fresh, encodeBookCommand(command));
      expect(replay.status).toBe(200);
      const replayed = (await replay.json()) as typeof body;
      expect(replayed.result.disposition).toBe("replayed");
      expect(replayed.originalResult).toEqual(body.originalResult);
      expect((await call("/commands", token, encodeBookCommand(command))).status).toBe(403);
      const foreignToken = await signer.token(foreign);
      const foreignProvisioned = await (await rpc()).provision(
        foreignToken,
        encodeDurableBook(genesis()),
        encodeBookCommand(activation()),
        "foreign-initialize",
      );
      // Unexpected loss: no maintenance, retirement, seal or restore approval.
      // Preserve an acknowledged commit, retained rejection and access revocation
      // before destroying this isolated book. Exercise both lagging and caught-up
      // R2: even a complete prefix is not independent replacement-writer authority.
      const foreignPost = encodeBookCommand(posting("foreign-saved"));
      const foreignSaved = await call("/commands", foreignToken, foreignPost);
      expect(foreignSaved.status).toBe(200);
      const foreignSavedReceipt = (await foreignSaved.json()) as typeof body;
      expect(foreignSavedReceipt).toMatchObject({
        outcomeSequence: "2",
        result: { disposition: "committed" },
      });
      const foreignRejected = await call(
        "/commands",
        foreignToken,
        encodeBookCommand(posting("foreign-stale", 0n)),
      );
      expect(foreignRejected.status).toBe(200);
      const foreignRejectedReceipt = (await foreignRejected.json()) as typeof body;
      expect(foreignRejectedReceipt).toMatchObject({
        outcomeSequence: "3",
        result: { disposition: "rejected" },
      });
      expect(
        (
          await call(
            "/authorization",
            foreignToken,
            JSON.stringify({ requestId: "foreign-revoke", expectedRevision: "0" }),
          )
        ).status,
      ).toBe(200);
      const foreignCurrent = await signer.token(foreign, { authorizationRevision: "1" });
      if (nativeSnapshot) await invoke("deliverArchiveAlarm", foreign);
      expect(await invoke("archiveStatus", foreignCurrent)).toMatchObject({
        observedSequence: "3",
        archivedSequence: nativeSnapshot ? "3" : "1",
        pendingOutcomes: nativeSnapshot ? "0" : "2",
      });
      // A retained source snapshot is the authority fixture. No retirement,
      // catalog approval or archive seal is prepared before the fault.
      const recoveryRequest = "unexpected-loss";
      const recoveryEvidence = (await invoke(
        "captureRecoveryEvidence",
        foreign,
        foreignProvisioned.catalog.contentHash,
        recoveryRequest,
      )) as NativeRecoveryEvidence;
      expect(recoveryEvidence).toMatchObject({
        head: { sequence: "3", bookRevision: "2" },
        authorizationRevision: "1",
      });
      await invoke("simulatePrimaryLoss", foreign);
      await runtime.dispose();
      runtime = new Miniflare(options);
      // Even at fence zero, an active catalog forbids blank reconstruction after
      // primary loss. Ordinary provisioning is not a recovery bypass.
      await expect(
        async () =>
          await (await rpc()).provision(
            foreignToken,
            encodeDurableBook(genesis()),
            encodeBookCommand(activation()),
            "foreign-reinitialize",
          ),
      ).toThrow();
      expect((await call("/commands", foreignToken, encodeBookCommand(command))).status).toBe(503);
      expect((await call("/commands", foreignCurrent, foreignPost)).status).toBe(503);
      expect(
        (await call("/outcomes", foreignCurrent, JSON.stringify({ after: null, limit: 1 }))).status,
      ).toBe(503);
      expect(
        (
          await call(
            "/authorization",
            foreignCurrent,
            JSON.stringify({ requestId: "lost-access", expectedRevision: "1" }),
          )
        ).status,
      ).toBe(503);
      await expect(invoke("archiveStatus", foreignCurrent)).rejects.toThrow();
      await expect(invoke("restoreStep", foreignCurrent)).rejects.toThrow("ledger_forbidden");
      await expect(invoke("verifyRestoredSnapshot", foreignCurrent)).rejects.toThrow(
        "ledger_forbidden",
      );
      await expect(invoke("activateRestoredWriter", foreignCurrent)).rejects.toThrow(
        "ledger_forbidden",
      );
      expect((await call("/recover", foreignCurrent)).status).toBe(404);
      // Ordinary, even current maintain credentials cannot authorize disaster
      // recovery. The test authority uses a separate issuer key.
      await expect(
        invoke(
          "recoverUnavailableSource",
          foreignCurrent,
          foreignProvisioned.catalog,
          recoveryRequest,
        ),
      ).rejects.toThrow("ledger_unauthorized");
      await expect(
        invoke("beginRecovery", foreignCurrent, foreignProvisioned.catalog, recoveryRequest),
      ).rejects.toThrow("ledger_unauthorized");
      const incident = await recoverySigner.incident(
        foreign,
        foreignProvisioned.catalog.contentHash,
        recoveryRequest,
      );
      const pending = (await invoke(
        "beginRecovery",
        incident,
        foreignProvisioned.catalog,
        recoveryRequest,
      )) as NativeCatalogSnapshot;
      expect(
        await invoke("beginRecovery", incident, foreignProvisioned.catalog, recoveryRequest),
      ).toEqual(pending);
      expect(pending.status).toBe("maintenance");
      await expect(
        invoke("inspectRecoverySource", incident, foreignProvisioned.catalog, recoveryRequest),
      ).rejects.toThrow();
      const incidentCredential = await recoverySigner.recovery(
        recoveryEvidence,
        pending.contentHash,
      );
      await expect(
        invoke("recoverUnavailableSource", incident, foreignProvisioned.catalog, recoveryRequest),
      ).rejects.toThrow("ledger_unauthorized");
      await expect(
        invoke(
          "recoverUnavailableSource",
          await recoverySigner.token(foreign, { permissions: ["read"] }),
          foreignProvisioned.catalog,
          recoveryRequest,
        ),
      ).rejects.toThrow("ledger_unauthorized");
      await expect(
        invoke(
          "recoverUnavailableSource",
          await recoverySigner.recovery({ ...recoveryEvidence, scope }, pending.contentHash),
          foreignProvisioned.catalog,
          recoveryRequest,
        ),
      ).rejects.toThrow("ledger_forbidden");
      const expiredAt = Math.floor(Date.now() / 1000) - 10;
      await expect(
        invoke(
          "recoverUnavailableSource",
          await recoverySigner.recovery(recoveryEvidence, pending.contentHash, {
            iat: expiredAt - 10,
            nbf: expiredAt - 10,
            exp: expiredAt,
          }),
          foreignProvisioned.catalog,
          recoveryRequest,
        ),
      ).rejects.toThrow("ledger_unauthorized");
      if (!nativeSnapshot) {
        await expect(
          invoke(
            "recoverUnavailableSource",
            incidentCredential,
            foreignProvisioned.catalog,
            recoveryRequest,
          ),
        ).rejects.toThrow("native_archive_cutoff_incomplete");
        expect((await call("/commands", foreignCurrent, foreignPost)).status).toBe(503);
      } else {
        const disasterApproval = (await invoke(
          "recoverUnavailableSource",
          incidentCredential,
          foreignProvisioned.catalog,
          recoveryRequest,
        )) as NativeCatalogSnapshot;
        expect(disasterApproval.restore?.recovery).toMatchObject({
          expectedCatalogHash: foreignProvisioned.catalog.contentHash,
        });
        expect(disasterApproval.sealed?.head.sequence).toBe("3");
        expect(disasterApproval.fence).toBe("1");
        if (recoveryRestart) {
          await runtime.dispose();
          runtime = new Miniflare(options);
        }
        expect(
          await invoke(
            "recoverUnavailableSource",
            incidentCredential,
            foreignProvisioned.catalog,
            recoveryRequest,
          ),
        ).toEqual(disasterApproval);
        const recoveredToken = await signer.token(foreign, {
          writerFence: "1",
          authorizationRevision: "1",
        });
        let disasterPhase = "";
        for (let attempt = 0; attempt < 40 && disasterPhase !== "verified"; attempt++) {
          disasterPhase = ((await invoke("restoreStep", recoveredToken)) as { phase: string })
            .phase;
          expect((await call("/commands", recoveredToken, foreignPost)).status).toBe(503);
          if (attempt === 1 && recoveryRestart) {
            await runtime.dispose();
            runtime = new Miniflare(options);
          }
        }
        expect(disasterPhase).toBe("verified");
        const recoveredCatalog = await (await rpc()).control(
          recoveredToken,
          "finishRestore",
          disasterApproval,
          "disaster-resume",
        );
        expect(recoveredCatalog.status).toBe("active");
        await invoke("activateRestoredWriter", recoveredToken);
        const replayCommit = await call("/commands", recoveredToken, foreignPost);
        expect(replayCommit.status).toBe(200);
        const restoredCommit = (await replayCommit.json()) as typeof body;
        expect(restoredCommit).toMatchObject({
          outcomeSequence: "2",
          result: { disposition: "replayed" },
        });
        expect(restoredCommit.originalResult).toEqual(foreignSavedReceipt.originalResult);
        const replayRejection = await call(
          "/commands",
          recoveredToken,
          encodeBookCommand(posting("foreign-stale", 0n)),
        );
        expect(replayRejection.status).toBe(200);
        const restoredRejection = (await replayRejection.json()) as typeof body;
        expect(restoredRejection).toMatchObject({
          outcomeSequence: "3",
          originalResult: { disposition: "rejected" },
        });
        expect(restoredRejection.originalResult).toEqual(foreignRejectedReceipt.originalResult);
        expect((await call("/commands", foreignCurrent, foreignPost)).status).toBe(403);
        expect(
          (await call("/commands", await signer.token(foreign, { writerFence: "1" }), foreignPost))
            .status,
        ).toBe(403);
        const continued = await call(
          "/commands",
          recoveredToken,
          encodeBookCommand(posting("after-disaster", 2n)),
        );
        expect(continued.status).toBe(200);
        expect(await continued.json()).toMatchObject({
          outcomeSequence: "4",
          result: { disposition: "committed" },
        });
        await expect(
          invoke(
            "recoverUnavailableSource",
            incidentCredential,
            foreignProvisioned.catalog,
            recoveryRequest,
          ),
        ).rejects.toThrow("ledger_forbidden");
      }
      const maintenance = JSON.parse(
        JSON.stringify(
          await (await rpc()).control(
            fresh,
            "beginMaintenance",
            provisioned.catalog,
            "maintenance",
          ),
        ),
      ) as NativeCatalogSnapshot;
      expect(maintenance.status).toBe("maintenance");
      const sourceIncident = await recoverySigner.incident(
        scope,
        provisioned.catalog.contentHash,
        "maintenance",
      );
      let sourceEvidence: NativeRecoveryEvidence | null = null;
      for (let attempt = 0; attempt < 10 && !sourceEvidence; attempt++) {
        const observed = (await invoke(
          "inspectRecoverySource",
          sourceIncident,
          provisioned.catalog,
          "maintenance",
        )) as {
          complete: boolean;
          evidence: NativeRecoveryEvidence | null;
        };
        expect(observed.complete).toBe(observed.evidence !== null);
        sourceEvidence = observed.evidence;
      }
      expect(sourceEvidence).toMatchObject({
        head: { sequence: "2", bookRevision: "2" },
        authorizationRevision: "1",
      });
      await expect(
        invoke("inspectRecoverySource", fresh, provisioned.catalog, "maintenance"),
      ).rejects.toThrow("ledger_unauthorized");
      expect(
        (await call("/commands", fresh, encodeBookCommand(posting("after-maintenance", 2n))))
          .status,
      ).toBe(503);
      const retired = await (await rpc()).control(fresh, "retireWriter", maintenance, "retire");
      expect(retired.fence).toBe("1");
      expect(retired.retirement?.head.sequence).toBe("2");
      await runtime.dispose();
      runtime = new Miniflare(options);
      expect((await call("/commands", fresh, encodeBookCommand(command))).status).toBe(503);
      await invoke("deliverArchiveAlarm", scope);
      const sealed = await (await rpc()).control(fresh, "sealArchive", retired, "seal");
      expect(sealed.sealed?.head.sequence).toBe("2");
      let approval: NativeCatalogSnapshot | undefined;
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          approval = await (await rpc()).control(fresh, "approveRestore", sealed, "restore");
          break;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !error.message.includes("native_catalog_projection_pending")
          )
            throw error;
        }
      }
      if (!approval)
        throw new Error("Source projection did not complete in its bounded test budget");
      expect(approval.restore?.authorizationRevision).toBe("1");
      const replacement = await signer.token(scope, {
        writerFence: "1",
        authorizationRevision: "1",
      });
      await expect(async () => await invoke("restoreStep", replacement)).toThrow();
      // Explicit isolated fault: destroy only this test's book, not the independent
      // catalog or R2. Restart discards all cached source state.
      if (!nativeSnapshot) await invoke("simulatePrimaryLoss", scope);
      await runtime.dispose();
      runtime = new Miniflare(options);
      await expect(
        async () =>
          await (await rpc()).provision(
            token,
            encodeDurableBook(genesis()),
            encodeBookCommand(activation()),
            "blank-replacement",
          ),
      ).toThrow();
      let phase = "";
      for (let attempt = 0; attempt < 40 && phase !== "verified"; attempt++) {
        phase = (
          (await invoke(
            nativeSnapshot ? "verifyRestoredSnapshot" : "restoreStep",
            replacement,
          )) as { phase: string }
        ).phase;
        expect((await call("/commands", replacement, encodeBookCommand(command))).status).toBe(503);
        if (attempt === 1) {
          await runtime.dispose();
          runtime = new Miniflare(options);
        }
      }
      expect(phase).toBe("verified");
      const resumed = await (await rpc()).control(replacement, "finishRestore", approval, "resume");
      expect(resumed.status).toBe("active");
      await invoke("activateRestoredWriter", replacement);
      expect((await call("/commands", fresh, encodeBookCommand(command))).status).toBe(403);
      const restored = await call("/commands", replacement, encodeBookCommand(command));
      expect(restored.status).toBe(200);
      expect(((await restored.json()) as typeof body).originalResult).toEqual(body.originalResult);
      const afterRestore = await call(
        "/commands",
        replacement,
        encodeBookCommand(posting("after-restore", 2n)),
      );
      expect(afterRestore.status).toBe(200);
      expect(((await afterRestore.json()) as typeof body).outcomeSequence).toBe("3");
      expect(
        (
          await call(
            "/authorization",
            replacement,
            JSON.stringify({ requestId: "revoke-after-restore", expectedRevision: "1" }),
          )
        ).status,
      ).toBe(200);
      await expect(async () => await invoke("activateRestoredWriter", replacement)).toThrow(
        "ledger_forbidden",
      );
      await expect(
        async () => await (await rpc()).control(replacement, "finishRestore", approval, "resume"),
      ).toThrow("ledger_forbidden");
      const renewed = await signer.token(scope, { writerFence: "1", authorizationRevision: "2" });
      await invoke("activateRestoredWriter", renewed);
      expect(await (await rpc()).control(renewed, "finishRestore", approval, "resume")).toEqual(
        resumed,
      );
      expect(
        (await call("/outcomes", renewed, JSON.stringify({ after: null, limit: 16 }))).status,
      ).toBe(200);
    } finally {
      await runtime.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
