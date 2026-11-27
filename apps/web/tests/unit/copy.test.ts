// What the page keeps on the device of what it has read of the book (src/copy.ts, held.ts): locked with a key that comes with the token and is not kept with it, read back the next time
// the page opens, deleted at sign-out, and no use to anyone with another session's key.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { API_VERSION } from "@rastrata/application/client-contracts";
import { installAuthorizer } from "../../src/ambient";
import { Account, WORKSPACE_KEY } from "../../src/account";
import { BrowserApplicationClient, type ApplicationFetch } from "../../src/application-client";
import { Copy, type Place } from "../../src/copy";
import {
  COPY_WAIT_MS,
  expectCopy,
  FRESH_MS,
  forgetCopy,
  giveUpCopy,
  keyOf,
  peek,
  ready,
  reset,
  settled,
  unlockCopy,
} from "../../src/held";

type Stored = Awaited<ReturnType<Place["records"]>>[number];

/** The device's storage, in memory: what is in it is what a person with the device could read. */
function memoryPlace(): Place & { all: Map<string, Stored> } {
  const all = new Map<string, Stored>();
  return {
    all,
    records: async (scope) => [...all.values()].filter((record) => record.scope === scope),
    put: async (records) => {
      for (const record of records) all.set(record.id, record);
    },
    remove: async (ids) => {
      for (const id of ids) all.delete(id);
    },
    wipe: async () => all.clear(),
  };
}

/** 256 bits as the control Worker sends them. */
const keyBytes = (fill: number) =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const KEY = keyBytes(7);
const OTHER = keyBytes(9);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** A client whose reads and writes take any operation and answer anything: these tests are about what the page remembers of an answer, not about any one operation's shape. */
interface Loose {
  read(
    name: string,
    input?: unknown,
    options?: { signal?: AbortSignal; fresh?: boolean },
  ): Promise<Json>;
  write(name: string, input: unknown, workflow: string): Promise<Json>;
}
const loose = (client: BrowserApplicationClient): Loose => client as unknown as Loose;

let clock = 1_000_000;
beforeEach(() => {
  clock = 1_000_000;
  reset(() => clock);
  installAuthorizer(null);
});
afterEach(() => {
  reset();
  installAuthorizer(null);
});

const answerOf = (n: number, at = clock, scope = "wsp_a") => ({
  key: `${scope}\nlocal-book\nperiods.list\n{"n":${n}}`,
  text: JSON.stringify({ periods: [`client-${n}`], private: "Mrs. Fenwick's invoice" }),
  at,
});

async function kept(place: Place, key = KEY, scope = "wsp_a", count = 3) {
  const writer = new Copy(place);
  await writer.unlock(key, scope);
  for (let n = 1; n <= count; n += 1) writer.save(answerOf(n, 1_000 + n, scope));
  await writer.settled();
}

test("what was kept is given back, newest first, by the same key", async () => {
  const place = memoryPlace();
  await kept(place);
  const back = await new Copy(place).unlock(KEY, "wsp_a");
  expect(back.map((answer) => answer.at)).toEqual([1_003, 1_002, 1_001]);
  expect(back[0]).toEqual(answerOf(3, 1_003));
});

test("what is on the device says nothing of what was asked or answered, and only the workspace and the time in the clear", async () => {
  const place = memoryPlace();
  await kept(place);
  expect(place.all.size).toBe(3);
  for (const record of place.all.values()) {
    const bytes = new TextDecoder("latin1").decode(record.data);
    expect(bytes).not.toContain("Fenwick");
    expect(bytes).not.toContain("periods");
    expect(record.id).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(record).sort()).toEqual(["at", "build", "data", "id", "iv", "scope"]);
  }
});

test("another session's key reads nothing, and what it could not read is deleted; another workspace's records are left alone", async () => {
  const place = memoryPlace();
  await kept(place);
  await kept(place, KEY, "wsp_b", 2);
  expect(await new Copy(place).unlock(OTHER, "wsp_a")).toEqual([]);
  expect([...place.all.values()].filter((record) => record.scope === "wsp_a")).toHaveLength(0);
  expect([...place.all.values()].filter((record) => record.scope === "wsp_b")).toHaveLength(2);
  expect(await new Copy(place).unlock(KEY, "wsp_b")).toHaveLength(2);
});

test("a record that was damaged is deleted and the others are given back; a key that is not a key gives nothing and throws nothing", async () => {
  const place = memoryPlace();
  await kept(place);
  const [first] = [...place.all.values()];
  if (!first) throw new Error("nothing kept");
  place.all.set(first.id, { ...first, data: first.data.map((byte) => byte ^ 1) });
  expect(await new Copy(place).unlock(KEY, "wsp_a")).toHaveLength(2);
  expect(place.all.size).toBe(2);
  expect(await new Copy(place).unlock("not a key!", "wsp_a")).toEqual([]);
  expect(await new Copy(place).unlock("c2hvcnQ", "wsp_a")).toEqual([]);
});

test("nothing is written before the copy is unlocked, and nothing after it is forgotten", async () => {
  const place = memoryPlace();
  const copy = new Copy(place);
  copy.save(answerOf(1));
  await copy.settled();
  expect(place.all.size).toBe(0);
  await copy.unlock(KEY, "wsp_a");
  copy.save(answerOf(2));
  await copy.settled();
  expect(place.all.size).toBe(1);
  await copy.forget();
  expect(place.all.size).toBe(0);
  copy.save(answerOf(3));
  await copy.settled();
  expect(place.all.size).toBe(0);
});

test("a change erases what was kept of the workspace and leaves the other workspaces', and what was waiting to be written is not written", async () => {
  const place = memoryPlace();
  await kept(place, KEY, "wsp_b", 2);
  const copy = new Copy(place);
  await copy.unlock(KEY, "wsp_a");
  copy.save(answerOf(1));
  await copy.settled();
  copy.save(answerOf(2));
  await copy.erase();
  await copy.settled();
  expect([...place.all.values()].map((record) => record.scope)).toEqual(["wsp_b", "wsp_b"]);
});

test("what is kept is bounded: the oldest go first", async () => {
  const place = memoryPlace();
  const copy = new Copy(place);
  await copy.unlock(KEY, "wsp_a");
  for (let n = 0; n < 320; n += 1) copy.save(answerOf(n, 5_000 + n));
  await copy.settled();
  expect(place.all.size).toBe(300);
  const back = await new Copy(place).unlock(KEY, "wsp_a");
  expect(Math.min(...back.map((answer) => answer.at))).toBe(5_020);
});

// ---- as the page reads it back ---------------------------------------------------------------------------

const answer = (data: unknown) =>
  Response.json({ version: API_VERSION, bookId: "local-book", ok: true, data });

/** What the application's page hands the account layer to do with the key (boot.ts). */
const copyHooks = {
  unlock: (key: string, workspace: string) => void unlockCopy(key, workspace),
  giveUp: giveUpCopy,
  forget: forgetCopy,
};

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

function scoped(workspace = "wsp_a") {
  installAuthorizer({ authorization: async () => null, scope: () => workspace, ended: () => {} });
}

test("the first reads wait for the copy, find what the last visit kept, are given it at once, and the service is asked again behind it", async () => {
  const place = memoryPlace();
  scoped();
  // A last visit: it read the periods and kept them.
  const asked: string[] = [];
  const service = (async (url: string) => {
    asked.push(String(url));
    return answer({ periods: ["now"] });
  }) as ApplicationFetch;
  const earlier = new Copy(place);
  expectCopy(earlier);
  await unlockCopy(KEY, "wsp_a");
  await loose(new BrowserApplicationClient(storage(), service)).read("periods.list", {});
  await earlier.settled();
  asked.length = 0;

  // This visit: nothing is held until the key has come.
  reset(() => clock);
  scoped();
  clock += FRESH_MS * 10;
  expectCopy(new Copy(place));
  const client = loose(new BrowserApplicationClient(storage(), service));
  const reading = client.read("periods.list", {});
  let settledEarly = false;
  void reading.then(() => {
    settledEarly = true;
  });
  await new Promise((done) => setTimeout(done, 20));
  expect(settledEarly).toBe(false);
  expect(asked).toEqual([]);
  await unlockCopy(KEY, "wsp_a");
  // What the last visit kept, though the service has not been asked: it is given at once, and the service is asked again behind it.
  expect(await reading).toEqual({ periods: ["now"] });
  await settled();
  expect(asked).toEqual(["/v1/periods.list"]);
});

test("a token that does not come lets the reads go on without the copy, and so does the wait running out", async () => {
  scoped();
  expectCopy(new Copy(memoryPlace()));
  let released = false;
  void ready().then(() => {
    released = true;
  });
  await new Promise((done) => setTimeout(done, 5));
  expect(released).toBe(false);
  giveUpCopy();
  await ready();
  expect(COPY_WAIT_MS).toBeLessThanOrEqual(2_500);
  // And with the wait left to run out.
  const started = Date.now();
  expectCopy(new Copy(memoryPlace()));
  await ready();
  expect(Date.now() - started).toBeGreaterThanOrEqual(COPY_WAIT_MS - 50);
});

test("an answer a read has already kept is not replaced by an older one from the device", async () => {
  const place = memoryPlace();
  scoped();
  const earlier = new Copy(place);
  await earlier.unlock(KEY, "wsp_a");
  const older = answerOf(1, clock - 100_000);
  earlier.save({ ...older, key: keyOf("local-book", "periods.list", {}), text: '{"n":"old"}' });
  await earlier.settled();
  reset(() => clock);
  scoped();
  const service = (async () => answer({ n: "new" })) as ApplicationFetch;
  expectCopy(new Copy(place));
  const client = loose(new BrowserApplicationClient(storage(), service));
  // A read that the copy cannot wait for (the wait ran out) has asked and kept the new answer.
  giveUpCopy();
  expect(await client.read("periods.list", {})).toEqual({ n: "new" });
  await unlockCopy(KEY, "wsp_a");
  expect(await client.read("periods.list", {})).toEqual({ n: "new" });
});

test("the token's key unlocks the copy, a token with none lets go of it, and signing out deletes what is on the device", async () => {
  const place = memoryPlace();
  scoped();
  const earlier = new Copy(place);
  expectCopy(earlier);
  await unlockCopy(KEY, "wsp_a");
  const service = (async () => answer({ periods: ["kept"] })) as ApplicationFetch;
  await loose(new BrowserApplicationClient(storage(), service)).read("periods.list", {});
  await earlier.settled();
  expect(place.all.size).toBe(1);

  reset(() => clock);
  const notes = storage();
  notes.setItem(WORKSPACE_KEY, "wsp_a");
  const control = (async (path: string) => {
    if (path === "/auth/workspace-token")
      return Response.json({ token: "t", expiresIn: 600, copyKey: KEY });
    return Response.json({});
  }) as ApplicationFetch;
  const account = new Account({
    ask: control,
    storage: notes,
    now: () => clock,
    copy: copyHooks,
  });
  installAuthorizer(account);
  expectCopy(new Copy(place));
  expect(await account.authorization()).toBe("Bearer t");
  await ready();
  expect(peek(keyOf("local-book", "periods.list", {}))).not.toBeNull();

  // Without a key in the answer the page goes on without the copy.
  reset(() => clock);
  const bare = new Account({
    ask: (async () => Response.json({ token: "t", expiresIn: 600 })) as ApplicationFetch,
    storage: notes,
    now: () => clock,
    copy: copyHooks,
  });
  expectCopy(new Copy(place));
  const began = performance.now();
  await bare.authorization();
  await ready();
  // It is the token that came without a key that lets the first reads go on, not the wait running out (two seconds): this is what a page that had to wait for nothing is held to.
  expect(performance.now() - began).toBeLessThan(500);
  expect(peek(keyOf("local-book", "periods.list", {}))).toBeNull();

  // Signing out deletes what is on the device, whatever workspace it was of.
  reset(() => clock);
  expectCopy(new Copy(place));
  await account.signOut();
  expect(place.all.size).toBe(0);
  await forgetCopy();
});

test("what the page holds is kept on the device as it is read, and a change erases it there as it does here", async () => {
  const place = memoryPlace();
  scoped();
  const copy = new Copy(place);
  expectCopy(copy);
  await unlockCopy(KEY, "wsp_a");
  const service = (async () => answer({ periods: ["read"] })) as ApplicationFetch;
  const client = loose(new BrowserApplicationClient(storage(), service));
  await client.read("periods.list", {});
  await client.read("accounts.list", {});
  await copy.settled();
  expect(place.all.size).toBe(2);
  // A write ends what is held (the client does it when a write goes through), and so what is kept.
  const { clear } = await import("../../src/held");
  clear();
  await copy.settled();
  await new Promise((done) => setTimeout(done, 10));
  expect(place.all.size).toBe(0);
});

test("what was read back from the device is checked with the service however recent it is, and not taken for a read", async () => {
  const place = memoryPlace();
  scoped();
  const earlier = new Copy(place);
  expectCopy(earlier);
  await unlockCopy(KEY, "wsp_a");
  let version = 1;
  const asked: string[] = [];
  const service = (async (url: string) => {
    asked.push(String(url));
    return answer({ version });
  }) as ApplicationFetch;
  await loose(new BrowserApplicationClient(storage(), service)).read("periods.list", {});
  await earlier.settled();
  asked.length = 0;

  // Opened again a moment later, and the book was changed behind the page's back meanwhile.
  reset(() => clock);
  scoped();
  clock += 1_000;
  version = 2;
  expectCopy(new Copy(place));
  await unlockCopy(KEY, "wsp_a");
  const client = loose(new BrowserApplicationClient(storage(), service));
  expect(await client.read("periods.list", {})).toEqual({ version: 1 });
  await settled();
  expect(asked).toEqual(["/v1/periods.list"]);
  expect(await client.read("periods.list", {})).toEqual({ version: 2 });
});

test("every token brings the same key, and the copy is read back once for it", async () => {
  const place = memoryPlace();
  scoped();
  await kept(place);
  let reads = 0;
  const counting: Place = {
    ...place,
    records: async (scope) => {
      reads += 1;
      return place.records(scope);
    },
  };
  expectCopy(new Copy(counting));
  await unlockCopy(KEY, "wsp_a");
  await unlockCopy(KEY, "wsp_a");
  await unlockCopy(KEY, "wsp_a");
  expect(reads).toBe(1);
  // Another workspace, or another key, is read back.
  await unlockCopy(KEY, "wsp_b");
  expect(reads).toBe(2);
});

test("a page reads back only what a page of its own build made: what an older build left is not read and is deleted", async () => {
  const place = memoryPlace();
  const older = new Copy(place, "index-old.js");
  await older.unlock(KEY, "wsp_a");
  older.save(answerOf(1, 1_001));
  older.save(answerOf(2, 1_002));
  await older.settled();
  expect(place.all.size).toBe(2);
  // The same key and workspace, a newer build: nothing is given back, and what the older one left is gone.
  const current = new Copy(place, "index-new.js");
  expect(await current.unlock(KEY, "wsp_a")).toEqual([]);
  expect(place.all.size).toBe(0);
  current.save(answerOf(3, 1_003));
  await current.settled();
  const back = await new Copy(place, "index-new.js").unlock(KEY, "wsp_a");
  expect(back.map((answer) => answer.at)).toEqual([1_003]);
  // And the older build, opened again, finds nothing of the newer one's.
  expect(await new Copy(place, "index-old.js").unlock(KEY, "wsp_a")).toEqual([]);
});
