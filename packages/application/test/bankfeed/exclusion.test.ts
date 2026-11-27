import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { configureSafety } from "../../src/safety/jobs.ts";
import { FIXTURE_PASSWORD, FIXTURE_USER } from "./fake-bridge.ts";
import { type World, closeWorlds, linkByCode, uuid, world } from "./support.ts";

afterEach(closeWorlds);

/** Every spelling of the credential. The access URL is excluded from backups and from the open export,
 * and these tests read the files byte for byte to prove it. */
const secrets = (w: World): string[] => [
  FIXTURE_PASSWORD,
  FIXTURE_USER,
  btoa(`${FIXTURE_USER}:${FIXTURE_PASSWORD}`),
  w.bridge.accessUrl(),
  w.bridge.setupToken(),
];

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Run a long operation to its end, asking again with the same identity while it is running. */
async function finish(w: World, name: string, input: unknown = {}): Promise<{ state: string }> {
  const id = uuid();
  for (let attempt = 0; attempt < 600; attempt++) {
    const reply = await w.call(name, input, id);
    if (reply.status !== 200) throw new Error(`${name}: ${JSON.stringify(reply.body.error)}`);
    if (reply.body.data.state !== "running") return reply.body.data;
    await Bun.sleep(50);
  }
  throw new Error(`${name} did not finish`);
}

async function connectedBook(): Promise<World> {
  const w = await world({ connected: true });
  configureSafety(w.service, { waitMs: 60_000 });
  await linkByCode(w, "ACT-checking-0001", "1000", "2026-09-01");
  await w.ok("bankfeed.sync", {});
  await w.ok("bankfeed.settings", { dailySync: true, dailyAt: "06:17" });
  return w;
}

test("a backup holds the whole book, the bank feed's links and cursors included, and not the credential", async () => {
  const w = await connectedBook();
  const done = await finish(w, "backup.create");
  expect(done.state).toBe("done");
  const backups = filesUnder(join(w.directory, "backups"));
  expect(backups.length).toBeGreaterThan(0);
  for (const file of backups)
    for (const secret of secrets(w))
      expect(readFileSync(file).toString("latin1").includes(secret), `${file} holds a secret`).toBe(
        false,
      );

  // What is in the backup is what a restore needs to carry on: links, cursors, settings, history.
  const snapshot = backups.find((file) => file.endsWith(".sqlite"));
  expect(snapshot).toBeDefined();
  const db = new Database(snapshot as string, { readonly: true });
  try {
    const count = (table: string) =>
      (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count("bankfeed_links")).toBe(1);
    expect(count("bankfeed_accounts")).toBe(2);
    expect(count("bankfeed_runs")).toBeGreaterThan(0);
    expect(count("bankfeed_requests")).toBeGreaterThan(0);
    expect(
      (db.query("SELECT through FROM bankfeed_links").get() as { through: number }).through,
    ).toBeGreaterThan(0);
    expect(
      (db.query("SELECT daily_sync FROM bankfeed_settings").get() as { daily_sync: number })
        .daily_sync,
    ).toBe(1);
  } finally {
    db.close();
  }
});

test("the open export holds the books, not the credential", async () => {
  const w = await connectedBook();
  const done = await finish(w, "export.create");
  expect(done.state).toBe("done");
  const files = filesUnder(join(w.directory, "exports"));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files)
    for (const secret of secrets(w))
      expect(readFileSync(file).toString("latin1").includes(secret), `${file} holds a secret`).toBe(
        false,
      );
});

test("a book restored from a backup comes back with its links and no connection, and connecting again carries on", async () => {
  const w = await connectedBook();
  const status = await w.ok("bankfeed.status", {});
  const through = status.accounts.find((a: { id: string }) => a.id === "ACT-checking-0001").link
    .through;
  await finish(w, "backup.create");
  // As on another computer: the book is there, the private file is not.
  await w.ok("bankfeed.disconnect", {});
  const after = await w.ok("bankfeed.status", {});
  expect(after.connected).toBe(false);
  expect(after.linked).toBe(1);
  expect(
    after.accounts.find((a: { id: string }) => a.id === "ACT-checking-0001").link.through,
  ).toBe(through);
  w.bridge.claimed = false;
  await w.ok("bankfeed.connect", { setupToken: w.bridge.setupToken() });
  const resumed = (await w.ok("bankfeed.sync", {})).accounts[0];
  expect(resumed.state).toBe("complete");
});
