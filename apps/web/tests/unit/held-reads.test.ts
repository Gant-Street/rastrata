// What the page holds of the service (src/held.ts) and how a screen reads it (application-client.ts, loader.ts): an answer is kept and given at once, the service is asked again behind
// an old one and what showed it changes only if the new answer differs, and any change the page makes ends all of it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { API_VERSION } from "@rastrata/application/client-contracts";
import { createRoot } from "solid-js";
import { installAuthorizer } from "../../src/ambient";
import {
  BrowserApplicationClient,
  READ_AGAIN_MS,
  readAgain,
  type ApplicationFetch,
} from "../../src/application-client";
import { FRESH_MS, MAX_AGE_MS, reset, same, settled } from "../../src/held";
import { bookSettings, readBookSettings, resetBookSettings } from "../../src/book-settings";
import { createLoader } from "../../src/loader";

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
  // What is tested here is what the page does with an answer or with none: a read that fails is not asked again first (tests/unit/application-client.test.ts has that).
  readAgain.waits = [];
});
afterEach(() => {
  readAgain.waits = READ_AGAIN_MS;
  reset();
  installAuthorizer(null);
});

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

const answer = (data: unknown, bookId = "local-book") =>
  Response.json({ version: API_VERSION, bookId, ok: true, data });

/** A service that answers each read with what `data` says at that moment, and keeps the list of what it was asked. */
function service(data: (name: string) => unknown = (name) => ({ name, n: 0 })) {
  const asked: string[] = [];
  const waiting: (() => void)[] = [];
  let hold: readonly string[] | null = null;
  const fetcher = (async (url: string) => {
    const name = String(url).replace("/v1/", "");
    asked.push(name);
    if (hold !== null && (hold.length === 0 || hold.includes(name)))
      await new Promise<void>((done) => waiting.push(done));
    return answer(data(name));
  }) as ApplicationFetch;
  return {
    asked,
    client: (bookId = "local-book") =>
      loose(new BrowserApplicationClient(storage(), fetcher, bookId)),
    /** The answers to these reads (all of them when none are named) wait until `release`. */
    holdAnswers: (...names: string[]) => {
      hold = names;
    },
    release: () => {
      hold = null;
      for (const done of waiting.splice(0)) done();
    },
  };
}

test("a read of a kind that is held is asked once and kept: the next read within two seconds makes no request and gets an object of its own", async () => {
  const world = service(() => ({ accounts: [{ code: "1000" }] }));
  const client = world.client();
  const first = await client.read("accounts.list", {});
  (first as { accounts: unknown[] }).accounts.push({ code: "mutated" });
  clock += FRESH_MS - 1;
  const second = await client.read("accounts.list", {});
  expect(world.asked).toEqual(["accounts.list"]);
  expect(second).toEqual({ accounts: [{ code: "1000" }] });
  expect(second).not.toBe(first);
  // Asked with something else, it is another read.
  await client.read("accounts.list", { includeInactive: true } as never);
  expect(world.asked).toHaveLength(2);
  // The same thing asked in another order of its fields is the same read.
  await client.read("journal.list", { a: 1, b: 2 } as never);
  await client.read("journal.list", { b: 2, a: 1 } as never);
  expect(world.asked.filter((name) => name === "journal.list")).toHaveLength(1);
});

test("an answer over two seconds old is given at once, the service is asked again behind it, and the next read has what came", async () => {
  let n = 0;
  const next = () => {
    n += 1;
    return n;
  };
  const world = service(() => ({ n: next() }));
  const client = world.client();
  expect(await client.read("periods.list", {})).toEqual({ n: 1 });
  clock += FRESH_MS + 1;
  world.holdAnswers();
  // The old answer comes back before the service has answered.
  expect(await client.read("periods.list", {})).toEqual({ n: 1 });
  expect(world.asked).toEqual(["periods.list", "periods.list"]);
  // A second read meanwhile does not ask a third time.
  expect(await client.read("periods.list", {})).toEqual({ n: 1 });
  expect(world.asked).toHaveLength(2);
  world.release();
  await settled();
  expect(await client.read("periods.list", {})).toEqual({ n: 2 });
  expect(world.asked).toHaveLength(2);
});

test("an answer over a week old is not given, and a read asks; one a little younger is given at once and checked", async () => {
  let n = 0;
  const next = () => {
    n += 1;
    return n;
  };
  const world = service(() => ({ n: next() }));
  const client = world.client();
  await client.read("periods.list", {});
  clock += MAX_AGE_MS - 1;
  // A little under a week: given at once, with the service asked again behind it.
  expect(await client.read("periods.list", {})).toEqual({ n: 1 });
  await settled();
  expect(world.asked).toHaveLength(2);
  // Over a week since that answer was made: not given, and the read waits for the service.
  clock += MAX_AGE_MS + 1;
  expect(await client.read("periods.list", {})).toEqual({ n: 3 });
});

test("reads reached together share one request, and a read that is abandoned stops waiting without stopping the others", async () => {
  const world = service();
  const client = world.client();
  world.holdAnswers();
  const stop = new AbortController();
  const all = [
    client.read("accounts.list", {}),
    client.read("accounts.list", {}),
    client.read("accounts.list", {}, { signal: stop.signal }),
  ];
  stop.abort();
  await expect(all[2]).rejects.toThrow("could not be read");
  world.release();
  expect(await all[0]).toEqual({ name: "accounts.list", n: 0 });
  expect(await all[1]).toEqual({ name: "accounts.list", n: 0 });
  expect(world.asked).toHaveLength(1);
});

test("any write ends what is held, and an answer that was on its way when the write was made is not kept", async () => {
  let n = 0;
  const next = () => {
    n += 1;
    return n;
  };
  const world = service((name) => (name === "drafts.recover" ? { id: "d" } : { n: next() }));
  const client = world.client();
  await client.read("accounts.list", {});
  expect(await client.read("accounts.list", {})).toEqual({ n: 1 });
  // A read that is on its way when the write goes through: its answer is from before the write, and is not kept.
  world.holdAnswers("periods.list");
  const late = client.read("periods.list", {});
  // The write: a refusal ends what is held as well, for its outcome may be uncertain.
  await client
    .write(
      "drafts.recover",
      { draftId: "d", expectedVersion: 1, postingOperationId: crypto.randomUUID() },
      "w",
    )
    .catch(() => {});
  world.release();
  await late;
  expect(world.asked.filter((name) => name === "accounts.list")).toHaveLength(1);
  expect(await client.read("accounts.list", {})).toEqual({ n: 3 });
  expect(world.asked.filter((name) => name === "accounts.list")).toHaveLength(2);
  const before = world.asked.length;
  await client.read("periods.list", {});
  expect(world.asked.length).toBe(before + 1);
});

test("a read that must not be given what the page holds is not kept either when a change was made while it was on its way", async () => {
  let n = 0;
  const next = () => {
    n += 1;
    return n;
  };
  const world = service((name) => (name === "drafts.recover" ? { id: "d" } : { n: next() }));
  const client = world.client();
  // A fresh read begins, and a write goes through before the service answers it.
  world.holdAnswers("accounts.list");
  const late = client.read("accounts.list", {}, { fresh: true });
  await client
    .write(
      "drafts.recover",
      { draftId: "d", expectedVersion: 1, postingOperationId: crypto.randomUUID() },
      "w",
    )
    .catch(() => {});
  world.release();
  expect(await late).toEqual({ n: 1 });
  // What it said is from before the change: the next read asks, and is not given it.
  expect(await client.read("accounts.list", {})).toEqual({ n: 2 });
  expect(world.asked.filter((name) => name === "accounts.list")).toHaveLength(2);
});

test("a draft that is opened to be edited is never given from what the page holds", async () => {
  let n = 0;
  const next = () => {
    n += 1;
    return n;
  };
  const world = service(() => ({ id: "d", version: next(), status: "draft", data: {} }));
  const client = world.client();
  await client.read("drafts.get", { draftId: "d" });
  expect(await client.read("drafts.get", { draftId: "d" })).toMatchObject({ version: 2 });
  expect(world.asked.filter((name) => name === "drafts.get")).toHaveLength(2);
});

test("the kinds that are not held are asked every time: a calculation made to order, the state of a job", async () => {
  const world = service();
  const client = world.client();
  for (const name of ["backup.status", "reports.export", "rules.test"] as const) {
    await client.read(name, {} as never);
    await client.read(name, {} as never);
  }
  expect(world.asked).toHaveLength(6);
});

test("an asking again that fails lets go of what was held: the next read asks, and fails in its own words", async () => {
  let up = true;
  const asked: string[] = [];
  const fetcher = (async (url: string) => {
    asked.push(String(url));
    if (!up) throw new Error("offline");
    return answer({ n: 1 });
  }) as ApplicationFetch;
  const client = loose(new BrowserApplicationClient(storage(), fetcher));
  await client.read("periods.list", {});
  clock += FRESH_MS + 1;
  up = false;
  expect(await client.read("periods.list", {})).toEqual({ n: 1 });
  await settled();
  await expect(client.read("periods.list", {})).rejects.toThrow("could not be read");
  expect(asked).toHaveLength(3);
});

test("what is held is for one workspace and one book: another's is never shown", async () => {
  const world = service(() => ({ owner: "a" }));
  const client = world.client();
  installAuthorizer({
    authorization: async () => null,
    scope: () => "wsp_a",
    ended: () => {},
  });
  await client.read("accounts.list", {});
  await client.read("accounts.list", {});
  expect(world.asked).toHaveLength(1);
  installAuthorizer({
    authorization: async () => null,
    scope: () => "wsp_b",
    ended: () => {},
  });
  await client.read("accounts.list", {});
  expect(world.asked).toHaveLength(2);
  await world
    .client("another-book")
    .read("accounts.list", {})
    .catch(() => {});
  expect(world.asked).toHaveLength(3);
});

test("what is held is bounded: the least recently used goes first", async () => {
  const world = service();
  const client = world.client();
  for (let i = 0; i < 405; i += 1) await client.read("journal.get", { id: `j${i}` } as never);
  expect(world.asked).toHaveLength(405);
  await client.read("journal.get", { id: "j404" } as never);
  expect(world.asked).toHaveLength(405);
  await client.read("journal.get", { id: "j0" } as never);
  expect(world.asked).toHaveLength(406);
});

test("two values from the service are the same when what is in them is", () => {
  expect(same({ a: [1, { b: "x" }], c: null }, { c: null, a: [1, { b: "x" }] })).toBe(true);
  expect(same([1, 2], [2, 1])).toBe(false);
  expect(same({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  expect(same(new Map([["a", 1]]), new Map([["a", 1]]))).toBe(true);
  expect(same(new Map([["a", 1]]), new Map([["a", 2]]))).toBe(false);
  expect(same(new Date(5), new Date(5))).toBe(true);
  expect(same("1", 1)).toBe(false);
});

// ---- the screens' loaders -----------------------------------------------------------------------------

/** Let what is waiting run: a read goes through several steps, each of which gives way to the others. */
const turns = async (count = 3) => {
  for (let i = 0; i < count; i += 1) await new Promise((done) => setTimeout(done, 1));
};

test("a loader shows what is held at once, while the service is being asked again, and changes what it shows only when the new answer differs", async () => {
  let version = 1;
  const world = service(() => ({ version }));
  const client = world.client();
  await createRoot(async (dispose) => {
    const first = createLoader(() => client.read("periods.list", {}));
    await turns();
    expect(first.value()).toEqual({ version: 1 });
    clock += FRESH_MS + 1;
    version = 2;
    world.holdAnswers();
    const again = createLoader(() => client.read("periods.list", {}));
    await turns();
    // Drawn from what was held, with the service not yet heard from, and not marked as reading.
    expect(again.value()).toEqual({ version: 1 });
    expect(again.loading()).toBe(false);
    const seen: unknown[] = [];
    const shown = again.value();
    world.release();
    await settled();
    await turns(10);
    seen.push(again.value());
    expect(seen[0]).toEqual({ version: 2 });
    expect(shown).toEqual({ version: 1 });
    dispose();
  });
});

test("when the service says what the page held, the loader's value is not replaced: the screen does not redraw", async () => {
  const world = service(() => ({ same: true }));
  const client = world.client();
  await createRoot(async (dispose) => {
    createLoader(() => client.read("periods.list", {}));
    await turns();
    clock += FRESH_MS + 1;
    const again = createLoader(() => client.read("periods.list", {}));
    await turns();
    const shown = again.value();
    expect(shown).toEqual({ same: true });
    await settled();
    await turns(10);
    expect(again.value()).toBe(shown);
    dispose();
  });
});

test("a screen that reads again after a change asks the service, and one that reads again with nothing changed is given what is held", async () => {
  let version = 1;
  const world = service((name) => (name === "drafts.recover" ? { id: "d" } : { version }));
  const client = world.client();
  await createRoot(async (dispose) => {
    const loader = createLoader(() => client.read("periods.list", {}));
    await turns();
    version = 2;
    // Nothing was changed by the page, and what it holds is two seconds old at most: it is as good as a read.
    await loader.reload();
    expect(loader.value()).toEqual({ version: 1 });
    expect(world.asked).toHaveLength(1);
    // The page changes something (a refusal counts, its outcome may be uncertain): what it holds is let go, and the read asks.
    await client
      .write(
        "drafts.recover",
        { draftId: "d", expectedVersion: 1, postingOperationId: crypto.randomUUID() },
        "w",
      )
      .catch(() => {});
    await loader.reload();
    expect(loader.value()).toEqual({ version: 2 });
    expect(world.asked.filter((name) => name === "periods.list")).toHaveLength(2);
    dispose();
  });
});

test("when asking again fails after an old answer was shown, the loader says what went wrong", async () => {
  let up = true;
  const fetcher = (async () => {
    if (!up) throw new Error("offline");
    return answer({ n: 1 });
  }) as ApplicationFetch;
  const client = loose(new BrowserApplicationClient(storage(), fetcher));
  await createRoot(async (dispose) => {
    createLoader(() => client.read("periods.list", {}));
    await turns();
    clock += FRESH_MS + 1;
    up = false;
    const again = createLoader(() => client.read("periods.list", {}));
    await turns();
    expect(again.value()).toEqual({ n: 1 });
    await settled();
    await turns(10);
    expect(again.error()).toBeInstanceOf(Error);
    dispose();
  });
});

test("a loader that was given a value read before the page drew itself reads it again when what is held is found to be different", async () => {
  let version = 1;
  const world = service(() => ({ version }));
  const client = world.client();
  await client.read("periods.list", {});
  clock += FRESH_MS + 1;
  version = 2;
  await createRoot(async (dispose) => {
    // The page read it before it drew itself, and was given what it held.
    const opening = await client.read("periods.list", {});
    const loader = createLoader(() => client.read("periods.list", {}), opening);
    expect(loader.value()).toEqual({ version: 1 });
    await settled();
    await turns(5);
    expect(loader.value()).toEqual({ version: 2 });
    dispose();
  });
});

test("the book's settings are read again when what the page held of the book is found to be different", async () => {
  resetBookSettings();
  let name = "Old Name Co";
  const world = service((operation) =>
    operation === "book.get"
      ? {
          enabled: true,
          bookId: "local-book",
          setup: { name },
          mode: "x",
          permissions: [],
          head: null,
        }
      : {},
  );
  const client = world.client();
  expect(
    (await readBookSettings({ client: client as unknown as BrowserApplicationClient }))?.name,
  ).toBe("Old Name Co");
  clock += FRESH_MS + 1;
  name = "New Name Co";
  // Read again by whatever asks next: given what is held, with the service asked behind it.
  await client.read("book.get", {});
  await settled();
  await turns(5);
  expect(bookSettings().acceptMode).toBeDefined();
  const { businessName } = await import("../../src/book-settings");
  expect(businessName()).toBe("New Name Co");
  resetBookSettings();
});

test("a screen asked to read again from the service lets go of what it read and asks, though the answer it holds is young; the other screens' answers stay", async () => {
  let version = 1;
  const world = service(() => ({ version }));
  const client = world.client();
  await createRoot(async (dispose) => {
    const loader = createLoader(() => client.read("periods.list", {}));
    await turns();
    // Another screen's answer, read when none of the first's was under way.
    await client.read("accounts.list", {});
    version = 2;
    await loader.refresh();
    expect(loader.value()).toEqual({ version: 2 });
    expect(world.asked.filter((name) => name === "periods.list")).toHaveLength(2);
    await client.read("accounts.list", {});
    expect(world.asked.filter((name) => name === "accounts.list")).toHaveLength(1);
    dispose();
  });
});

test("a screen that begins from an answer the page held, and is made after the asking again behind it has found a difference, is brought up to date: nobody was there to be told", async () => {
  let version = 1;
  const world = service(() => ({ version }));
  const client = world.client();
  await client.read("periods.list", {});
  clock += FRESH_MS + 1;
  version = 2;
  // The page's first read is given at once from what it holds, and the service is asked again behind it; the asking finishes (and finds a difference) before any screen exists.
  const given = await client.read("periods.list", {});
  await settled();
  expect(given).toEqual({ version: 1 });
  await createRoot(async (dispose) => {
    // The screen is made from what it was given before the page drew, as the shell and Home are (opening.ts).
    const screen = createLoader(() => client.read("periods.list", {}), given);
    expect(screen.value()).toEqual({ version: 1 });
    await turns(10);
    expect(screen.value()).toEqual({ version: 2 });
    // No request was made for it: what the page holds now is what the asking again found.
    expect(world.asked.filter((name) => name === "periods.list")).toHaveLength(2);
    dispose();
  });
});

test("a screen whose reads were under way when the asking again behind one of them found a difference is brought up to date when they are over", async () => {
  let version = 1;
  const world = service((name) => (name === "periods.list" ? { version } : { name }));
  const client = world.client();
  await client.read("periods.list", {});
  clock += FRESH_MS + 1;
  version = 2;
  await createRoot(async (dispose) => {
    // Two reads in one: the first is given at once from what is held and checked behind; the second takes its time, so the check is over (and has found the difference) before the screen has its value.
    world.holdAnswers("accounts.list");
    const screen = createLoader(async () => {
      const [periods] = await Promise.all([
        client.read("periods.list", {}),
        client.read("accounts.list", {}),
      ]);
      return periods;
    });
    await turns(10);
    expect(world.asked).toContain("accounts.list");
    world.release();
    await turns(10);
    await settled();
    await turns(10);
    expect(screen.value()).toEqual({ version: 2 });
    dispose();
  });
});
