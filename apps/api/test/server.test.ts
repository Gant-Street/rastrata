import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalApplicationServer } from "../src/server.ts";
import { APPLICATION_API_VERSION } from "@rastrata/application/schema";

test("standalone runtime preserves browser compatibility and serves the same versioned book", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-api-runtime-"));
  const runtime = await startLocalApplicationServer({
    path: join(directory, "book.sqlite"),
    port: 0,
  });
  const base = `http://127.0.0.1:${runtime.server.port}`;
  try {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const setup = {
      name: "Shared Co",
      currency: "USD",
      fiscalYear: 2026,
      periodModel: "monthly",
      accounts: [
        { code: "1000", name: "Cash", role: "asset" },
        { code: "3000", name: "Capital", role: "equity" },
      ],
    };
    expect(
      (
        await fetch(`${base}/api/book/setup`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(setup),
        })
      ).status,
    ).toBe(200);
    const response = await fetch(`${base}/v1/accounts.list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: APPLICATION_API_VERSION, bookId: "local-book", input: {} }),
    });
    expect((await response.json()).data.accounts.map((a: { id: string }) => a.id)).toEqual([
      "1000",
      "3000",
    ]);
    const legacy = await fetch(`${base}/api/book`);
    expect(legacy.headers.get("x-rastrata-api-version")).toBe(APPLICATION_API_VERSION);
    expect((await legacy.json()).setup.name).toBe("Shared Co");
    expect(
      (await fetch(`${base}/v1/schema`, { headers: { origin: "https://example.com" } })).status,
    ).toBe(403);
  } finally {
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("only the upload route takes a large body: statements up to 16 MiB, everything else 128 KiB", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-api-uploads-"));
  const runtime = await startLocalApplicationServer({
    path: join(directory, "book.sqlite"),
    port: 0,
  });
  const base = `http://127.0.0.1:${runtime.server.port}`;
  try {
    const statement = new TextEncoder().encode(
      "Date,Amount,Description\n01/02/2026,-12.34,COFFEE\n",
    );
    const small = await fetch(`${base}/v1/uploads`, {
      method: "POST",
      headers: { "content-type": "text/csv", "x-upload-name": "statement.csv" },
      body: statement,
    });
    const receipt = await small.json();
    // Once the ingestion pipeline is installed the file is archived; until then the route says so.
    expect([200, 503]).toContain(small.status);
    if (small.status === 200) expect(receipt.data.size).toBe(statement.byteLength);
    else expect(receipt.error.code).toBe("ingest_unavailable");

    for (const path of ["/api/book/setup", "/v1/book.get"]) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: " ".repeat(131073),
      });
      expect(response.status, path).toBe(413);
      await response.arrayBuffer();
    }

    // The server refuses this one before reading it, so it must not share a connection.
    const oversized = await fetch(`${base}/v1/uploads`, {
      method: "POST",
      headers: { "content-type": "text/csv", connection: "close" },
      body: new Uint8Array(16 * 1024 * 1024 + 8192),
      keepalive: false,
    });
    expect(oversized.status).toBe(413);
    await oversized.arrayBuffer();
  } finally {
    // Bun keeps the refused upload's connection until its idle timeout; close it now.
    await runtime.server.stop(true);
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
