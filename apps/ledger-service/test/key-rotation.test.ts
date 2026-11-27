import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { encodeBookCommand, encodeDurableBook } from "@rastrata/kernel";
import type { BookAuthorizationConfiguration, CompleteBookScope } from "@rastrata/ledger";
import { BOOK, activation, genesis, issuer, posting } from "./fixtures.ts";

test("pinned key rollout overlaps keys then revokes the old signer at gateway and book without changing receipts", async () => {
  const oldSigner = await issuer("old"),
    nextSigner = await issuer("next");
  const compile = async (file: string) => {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, file)],
      target: "node",
      format: "esm",
      external: ["node:crypto", "cloudflare:workers"],
    });
    if (!result.success || !result.outputs[0]) throw new Error("Missing rotation bundle");
    return result.outputs[0].text();
  };
  const script = await compile("../src/index.ts"),
    driver = await compile("control-worker.ts");
  const directory = mkdtempSync(join(tmpdir(), "rastrata-key-rotation-"));
  const options = (configuration: BookAuthorizationConfiguration) => ({
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
        bindings: { BOOK_AUTHORIZATION: configuration, LEDGER_NAMESPACE_ID: "rotation-test" },
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
  let runtime = new Miniflare(options(oldSigner.configuration));
  const rpc = async <T>(method: string, ...args: unknown[]): Promise<T> => {
    const response = await (await runtime.getWorker("driver")).fetch("http://driver.test", {
      method: "POST",
      body: JSON.stringify({ method, args }),
    });
    const value = await response.json();
    if (!response.ok) throw new Error((value as { error: string }).error);
    return value as T;
  };
  const save = async (token: string, id: string, revision: bigint) => {
    const response = await runtime.dispatchFetch("https://ledger.test/commands", {
      method: "POST",
      headers: { authorization: token, "content-type": "application/json", connection: "close" },
      body: encodeBookCommand(posting(id, revision)),
    });
    return {
      status: response.status,
      body: (await response.json()) as {
        outcomeSequence?: string;
        result?: { disposition: string };
        originalResult?: unknown;
      },
    };
  };
  try {
    const scope = await rpc<CompleteBookScope>("resolveIdentity", "rotation-tenant", BOOK);
    const oldToken = await oldSigner.token(scope),
      nextToken = await nextSigner.token(scope);
    await rpc(
      "provision",
      oldToken,
      encodeDurableBook(genesis()),
      encodeBookCommand(activation()),
      "initialize",
    );
    expect((await save(nextToken, "not-trusted-yet", 1n)).status).toBe(401);
    await expect(rpc("checkBookAuthorization", scope, nextToken)).rejects.toThrow(
      "ledger_unauthorized",
    );
    const first = await save(oldToken, "before", 1n);
    expect(first.status).toBe(200);
    expect(first.body.outcomeSequence).toBe("2");

    await runtime.dispose();
    runtime = new Miniflare(
      options({
        ...oldSigner.configuration,
        publicKeys: {
          keys: [
            ...oldSigner.configuration.publicKeys.keys,
            ...nextSigner.configuration.publicKeys.keys,
          ],
        },
      }),
    );
    for (const token of [oldToken, nextToken])
      expect(await rpc<{ authorized: boolean }>("checkBookAuthorization", scope, token)).toEqual({
        authorized: true,
      });
    expect((await save(oldToken, "overlap-old", 2n)).body.outcomeSequence).toBe("3");
    expect((await save(nextToken, "overlap-next", 3n)).body.outcomeSequence).toBe("4");

    await runtime.dispose();
    runtime = new Miniflare(options(nextSigner.configuration));
    expect((await save(oldToken, "retired-key", 4n)).status).toBe(401);
    await expect(rpc("checkBookAuthorization", scope, oldToken)).rejects.toThrow(
      "ledger_unauthorized",
    );
    const retry = await save(nextToken, "before", 1n);
    expect(retry.status).toBe(200);
    expect(retry.body.outcomeSequence).toBe("2");
    expect(retry.body.result?.disposition).toBe("replayed");
    expect(retry.body.originalResult).toEqual(first.body.originalResult);
    const next = await save(nextToken, "after", 4n);
    expect(next.status).toBe(200);
    expect(next.body.outcomeSequence).toBe("5");
    expect(next.body.result?.disposition).toBe("committed");
  } finally {
    await runtime.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}, 60000);
