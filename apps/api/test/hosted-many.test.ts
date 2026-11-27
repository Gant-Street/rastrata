// The hosted server with more than one book: the books a signed member token names and the books the control plane's key makes, opened when
// their first request arrives and closed when nobody uses them. The server is real (books in a log on a memory tail and a file bucket); the
// control plane's tokens are told to the front door by a verifier, as in hosted-product.test.ts. See docs/reference/program/hosting/many-books.md.
import { fakeStripe } from "@rastrata/application/testing/fake-stripe";
import { BUNDLE_UPLOAD, bundleOf } from "@rastrata/application/testing/stripe-bundle";
import { buildScenario } from "@rastrata/application/testing/stripe-fixtures";
import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { issueOwnerKey, issueServiceKey, sha256Hex } from "@rastrata/application/agent";
import type { MemberTokenVerdict, MemberTokenVerifier } from "@rastrata/application/member-token";
import { APPLICATION_API_VERSION } from "@rastrata/application/schema";
import {
  BookKeys,
  FileObjectStore,
  HOT_FOLDER,
  type LogTier,
  type ObjectStore,
  ObjectStoreUncertain,
  recordReview,
  reviewCount,
} from "@rastrata/booklog";
import { MemoryLogTier } from "@rastrata/booklog/testing";
import type { BooksSettings } from "../src/hosted-books.ts";
import {
  type HostedServerOptions,
  parseBookStore,
  startHostedApplicationServer,
} from "../src/hosted.ts";

const OWNER_KEY = issueOwnerKey();
const PUBLIC = "https://app.example.test";
const HOST = "app.example.test";
const HOME = "book-1";
const A = "tenant-aaaa";
const B = "tenant-bbbb";
const C = "tenant-cccc";
const USER = (n: number): string => `user_${String(n).padStart(10, "0")}`;
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const book = (name: string) => ({
  name,
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1010", name: "Checking", role: "asset" },
    { code: "3100", name: "Owner draw", role: "equity" },
    { code: "6100", name: "Software", role: "expense" },
  ],
});

const draft = (reference: string) => ({
  data: {
    date: "2026-03-02",
    reference,
    narration: reference,
    lines: [
      { accountId: "6100", debit: "5.00", credit: "" },
      { accountId: "1010", debit: "", credit: "5.00" },
    ],
  },
});
/** The references of the drafts a book holds (the first page: the tests make few). */
const references = (reply: { body: { data: { drafts?: { data?: { reference?: string } }[] } } }) =>
  (reply.body.data.drafts ?? []).map((item) => item.data?.reference);

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

interface Reply {
  readonly status: number;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are inspected loosely
  readonly body: any;
  readonly headers: Headers;
}
async function reply(response: Response): Promise<Reply> {
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, body, headers: response.headers };
}

/** The control plane's tokens as the front door sees them (see hosted-product.test.ts). */
function members() {
  const known = new Map<string, MemberTokenVerdict>();
  let counter = 0;
  const verifier: MemberTokenVerifier = {
    verify: async (token) => known.get(token) ?? { kind: "refused" },
  };
  const issue = (verdict: MemberTokenVerdict): string => {
    const token = `aaaaaaaaaa${String(++counter).padStart(4, "0")}.bbbbbbbbbbbb.cccccccccccc`;
    known.set(token, verdict);
    return token;
  };
  const forUser = (userId: string, bookId: string): string =>
    issue({ kind: "valid", claims: { sub: userId, wid: "wsp_0000000001", bid: bookId } });
  /** The token the control plane makes for an agent key of a person: the person's identity, the key and what it may do. */
  const forAgent = (
    userId: string,
    bookId: string,
    scopes: readonly ("read" | "draft" | "post" | "configure" | "correct" | "close")[],
    keyId = "0123456789abcdef",
  ): string =>
    issue({
      kind: "valid",
      claims: {
        sub: userId,
        wid: "wsp_0000000001",
        bid: bookId,
        agent: { keyId, scopes, name: "Month-end bot", expiresAt: "2027-01-13T12:00:00.000Z" },
      },
    });
  return { verifier, issue, forUser, forAgent };
}

async function many(
  settings: Partial<BooksSettings> = {},
  extra: Partial<HostedServerOptions> & {
    tail?: LogTier;
    /** Called with the folder of the run before the server starts, to put files where an earlier process left them. */
    beforeStart?: (root: string) => void;
    /** The bucket as the server sees it, made from the folder's own (a test that makes the storage misbehave). */
    bulkWith?: (inner: FileObjectStore) => ObjectStore;
    /** The control plane's tokens and key, when this server is the second pod of a service whose first pod is another world: both pods check the same credentials. */
    shared?: { readonly tokens: ReturnType<typeof members>; readonly serviceKey: string };
    /** The number the operation ids of this world's writes begin after (the pods of one service write to the same books, and an operation id is used once). */
    operationBase?: number;
    /** More of the book store's settings, as the environment gives them (a snapshot every few entries). */
    store?: Record<string, string>;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "rastrata-many-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const memory = new MemoryLogTier();
  const { tail, beforeStart, bulkWith, shared, operationBase, store, ...rest } = extra;
  beforeStart?.(root);
  const tokens = shared?.tokens ?? members();
  const serviceKey = shared?.serviceKey ?? issueServiceKey();
  const lines: string[] = [];
  const server = await startHostedApplicationServer({
    config: parseBookStore(`r2log://${HOME}`, {
      RASTRATA_BOOK_BULK: pathToFileURL(join(root, "bucket")).href,
      RASTRATA_BOOK_TAIL: "memory",
      RASTRATA_BOOK_CACHE: join(root, "cache"),
      ...store,
    }),
    port: 0,
    telemetry: false,
    stores: {
      tail: tail ?? memory,
      ...(bulkWith ? { bulk: bulkWith(new FileObjectStore(join(root, "bucket"))) } : {}),
    },
    log: (line) => lines.push(line),
    ownerKey: OWNER_KEY,
    serving: { bind: "0.0.0.0", allowedHosts: [HOST], publicOrigin: PUBLIC },
    web: null,
    agentTokens: false,
    memberTokens: { origin: PUBLIC, verifier: tokens.verifier },
    serviceKeys: [await sha256Hex(serviceKey)],
    books: { settings: { sweepMs: 0, ...settings } },
    ...rest,
  });
  cleanup.push(() => server.stop());
  const base = `http://127.0.0.1:${server.server.port}`;
  const registry = server.books;
  if (!registry) throw new Error("the server has no registry");
  let n = operationBase ?? 1000;
  const call = (
    credential: string,
    name: string,
    input: unknown = {},
    options: { writes?: boolean; book?: string; headers?: Record<string, string> } = {},
  ): Promise<Reply> =>
    fetch(`${base}/v1/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: HOST,
        authorization: `Bearer ${credential}`,
        ...(options.book !== undefined ? { "x-rastrata-book": options.book } : {}),
        ...options.headers,
      },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: "local-book",
        input,
        ...(options.writes ? { operationId: id(++n) } : {}),
      }),
    }).then(reply);
  /** The control plane makes a book by naming it, and puts its first owner in. */
  const provision = (bookId: string, userId: string, role = "owner") =>
    call(
      serviceKey,
      "members.add",
      { userId, email: `${userId}@example.com`, role },
      { writes: true, book: bookId },
    );
  const health = async () =>
    (
      await reply(
        await fetch(`${base}/health`, {
          headers: { host: HOST, authorization: `Bearer ${OWNER_KEY}` },
        }),
      )
    ).body;
  const cacheFiles = (): string[] => {
    const directory = join(root, "cache");
    return existsSync(directory) ? readdirSync(directory).filter((f) => f.endsWith(".sqlite")) : [];
  };
  const grants = (bookId: string): number =>
    memory.records.filter((r) => r.book === bookId && r.op === "grant").length;
  const releases = (bookId: string): number =>
    memory.records.filter((r) => r.book === bookId && r.op === "release").length;
  return {
    server,
    base,
    registry,
    memory,
    root,
    lines,
    serviceKey,
    ...tokens,
    call,
    provision,
    health,
    cacheFiles,
    grants,
    releases,
  };
}
type World = Awaited<ReturnType<typeof many>>;

/** A tenant: the control plane makes the book and its owner, and the owner sets it up. */
async function tenant(world: World, bookId: string, userId: string, name: string) {
  expect((await world.provision(bookId, userId)).status).toBe(200);
  const token = world.forUser(userId, bookId);
  const setup = await world.call(token, "book.setup", book(name), { writes: true });
  expect(setup.status).toBe(200);
  return token;
}

test("the control plane makes a book by naming it, and its owner then works in it with a signed token", async () => {
  const world = await many();
  expect(world.cacheFiles()).toEqual([]);
  const made = await world.provision(A, USER(1));
  expect(made.status).toBe(200);
  expect(made.body.data).toMatchObject({ userId: USER(1), role: "owner" });
  expect(world.cacheFiles()).toEqual([`${A}.sqlite`]);
  const token = world.forUser(USER(1), A);
  const context = await world.call(token, "book.get");
  expect(context.status).toBe(200);
  expect(context.body.data.member).toEqual({ userId: USER(1), role: "owner" });
  expect(context.body.data.setup).toBeNull();
  const setup = await world.call(token, "book.setup", book("Tenant A"), { writes: true });
  expect(setup.status).toBe(200);
  expect((await world.call(token, "book.get")).body.data.setup.name).toBe("Tenant A");
  // The home book was not touched: it is not even open.
  expect((await world.health()).hosted.open).toBe(false);
});

test("every tenant sees its own book and no one else's, and the same person is what each book says they are", async () => {
  const world = await many();
  const a = await tenant(world, A, USER(1), "Tenant A");
  const b = await tenant(world, B, USER(2), "Tenant B");
  expect((await world.call(a, "book.get")).body.data.setup.name).toBe("Tenant A");
  expect((await world.call(b, "book.get")).body.data.setup.name).toBe("Tenant B");
  // A draft in A is not in B.
  const created = await world.call(a, "drafts.create", draft("only-for-a"), { writes: true });
  expect(created.status).toBe(200);
  expect(references(await world.call(a, "drafts.list"))).toEqual(["only-for-a"]);
  expect(references(await world.call(b, "drafts.list"))).toEqual([]);
  // User 1 is the owner of A. In B they are what B's own table makes them: a member of B added by B's control-plane call, with fewer rights.
  expect((await world.provision(B, USER(1), "member")).status).toBe(200);
  const one = world.forUser(USER(1), B);
  const inBAsMember = await world.call(one, "book.get");
  expect(inBAsMember.body.data.member).toEqual({ userId: USER(1), role: "member" });
  expect(inBAsMember.body.data.permissions).toEqual(["read", "draft"]);
  expect((await world.call(a, "book.get")).body.data.permissions).toContain("provision");
});

test("a token reaches the book it names and no other, whatever else the request says", async () => {
  const world = await many();
  const a = await tenant(world, A, USER(1), "Tenant A");
  await tenant(world, B, USER(2), "Tenant B");
  const names = async (extra: { book?: string; headers?: Record<string, string> }) =>
    (await world.call(a, "book.get", {}, extra)).body.data?.setup?.name;
  // A header naming B, a body that names B, a path and a query that name B: the token's book is the only one there is.
  expect(await names({ book: B })).toBe("Tenant A");
  expect(await names({ headers: { "x-rastrata-book": `${B}, ${A}` } })).toBe("Tenant A");
  const body = await fetch(`${world.base}/v1/book.get?book=${B}&bookId=${B}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: HOST,
      authorization: `Bearer ${a}`,
      "x-forwarded-for": "10.0.0.1",
    },
    body: JSON.stringify({
      version: APPLICATION_API_VERSION,
      bookId: B,
      input: { book: B, bookId: B },
    }),
  }).then(reply);
  expect(body.body.data?.setup?.name ?? body.body.error?.code).not.toBe("Tenant B");
  // A good token for a person who is in A but is for B: B's member table does not know them.
  const crossed = await world.call(world.forUser(USER(1), B), "book.get");
  expect(crossed.status).toBe(403);
  expect(crossed.body.error.code).toBe("not_a_member");
});

test("the header that names a book is read for the control plane's key and for no one else", async () => {
  const world = await many();
  await tenant(world, A, USER(1), "Tenant A");
  // The owner key has the home book, whatever the header says; the header does not take it to A.
  const owner = await world.call(OWNER_KEY, "book.setup", book("Home"), { writes: true, book: A });
  expect(owner.status).toBe(200);
  expect((await world.call(OWNER_KEY, "book.get", {}, { book: A })).body.data.setup.name).toBe(
    "Home",
  );
  expect((await world.call(world.forUser(USER(1), A), "book.get")).body.data.setup.name).toBe(
    "Tenant A",
  );
  // The control plane's key without a header has no book to work on.
  const none = await world.call(world.serviceKey, "members.list", {}, {});
  expect(none.status).toBe(400);
  expect(none.body.error).toMatchObject({ code: "book_required", retryable: false });
  // With the home book's own name it works on the home book, and with A's on A.
  const home = await world.call(world.serviceKey, "members.list", {}, { book: HOME });
  expect(home.status).toBe(200);
  expect(home.body.data.members).toEqual([]);
  const inA = await world.call(world.serviceKey, "members.list", {}, { book: A });
  expect(inA.body.data.members.map((m: { userId: string }) => m.userId)).toEqual([USER(1)]);
  // And it can do no more in a book than the four member operations.
  const read = await world.call(world.serviceKey, "book.get", {}, { book: A });
  expect(read.status).toBe(403);
});

test("a name that is not a book's is refused before anything is opened or made", async () => {
  const world = await many();
  const tail = world.memory.records.length;
  const names = [
    "../etc",
    "a/b/c/d/e/f/g",
    "tenant.aaaa",
    "short",
    "x".repeat(65),
    "tenant aaaa",
    "tenänt-aaa",
    "%2e%2e%2fsecret",
    "tenant-aaaa\\x",
    "tenant-aaaa,tenant-bbbb",
  ];
  for (const name of names) {
    const refused = await world.call(world.serviceKey, "members.list", {}, { book: name });
    expect(refused.status, name).toBe(400);
    expect(refused.body.error.code, name).toBe("book_invalid");
  }
  const empty = await world.call(world.serviceKey, "members.list", {}, { book: "" });
  expect(empty.body.error.code).toBe("book_required");
  expect(world.cacheFiles()).toEqual([]);
  expect(world.memory.records.length).toBe(tail);
  expect(world.registry.stats()).toMatchObject({ tracked: 0, counted: 0, open: 0 });
  expect(existsSync(join(world.root, "etc"))).toBe(false);
});

test("a book that many requests ask for at once is opened once", async () => {
  const world = await many({ idleMs: 1 });
  const token = await tenant(world, A, USER(1), "Tenant A");
  await new Promise((done) => setTimeout(done, 5));
  expect(await world.registry.sweep()).toBe(1);
  expect(world.cacheFiles()).toEqual([]);
  const before = world.grants(A);
  const answers = await Promise.all(
    Array.from({ length: 20 }, () => world.call(token, "book.get")),
  );
  expect(answers.map((a) => a.status)).toEqual(Array(20).fill(200));
  expect(world.grants(A) - before).toBe(1);
  expect(world.registry.stats().open).toBe(1);
});

test("a book nobody uses is closed: its lease is given back, its cache is deleted, and it comes back whole", async () => {
  const world = await many({ idleMs: 1 });
  const token = await tenant(world, A, USER(1), "Tenant A");
  const posted = await world.call(token, "drafts.create", draft("kept-across-a-close"), {
    writes: true,
  });
  expect(posted.status).toBe(200);
  expect(world.cacheFiles()).toEqual([`${A}.sqlite`]);
  await new Promise((done) => setTimeout(done, 5));
  expect(await world.registry.sweep()).toBe(1);
  expect(world.cacheFiles()).toEqual([]);
  expect(world.releases(A)).toBeGreaterThanOrEqual(1);
  expect(world.memory.peek(A).head.leaseHolder).toBeNull();
  expect(world.registry.stats()).toMatchObject({ open: 0, counted: 0, tracked: 0 });
  // The next request opens it again from the log, and everything is there.
  const back = await world.call(token, "drafts.list");
  expect(back.status).toBe(200);
  expect(references(back)).toEqual(["kept-across-a-close"]);
  expect(world.cacheFiles()).toEqual([`${A}.sqlite`]);
});

test("a pod that is full closes the book used least recently, and that book loses nothing", async () => {
  const world = await many({ maxBooks: 2 });
  const a = await tenant(world, A, USER(1), "Tenant A");
  await new Promise((done) => setTimeout(done, 3));
  const b = await tenant(world, B, USER(2), "Tenant B");
  await new Promise((done) => setTimeout(done, 3));
  // A is used again, so B is the one that has waited longest.
  expect((await world.call(a, "book.get")).status).toBe(200);
  await new Promise((done) => setTimeout(done, 3));
  const c = await tenant(world, C, USER(3), "Tenant C");
  expect(world.cacheFiles().sort()).toEqual([`${A}.sqlite`, `${C}.sqlite`]);
  expect(world.registry.stats()).toMatchObject({ counted: 2, closed: { room: 1 } });
  // B is read again from the log, and a book had to give way for it.
  const again = await world.call(b, "book.get");
  expect(again.status).toBe(200);
  expect(again.body.data.setup.name).toBe("Tenant B");
  expect(world.cacheFiles().length).toBe(2);
  expect((await world.call(c, "book.get")).body.data.setup.name).toBe("Tenant C");
});

test("one tenant's flood is answered 429 in the application's words, and the others are not slowed", async () => {
  const world = await many({ rate: 5, burst: 5, inflight: 100 });
  const a = await tenant(world, A, USER(1), "Tenant A");
  const b = await tenant(world, B, USER(2), "Tenant B");
  const flood = [];
  for (let i = 0; i < 40; i += 1) flood.push(await world.call(a, "book.get"));
  const refused = flood.filter((r) => r.status === 429);
  expect(refused.length).toBeGreaterThan(20);
  expect(refused[0]?.body).toMatchObject({
    ok: false,
    error: { code: "rate_limited", retryable: true },
  });
  expect(Number(refused[0]?.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  expect(flood.filter((r) => r.status === 200).length).toBeLessThanOrEqual(10);
  // B has an allowance of its own.
  const calm = await world.call(b, "book.get");
  expect(calm.status).toBe(200);
  expect(world.registry.stats().refused.rate).toBeGreaterThan(20);
});

test("a book whose tail fails answers in the application's words, and the other books go on", async () => {
  const memory = new MemoryLogTier();
  let failing: string | null = null;
  const tail: LogTier = new Proxy(memory, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (
          failing !== null &&
          args[0] === failing &&
          ["acquire", "head", "readFrom"].includes(String(property))
        )
          return Promise.reject(new Error("the tail for this book is down"));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const world = await many({}, { tail });
  const a = await tenant(world, A, USER(1), "Tenant A");
  const b = await tenant(world, B, USER(2), "Tenant B");
  await world.registry.sweep();
  await new Promise((done) => setTimeout(done, 2));
  // Close A so that it has to be opened again, with its tail down.
  const slot = await world.registry.acquire(A);
  await slot.slot.evict();
  slot.release();
  failing = A;
  const down = await world.call(a, "book.get");
  expect(down.status).toBeGreaterThanOrEqual(500);
  expect(down.body.error.retryable).toBe(true);
  expect((await world.call(b, "book.get")).status).toBe(200);
  // The book that failed to open left nothing counted against the pod.
  expect(world.registry.stats().counted).toBe(1);
  failing = null;
  expect((await world.call(a, "book.get")).status).toBe(200);
});

test("a book being deleted lets no member in and tells them so, the control plane's key can retire and restore it, and another book is unaffected", async () => {
  const world = await many();
  const a = await tenant(world, A, USER(1), "Tenant A");
  const b = await tenant(world, B, USER(2), "Tenant B");
  expect((await world.provision(A, USER(3), "member")).status).toBe(200);
  const member = world.forUser(USER(3), A);
  expect((await world.call(member, "book.get")).status).toBe(200);

  const retired = await world.call(world.serviceKey, "book.retire", {}, { writes: true, book: A });
  expect(retired.status).toBe(200);
  expect(retired.body.data.retired).toBe(true);
  // The owner and the member are told the same thing, and it is not "you are not a member".
  for (const token of [a, member]) {
    const refused = await world.call(token, "book.get");
    expect(refused.status).toBe(410);
    expect(refused.body.error).toMatchObject({ code: "book_retired", retryable: false });
  }
  // The control plane's key still reads who is in (and that the book is retired), and nothing else is let in by it.
  const listed = await world.call(world.serviceKey, "members.list", {}, { book: A });
  expect(listed.status).toBe(200);
  expect(listed.body.data.members).toHaveLength(2);
  expect(listed.body.data.retiredAt).toBe(retired.body.data.retiredAt);
  expect((await world.call(world.serviceKey, "book.get", {}, { book: A })).status).toBe(403);
  // Another book is as it was, and so is a person who was never in this one.
  expect((await world.call(b, "book.get")).status).toBe(200);
  const stranger = world.forUser(USER(9), A);
  expect((await world.call(stranger, "book.get")).status).toBe(410);

  const restored = await world.call(
    world.serviceKey,
    "book.unretire",
    {},
    { writes: true, book: A },
  );
  expect(restored.body.data).toEqual({ retired: false, retiredAt: null });
  expect((await world.call(a, "book.get")).status).toBe(200);
  expect((await world.call(member, "book.get")).body.data.member).toEqual({
    userId: USER(3),
    role: "member",
  });
  // A person who is not in it is back to being not in it.
  expect((await world.call(stranger, "book.get")).status).toBe(403);
});

test("a book the tail has a mark for is gone: its token and the control plane's key are told 410, nothing recreates it, and another book is unaffected", async () => {
  const world = await many();
  const a = await tenant(world, A, USER(1), "Tenant A");
  const b = await tenant(world, B, USER(2), "Tenant B");
  await world.registry.sweep();
  await new Promise((done) => setTimeout(done, 2));
  // The control plane's side of deleting (the tail Worker's tombstone): the mark is made, and the pod has the book open or lets it go.
  const open = await world.registry.acquire(A);
  await open.slot.evict();
  open.release();
  world.memory.destroy(A);

  const gone = await world.call(a, "book.get");
  expect(gone.status).toBe(410);
  expect(gone.body.error).toMatchObject({ code: "book_deleted", retryable: false });
  expect(JSON.stringify(gone.body)).not.toContain(A);
  // A token issued a moment before, a write, and the control plane's own key (which would put an owner in and so make the book again): all the same answer.
  expect((await world.call(a, "book.setup", book("Again"), { writes: true })).status).toBe(410);
  const recreate = await world.provision(A, USER(9));
  expect(recreate.status).toBe(410);
  expect(recreate.body.error.code).toBe("book_deleted");
  // Nothing is left of it on this pod: no cache file, nothing counted, nothing waiting for a lease; and the other book is as it was.
  expect(world.cacheFiles()).toEqual([`${B}.sqlite`]);
  expect(world.registry.stats().counted).toBe(1);
  expect((await world.call(b, "book.get")).status).toBe(200);
  expect((await world.call(b, "book.get")).body.data.setup.name).toBe("Tenant B");
});

test("the home book goes on as it was: the owner key, a member token for it, and agent tokens refused", async () => {
  const world = await many();
  expect((await world.call(OWNER_KEY, "book.setup", book("Home"), { writes: true })).status).toBe(
    200,
  );
  expect((await world.call(OWNER_KEY, "book.get")).body.data.principal).toEqual({ kind: "owner" });
  const added = await world.call(
    world.serviceKey,
    "members.add",
    { userId: USER(7), email: "seven@example.com", role: "admin" },
    { writes: true, book: HOME },
  );
  expect(added.status).toBe(200);
  const token = world.forUser(USER(7), HOME);
  const seven = await world.call(token, "book.get");
  expect(seven.body.data.member).toEqual({ userId: USER(7), role: "admin" });
  expect(seven.body.data.setup.name).toBe("Home");
  expect(world.registry.stats()).toMatchObject({ tracked: 0, counted: 0 });
  const agent = await world.call(
    "rst_0000000000000000_made-up-token-made-up-token-made-up-to",
    "book.get",
  );
  expect(agent.status).toBe(401);
});

test("the server says how many books it holds and never which", async () => {
  const world = await many();
  await tenant(world, A, USER(1), "Tenant A");
  await tenant(world, B, USER(2), "Tenant B");
  // A stranger reads that the page may offer no connection, and nothing of the load. Agents are offered (as keys, which the control plane exchanges for tokens), so the page is not told otherwise.
  const stranger = (await reply(await fetch(`${world.base}/health`, { headers: { host: HOST } })))
    .body;
  expect(stranger.hosted).toEqual({
    accounts: true,
    backups: false,
    connections: false,
  });
  const health = await world.health();
  expect(health.hosted.books).toEqual({ open: 2, max: 256 });
  // The page offers no bank or Stripe connection: a credential kept for one book would be every book's.
  expect(health.hosted.connections).toBe(false);
  // It takes no agent's token of the book's own, and the page is not told that it takes none: an agent comes with a key the control plane exchanges.
  expect(health.hosted.agents).toBeUndefined();
  expect(JSON.stringify(health)).not.toContain("tenant-");
});

test("the server tells anyone the commit it was built from, which the release pipeline waits for", async () => {
  const world = await many({}, { env: { RASTRATA_REVISION: "fbaf568d" } });
  const stranger = (await reply(await fetch(`${world.base}/health`, { headers: { host: HOST } })))
    .body;
  expect(stranger.revision).toBe("fbaf568d");
  const unbuilt = await many();
  const before = (await reply(await fetch(`${unbuilt.base}/health`, { headers: { host: HOST } })))
    .body;
  expect("revision" in before).toBe(false);
});

test("each tenant exports its own book: the zip holds its words and none of the other's, and the other's token finds no such export", async () => {
  const world = await many();
  const a = await tenant(world, A, USER(1), "Tenant A Export");
  const b = await tenant(world, B, USER(2), "Tenant B Export");
  /** `export.create` is a job: asked again with the same identity until it is done. */
  const exportOf = async (token: string, operationId: string): Promise<string> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const answer = await reply(
        await fetch(`${world.base}/v1/export.create`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            host: HOST,
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            version: APPLICATION_API_VERSION,
            bookId: "local-book",
            operationId,
            input: {},
          }),
        }),
      );
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      if (answer.body.data.state !== "running") return answer.body.data.export.id as string;
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error("the export did not finish");
  };
  const fetchExport = (token: string, exportId: string) =>
    fetch(`${world.base}/v1/exports/${exportId}`, {
      headers: { host: HOST, authorization: `Bearer ${token}` },
    });
  const idA = await exportOf(a, id(1));
  const idB = await exportOf(b, id(2));

  const zipA = await fetchExport(a, idA);
  expect(zipA.status).toBe(200);
  expect(zipA.headers.get("content-type")).toBe("application/zip");
  const unzip = Bun.which("unzip");
  if (unzip) {
    const folder = mkdtempSync(join(tmpdir(), "rastrata-many-zip-"));
    try {
      const files = new Map<string, string>();
      for (const [name, bytes] of [
        [idA, new Uint8Array(await zipA.arrayBuffer())],
        [idB, new Uint8Array(await (await fetchExport(b, idB)).arrayBuffer())],
      ] as const) {
        const archive = join(folder, `${name}.zip`);
        writeFileSync(archive, bytes);
        expect(Bun.spawnSync([unzip, "-tq", archive]).exitCode).toBe(0);
        const book = Bun.spawnSync([unzip, "-p", archive, `${name}/book.json`]).stdout;
        files.set(name, new TextDecoder().decode(book));
      }
      expect(files.get(idA)).toContain("Tenant A Export");
      expect(files.get(idA)).not.toContain("Tenant B Export");
      expect(files.get(idB)).toContain("Tenant B Export");
      expect(files.get(idB)).not.toContain("Tenant A Export");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }
  // An export is the book's own: the other tenant's token, and the control plane's key, do not find it.
  expect((await fetchExport(b, idA)).status).toBe(404);
  expect((await fetchExport(a, idB)).status).toBe(404);
  const asService = await fetch(`${world.base}/v1/exports/${idA}`, {
    headers: { host: HOST, authorization: `Bearer ${world.serviceKey}`, "x-rastrata-book": A },
  });
  expect(asService.status).toBe(403);
  // And a member below an administrator cannot fetch one at all.
  const member = world.forUser(USER(3), A);
  expect((await world.provision(A, USER(3), "member")).status).toBe(200);
  expect((await fetchExport(member, idA)).status).toBe(403);
});

test("stopping the server closes every book: the leases are given back", async () => {
  const world = await many();
  await tenant(world, A, USER(1), "Tenant A");
  await tenant(world, B, USER(2), "Tenant B");
  expect(world.memory.peek(A).head.leaseHolder).not.toBeNull();
  await world.server.stop();
  expect(world.server.clean).toBe(true);
  expect(world.memory.peek(A).head.leaseHolder).toBeNull();
  expect(world.memory.peek(B).head.leaseHolder).toBeNull();
});

/** Two pods of one service, as the cluster runs them: one tail and one bucket between them, and the same credentials. `through` is what the pods call the tail by (a test that counts the questions
 * asked of it). */
/** Whether the book's lease is this pod's now. A pod that hands a request on opens the book behind it, for the day the book comes to it, and holds nothing: the work is the holder's. */
function heldBy(tail: MemoryLogTier, pod: World, book = A): boolean {
  return (tail.peek(book).head.leaseHolder ?? "").endsWith(`:${pod.server.server.port}`);
}

async function twoPods(
  first: Partial<HostedServerOptions> = {},
  second: Partial<HostedServerOptions> = {},
  through: (inner: MemoryLogTier) => LogTier = (inner) => inner,
) {
  const tail = new MemoryLogTier();
  const bucket = mkdtempSync(join(tmpdir(), "rastrata-many-bucket-"));
  cleanup.push(() => rmSync(bucket, { recursive: true, force: true }));
  const store = new FileObjectStore(bucket);
  // The two pods of a test are one process, so one's work (a book opened behind a request it handed on, a log read from its first entry) is time the other's lease is not renewed in: on the
  // runners, at a load of 4, a lease of five seconds lapsed in the middle of a test and the book changed pods. Two real pods are two processes. A test that is about a lease lapsing sets its own.
  const steady = { leaseMs: 20_000 };
  const one = await many({}, { tail: through(tail), bulkWith: () => store, ...steady, ...first });
  const two = await many(
    {},
    {
      tail: through(tail),
      bulkWith: () => store,
      ...steady,
      shared: {
        tokens: {
          verifier: one.verifier,
          issue: one.issue,
          forUser: one.forUser,
          forAgent: one.forAgent,
        },
        serviceKey: one.serviceKey,
      },
      operationBase: 2000,
      ...second,
    },
  );
  return { tail, one, two };
}

// Two pods of one service are two processes with two names, but a name used to be the host, the process and the
// millisecond it started: two servers made by one process in the same millisecond (these tests, on a fast runner)
// had the same name, the second took the first's lease for its own ("the holder is this process"), handed nothing
// on, and refused the book after the lease wait. The clock is held still here so that both start in one instant.
test("two servers that start in the same instant are still two holders: the second hands a request to the first", async () => {
  const clock = Date.now;
  const instant = clock();
  Date.now = () => instant;
  let pods: Awaited<ReturnType<typeof twoPods>>;
  try {
    pods = await twoPods();
  } finally {
    Date.now = clock;
  }
  const { tail, one, two } = pods;
  const owner = await tenant(one, A, USER(1), "Tenant A");
  expect((await one.call(owner, "drafts.create", draft("before"), { writes: true })).status).toBe(
    200,
  );
  const holder = tail.peek(A).head.leaseHolder;
  const listed = await two.call(two.forUser(USER(1), A), "drafts.list");
  expect(
    listed.status,
    JSON.stringify({ body: listed.body, peers: (await two.health()).hosted.peers }),
  ).toBe(200);
  expect(references(listed)).toEqual(["before"]);
  expect((await two.health()).hosted.peers.forwarded).toBe(1);
  expect(tail.peek(A).head.leaseHolder).toBe(holder);
});

test("a pod that is asked for a tenant's book that the other pod holds hands the request to it: the answer is the holder's, at once, and the book stays where it was", async () => {
  const { tail, one, two } = await twoPods();
  const owner = await tenant(one, A, USER(1), "Tenant A");
  expect((await one.call(owner, "drafts.create", draft("before"), { writes: true })).status).toBe(
    200,
  );
  const holder = tail.peek(A).head.leaseHolder;
  // The lease says where the book is served.
  expect(holder).toMatch(/\.[0-9]+@[0-9]{1,3}(\.[0-9]{1,3}){3}:[0-9]+$/);

  const started = performance.now();
  const listed = await two.call(two.forUser(USER(1), A), "drafts.list");
  // A refusal says what the second pod tried (the runners, at a load of 8, have seen one).
  expect(
    listed.status,
    JSON.stringify({ body: listed.body, peers: (await two.health()).hosted.peers }),
  ).toBe(200);
  expect(references(listed)).toEqual(["before"]);
  // Not waited for, not taken: asked of the pod that has it.
  expect(performance.now() - started).toBeLessThan(500);
  expect(tail.peek(A).head.leaseHolder).toBe(holder);

  // A write through the second pod is done once, by the first, and the second holds nothing.
  const wrote = await two.call(
    two.forUser(USER(1), A),
    "drafts.create",
    draft("through the other"),
    {
      writes: true,
    },
  );
  expect(wrote.status).toBe(200);
  expect(references(await one.call(owner, "drafts.list")).sort()).toEqual([
    "before",
    "through the other",
  ]);
  expect(tail.peek(A).head.leaseHolder).toBe(holder);
  expect(heldBy(tail, two)).toBe(false);
  // The owner is told how many were handed on.
  expect((await two.health()).hosted.peers).toEqual({
    forwarded: 2,
    unreachable: 0,
    refused: 0,
    unanswered: 0,
    lastFailure: null,
  });
  expect((await one.health()).hosted.peers).toEqual({
    forwarded: 0,
    unreachable: 0,
    refused: 0,
    unanswered: 0,
    lastFailure: null,
  });
});

test("a pod that has just found which pod holds a book hands the next requests on without asking the tail who holds it, until it has not heard from that pod for a moment", async () => {
  let acquires = 0;
  const { one, two } = await twoPods({}, {}, (inner) => ({
    capabilities: inner.capabilities,
    head: (book) => inner.head(book),
    readFrom: (book, seq, limit) => inner.readFrom(book, seq, limit),
    acquire: (book, holder, ttl) => {
      acquires += 1;
      return inner.acquire(book, holder, ttl);
    },
    renew: (book, lease, ttl) => inner.renew(book, lease, ttl),
    release: (book, lease) => inner.release(book, lease),
    seal: (book, input) => inner.seal(book, input),
    append: (book, input) => inner.append(book, input),
  }));
  const owner = await tenant(one, A, USER(1), "Tenant A");
  expect((await one.call(owner, "drafts.create", draft("before"), { writes: true })).status).toBe(
    200,
  );
  const token = two.forUser(USER(1), A);
  acquires = 0;
  for (let n = 0; n < 6; n += 1) {
    const listed = await two.call(token, "drafts.list");
    expect(
      listed.status,
      JSON.stringify({ n, body: listed.body, peers: (await two.health()).hosted.peers }),
    ).toBe(200);
    expect(references(listed)).toEqual(["before"]);
  }
  // The first request asked the tail and was refused; the five after it were handed on at once.
  expect(acquires).toBe(1);
  expect((await two.health()).hosted.peers.forwarded).toBe(6);
  // A moment later the pod asks again, because the other pod may have let the book go.
  await Bun.sleep(1200);
  expect((await two.call(token, "drafts.list")).status).toBe(200);
  expect(acquires).toBe(2);
});

test("a pod hands a request on only after it has checked the credential itself, and a request that was handed on is not handed on again", async () => {
  const { tail, one, two } = await twoPods({}, { leaseWaitMs: 300 });
  await tenant(one, A, USER(1), "Tenant A");
  const holder = tail.peek(A).head.leaseHolder;
  // A token the control plane never made is turned away by the pod that is asked, which has nothing to hand on.
  expect((await two.call("aaaaaaaaaa9999.bbbbbbbbbbbb.cccccccccccc", "drafts.list")).status).toBe(
    401,
  );
  expect((await two.health()).hosted.peers.forwarded).toBe(0);
  // A request that says it was handed on is answered where it is: the pod does not send it round again, and the book is busy.
  const again = await two.call(two.forUser(USER(1), A), "drafts.list", undefined, {
    headers: { "x-rastrata-forwarded": "somebody" },
  });
  expect(again.status).toBe(503);
  expect(again.body.error.code).toBe("book_busy");
  expect((await two.health()).hosted.peers.forwarded).toBe(0);
  expect(tail.peek(A).head.leaseHolder).toBe(holder);
});

test("a credential is not sent to an address that only says it holds the book: it has to be a pod of the service, and the holder the lease names", async () => {
  const { tail, one, two } = await twoPods({}, { leaseWaitMs: 1200 });
  await tenant(one, A, USER(1), "Tenant A");
  await one.server.stop();
  // Something that is not a pod of the service answers where a dead pod was, and the lease (written by anyone who has the tail's token) names it.
  const heard: { path: string; authorization: string | null }[] = [];
  const impostor = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      heard.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
      });
      return Response.json({ holder: "impostor#1#x", mac: "not-a-mac" });
    },
  });
  cleanup.push(() => impostor.stop(true));
  const granted = await tail.acquire(A, `impostor#1#x.1@127.0.0.1:${impostor.port}`, 30_000);
  expect(granted.ok).toBe(true);

  const answer = await two.call(two.forUser(USER(1), A), "drafts.list");
  expect(answer.status).toBe(503);
  expect(answer.body.error.code).toBe("book_busy");
  // It was asked who it was, and nothing else: no request, and no credential.
  expect(heard.map((h) => h.path)).toEqual(["/_peer"]);
  expect(heard.every((h) => h.authorization === null)).toBe(true);
  expect((await two.health()).hosted.peers).toMatchObject({
    forwarded: 0,
    unreachable: 0,
    refused: 1,
  });
});

test("when the pod that holds the book does not answer, the book is waited for and taken when its lease lapses", async () => {
  // Leases of a second, and a book that lets its lease go a moment after its last request.
  const { tail, two } = await twoPods({}, { leaseMs: 1000, idleReleaseMs: 150 });
  const owner = await tenant(two, A, USER(1), "Tenant A");
  expect((await two.call(owner, "drafts.create", draft("before"), { writes: true })).status).toBe(
    200,
  );
  await Bun.sleep(600);
  expect(tail.peek(A).head.leaseHolder).toBeNull();
  // The lease of a pod that is gone: a name with an address where nothing listens.
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = closed.port;
  await closed.stop(true);
  const granted = await tail.acquire(A, `ghost#1#x.1@127.0.0.1:${port}`, 1000);
  expect(granted.ok).toBe(true);

  const started = performance.now();
  const answer = await two.call(owner, "drafts.list");
  const waited = performance.now() - started;
  expect(answer.status).toBe(200);
  expect(references(answer)).toEqual(["before"]);
  // It waited for the lease to lapse, which is about a second, and then held the book itself.
  expect(waited).toBeGreaterThan(500);
  expect(waited).toBeLessThan(2500);
  expect(tail.peek(A).head.leaseHolder).not.toBeNull();
  expect(tail.peek(A).head.leaseHolder).not.toMatch(/^ghost/);
  expect((await two.health()).hosted.peers).toMatchObject({ forwarded: 0, refused: 0 });
});

test("a pod that has a book open and let go of its lease reads what the other pod wrote meanwhile, however long it keeps the book open", async () => {
  // Each pod lets its lease go a moment after its last request (a minute, on the live service) and neither closes the book: a pod keeps one for hours, so that a person who
  // comes back finds it open. The Service sends a request to either pod, so the book is open in both, and what one writes the other must read.
  const lapsing = { leaseMs: 1000, idleReleaseMs: 150 };
  const { tail, one, two } = await twoPods(lapsing, lapsing);
  const owner = await tenant(one, A, USER(1), "Tenant A");
  expect((await one.call(owner, "drafts.create", draft("first"), { writes: true })).status).toBe(
    200,
  );
  await Bun.sleep(600);
  expect(tail.peek(A).head.leaseHolder).toBeNull();
  // The other pod takes the book from its log, and writes.
  const viaTwo = two.forUser(USER(1), A);
  expect((await two.call(viaTwo, "drafts.create", draft("second"), { writes: true })).status).toBe(
    200,
  );
  await Bun.sleep(600);
  expect(tail.peek(A).head.leaseHolder).toBeNull();
  // The first pod still has the book open from before, and answers with both, without opening it again.
  expect((await one.health()).hosted.books.open).toBe(1);
  const answer = await one.call(owner, "drafts.list");
  expect(answer.status).toBe(200);
  expect(references(answer).sort()).toEqual(["first", "second"]);
  expect((await one.health()).hosted.books.open).toBe(1);
  // And the other way round.
  expect((await one.call(owner, "drafts.create", draft("third"), { writes: true })).status).toBe(
    200,
  );
  await Bun.sleep(600);
  expect(references(await two.call(viaTwo, "drafts.list")).sort()).toEqual([
    "first",
    "second",
    "third",
  ]);
});

/** `export.create` is a job: asked again, with the same identity, until it is done. Each ask goes to the next pod, as the Service sends one. */
async function exportThrough(
  pods: readonly { readonly pod: World; readonly credential: string }[],
  operationId: string,
): Promise<string> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { pod, credential } = pods[attempt % pods.length] as (typeof pods)[number];
    const answer = await reply(
      await fetch(`${pod.base}/v1/export.create`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: HOST,
          authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: "local-book",
          operationId,
          input: {},
        }),
      }),
    );
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    if (answer.body.data.state !== "running") return answer.body.data.export.id as string;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error("the export did not finish");
}

test("an export is made and fetched through the pod that does not hold the book: the job and the file are the holder's, and either pod gives the same zip", async () => {
  const { tail, one, two } = await twoPods();
  const owner = await tenant(one, A, USER(1), "Tenant A Export");
  expect((await one.call(owner, "drafts.create", draft("kept"), { writes: true })).status).toBe(
    200,
  );
  const viaTwo = two.forUser(USER(1), A);
  // The asks alternate between the pods, as the Service's would: a job started through one is finished through the other.
  const exportId = await exportThrough(
    [
      { pod: two, credential: viaTwo },
      { pod: one, credential: owner },
    ],
    id(77),
  );
  const fetchFrom = async (pod: World, credential: string) => {
    const answer = await fetch(`${pod.base}/v1/exports/${exportId}`, {
      headers: { host: HOST, authorization: `Bearer ${credential}` },
    });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/zip");
    return new Uint8Array(await answer.arrayBuffer());
  };
  const throughTwo = await fetchFrom(two, viaTwo);
  const throughOne = await fetchFrom(one, owner);
  // The same bytes whichever pod was asked, and a zip that checks.
  expect(throughTwo.length).toBeGreaterThan(1000);
  expect(throughTwo).toEqual(throughOne);
  const unzip = Bun.which("unzip");
  if (unzip) {
    const folder = mkdtempSync(join(tmpdir(), "rastrata-pods-zip-"));
    try {
      const archive = join(folder, "export.zip");
      writeFileSync(archive, throughTwo);
      expect(Bun.spawnSync([unzip, "-tq", archive]).exitCode).toBe(0);
      const listed = new TextDecoder().decode(Bun.spawnSync([unzip, "-Z1", archive]).stdout);
      for (const name of [
        "journals.jsonl",
        "commands.jsonl",
        "manifest.json",
        "records-changes.json",
        "records-rules.json",
      ])
        expect(listed, name).toContain(`${exportId}/${name}`);
      const book = Bun.spawnSync([unzip, "-p", archive, `${exportId}/book.json`]).stdout;
      expect(new TextDecoder().decode(book)).toContain("Tenant A Export");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }
  // The pod that does not hold the book never held it, and told the owner how many it handed on.
  expect(heldBy(tail, two)).toBe(false);
  expect((await two.health()).hosted.peers.forwarded).toBeGreaterThanOrEqual(2);
  expect((await two.health()).hosted.peers).toMatchObject({ unreachable: 0, refused: 0 });
});

test("a statement file uploaded to the pod that does not hold the book arrives whole in the holder's book: the receipt is the file's, the same file from the holder gives the same receipt, and either pod reads it", async () => {
  const { tail, one, two } = await twoPods();
  const owner = await tenant(one, A, USER(1), "Tenant A Statements");
  const viaTwo = two.forUser(USER(1), A);
  // A statement of 100,000 lines, about 4.5 MiB: a body that is not a single read of a socket.
  const lines = ["Date,Description,Amount"];
  for (let index = 0; index < 100_000; index += 1)
    lines.push(
      `2026-03-${String(1 + (index % 28)).padStart(2, "0")},VENDOR NUMBER ${index},-${(index % 900) + 1}.00`,
    );
  const csv = `${lines.join("\n")}\n`;
  const expected = new Bun.CryptoHasher("sha256").update(csv).digest("hex");
  const upload = (pod: World, credential: string, body: string, type = "text/csv") =>
    fetch(`${pod.base}/v1/uploads`, {
      method: "POST",
      headers: {
        host: HOST,
        authorization: `Bearer ${credential}`,
        "content-type": type,
        "x-upload-name": "march%20statement.csv",
      },
      body,
    }).then(reply);
  const first = await upload(two, viaTwo, csv);
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body.data).toMatchObject({
    sha256: expected,
    size: Buffer.byteLength(csv),
    mediaType: "text/csv",
    name: "march statement.csv",
  });
  // The file is addressed by what it holds: the holder's receipt for the same bytes is the same.
  const again = await upload(one, owner, csv);
  expect(again.body.data.sha256).toBe(expected);
  // Either pod reads it back: it is in the holder's book, not in the pod that took the request.
  const readThrough = (pod: World, credential: string) =>
    pod.call(credential, "import.preview", { sha256: expected, ledgerAccountId: "1010" });
  const seenByTwo = await readThrough(two, viaTwo);
  const seenByOne = await readThrough(one, owner);
  expect(seenByTwo.status, JSON.stringify(seenByTwo.body).slice(0, 400)).toBe(seenByOne.status);
  expect(seenByTwo.body).toEqual(seenByOne.body);
  // A refusal is the holder's too, in its words: a file that cannot be a statement is turned away with the status it would give.
  const refused = await upload(two, viaTwo, "{}", "application/json");
  expect(refused.status).toBe(415);
  expect(refused.body.error.code).toBe("media_type_unsupported");
  // And a file over the limit is turned away without the pod that took it holding the book.
  const tooLarge = await upload(two, viaTwo, "x".repeat(16 * 1024 * 1024 + 1));
  expect(tooLarge.status).toBe(413);
  expect(heldBy(tail, two)).toBe(false);
  expect((await two.health()).hosted.peers).toMatchObject({ unreachable: 0, refused: 0 });
});

test("Stripe is pulled through both pods: the answers are uploaded to the holder of the book, the holder books the payouts, and the pod that does not hold the book never opens it", async () => {
  const { tail, one, two } = await twoPods();
  expect((await one.provision(A, USER(1))).status).toBe(200);
  const owner = one.forUser(USER(1), A);
  const roleKeyed = (code: string, name: string, role: string, roleKey?: string) => ({
    code,
    name,
    role,
    ...(roleKey ? { tags: { roleKey } } : {}),
  });
  const setup = await one.call(
    owner,
    "book.setup",
    {
      name: "Tenant A Stripe",
      currency: "USD",
      fiscalYear: 2026,
      periodModel: "monthly",
      accounts: [
        roleKeyed("1000", "Checking", "asset"),
        roleKeyed("1100", "Stripe balance", "asset", "stripe.balance"),
        roleKeyed("1110", "Stripe payouts in transit", "asset", "payouts.in-transit"),
        roleKeyed("2500", "Sales tax payable", "liability", "tax.sales"),
        roleKeyed("3000", "Owner's equity", "equity"),
        roleKeyed("4000", "Sales", "income", "revenue.sales"),
        roleKeyed("4100", "Returns and allowances", "income", "refunds"),
        roleKeyed("6025", "Stripe fees", "expense", "stripe.fees"),
        roleKeyed("6026", "Chargebacks and disputes", "expense", "chargebacks"),
      ],
    },
    { writes: true },
  );
  expect(setup.status, JSON.stringify(setup.body)).toBe(200);
  const configured = await one.call(
    owner,
    "stripe.configure",
    { timeZone: "America/Denver" },
    { writes: true },
  );
  expect(configured.body.data.ready).toBe(true);

  const stripeKey = `${"rk_"}live_PodsRehearsalKey0123456789`;
  const stripe = fakeStripe(buildScenario(), {
    key: stripeKey,
    now: () => Math.floor(Date.now() / 1000),
  });
  const pods = [
    { pod: two, credential: two.forUser(USER(1), A) },
    { pod: one, credential: owner },
  ];
  /** A book is allowed some thirty requests a second: a sender that is told to slow down waits and asks again, as the command does. */
  const patiently = async <T extends { status: number }>(ask: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const answered = await ask();
      if (answered.status !== 429) return answered;
      await new Promise((done) => setTimeout(done, 40));
    }
    throw new Error("the book kept limiting requests");
  };
  const uploadVia = async (at: (typeof pods)[number], bytes: Uint8Array) =>
    patiently(async () =>
      reply(
        await fetch(`${at.pod.base}/v1/uploads`, {
          method: "POST",
          headers: { host: HOST, authorization: `Bearer ${at.credential}`, ...BUNDLE_UPLOAD },
          body: bytes as unknown as BodyInit,
        }),
      ),
    );
  /** A pull as the command makes it, each round to the other pod: the call, and the uploads of the answers it asked for. */
  const pullThroughBoth = async (asOf: string) => {
    let bundle: string[] = [];
    for (let rounds = 1; rounds < 80; rounds += 1) {
      const at = pods[rounds % 2] as (typeof pods)[number];
      const answered = await patiently(() =>
        at.pod.call(at.credential, "stripe.receive", { asOf, bundles: bundle }, { writes: true }),
      );
      expect(answered.status, JSON.stringify(answered.body)).toBe(200);
      const { needs, more } = answered.body.data as { needs: string[]; more: boolean };
      if (needs.length === 0 && !more) return { rounds, last: answered.body.data };
      const answers = [];
      for (const need of needs) {
        const fetched = await stripe.fetch(new URL(need, "https://api.stripe.com"), {
          method: "GET",
          headers: { authorization: `Bearer ${stripeKey}` },
        });
        answers.push({
          request: need,
          status: fetched.status,
          body: new Uint8Array(await fetched.arrayBuffer()),
        });
      }
      // The bundle goes to the other pod than the call that will read it.
      const other = pods[(rounds + 1) % 2] as (typeof pods)[number];
      const stored = await uploadVia(other, bundleOf(answers));
      expect(stored.status, JSON.stringify(stored.body)).toBe(200);
      bundle = [stored.body.data.sha256 as string];
    }
    throw new Error("the pull did not finish");
  };
  const first = await pullThroughBoth(new Date(Math.floor(Date.now() / 1000) * 1000).toISOString());
  const rounds = first.rounds;
  // The book is the holder's: either pod says six payouts are booked, and the pod that never held it never opened it.
  const fromOne = await one.call(owner, "stripe.status", {});
  const fromTwo = await two.call(pods[0]?.credential as string, "stripe.status", {});
  expect(fromOne.body.data.payouts).toMatchObject({ known: 6, booked: 6, mismatched: 0 });
  expect(fromTwo.body.data.payouts).toEqual(fromOne.body.data.payouts);
  expect(fromOne.body.data.fetchedBy).toBe("sender");
  expect(heldBy(tail, two)).toBe(false);
  expect((await two.health()).hosted.peers.forwarded).toBeGreaterThanOrEqual(rounds);
  expect((await two.health()).hosted.peers).toMatchObject({ unreachable: 0, refused: 0 });
  // Stripe saw only reads with the sender's key.
  expect(stripe.seen.every((seen) => seen.method === "GET" && seen.authorised)).toBe(true);
  // And the same pull again, a little later, brings nothing new.
  const second = await pullThroughBoth(
    new Date(Math.floor(Date.now() / 1000) * 1000 + 60_000).toISOString(),
  );
  expect(second.last.run).toMatchObject({ newLines: 0, payouts: 0 });
  expect((await one.call(owner, "stripe.status", {})).body.data.payouts).toMatchObject({
    known: 6,
    booked: 6,
  });
});

test("the control plane's key tells a book which Stripe account the owner connected, delivers the answers read from it and reads the reply, through either pod, and can draft nothing else", async () => {
  const { tail, one, two } = await twoPods();
  expect((await one.provision(A, USER(1))).status).toBe(200);
  const owner = one.forUser(USER(1), A);
  const roleKeyed = (code: string, name: string, role: string, roleKey?: string) => ({
    code,
    name,
    role,
    ...(roleKey ? { tags: { roleKey } } : {}),
  });
  const setup = await one.call(
    owner,
    "book.setup",
    {
      name: "Tenant A Stripe",
      currency: "USD",
      fiscalYear: 2026,
      periodModel: "monthly",
      accounts: [
        roleKeyed("1000", "Checking", "asset"),
        roleKeyed("1100", "Stripe balance", "asset", "stripe.balance"),
        roleKeyed("1110", "Stripe payouts in transit", "asset", "payouts.in-transit"),
        roleKeyed("2500", "Sales tax payable", "liability", "tax.sales"),
        roleKeyed("3000", "Owner's equity", "equity"),
        roleKeyed("4000", "Sales", "income", "revenue.sales"),
        roleKeyed("4100", "Returns and allowances", "income", "refunds"),
        roleKeyed("6025", "Stripe fees", "expense", "stripe.fees"),
        roleKeyed("6026", "Chargebacks and disputes", "expense", "chargebacks"),
      ],
    },
    { writes: true },
  );
  expect(setup.status, JSON.stringify(setup.body)).toBe(200);
  expect(
    (await one.call(owner, "stripe.configure", { timeZone: "America/Denver" }, { writes: true }))
      .body.data.ready,
  ).toBe(true);

  const key = one.serviceKey;
  // The owner cannot say which account was connected: only the control plane's key can.
  const byOwner = await one.call(
    owner,
    "stripe.link",
    { account: { id: "acct_1FixtureAccount0001", livemode: true } },
    { writes: true },
  );
  expect(byOwner.body.error.code).toBe("service_only");
  // The control plane's key can, through the pod that does not hold the book.
  const linked = await two.call(
    key,
    "stripe.link",
    { account: { id: "acct_1FixtureAccount0001", livemode: true } },
    { writes: true, book: A },
  );
  expect(linked.status, JSON.stringify(linked.body)).toBe(200);
  expect(linked.body.data).toEqual({ linked: true, reason: null });
  expect((await one.call(owner, "stripe.status", {})).body.data.link).toMatchObject({
    accountId: "acct_1FixtureAccount0001",
    livemode: true,
  });
  // It uploads a bundle for Stripe, to either pod, with the book named in the header, and delivers it.
  const upload = (pod: typeof one) =>
    fetch(`${pod.base}/v1/uploads`, {
      method: "POST",
      headers: {
        host: HOST,
        authorization: `Bearer ${key}`,
        "x-rastrata-book": A,
        ...BUNDLE_UPLOAD,
      },
      body: bundleOf([]) as unknown as BodyInit,
    }).then(reply);
  const stored = await upload(one);
  expect(stored.status, JSON.stringify(stored.body)).toBe(200);
  const sha = stored.body.data.sha256 as string;
  expect((await upload(two)).body.data.sha256).toBe(sha);
  const asOf = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  const received = await one.call(
    key,
    "stripe.receive",
    { asOf, bundles: [sha], livemode: true },
    { writes: true, book: A },
  );
  expect(received.status, JSON.stringify(received.body)).toBe(200);
  expect(received.body.data.needs).toContain("/v1/account");
  expect(received.body.data.apiVersion).toMatch(/^[0-9]{4}-/);
  // And it is no more than that: it cannot sync, choose accounts, or upload a statement.
  for (const [name, input] of [
    ["stripe.sync", {}],
    ["stripe.configure", {}],
    ["stripe.payouts", {}],
  ] as const) {
    const refused = await one.call(key, name, input, { writes: true, book: A });
    expect(refused.status, name).toBe(403);
  }
  const statement = await fetch(`${one.base}/v1/uploads`, {
    method: "POST",
    headers: {
      host: HOST,
      authorization: `Bearer ${key}`,
      "x-rastrata-book": A,
      "content-type": "text/csv",
    },
    body: "date,amount\n2026-01-01,1.00\n",
  }).then(reply);
  expect(statement.status).toBe(403);
  expect(heldBy(tail, two)).toBe(false);
});

test("with forwarding off, a pod that starts beside the one it replaces waits for a tenant's book, and has it, whole, when the old pod stops", async () => {
  const { tail, one, two } = await twoPods({ peers: false }, { peers: false });
  const owner = await tenant(one, A, USER(1), "Tenant A");
  expect((await one.call(owner, "drafts.create", draft("before"), { writes: true })).status).toBe(
    200,
  );
  const holder = tail.peek(A).head.leaseHolder;
  expect(holder).not.toBeNull();

  let answered: number | null = null;
  const asking = two.call(two.forUser(USER(1), A), "drafts.list").then((result) => {
    answered = result.status;
    return result;
  });
  await Bun.sleep(500);
  // Still waiting: it was not turned away, and it did not take a book that is held.
  expect(answered).toBeNull();
  expect(tail.peek(A).head.leaseHolder).toBe(holder);

  await one.server.stop();
  const listed = await asking;
  expect(listed.status).toBe(200);
  // The new pod holds the book now, and what the old one wrote is in it.
  expect(tail.peek(A).head.leaseHolder).not.toBe(holder);
  expect(tail.peek(A).head.leaseHolder).not.toBeNull();
  expect(references(listed)).toEqual(["before"]);
});

test("the server will not start to serve many books on a footing that would let one book open another or open books for nobody", async () => {
  const root = mkdtempSync(join(tmpdir(), "rastrata-many-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const tokens = members();
  const attempt = (extra: Partial<HostedServerOptions>) =>
    startHostedApplicationServer({
      config: parseBookStore(`r2log://${HOME}`, {
        RASTRATA_BOOK_BULK: pathToFileURL(join(root, "bucket")).href,
        RASTRATA_BOOK_TAIL: "memory",
        RASTRATA_BOOK_CACHE: join(root, "cache"),
      }),
      port: 0,
      telemetry: false,
      stores: { tail: new MemoryLogTier() },
      books: {},
      web: null,
      ...extra,
    });
  const locked = {
    ownerKey: OWNER_KEY,
    serving: { bind: "0.0.0.0", allowedHosts: [HOST], publicOrigin: PUBLIC },
    memberTokens: { origin: PUBLIC, verifier: tokens.verifier },
    agentTokens: false,
  } as const;
  const { ownerKey: _ownerKey, serving: _serving, ...unlocked } = locked;
  await expect(attempt(unlocked)).rejects.toThrow(/owner key/);
  const { memberTokens: _memberTokens, ...withoutTokens } = locked;
  await expect(attempt(withoutTokens)).rejects.toThrow(/member tokens/);
  await expect(attempt({ ...locked, agentTokens: true })).rejects.toThrow(/agent tokens/);
  const { agentTokens: _agentTokens, ...withDefault } = locked;
  await expect(attempt(withDefault)).rejects.toThrow(/agent tokens/);
  await expect(attempt({ ...locked, standby: true })).rejects.toThrow(/standby/);
  await expect(attempt({ ...locked, control: true })).rejects.toThrow(/standby or the experiment/);
});

test("a server for one book is what it was: a signed token for another book is refused, and so is a book named by the control plane's key", async () => {
  const root = mkdtempSync(join(tmpdir(), "rastrata-one-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const tokens = members();
  const serviceKey = issueServiceKey();
  const server = await startHostedApplicationServer({
    config: parseBookStore(`r2log://${HOME}`, {
      RASTRATA_BOOK_BULK: pathToFileURL(join(root, "bucket")).href,
      RASTRATA_BOOK_TAIL: "memory",
      RASTRATA_BOOK_CACHE: join(root, "cache"),
    }),
    port: 0,
    telemetry: false,
    stores: { tail: new MemoryLogTier() },
    ownerKey: OWNER_KEY,
    serving: { bind: "0.0.0.0", allowedHosts: [HOST], publicOrigin: PUBLIC },
    web: null,
    agentTokens: false,
    memberTokens: { origin: PUBLIC, verifier: tokens.verifier },
    serviceKeys: [await sha256Hex(serviceKey)],
  });
  cleanup.push(() => server.stop());
  const base = `http://127.0.0.1:${server.server.port}`;
  const send = (credential: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/v1/members.list`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: HOST,
        authorization: `Bearer ${credential}`,
        ...headers,
      },
      body: JSON.stringify({ version: APPLICATION_API_VERSION, bookId: "local-book", input: {} }),
    }).then(reply);
  expect(server.books).toBeNull();
  expect((await send(tokens.forUser(USER(1), A))).body.error.code).toBe("book_scope_mismatch");
  // The control plane's key with no header works on the one book; with a header naming another it is told this server does not serve it.
  expect((await send(serviceKey)).status).toBe(200);
  const other = await send(serviceKey, { "x-rastrata-book": A });
  expect(other.status).toBe(403);
  expect(other.body.error.code).toBe("book_scope_mismatch");
  expect((await send(serviceKey, { "x-rastrata-book": HOME })).status).toBe(200);
  expect(existsSync(join(root, "cache", `${A}.sqlite`))).toBe(false);
});

test("a restarted process removes the caches of the books the last one held, and touches nothing that is not a book's cache", async () => {
  const removed = [`${A}.sqlite`, `${A}.sqlite-wal`, `${B}.sqlite-shm`];
  const kept = [
    "notes.txt",
    "x.sqlite",
    "a.b.sqlite",
    `${A}.sqlite.keep`,
    `${C}.stripe-key`,
    `${HOME}.sqlite`,
  ];
  const world = await many(
    {},
    {
      beforeStart: (root) => {
        mkdirSync(join(root, "cache"), { recursive: true });
        for (const name of [...kept, ...removed]) writeFileSync(join(root, "cache", name), "x");
      },
    },
  );
  expect(readdirSync(join(world.root, "cache")).sort()).toEqual([...kept].sort());
  expect(world.lines).toContain("removed 3 cache files left by an earlier process");
});

test("a pod with many books has no credential that is one tenant's alone: a Stripe key in the environment, a Stripe key in the folder, and a bank connection in the folder are no book's", async () => {
  const key = `sk_test_${"a".repeat(24)}`;
  const saved = process.env.RASTRATA_STRIPE_KEY;
  process.env.RASTRATA_STRIPE_KEY = key;
  try {
    const world = await many(
      {},
      {
        beforeStart: (root) => {
          mkdirSync(join(root, "cache"), { recursive: true });
          writeFileSync(join(root, "cache", "stripe.key"), `${key}\n`, { mode: 0o600 });
          writeFileSync(
            join(root, "cache", "simplefin.access"),
            "https://user:secret@beta-bridge.simplefin.org/simplefin\n",
            { mode: 0o600 },
          );
        },
      },
    );
    const a = await tenant(world, A, USER(1), "Tenant A");
    const b = await tenant(world, B, USER(2), "Tenant B");
    const claim = btoa("https://beta-bridge.simplefin.org/simplefin/claim/abcdef123456");
    for (const token of [a, b]) {
      const stripe = await world.call(token, "stripe.status", {});
      expect(stripe.status).toBe(200);
      expect(stripe.body.data.key).toMatchObject({ present: false, source: null });
      const feed = await world.call(token, "bankfeed.status", {});
      expect(feed.body.data).toMatchObject({
        connected: false,
        credential: { present: false, host: null },
      });
      // And none can be made: there is no private place for it to be kept, and the setup token is not used up.
      const connect = await world.call(
        token,
        "bankfeed.connect",
        { setupToken: claim },
        { writes: true },
      );
      expect(connect.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(connect.body)).toContain("no private place");
    }
    // The home book is no exception.
    await world.call(OWNER_KEY, "book.setup", book("Home"), { writes: true });
    expect((await world.call(OWNER_KEY, "stripe.status", {})).body.data.key.present).toBe(false);
    expect((await world.call(OWNER_KEY, "bankfeed.status", {})).body.data.connected).toBe(false);
  } finally {
    if (saved === undefined) Reflect.deleteProperty(process.env, "RASTRATA_STRIPE_KEY");
    else process.env.RASTRATA_STRIPE_KEY = saved;
  }
});

test("a book the verifier stopped is not opened: refused with 423 and no word of what is in it, no lease taken, another book untouched, and opened again once an operator has cleared the finding", async () => {
  const world = await many();
  const a = await tenant(world, A, USER(1), "Tenant A");
  const b = await tenant(world, B, USER(2), "Tenant B");
  // Close A so that it has to be opened again.
  const slot = await world.registry.acquire(A);
  await slot.slot.evict();
  slot.release();
  const bucket = new FileObjectStore(join(world.root, "bucket"));
  const keys = new BookKeys("", A);
  const number = await recordReview(bucket, keys, {
    kind: "replay_failed",
    seq: 12,
    expected: "a".repeat(64),
    found: "b".repeat(64),
    check: "ledger_replay",
    verifier: "test-build",
    at: "2026-10-15T12:00:00.000Z",
  });
  const grants = world.grants(A);
  const stopped = await world.call(a, "book.get");
  expect(stopped.status).toBe(423);
  expect(stopped.body.error).toMatchObject({ code: "book_under_review", retryable: false });
  expect(JSON.stringify(stopped.body)).not.toContain("Tenant A");
  // Writes, too, and a second ask: the book is still not opened, and the tail was never asked for a lease.
  expect((await world.call(a, "book.get")).status).toBe(423);
  expect((await world.call(a, "journal.post", {}, { writes: true })).status).toBe(423);
  expect(world.grants(A)).toBe(grants);
  expect(world.registry.stats().counted).toBe(1);
  // The other tenant works as before.
  expect((await world.call(b, "book.get")).body.data.setup.name).toBe("Tenant B");
  // An operator clears the finding in the bucket (the gateway has no route that deletes: this is the bucket itself), and the book opens, as it was.
  await bucket.delete(keys.review(number));
  const cleared = await world.call(a, "book.get");
  expect(cleared.status).toBe(200);
  expect(cleared.body.data.setup.name).toBe("Tenant A");
});

test("an open book's review check does not hold a request up: the first request after the wait is answered at once, and the stop the check finds is the next request's refusal", async () => {
  // A bucket whose listing takes half a second, as a busy one can.
  const slowList = (inner: FileObjectStore): ObjectStore =>
    new Proxy(inner, {
      get(target, name) {
        if (name === "list")
          return async (...args: Parameters<FileObjectStore["list"]>) => {
            await Bun.sleep(500);
            return target.list(...args);
          };
        const value = Reflect.get(target, name);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as ObjectStore;
  // Asked again after a tenth of a second, standing for the five minutes.
  const world = await many({}, { reviewCheckMs: 100, bulkWith: slowList });
  const a = await tenant(world, A, USER(1), "Tenant A");
  expect((await world.call(a, "book.get")).status).toBe(200);
  const bucket = new FileObjectStore(join(world.root, "bucket"));
  await recordReview(bucket, new BookKeys("", A), {
    kind: "replay_failed",
    seq: 12,
    expected: null,
    found: null,
    check: "ledger_replay",
    verifier: "test-build",
    at: "2026-10-15T12:00:00.000Z",
  });
  await Bun.sleep(150);
  const started = performance.now();
  const answered = await world.call(a, "book.get");
  const took = performance.now() - started;
  expect(answered.status).toBe(200);
  // The question takes half a second and the request did not wait for it.
  expect(took).toBeLessThan(350);
  // It found the stop: the book is closed and the next request is refused.
  await Bun.sleep(900);
  const refused = await world.call(a, "book.get");
  expect(refused.status).toBe(423);
  expect(refused.body.error).toMatchObject({ code: "book_under_review", retryable: false });
});

test("a book that is open when the verifier stops it is closed when it is next asked about, which is every few minutes and not every request, and is refused from then on", async () => {
  const stop = (bucket: FileObjectStore, book: string) =>
    recordReview(bucket, new BookKeys("", book), {
      kind: "replay_failed",
      seq: 12,
      expected: null,
      found: null,
      check: "ledger_replay",
      verifier: "test-build",
      at: "2026-10-15T12:00:00.000Z",
    });
  // The default wait: a book in use is asked about once in five minutes, so a stop does not reach it at once.
  {
    const world = await many();
    const a = await tenant(world, A, USER(1), "Tenant A");
    const bucket = new FileObjectStore(join(world.root, "bucket"));
    expect((await world.call(a, "book.get")).status).toBe(200);
    await stop(bucket, A);
    expect((await world.call(a, "book.get")).status).toBe(200);
  }
  // Asked at every request, for the test: the next request finds the stop, the book is closed and its lease given back, and the other book is untouched.
  const world = await many({}, { reviewCheckMs: 0 });
  const a = await tenant(world, A, USER(1), "Tenant A");
  const b = await tenant(world, B, USER(2), "Tenant B");
  const bucket = new FileObjectStore(join(world.root, "bucket"));
  expect((await world.call(a, "book.get")).status).toBe(200);
  const releases = world.releases(A);
  const number = await stop(bucket, A);
  const stopped = await world.call(a, "book.get");
  expect(stopped.status).toBe(423);
  expect(stopped.body.error).toMatchObject({ code: "book_under_review", retryable: false });
  expect(JSON.stringify(stopped.body)).not.toContain("Tenant A");
  expect(world.releases(A)).toBeGreaterThan(releases);
  expect(world.registry.stats().counted).toBe(1);
  // It stays refused, writes too, and the tail is not asked for a lease again.
  const grants = world.grants(A);
  expect((await world.call(a, "book.get")).status).toBe(423);
  expect((await world.call(a, "drafts.create", draft("late"), { writes: true })).status).toBe(423);
  expect(world.grants(A)).toBe(grants);
  expect((await world.call(b, "book.get")).body.data.setup.name).toBe("Tenant B");
  // An operator clears it, and the book opens again as it was.
  await bucket.delete(new BookKeys("", A).review(number));
  expect((await world.call(a, "book.get")).body.data.setup.name).toBe("Tenant A");
});

test("a book that is open stays open when the question whether it has been stopped cannot be answered: the storage being down is not a stop", async () => {
  let down = false;
  const world = await many(
    {},
    {
      reviewCheckMs: 0,
      bulkWith: (inner) => ({
        putIfAbsent: (key, body, options) => inner.putIfAbsent(key, body, options),
        get: (key) => inner.get(key),
        head: (key) => inner.head(key),
        list: (prefix, after, limit) => {
          if (down && prefix.includes("/review/")) throw new ObjectStoreUncertain("down");
          return inner.list(prefix, after, limit);
        },
        delete: (key) => inner.delete(key),
      }),
    },
  );
  const a = await tenant(world, A, USER(1), "Tenant A");
  expect((await world.call(a, "book.get")).status).toBe(200);
  down = true;
  expect((await world.call(a, "book.get")).body.data.setup.name).toBe("Tenant A");
  expect((await world.call(a, "drafts.create", draft("while-down"), { writes: true })).status).toBe(
    200,
  );
});

test("a token made for an agent key opens the book it names with the key's permissions and no more, as the person who made the key, and nothing of another book", async () => {
  const world = await many();
  const a = await tenant(world, A, USER(1), "Tenant A");
  const b = await tenant(world, B, USER(2), "Tenant B");
  const agent = world.forAgent(USER(1), A, ["read", "draft"]);
  const context = await world.call(agent, "book.get");
  expect(context.status).toBe(200);
  expect(context.body.data.setup.name).toBe("Tenant A");
  expect(context.body.data.permissions).toEqual(["read", "draft"]);
  expect(context.body.data.principal).toEqual({
    kind: "token",
    tokenId: "0123456789abcdef",
    label: "Month-end bot",
    expiresAt: "2027-01-13T12:00:00.000Z",
  });
  // It drafts; it does not post or change who is in the book, though its person is the owner.
  expect(
    (await world.call(agent, "drafts.create", draft("by-the-agent"), { writes: true })).status,
  ).toBe(200);
  expect(references(await world.call(a, "drafts.list"))).toEqual(["by-the-agent"]);
  expect((await world.call(agent, "journal.post", draft("no"), { writes: true })).status).toBe(403);
  expect(
    (
      await world.call(
        agent,
        "members.add",
        { userId: USER(9), email: "z@example.com", role: "member" },
        { writes: true },
      )
    ).status,
  ).toBe(403);
  // The book is the token's, whatever else the request says: B is out of reach, in a header or in a body.
  expect((await world.call(agent, "book.get", {}, { book: B })).body.data.setup.name).toBe(
    "Tenant A",
  );
  expect(references(await world.call(b, "drafts.list"))).toEqual([]);
  // A key of a person who is not in the book is told so, and the book is not changed by asking.
  const stranger = world.forAgent(USER(7), A, ["read"], "fedcba9876543210");
  const refused = await world.call(stranger, "book.get");
  expect(refused.status).toBe(403);
  expect(refused.body.error.code).toBe("not_a_member");
  // What the key did is in the book's trail, which the owner reads.
  const trail = await world.call(a, "tokens.activity");
  expect(trail.status).toBe(200);
  const events = trail.body.data.events as { tokenId: string; operation: string }[];
  expect(
    events.some(
      (event) => event.tokenId === "0123456789abcdef" && event.operation === "drafts.create",
    ),
  ).toBe(true);
});

test("what an agent key reads is in the log before the answer is sent, as a token of the book's is: a person's reads are not held to that", async () => {
  const world = await many();
  const person = await tenant(world, A, USER(1), "Tenant A");
  const appends = () =>
    world.memory.records.filter((record) => record.book === A && record.op === "append").length;
  // A person's read leaves nothing to wait for: it is not logged before the answer.
  await world.call(person, "accounts.list");
  const settled = appends();
  await world.call(person, "accounts.list");
  expect(appends()).toBe(settled);
  // An agent's read leaves a line of its own in the book's trail, and the line is durable before the answer is: the log has an entry for it by the time the call returns.
  const agent = world.forAgent(USER(1), A, ["read"], "fedcba9876543210");
  const before = appends();
  expect((await world.call(agent, "accounts.list")).status).toBe(200);
  expect(appends()).toBeGreaterThan(before);
});

// ---- the whole read (src/whole-read.ts): a process reads a book from its first entry the first time it opens it ------------------------

/** One service's storage, for processes that run one after another on it: each is started when the one before has stopped, as after a release. */
function storage() {
  const tail = new MemoryLogTier();
  const bucket = mkdtempSync(join(tmpdir(), "rastrata-many-bucket-"));
  cleanup.push(() => rmSync(bucket, { recursive: true, force: true }));
  const store = new FileObjectStore(bucket);
  /** The snapshots the processes have read from the bucket: a book opened from scratch downloads one, and a book found open does not. */
  const counts = { snapshots: 0 };
  const seen: ObjectStore = {
    putIfAbsent: (key, body, options) => store.putIfAbsent(key, body, options),
    get: (key) => {
      if (key.includes("/snap/")) counts.snapshots += 1;
      return store.get(key);
    },
    head: (key) => store.head(key),
    list: (prefix, after, limit) => store.list(prefix, after, limit),
    delete: (key) => store.delete(key),
  };
  let shared: { tokens: ReturnType<typeof members>; serviceKey: string } | undefined;
  let processes = 0;
  /** The next process, with a snapshot of each book every three entries so that there is one a pod would start from. */
  const start = async (
    options: Partial<HostedServerOptions> = {},
    settings: Partial<BooksSettings> = {},
    through: { readonly bulkWith?: () => ObjectStore } = {},
  ) => {
    const world = await many(settings, {
      tail,
      bulkWith: () => seen,
      store: { RASTRATA_BOOK_SNAPSHOT_EVERY: "3" },
      operationBase: 1000 * ++processes,
      ...(shared ? { shared } : {}),
      ...through,
      ...options,
    });
    shared ??= {
      tokens: {
        verifier: world.verifier,
        issue: world.issue,
        forUser: world.forUser,
        forAgent: world.forAgent,
      },
      serviceKey: world.serviceKey,
    };
    return world;
  };
  return { tail, bucket, store, seen, counts, start };
}

const DRAFTS = ["one", "two", "three", "four", "five", "six", "seven"];
/** A book with a few entries, written by a process that has since stopped: its log is sealed in the bucket and it has a snapshot. */
async function writtenAndLeft(kept: ReturnType<typeof storage>, bookId = A) {
  const first = await kept.start();
  const owner = await tenant(first, bookId, USER(1), "Tenant A");
  for (const reference of DRAFTS)
    expect(
      (await first.call(owner, "drafts.create", draft(reference), { writes: true })).status,
    ).toBe(200);
  await first.server.stop();
  const keys = new BookKeys("", bookId);
  expect((await kept.store.list(keys.snapPrefix, undefined, 100)).objects.length).toBeGreaterThan(
    0,
  );
  return { owner, keys };
}

const linksCheckedOf = (world: World, bookId: string) =>
  world.lines.filter((line) => line.startsWith(`whole read: every link of ${bookId} holds (`));

/** Wait for the server to have said something, as a background read does when it is done. */
async function said(world: World, start: string): Promise<string> {
  for (let tries = 0; tries < 200; tries += 1) {
    const line = world.lines.find((candidate) => candidate.startsWith(start));
    if (line) return line;
    await Bun.sleep(25);
  }
  throw new Error(`the server never said: ${start}\n${world.lines.join("\n")}`);
}

test("the first time a process opens a book it answers from the usual open, and then every link of the book's log is checked from the first entry in the background, once", async () => {
  const kept = storage();
  const { owner } = await writtenAndLeft(kept);
  const second = await kept.start();
  const listed = await second.call(owner, "drafts.list");
  expect(listed.status).toBe(200);
  expect(references(listed).sort()).toEqual([...DRAFTS].sort());
  // The book was not rebuilt from its first entry in front of the answer, and says so no more.
  expect(second.lines.some((line) => line.includes("was read from its first entry"))).toBe(false);
  const checked = await said(second, `whole read: every link of ${A} holds (`);
  // Every entry the first process wrote: the book's making, its setup and the seven drafts at the least.
  expect(Number(/\((\d+) entries read/.exec(checked)?.[1])).toBeGreaterThanOrEqual(
    DRAFTS.length + 2,
  );
  // Closed and opened again by the same process: it is not read again.
  const held = await second.registry.acquire(A);
  await held.slot.evict();
  held.release();
  expect((await second.call(owner, "drafts.list")).status).toBe(200);
  await Bun.sleep(100);
  expect(linksCheckedOf(second, A)).toHaveLength(1);
});

test("a book whose log is damaged in storage is served from its snapshot until the background read has found the damage twice, and is then stopped", async () => {
  const kept = storage();
  const { owner, keys } = await writtenAndLeft(kept);
  const folder = join(kept.bucket, "books", A, "sealed");
  const file = join(folder, readdirSync(folder).sort()[0] as string);
  const bytes = readFileSync(file);
  const middle = Math.floor(bytes.length / 2);
  bytes[middle] = (bytes[middle] as number) ^ 0xff;
  writeFileSync(file, bytes);

  // The book is asked about again at every request, so that the stop is seen at once (it is every five minutes otherwise). A server that opens the books in use ahead of a request reads the log
  // then, and finds the damage before anyone is served (the next test); this one opens a book when it is asked for it.
  const second = await kept.start({ reviewCheckMs: 0, prewarm: false });
  const other = await tenant(second, B, USER(2), "Tenant B");
  // The snapshot is newer than the damage, so the book opens and is answered; nobody knows yet.
  expect((await second.call(owner, "drafts.list")).status).toBe(200);
  await said(second, `whole read: ${A} failed in the background (chain_break at entry`);
  await said(second, `whole read: ${A} is stopped (chain_break`);
  expect(await reviewCount(kept.store, keys)).toBe(1);
  const stopped = await second.call(owner, "drafts.list");
  expect(stopped.status).toBe(423);
  expect(stopped.body.error).toMatchObject({ code: "book_under_review", retryable: false });
  expect(JSON.stringify(stopped.body)).not.toContain("Tenant A");
  // From then on it is refused before it is opened, a write too, and nothing is added to it.
  const head = kept.tail.peek(A).head.seq;
  expect((await second.call(owner, "drafts.create", draft("late"), { writes: true })).status).toBe(
    423,
  );
  expect(kept.tail.peek(A).head.seq).toBe(head);
  // The other book of the same process is as it was.
  expect((await second.call(other, "book.get")).body.data.setup.name).toBe("Tenant B");
}, 60_000);

test("a book whose log is damaged in storage is found, read twice, and stopped by a server that opens the books in use before it is ready, and nobody is served from it", async () => {
  const kept = storage();
  const { owner, keys } = await writtenAndLeft(kept);
  const folder = join(kept.bucket, "books", A, "sealed");
  const file = join(folder, readdirSync(folder).sort()[0] as string);
  const bytes = readFileSync(file);
  const middle = Math.floor(bytes.length / 2);
  bytes[middle] = (bytes[middle] as number) ^ 0xff;
  writeFileSync(file, bytes);

  // The book is opened ahead, from its snapshot, which is newer than the damage; its log is read from the first entry before the server is ready, and the damage is in it.
  const second = await kept.start({ reviewCheckMs: 0 });
  expect(
    second.lines.some((line) =>
      line.startsWith(`whole read: ${A} failed in the background (chain_break at entry`),
    ),
  ).toBe(true);
  expect(
    second.lines.some((line) => line.startsWith(`whole read: ${A} is stopped (chain_break`)),
  ).toBe(true);
  expect(await reviewCount(kept.store, keys)).toBe(1);
  // The first person to ask is refused as one who asks later is, and what the book holds is not shown; the lease was never taken.
  const grants = kept.tail.records.filter(
    (record) => record.book === A && record.op === "grant",
  ).length;
  const refused = await second.call(owner, "drafts.list");
  expect(refused.status).toBe(423);
  expect(refused.body.error).toMatchObject({ code: "book_under_review", retryable: false });
  expect(JSON.stringify(refused.body)).not.toContain("Tenant A");
  expect(
    kept.tail.records.filter((record) => record.book === A && record.op === "grant").length,
  ).toBe(grants);
  expect((await second.call(owner, "drafts.create", draft("late"), { writes: true })).status).toBe(
    423,
  );
  // The book that was open ahead and is stopped is let go, not kept in memory for the six hours.
  expect(second.cacheFiles()).not.toContain(`${A}.sqlite`);
}, 60_000);

test("a sealed part of the log after the snapshot that is damaged in storage fails the open the first time, and the second time stops the book", async () => {
  const kept = storage();
  const { owner, keys } = await writtenAndLeft(kept);
  // One byte near the end of the newest sealed segment, changed where it lies: the open applies the entries that follow the snapshot, and meets it.
  const folder = join(kept.bucket, "books", A, "sealed");
  const file = join(folder, readdirSync(folder).sort().at(-1) as string);
  const bytes = readFileSync(file);
  const near = bytes.length - 24;
  bytes[near] = (bytes[near] as number) ^ 0xff;
  writeFileSync(file, bytes);

  const second = await kept.start();
  const other = await tenant(second, B, USER(2), "Tenant B");
  const once = await second.call(owner, "drafts.list");
  expect(once.status).toBeGreaterThanOrEqual(500);
  expect(JSON.stringify(once.body)).not.toContain("Tenant A");
  // Nothing is stopped on one reading.
  expect(await reviewCount(kept.store, keys)).toBe(0);
  expect(
    second.lines.filter((line) => line.startsWith(`whole read: ${A} failed (chain_break at entry`)),
  ).toHaveLength(1);
  // The second reading fails the same way: the book is stopped, as the verifier stops one.
  const twice = await second.call(owner, "drafts.list");
  expect(twice.status).toBe(423);
  expect(twice.body.error).toMatchObject({ code: "book_under_review", retryable: false });
  expect(await reviewCount(kept.store, keys)).toBe(1);
  // The other book of the same process is as it was.
  expect((await second.call(other, "book.get")).body.data.setup.name).toBe("Tenant B");
}, 60_000);

test("a store that does not answer when a book is opened stops nothing: the next request opens the book and serves it, and its log is then checked in the background", async () => {
  const kept = storage();
  const { owner, keys } = await writtenAndLeft(kept);
  let failing = true;
  const flaky = (inner: ObjectStore): ObjectStore =>
    new Proxy(inner, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        // The store's own methods are called on the store itself.
        if (property !== "get") return value.bind(target);
        return async (key: string, ...more: unknown[]) => {
          if (failing && key.includes(`/${A}/sealed/`)) {
            const error = new Error("the bucket did not answer");
            error.name = "ObjectStoreError";
            throw Object.assign(error, { status: 503 });
          }
          return (value as (...all: unknown[]) => unknown).call(target, key, ...more);
        };
      },
    });
  const second = await kept.start({});
  await second.server.stop();
  const third = await many(
    {},
    {
      tail: kept.tail,
      bulkWith: () => flaky(kept.store),
      store: { RASTRATA_BOOK_SNAPSHOT_EVERY: "3" },
      operationBase: 9000,
      shared: {
        tokens: {
          verifier: second.verifier,
          issue: second.issue,
          forUser: second.forUser,
          forAgent: second.forAgent,
        },
        serviceKey: second.serviceKey,
      },
    },
  );
  for (let tries = 0; tries < 3; tries += 1)
    expect((await third.call(owner, "drafts.list")).status).toBeGreaterThanOrEqual(500);
  expect(await reviewCount(kept.store, keys)).toBe(0);
  expect(third.lines.some((line) => line.startsWith("whole read:"))).toBe(false);
  failing = false;
  const listed = await third.call(owner, "drafts.list");
  expect(listed.status).toBe(200);
  await said(third, `whole read: every link of ${A} holds (`);
  expect(linksCheckedOf(third, A)).toHaveLength(1);
}, 60_000);

// ---- the check behind the first answer --------------------------------------------------------------------------------------------------

/** Make a ledger answer with one stored outcome whose text is not the one its command makes, as a damaged store whose chain was made good again would: a read that applies the stored revisions does not
 * look at the text, and the check that executes every outcome does. */
const damaging = (sequence: number) => (service: { readonly ledger: unknown }) => {
  type Page = { outcomes: { encoded: string; head: { sequence: string } }[] };
  const ledger = service.ledger as { outcomes: (...args: unknown[]) => Promise<Page> };
  const original = ledger.outcomes.bind(ledger);
  ledger.outcomes = async (...args: unknown[]) => {
    const page = await original(...args);
    return {
      ...page,
      outcomes: page.outcomes.map((outcome) =>
        Number(outcome.head.sequence) === sequence
          ? { ...outcome, encoded: `${outcome.encoded} ` }
          : outcome,
      ),
    };
  };
};

test("a book whose ledger does not replay is answered from the stored revisions, the check behind the answer finds it and stops the book, and it is refused from then on", async () => {
  const kept = storage();
  const { owner, keys } = await writtenAndLeft(kept);
  const second = await kept.start({ reviewCheckMs: 0, wire: damaging(1) });
  // Nothing is executed in front of the first answer, and the first read of the ledger starts the check behind it.
  expect((await second.call(owner, "accounts.list")).status).toBe(200);
  await said(second, `${A} is stopped: its ledger does not replay`);
  expect(await reviewCount(kept.store, keys)).toBe(1);
  const stopped = await second.call(owner, "accounts.list");
  expect(stopped.status).toBe(423);
  expect(stopped.body.error).toMatchObject({ code: "book_under_review", retryable: false });
  // A write is refused the same, and nothing is added to the book.
  const head = kept.tail.peek(A).head.seq;
  expect((await second.call(owner, "drafts.create", draft("late"), { writes: true })).status).toBe(
    423,
  );
  expect(kept.tail.peek(A).head.seq).toBe(head);
  expect(await reviewCount(kept.store, keys)).toBe(1);
  // Another process finds the stop and does not open the book.
  await second.server.stop();
  const third = await kept.start({ reviewCheckMs: 0 });
  expect((await third.call(owner, "accounts.list")).status).toBe(423);
}, 60_000);

test("a write that is the first request to a book whose ledger does not replay waits for the check and is refused by it, and the book is stopped", async () => {
  const kept = storage();
  const { owner, keys } = await writtenAndLeft(kept);
  const second = await kept.start({ reviewCheckMs: 0, wire: damaging(1) });
  const head = kept.tail.peek(A).head.seq;
  const refused = await second.call(owner, "drafts.create", draft("early"), { writes: true });
  expect(refused.status).toBe(423);
  expect(refused.body.error).toMatchObject({ code: "book_under_review", retryable: false });
  await said(second, `${A} is stopped: its ledger does not replay`);
  expect(await reviewCount(kept.store, keys)).toBe(1);
  expect(kept.tail.peek(A).head.seq).toBe(head);
}, 60_000);

test("a book whose ledger replays is answered at once, and a write that comes first waits for the check and then runs", async () => {
  const kept = storage();
  const { owner, keys } = await writtenAndLeft(kept);
  const second = await kept.start({ reviewCheckMs: 0 });
  const created = await second.call(owner, "drafts.create", draft("first"), { writes: true });
  expect(created.status).toBe(200);
  const listed = await second.call(owner, "drafts.list");
  expect(references(listed).sort()).toEqual([...DRAFTS, "first"].sort());
  expect(await reviewCount(kept.store, keys)).toBe(0);
  // The check that ran behind the first answer says that it ended, once.
  expect(await said(second, `${A} was checked`)).toContain("outcomes executed again, none differs");
  expect(second.lines.filter((line) => line.startsWith(`${A} was checked`))).toHaveLength(1);
  expect(second.lines.some((line) => line.includes("does not replay"))).toBe(false);
}, 60_000);

// ---- the books in use are open before a server says it is ready (src/hot-books.ts, `BookSlot.prewarm`) ----------------------------------------------------------------------

/** Wait until something that happens behind the scenes has happened. */
async function eventually(check: () => boolean | Promise<boolean>, what: string, ms = 8000) {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`never happened: ${what}`);
    await Bun.sleep(25);
  }
}
const lists = async (kept: ReturnType<typeof storage>) =>
  (await kept.store.list(HOT_FOLDER)).objects;
const leases = (kept: ReturnType<typeof storage>) =>
  kept.tail.records.filter((record) => record.op === "grant").length;

/** Two tenants' books with a few entries, written by a server that has since stopped, as before a release. */
async function leftByARelease(kept: ReturnType<typeof storage>, options = {}) {
  const first = await kept.start(options);
  const a = await tenant(first, A, USER(1), "Tenant A");
  const b = await tenant(first, B, USER(2), "Tenant B");
  for (const reference of DRAFTS)
    expect((await first.call(a, "drafts.create", draft(reference), { writes: true })).status).toBe(
      200,
    );
  await first.server.stop();
  return { a, b };
}

test("a server that starts after another has the books that one had in use open before it says it is ready, holds none of them, and the first request for each takes the lease without reading the book again", async () => {
  const kept = storage();
  const { a } = await leftByARelease(kept);
  // What the server had open is in the bucket, once, as a list of its own.
  expect(await lists(kept)).toHaveLength(1);
  const before = leases(kept);

  const second = await kept.start();
  expect(second.registry.stats().open).toBe(2);
  expect(second.cacheFiles().sort()).toEqual([`${A}.sqlite`, `${B}.sqlite`]);
  expect(second.lines.find((line) => line.startsWith("prewarm: "))).toMatch(
    /^prewarm: 2 of 2 books in use are open, in \d+ ms, and checked behind in \d+ ms$/,
  );
  expect(leases(kept)).toBe(before);
  // Opening a book is not using it: the second server has each as last used when the first said, and not when it opened them.
  const told = JSON.parse(
    new TextDecoder().decode((await kept.store.get((await lists(kept))[0]?.key ?? ""))?.body),
  ) as { books: { id: string; at: number }[] };
  expect(told.books.map((book) => book.id).sort()).toEqual([A, B]);
  for (const book of told.books)
    expect(second.registry.hot().find((open) => open.id === book.id)?.at).toBe(book.at);
  const slotOf = async (id: string) => {
    const lease = await second.registry.acquire(id, "service");
    lease.release();
    return lease.slot;
  };
  expect((await slotOf(A)).warmed).toBe(true);
  expect((await slotOf(A)).book).toBeNull();

  // The first request takes the lease and reads what the log has gained; it does not download the book's snapshot again, and the book it is answered by is the one that was open.
  kept.counts.snapshots = 0;
  const listed = await second.call(a, "drafts.list");
  expect(listed.status).toBe(200);
  expect(references(listed).sort()).toEqual([...DRAFTS].sort());
  expect(kept.counts.snapshots).toBe(0);
  expect(leases(kept)).toBe(before + 1);
  expect(second.registry.stats().open).toBe(2);
  expect((await slotOf(A)).warmed).toBe(false);
  expect((await slotOf(A)).book).not.toBeNull();
  // The other is as it was until it is asked for.
  expect((await slotOf(B)).warmed).toBe(true);
});

test("without it the first request for a book is a cold open that downloads its snapshot, which is what the books in use being open ahead of it saves", async () => {
  const kept = storage();
  const { a } = await leftByARelease(kept);
  const second = await kept.start({ prewarm: false });
  expect(second.registry.stats().open).toBe(0);
  expect(second.lines.some((line) => line.startsWith("prewarm: "))).toBe(false);
  kept.counts.snapshots = 0;
  expect((await second.call(a, "drafts.list")).status).toBe(200);
  expect(kept.counts.snapshots).toBeGreaterThan(0);
});

test("books that the server before it still holds are opened without being taken, a request that asks for one is handed to the holder, and the new server takes it when the holder has let it go", async () => {
  const kept = storage();
  // The first server tells the others within a second of a book being opened (its check is every second here, every half minute in production).
  const first = await kept.start({ prewarm: { checkMs: 1000 } });
  const a = await tenant(first, A, USER(1), "Tenant A");
  await first.call(a, "drafts.create", draft("one"), { writes: true });
  await eventually(async () => (await lists(kept)).length > 0, "the first server's list");
  const holder = kept.tail.peek(A).head.leaseHolder;
  expect(holder).not.toBeNull();

  // A server that starts beside it, as in a rolling update, opens the book the first holds and takes nothing.
  const second = await kept.start();
  expect(second.registry.stats().open).toBe(1);
  expect(kept.tail.peek(A).head.leaseHolder).toBe(holder);
  expect((await first.call(a, "drafts.create", draft("two"), { writes: true })).status).toBe(200);

  // A request that comes to the second is the holder's to answer, and the second keeps the book open.
  const handed = await second.call(a, "drafts.list");
  expect(handed.status).toBe(200);
  expect(references(handed).sort()).toEqual(["one", "two"]);
  expect((await second.health()).hosted.peers.forwarded).toBe(1);
  expect(kept.tail.peek(A).head.leaseHolder).toBe(holder);
  expect(second.registry.stats().open).toBe(1);

  // The first leaves as it does at a release; the second takes the book where it stands, with what the first wrote, and does not read it from its snapshot again.
  await first.server.stop();
  await Bun.sleep(1100);
  kept.counts.snapshots = 0;
  const taken = await second.call(a, "drafts.list");
  expect(taken.status).toBe(200);
  expect(references(taken).sort()).toEqual(["one", "two"]);
  expect(kept.counts.snapshots).toBe(0);
  const now = kept.tail.peek(A).head.leaseHolder;
  expect(now).not.toBeNull();
  expect(now).not.toBe(holder);
});

test("a book written after a server opened it is read up to date when its lease is taken", async () => {
  const kept = storage();
  const { a } = await leftByARelease(kept);
  const second = await kept.start();
  expect(second.registry.stats().open).toBe(2);
  // Another server writes to the book meanwhile and leaves.
  const third = await kept.start({ prewarm: false });
  expect((await third.call(a, "drafts.create", draft("meanwhile"), { writes: true })).status).toBe(
    200,
  );
  await third.server.stop();
  const listed = await second.call(a, "drafts.list");
  expect(listed.status).toBe(200);
  expect(references(listed).sort()).toEqual([...DRAFTS, "meanwhile"].sort());
  // And a write by the second is a write on the whole book, not on what it had.
  expect((await second.call(a, "drafts.create", draft("after"), { writes: true })).status).toBe(
    200,
  );
  expect(references(await second.call(a, "drafts.list")).sort()).toEqual(
    [...DRAFTS, "meanwhile", "after"].sort(),
  );
});

test("a book the verifier has stopped is not opened ahead of a request, and the others are", async () => {
  const kept = storage();
  const { a, b } = await leftByARelease(kept);
  await recordReview(kept.store, new BookKeys("", A), {
    kind: "replay_failed",
    seq: 12,
    expected: null,
    found: null,
    check: "ledger_replay",
    verifier: "test-build",
    at: "2026-10-15T12:00:00.000Z",
  });
  const second = await kept.start();
  expect(second.cacheFiles()).toEqual([`${B}.sqlite`]);
  expect(second.registry.stats().open).toBe(1);
  expect((await second.call(a, "drafts.list")).status).toBe(423);
  expect((await second.call(b, "drafts.list")).status).toBe(200);
});

test("a list that names a book nobody has made opens nothing for it, leaves nothing on disk, and the book is made the way it always was", async () => {
  const kept = storage();
  const { a } = await leftByARelease(kept);
  // A list from some other server, which names a book that is not in the bucket.
  await kept.store.putIfAbsent(
    `${HOT_FOLDER}${String(Date.now() + 5).padStart(13, "0")}.pod-other.json`,
    new TextEncoder().encode(
      JSON.stringify({ v: 1, at: Date.now(), books: [{ id: "tenant-zzzz", at: Date.now() }] }),
    ),
  );
  const second = await kept.start();
  expect(second.cacheFiles().sort()).toEqual([`${A}.sqlite`, `${B}.sqlite`]);
  expect(second.registry.stats().open).toBe(2);
  expect(readdirSync(join(second.root, "cache")).filter((file) => file.includes("zzzz"))).toEqual(
    [],
  );
  // The book that was never made is made the way it always was: by the control plane naming it.
  expect((await second.provision("tenant-zzzz", USER(9))).status).toBe(200);
  expect((await second.call(second.forUser(USER(9), "tenant-zzzz"), "book.get")).status).toBe(200);
  expect((await second.call(a, "drafts.list")).status).toBe(200);
});

test("a bucket whose lists cannot be read does not keep the server from being ready: it opens nothing ahead, says so, and every book opens with its first request", async () => {
  const kept = storage();
  const { a } = await leftByARelease(kept);
  const refusing: ObjectStore = {
    putIfAbsent: (key, body, options) => kept.seen.putIfAbsent(key, body, options),
    get: (key) => kept.seen.get(key),
    head: (key) => kept.seen.head(key),
    list: (prefix, after, limit) => {
      if (prefix.includes(HOT_FOLDER)) throw new ObjectStoreUncertain("the bucket did not answer");
      return kept.seen.list(prefix, after, limit);
    },
    delete: (key) => kept.seen.delete(key),
  };
  const second = await kept.start({}, {}, { bulkWith: () => refusing });
  expect(second.registry.stats().open).toBe(0);
  expect(
    second.lines.some((line) => line.startsWith("hot books: the lists could not be read")),
  ).toBe(true);
  expect((await second.call(a, "drafts.list")).status).toBe(200);
});

test("a server with room for fewer books than were in use opens as many as it has room for, the ones used last, closes none of them for the next, and is ready", async () => {
  const kept = storage();
  const { a, b } = await leftByARelease(kept);
  // B was used last, as the first server's list says.
  const first = await kept.start({ prewarm: { checkMs: 1000 } });
  await first.call(a, "drafts.list");
  // A moment later, so that B was used after A by the clock the lists are in (milliseconds), and not in the same one.
  await Bun.sleep(10);
  await first.call(b, "drafts.list");
  await first.server.stop();
  // One at a time, so that the second is asked for with the first open: the room is taken by what is open, not by what is being opened.
  const second = await kept.start({}, { maxBooks: 1, loads: 1 });
  expect(second.registry.stats().open).toBe(1);
  expect(second.registry.stats().closed.room).toBe(0);
  expect(second.cacheFiles()).toEqual([`${B}.sqlite`]);
  expect((await second.call(a, "drafts.list")).status).toBe(200);
});

test("the server is ready when its time for opening the books is over, and the books it did not finish go on opening behind it; a request for one that is being opened waits for that and takes it", async () => {
  const kept = storage();
  const { a, b } = await leftByARelease(kept);
  let delayed = 0;
  const slow: ObjectStore = {
    putIfAbsent: (key, body, options) => kept.seen.putIfAbsent(key, body, options),
    get: async (key) => {
      if (key.includes("/snap/")) {
        delayed += 1;
        await Bun.sleep(300);
      }
      return kept.seen.get(key);
    },
    head: (key) => kept.seen.head(key),
    list: (prefix, after, limit) => kept.seen.list(prefix, after, limit),
    delete: (key) => kept.seen.delete(key),
  };
  const began = performance.now();
  const second = await kept.start({ prewarm: { budgetMs: 50 } }, {}, { bulkWith: () => slow });
  // Ready at the end of its time, with the books not yet open; they are opened behind it.
  expect(performance.now() - began).toBeLessThan(2500);
  expect(second.registry.stats().open).toBeLessThan(2);
  // A request now is for a book that is being opened or is about to be: it waits for that open and answers, and the book is on one file.
  const [listedA, listedB] = await Promise.all([
    second.call(a, "drafts.list"),
    second.call(b, "drafts.list"),
  ]);
  expect(listedA.status).toBe(200);
  expect(listedB.status).toBe(200);
  expect(references(listedA).sort()).toEqual([...DRAFTS].sort());
  await eventually(() => second.registry.stats().open === 2, "both books open");
  expect(second.cacheFiles().sort()).toEqual([`${A}.sqlite`, `${B}.sqlite`]);
  // Each book was read from its snapshot once, not twice (one by the opening ahead and one by the request).
  expect(delayed).toBeLessThanOrEqual(4);
  void (await second.health());
});

test("the server tells the ones after it which books it has open when the set changes and not otherwise, and again as it stops", async () => {
  const kept = storage();
  const first = await kept.start({ prewarm: { checkMs: 1000 } });
  expect(await lists(kept)).toHaveLength(0);
  const a = await tenant(first, A, USER(1), "Tenant A");
  await eventually(async () => (await lists(kept)).length === 1, "a list for the first book");
  const named = async (index: number) => {
    const key = (await lists(kept))[index]?.key ?? "";
    const stored = await kept.store.get(key);
    return (JSON.parse(new TextDecoder().decode(stored?.body)) as { books: { id: string }[] }).books
      .map((book) => book.id)
      .sort();
  };
  expect(await named(0)).toEqual([A]);
  // Use does not change the set: nothing more is written.
  await first.call(a, "drafts.list");
  await Bun.sleep(2300);
  expect(await lists(kept)).toHaveLength(1);
  // A second book does.
  await tenant(first, B, USER(2), "Tenant B");
  await eventually(async () => (await lists(kept)).length === 2, "a list for the second book");
  expect(await named(1)).toEqual([A, B]);
  // And at the end, a last word.
  await first.server.stop();
  expect((await lists(kept)).length).toBeGreaterThanOrEqual(3);
  expect(await named((await lists(kept)).length - 1)).toEqual([A, B]);
  // A server that tells nothing (none asked for) leaves nothing.
  const quiet = storage();
  const never = await quiet.start({ prewarm: false });
  await tenant(never, A, USER(1), "Tenant A");
  await never.server.stop();
  expect(await lists(quiet)).toHaveLength(0);
});

// The founder's first visit of 2026-11-22, and the ten minutes after it (docs/reference/program/performance.md, "The first visit of a day").
test("a pod that hands a request to the pod that holds the book opens the book behind it without taking it, so that when the lease has been let go and the next request reaches it, it takes the book with what was written meanwhile and reads nothing from the bucket", async () => {
  const lapsing = { leaseMs: 1000, idleReleaseMs: 150 };
  const { tail, one, two } = await twoPods(lapsing, lapsing);
  const owner = await tenant(one, A, USER(1), "Tenant A");
  expect((await one.call(owner, "drafts.create", draft("first"), { writes: true })).status).toBe(
    200,
  );
  // The second pod is asked while the first holds the book: it hands the request on, and opens the book for itself behind that.
  const viaTwo = two.forUser(USER(1), A);
  expect(references(await two.call(viaTwo, "drafts.list"))).toEqual(["first"]);
  expect((await two.health()).hosted.peers.forwarded).toBe(1);
  await eventually(
    () => two.cacheFiles().includes(`${A}.sqlite`),
    "the book open on the second pod",
  );
  await eventually(
    async () => (await two.health()).hosted.books.open === 1,
    "the book counted there",
  );
  // It holds nothing: the book is the first pod's, which goes on writing.
  expect(tail.peek(A).head.leaseHolder).toContain(`:${one.server.server.port}`);
  expect((await one.call(owner, "drafts.create", draft("second"), { writes: true })).status).toBe(
    200,
  );
  // Long enough for the lease to be let go, and for the second pod to stop taking the first's word for where the book is (a second).
  await Bun.sleep(1300);
  expect(tail.peek(A).head.leaseHolder).toBeNull();
  // The next request reaches the second pod: it takes the book it has, and reads what was written since.
  const before = two.lines.length;
  const started = performance.now();
  const answer = await two.call(viaTwo, "drafts.list");
  expect(answer.status).toBe(200);
  expect(references(answer).sort()).toEqual(["first", "second"]);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(tail.peek(A).head.leaseHolder).toContain(`:${two.server.server.port}`);
  // Not opened for the request: it was open.
  expect(two.lines.slice(before).filter((line) => line.startsWith("opened:"))).toEqual([]);
  expect((await two.health()).hosted.peers.forwarded).toBe(1);
});

test("a book that is opened while a request waits for it is written down, once, with how long it took", async () => {
  const world = await many();
  const owner = await tenant(world, A, USER(1), "Tenant A");
  const held = await world.registry.acquire(A);
  await held.slot.evict();
  held.release();
  const before = world.lines.length;
  const answers = await Promise.all(
    Array.from({ length: 6 }, () => world.call(owner, "drafts.list")),
  );
  expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 200, 200, 200]);
  const said = world.lines.slice(before).filter((line) => line.startsWith("opened:"));
  expect(said).toHaveLength(1);
  expect(said[0]).toMatch(new RegExp(`^opened: ${A} for a request, in \\d+ ms$`));
});

test("the requests of one page that reach a pod together, for a book it has open and another pod holds, ask the tail once who holds it and go to that pod together", async () => {
  let acquires = 0;
  const lapsing = { leaseMs: 1000, idleReleaseMs: 250 };
  const { tail, one, two } = await twoPods(
    lapsing,
    lapsing,
    (inner) =>
      new Proxy(inner, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property !== "acquire")
            return typeof value === "function" ? value.bind(target) : value;
          return async (...args: unknown[]) => {
            acquires += 1;
            // As far away as the tail is from a pod.
            await Bun.sleep(25);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      }),
  );
  const owner = await tenant(one, A, USER(1), "Tenant A");
  const viaTwo = two.forUser(USER(1), A);
  // The second pod holds the book for a while and lets it go: the book is open there, as it is on the first.
  await eventually(
    () => tail.peek(A).head.leaseHolder === null,
    "the first pod has let the book go",
  );
  expect(
    (await two.call(viaTwo, "drafts.create", draft("from two"), { writes: true })).status,
  ).toBe(200);
  await eventually(
    () => tail.peek(A).head.leaseHolder === null,
    "the second pod has let the book go",
  );
  // The first pod takes it again, and a page's requests reach the second pod while it holds it.
  expect((await one.call(owner, "drafts.list")).status).toBe(200);
  expect(tail.peek(A).head.leaseHolder).toContain(`:${one.server.server.port}`);
  const forwarded = (await two.health()).hosted.peers.forwarded;
  acquires = 0;
  const started = performance.now();
  const answers = await Promise.all(
    Array.from({ length: 12 }, () => two.call(viaTwo, "drafts.list")),
  );
  const took = performance.now() - started;
  expect(answers.map((answer) => answer.status)).toEqual(Array.from({ length: 12 }, () => 200));
  expect(answers.every((answer) => references(answer).includes("from two"))).toBe(true);
  expect((await two.health()).hosted.peers.forwarded).toBe(forwarded + 12);
  // One question to the tail (the first pod's own renewals are not questions of this kind), and not twelve one after another.
  expect(acquires).toBeLessThanOrEqual(2);
  expect(took).toBeLessThan(25 * 6);
  expect(tail.peek(A).head.leaseHolder).toContain(`:${one.server.server.port}`);
});

/** A bucket every call to which takes `ms`: a book opened from it takes a few tenths of a second, as one does on the service. */
function farAway(inner: FileObjectStore, ms: number): ObjectStore {
  return new Proxy(inner, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        await Bun.sleep(ms);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as ObjectStore;
}

test("everything two pages ask for at once waits for a book that is being opened and is answered: sixty requests, where thirty-two used to be the most", async () => {
  const world = await many({}, { bulkWith: (inner) => farAway(inner, 40) });
  const owner = await tenant(world, A, USER(1), "Tenant A");
  const held = await world.registry.acquire(A);
  await held.slot.evict();
  held.release();
  const answers = await Promise.all(
    Array.from({ length: 60 }, () => world.call(owner, "drafts.list")),
  );
  expect(answers.filter((answer) => answer.status !== 200).map((answer) => answer.status)).toEqual(
    [],
  );
  expect(world.registry.stats().refused).toEqual({ busy: 0, rate: 0 });
});

test("a request that is turned away by a limit is written down with what it asked for, and a minute of them does not fill the log", async () => {
  const world = await many(
    { inflight: 1, burst: 500, rate: 500 },
    { bulkWith: (inner) => farAway(inner, 40) },
  );
  const owner = await tenant(world, A, USER(1), "Tenant A");
  // While the book is being opened for the first of them, the rest are over the limit.
  const held = await world.registry.acquire(A);
  await held.slot.evict();
  held.release();
  const answers = await Promise.all(
    Array.from({ length: 40 }, () => world.call(owner, "drafts.list")),
  );
  const refused = answers.filter((answer) => answer.status === 429).length;
  expect(refused).toBeGreaterThan(20);
  const said = world.lines.filter((line) => line.startsWith("refused:"));
  expect(said[0]).toBe("refused: rate_limited /v1/drafts.list");
  expect(said.length).toBeLessThanOrEqual(20);
});
