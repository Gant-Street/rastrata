import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { decodeBookOutcome, encodeBookCommand, encodeDurableBook } from "@rastrata/kernel";
import { NativeLedgerHttp } from "../src/native-ledger-http.ts";
import { AuthorizedNativeLedger } from "../src/authorized-native-ledger.ts";
import type { BookApplicationService } from "../src/book-application-service.ts";
import type { SqliteStorage } from "../src/sqlite.ts";
import { authorizationFixture } from "./authorization-fixtures.ts";
import { activation, genesis, posting } from "./fixtures.ts";

async function fixture(
  timeout = 10000,
  application: (ledger: AuthorizedNativeLedger) => BookApplicationService = (ledger) => ledger,
) {
  const f = await authorizationFixture(),
    db = new Database(":memory:");
  const queries: string[] = [];
  const storage: SqliteStorage = {
    sql: {
      exec(query, ...bindings) {
        queries.push(query);
        return db
          .query(query)
          .all(
            ...bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)),
          ) as Record<string, unknown>[];
      },
    },
    transactionSync: (work) => db.transaction(work)(),
    sync: async () => {},
  };
  const ledger = new AuthorizedNativeLedger(
    storage,
    f.scope,
    f.scope.objectId,
    () => ({ fence: "0", pending: false }),
    f.authorizer,
  );
  const http = new NativeLedgerHttp(application(ledger), timeout),
    token = await f.token();
  const call = (
    path: string,
    body: string,
    authorization: string = token,
    headers: Record<string, string> = {},
  ) =>
    http.fetch(
      new Request(`http://ledger.test${path}`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json", ...headers },
        body,
      }),
    );
  const provision = () =>
    call(
      "/provision",
      JSON.stringify({
        genesis: encodeDurableBook(genesis()),
        command: encodeBookCommand(activation()),
      }),
    );
  return { ...f, db, queries, ledger, http, call, provision, authorization: token };
}

test("HTTP accepts a structural asynchronous application port and rechecks revocation after its wait", async () => {
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const calls: string[] = [];
  const f = await fixture(
    10000,
    (ledger): BookApplicationService => ({
      checkRequestAuthorization: (...args) => ledger.checkRequestAuthorization(...args),
      provision: (...args) => {
        calls.push("provision");
        return ledger.provision(...args);
      },
      execute: async (...args) => {
        calls.push("execute");
        entered.resolve();
        await resume.promise;
        return ledger.execute(...args);
      },
      outcomes: (...args) => {
        calls.push("outcomes");
        return ledger.outcomes(...args);
      },
      advanceAuthorization: (...args) => {
        calls.push("authorization");
        return ledger.advanceAuthorization(...args);
      },
    }),
  );
  try {
    expect((await f.provision()).status).toBe(200);
    const pending = f.call("/commands", encodeBookCommand(posting("waited")));
    await entered.promise;
    const revoked = await f.call(
      "/authorization",
      JSON.stringify({ requestId: "revoke-during-preparation", expectedRevision: "0" }),
    );
    expect(revoked.status).toBe(200);
    resume.resolve();
    const refused = await pending;
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "ledger_forbidden" });

    const current = await f.token({ authorizationRevision: "1" });
    const page = await f.call("/outcomes", JSON.stringify({ after: null, limit: 16 }), current);
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({ observedTip: { sequence: "1" } });
    const saved = await f.call("/commands", encodeBookCommand(posting("waited")), current);
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body).toMatchObject({ outcomeSequence: "2", result: { disposition: "committed" } });
    const retry = await f.call("/commands", encodeBookCommand(posting("waited")), current);
    expect(await retry.json()).toMatchObject({
      outcomeSequence: "2",
      result: { disposition: "replayed" },
      originalResult: (body as { originalResult: unknown }).originalResult,
    });
    expect(calls).toEqual([
      "provision",
      "execute",
      "authorization",
      "outcomes",
      "execute",
      "execute",
    ]);
  } finally {
    resume.resolve();
    f.db.close();
  }
});

test("HTTP executes real exact commands and exposes retained receipts and paged outcome envelopes", async () => {
  const f = await fixture();
  try {
    expect((await f.provision()).status).toBe(200);
    f.queries.length = 0;
    const saved = await f.call("/commands", encodeBookCommand(posting("wire")));
    expect(saved.status).toBe(200);
    expect(saved.headers.get("cache-control")).toBe("no-store");
    expect(f.queries).toHaveLength(8);
    const body = (await saved.json()) as {
      result: { disposition: string; observedBookRevision: string };
      originalResult: unknown;
      outcomeSequence: string;
    };
    expect(body.result.disposition).toBe("committed");
    expect(body.result.observedBookRevision).toBe("2");
    expect(body.outcomeSequence).toBe("2");
    const retry = (await (
      await f.call("/commands", encodeBookCommand(posting("wire")))
    ).json()) as typeof body;
    expect(retry.result.disposition).toBe("replayed");
    expect(retry.originalResult).toEqual(body.originalResult);
    const rejected = (await (
      await f.call("/commands", encodeBookCommand(posting("stale")))
    ).json()) as typeof body;
    expect(rejected.result.disposition).toBe("rejected");
    expect(rejected.outcomeSequence).toBe("3");
    const page = (await (
      await f.call("/outcomes", JSON.stringify({ after: null, limit: 16 }))
    ).json()) as {
      outcomes: { encoded: string }[];
      through: { chainHash: string; sequence: string; bookRevision: string };
    };
    expect(page.outcomes).toHaveLength(3);
    for (const outcome of page.outcomes)
      expect(decodeBookOutcome(outcome.encoded).disposition).toBe("decoded");
    const reordered = {
      chainHash: page.through.chainHash,
      bookRevision: page.through.bookRevision,
      sequence: page.through.sequence,
    };
    const terminal = await f.call("/outcomes", JSON.stringify({ after: reordered, limit: 16 }));
    expect(terminal.status).toBe(200);
    expect(((await terminal.json()) as { outcomes: unknown[] }).outcomes).toHaveLength(0);
    expect(
      (
        await f.call(
          "/authorization",
          JSON.stringify({ requestId: "revoke", expectedRevision: "0" }),
        )
      ).status,
    ).toBe(200);
    expect((await f.call("/commands", encodeBookCommand(posting("wire")))).status).toBe(403);
  } finally {
    f.db.close();
  }
});

test("HTTP rejects unauthorized, malformed, oversized and foreign inputs without financial access", async () => {
  const f = await fixture();
  try {
    expect((await f.call("/commands", "malformed", "Bearer bad")).status).toBe(401);
    expect(
      (
        await f.call(
          "/commands",
          encodeBookCommand(posting("wire")),
          await f.token({ permissions: ["read"] }),
        )
      ).status,
    ).toBe(403);
    expect((await f.call("/__proto__", "{}")).status).toBe(404);
    expect((await f.call("/commands?foo=bar", "{}")).status).toBe(404);
    expect((await f.http.fetch(new Request("http://ledger.test/commands"))).status).toBe(405);
    for (const path of ["/commands", "/provision", "/outcomes", "/authorization"])
      expect((await f.call(path, "{")).status).toBe(400);
    expect(
      (await f.call("/commands", "{}", f.authorization, { "content-type": "text/plain" })).status,
    ).toBe(415);
    expect(
      (await f.call("/commands", "{}", f.authorization, { "content-encoding": "gzip" })).status,
    ).toBe(415);
    expect((await f.call("/commands", "x".repeat(1048577))).status).toBe(413);
    const invalidUtf8 = await f.http.fetch(
      new Request("http://ledger.test/commands", {
        method: "POST",
        headers: { authorization: f.authorization, "content-type": "application/json" },
        body: new Uint8Array([0xff]),
      }),
    );
    expect(invalidUtf8.status).toBe(400);
    expect(f.queries).toHaveLength(0);
    for (const after of [
      false,
      [],
      {},
      { sequence: "00", bookRevision: "0", chainHash: "0".repeat(64) },
      { sequence: "0", bookRevision: "1", chainHash: "0".repeat(64) },
    ])
      expect((await f.call("/outcomes", JSON.stringify({ after, limit: 1 }))).status).toBe(400);
    expect(f.queries).toHaveLength(0);
    expect((await f.provision()).status).toBe(200);
    const foreign = { sequence: "0", bookRevision: "0", chainHash: "0".repeat(64) };
    expect((await f.call("/outcomes", JSON.stringify({ after: foreign, limit: 1 }))).status).toBe(
      400,
    );
    f.db.exec("UPDATE ledger_native_book SET head='private corrupted storage details'");
    const failed = await f.call("/commands", encodeBookCommand(posting("wire")));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({
      version: "rastrata-native-http-v1",
      error: "ledger_service_unavailable",
    });
  } finally {
    f.db.close();
  }
});

test("HTTP bounds concurrent uploads and ends stalled or aborted bodies before entering the ledger", async () => {
  const f = await fixture(20);
  try {
    const pending = Array.from({ length: 16 }, () =>
      f.http.fetch(
        new Request("http://ledger.test/commands", {
          method: "POST",
          headers: { authorization: f.authorization, "content-type": "application/json" },
          body: new ReadableStream<Uint8Array>(),
        }),
      ),
    );
    expect((await f.call("/commands", "{}")).status).toBe(429);
    for (const result of await Promise.all(pending)) expect(result.status).toBe(408);
    const abort = new AbortController();
    abort.abort();
    expect(
      (
        await f.http.fetch(
          new Request("http://ledger.test/commands", {
            method: "POST",
            signal: abort.signal,
            headers: { authorization: f.authorization, "content-type": "application/json" },
            body: new ReadableStream<Uint8Array>(),
          }),
        )
      ).status,
    ).toBe(408);
    expect(f.queries).toHaveLength(0);
    expect((await f.call("/commands", "{}")).status).toBe(400);
  } finally {
    f.db.close();
  }
});
