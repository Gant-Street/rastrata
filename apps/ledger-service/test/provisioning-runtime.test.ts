import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { encodeBookCommand, encodeDurableBook, executeBookCommand } from "@rastrata/kernel";
import type { CompleteBookScope, NativeCatalogSnapshot } from "@rastrata/ledger";
import { BOOK, activation, genesis, issuer, posting } from "./fixtures.ts";

const faults = [
  "reserve-before",
  "reserve-after",
  "initialize-before",
  "initialize-after",
  "activate-before",
  "activate-after",
  "refresh-before",
  "refresh-after",
  // Three independently durable R2 publications: genesis, manifest, control.
  "archive-1-before",
  "archive-1-after",
  "archive-2-before",
  "archive-2-after",
  "archive-3-before",
  "archive-3-after",
] as const;

test("every provisioning boundary resumes after cold restart without duplicate accounting", async () => {
  const signer = await issuer();
  const bundle = async (file: string) => {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, file)],
      target: "node",
      format: "esm",
      external: ["node:crypto", "cloudflare:workers"],
    });
    if (!result.success || !result.outputs[0]) throw new Error("Missing provisioning bundle");
    return result.outputs[0].text();
  };
  const script = await bundle("provisioning-worker.ts");
  const driver = await bundle("control-worker.ts");
  for (const fault of faults) {
    const directory = mkdtempSync(join(tmpdir(), "rastrata-provision-fault-"));
    const options = (point: string) => ({
      workers: [
        {
          name: "ledger",
          modules: true,
          script,
          compatibilityDate: "2026-07-30",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            BOOKS: { className: "LedgerBook", useSQLite: true },
            CATALOGS: { className: "LedgerCatalog", useSQLite: true },
          },
          r2Buckets: ["ARCHIVE"],
          bindings: {
            BOOK_AUTHORIZATION: signer.configuration,
            LEDGER_NAMESPACE_ID: "provision-fault-test",
            PROVISION_FAULT: point,
          },
        },
        {
          name: "driver",
          modules: true,
          script: driver,
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
      cf: false as const,
    });
    let runtime = new Miniflare(options(fault));
    const rpc = async <T>(method: string, ...args: unknown[]): Promise<T> => {
      const response = await (await runtime.getWorker("driver")).fetch("http://driver.test", {
        method: "POST",
        body: JSON.stringify({ method, args }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error((value as { error: string }).error);
      return value as T;
    };
    const command = async (token: string, body: string) => {
      const response = await runtime.dispatchFetch("https://ledger.test/commands", {
        method: "POST",
        headers: { authorization: token, "content-type": "application/json", connection: "close" },
        body,
      });
      return { status: response.status, body: await response.json() };
    };
    try {
      const scope = await rpc<CompleteBookScope>("resolveIdentity", `tenant-${fault}`, BOOK);
      const token = await signer.token(scope);
      const args = [
        token,
        encodeDurableBook(genesis()),
        encodeBookCommand(activation()),
        "initialize",
      ];
      await expect(rpc("provision", ...args)).rejects.toThrow(
        fault.startsWith("archive-") ? "archive_write_uncertain" : "platform_failure",
      );
      // Until independent catalog activation succeeds, ordinary writes cannot
      // observe or extend a half-provisioned book, even with a valid capability.
      if (!["activate-after", "refresh-before", "refresh-after"].includes(fault))
        expect((await command(token, encodeBookCommand(posting()))).status).toBe(503);

      await runtime.dispose();
      runtime = new Miniflare(options(""));
      type Provisioned = { catalog: NativeCatalogSnapshot; receipt: unknown };
      const resumed = await rpc<Provisioned>("provision", ...args);
      expect(resumed.catalog.status).toBe("active");
      expect(resumed.catalog.fence).toBe("0");
      expect(await rpc<Provisioned>("provision", ...args)).toEqual(resumed);
      expect(await rpc("archiveStatus", token)).toMatchObject({
        status: "caughtUp",
        archivedSequence: "1",
        observedSequence: "1",
        pendingOutcomes: "0",
      });
      const active = executeBookCommand(genesis().state, genesis().protocol, activation());
      const oracle = executeBookCommand(active.state, active.protocol, posting());
      const saved = await command(token, encodeBookCommand(posting()));
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({
        outcomeSequence: "2",
        result: { disposition: "committed", resultHash: oracle.result.resultHash },
      });
      const replay = await command(token, encodeBookCommand(posting()));
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({
        outcomeSequence: "2",
        result: { disposition: "replayed" },
      });
    } finally {
      await runtime.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }
}, 60000);
