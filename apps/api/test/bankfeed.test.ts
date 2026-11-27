import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BankfeedScheduler } from "@rastrata/application/local";
import { APPLICATION_API_VERSION } from "@rastrata/application/schema";
import { startLocalApplicationServer } from "../src/server.ts";

// The optional daily bank feed sync is a timer inside the service. These tests are about the wiring:
// a server started without it never syncs by itself, one started with it only looks at the owner's
// setting, and that setting is off until the owner turns it on.

const BOOK = {
  name: "Feed Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Cash", role: "asset" },
    { code: "3000", name: "Capital", role: "equity" },
  ],
};

async function status(base: string): Promise<{
  scheduler: boolean;
  connected: boolean;
  settings: { dailySync: boolean; dailyAt: string };
}> {
  const response = await fetch(`${base}/v1/bankfeed.status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: APPLICATION_API_VERSION, bookId: "local-book", input: {} }),
  });
  const body = await response.json();
  if (!body.ok) throw new Error(JSON.stringify(body.error));
  return body.data;
}

async function withServer(
  bankfeed: boolean | undefined,
  body: (
    base: string,
    runtime: Awaited<ReturnType<typeof startLocalApplicationServer>>,
  ) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-api-bankfeed-"));
  const runtime = await startLocalApplicationServer({
    path: join(directory, "book.sqlite"),
    port: 0,
    ...(bankfeed === undefined ? {} : { bankfeed }),
  });
  const base = `http://127.0.0.1:${runtime.server.port}`;
  try {
    const setup = await fetch(`${base}/api/book/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(BOOK),
    });
    expect(setup.status).toBe(200);
    await body(base, runtime);
  } finally {
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a server started without the bank feed timer has none, and says so", async () => {
  await withServer(undefined, async (base, runtime) => {
    expect(runtime.feedScheduler).toBeNull();
    const state = await status(base);
    expect(state.scheduler).toBe(false);
    expect(state.connected).toBe(false);
  });
});

test("a server started with it runs the timer, the daily sync is off until the owner turns it on, and stopping stops it", async () => {
  const kept: { timer: BankfeedScheduler | null } = { timer: null };
  await withServer(true, async (base, runtime) => {
    kept.timer = runtime.feedScheduler;
    expect(kept.timer).not.toBeNull();
    const state = await status(base);
    expect(state.scheduler).toBe(true);
    expect(state.settings).toEqual({ dailySync: false, dailyAt: "06:17" });
    // The owner has not turned the daily sync on, so a pass does nothing and asks no one.
    expect(await kept.timer?.run()).toEqual({ ran: false, reason: "off" });
  });
  // The server is stopped: the timer is too, and a pass after that does nothing.
  expect(await kept.timer?.run()).toBeNull();
});
