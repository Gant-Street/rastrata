import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROLE_PERMISSIONS, type WorkspaceRole } from "../src/agent/member.ts";
import type { ApplicationAccess } from "../src/agent/principal.ts";
import { ApplicationHttp } from "../src/http.ts";
import { LocalBookService } from "../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS, operationCatalog } from "../src/schema.ts";
import { memberState } from "../src/slices/members/store.ts";
import { cleanupSafetyFixtures, safetyFixture } from "./support/safety.ts";

// A workspace that has not subscribed is read-only (docs/reference/program/hosting/billing-stripe.md): the people in it read the books and export them, and nothing more. The control plane
// says so with `book.access`, and the rule is applied where the book decides what a person may do. Nothing is deleted or taken out, and lifting it restores everything at once.
const book = {
  name: "Read Only Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Cash", role: "asset" },
    { code: "3000", name: "Capital", role: "equity" },
  ],
};
const START = new Date("2026-10-15T12:00:00.000Z");
// biome-ignore lint/suspicious/noExplicitAny: decoded JSON in a test
type Json = Record<string, any>;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
  cleanupSafetyFixtures();
});

let counter = 0;
const operationId = (): string => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const user = (n: number): string => `user_${String(n).padStart(10, "0")}`;

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-read-only-"));
  const service = await LocalBookService.open(join(directory, "book.sqlite"));
  let now = START;
  const http = new ApplicationHttp(
    service,
    { bookId: service.bookId, permissions: BUSINESS_PERMISSIONS },
    { clock: () => now },
  );
  cleanup.push(() => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function send(name: string, input: unknown, as?: ApplicationAccess) {
    const response = await http.fetch(
      new Request(`http://127.0.0.1:4010/v1/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: "local-book",
          input,
          operationId: operationId(),
        }),
      }),
      as,
    );
    return { status: response.status, body: (await response.json()) as Json };
  }
  const control = http.serviceAccess("control");
  const add = (n: number, role: WorkspaceRole) =>
    send("members.add", { userId: user(n), email: `person${n}@example.com`, role }, control);
  const world = {
    service,
    http,
    send,
    control,
    add,
    tick: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    access: (n: number) => {
      const access = http.memberAccess(user(n));
      if (access === null) throw new Error(`person ${n} is not in the book`);
      return access;
    },
    readOnly: (readOnly: boolean) => send("book.access", { readOnly }, control),
  };
  await send("book.setup", book);
  await add(1, "owner");
  await add(2, "admin");
  await add(3, "accountant");
  await add(4, "member");
  return world;
}

const ROLES: readonly [number, WorkspaceRole][] = [
  [1, "owner"],
  [2, "admin"],
  [3, "accountant"],
  [4, "member"],
];

test("a book is open until the control plane says otherwise, and only the control plane can say so", async () => {
  const world = await fixture();
  for (const [n, role] of ROLES) {
    const access = world.access(n);
    expect(access.readOnly, role).toBeUndefined();
    expect(access.operations, role).toBeUndefined();
    expect(access.permissions, role).toEqual(ROLE_PERMISSIONS[role]);
  }
  // An owner holds `provision`, and still cannot lift or set it: it is the control plane's word about the workspace's subscription, and not the owner's about the book.
  for (const readOnly of [true, false]) {
    const refused = await world.send("book.access", { readOnly }, world.access(1));
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("service_only");
  }
  // Below the owner it is the plain refusal for want of the permission.
  const accountant = await world.send("book.access", { readOnly: true }, world.access(3));
  expect(accountant.body.error.code).toBe("permission_denied");
  expect(memberState(world.service).readOnlySince()).toBeNull();

  const set = await world.readOnly(true);
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  expect(set.body.data).toEqual({ readOnly: true, readOnlySince: START.toISOString() });
  expect(memberState(world.service).readOnlySince()).toBe(START.toISOString());
});

test("in a read-only book a person reads and exports and nothing more, and is told the true reason", async () => {
  const world = await fixture();
  await world.readOnly(true);

  for (const [n, role] of ROLES) {
    const access = world.access(n);
    const held = ROLE_PERMISSIONS[role];
    // Reads are answered; the person still is who they are.
    const read = await world.send("accounts.list", {}, access);
    expect(read.status, `${role} reads`).toBe(200);
    expect(access.principal).toEqual({ kind: "member", userId: user(n), role });
    expect(access.readOnly).toEqual({ since: START.toISOString(), held });
    expect(
      access.permissions.every((p) => p === "read" || p === "configure"),
      role,
    ).toBe(true);
    expect(access.permissions.includes("read"), role).toBe(true);
    // Each kind of write the role holds is refused in the words of the cause; one it never held is the plain refusal it always was.
    const attempts: [string, string][] = [
      ["inbox.post", "post"],
      ["rules.create", "draft"],
      ["payees.save", "configure"],
      ["periods.prepare", "close"],
      ["inbox.recategorize", "correct"],
      ["members.add", "provision"],
    ];
    for (const [operation, permission] of attempts) {
      const answer = await world.send(operation, {}, access);
      expect(answer.status, `${role} ${operation}`).toBe(403);
      expect(answer.body.error.code, `${role} ${operation}`).toBe(
        (held as readonly string[]).includes(permission)
          ? "workspace_read_only"
          : "permission_denied",
      );
    }
  }
  const said = await world.send("rules.create", {}, world.access(1));
  expect(said.body.error.message).toContain("read-only until it is subscribed");
  expect(said.body.error.message).toContain("export");
});

test("a refusal because the book is read-only names the operation it was sent for, so that a client that keeps its writes by identity can tell which one was refused", async () => {
  const world = await fixture();
  await world.readOnly(true);
  const identity = "00000000-0000-4000-8000-0000000000aa";
  const response = await world.http.fetch(
    new Request("http://127.0.0.1:4010/v1/rules.create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: "local-book",
        input: {},
        operationId: identity,
      }),
    }),
    world.access(1),
  );
  const answer = (await response.json()) as Json;
  expect(response.status).toBe(403);
  expect(answer).toMatchObject({
    ok: false,
    operationId: identity,
    error: { code: "workspace_read_only", retryable: false },
  });
  // A body that cannot be read, or that names no identity, still gets the plain refusal.
  for (const body of ["not json", JSON.stringify({ input: {}, operationId: "not-a-uuid" })]) {
    const odd = await world.http.fetch(
      new Request("http://127.0.0.1:4010/v1/rules.create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      world.access(1),
    );
    const refused = (await odd.json()) as Json;
    expect(odd.status).toBe(403);
    expect(refused.error.code).toBe("workspace_read_only");
    expect(refused).not.toHaveProperty("operationId");
  }
});

test("what a read-only book answers is worked out from the catalog: every read, the export, and no write", async () => {
  const world = await fixture();
  await world.readOnly(true);
  const allowed = world.access(1).operations ?? [];
  expect(allowed.length).toBeGreaterThan(50);
  for (const operation of operationCatalog) {
    const answers = allowed.includes(operation.name);
    const should =
      (operation.permission === "read" && !operation.writes) || operation.name === "export.create";
    expect(answers, operation.name).toBe(should);
  }
  expect(allowed).toContain("export.create");
  expect(allowed).not.toContain("book.access");
  expect(allowed).not.toContain("members.add");
});

test("an agent key speaks for its person, so it is cut the same way", async () => {
  const world = await fixture();
  const key = {
    keyId: "rsa_0123456789abcdef",
    scopes: ["read", "draft", "post", "configure"],
    name: "Bookkeeping agent",
    expiresAt: "2027-01-01T00:00:00.000Z",
  };
  const open = world.http.agentAccess(user(1), key);
  expect(open?.permissions).toEqual(["read", "draft", "post", "configure"]);
  await world.readOnly(true);
  const cut = world.http.agentAccess(user(1), key);
  expect(cut?.permissions).toEqual(["read", "configure"]);
  expect(cut?.operations).toEqual(world.access(1).operations);
  expect(cut?.readOnly?.since).toBe(START.toISOString());
  if (cut === null || cut === undefined) throw new Error("the key has no access");
  expect((await world.send("accounts.list", {}, cut)).status).toBe(200);
  const refused = await world.send("rules.create", {}, cut);
  expect(refused.body.error.code).toBe("workspace_read_only");
});

test("lifting it restores everyone at once, asking for what is so changes nothing, and nobody was taken out or changed", async () => {
  const world = await fixture();
  const before = memberState(world.service).list();
  await world.readOnly(true);
  world.tick(3_600_000);
  // The time is the first's, however often it is said.
  const again = await world.readOnly(true);
  expect(again.body.data).toEqual({ readOnly: true, readOnlySince: START.toISOString() });
  // The control plane still manages who is in a read-only workspace (a person leaves; a person is invited), as its own key and unaffected.
  const added = await world.add(5, "member");
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  const lifted = await world.readOnly(false);
  expect(lifted.body.data).toEqual({ readOnly: false, readOnlySince: null });
  expect((await world.readOnly(false)).body.data).toEqual({ readOnly: false, readOnlySince: null });
  for (const [n, role] of ROLES) {
    const access = world.access(n);
    expect(access.permissions, role).toEqual(ROLE_PERMISSIONS[role]);
    expect(access.readOnly, role).toBeUndefined();
  }
  expect(memberState(world.service).list().slice(0, before.length)).toEqual(before);
  // A new lapse starts a new time.
  world.tick(60_000);
  expect((await world.readOnly(true)).body.data.readOnlySince).toBe(
    new Date(START.getTime() + 3_600_000 + 60_000).toISOString(),
  );
});

test("a read-only book can still be exported, and the zip is fetched", async () => {
  const root = mkdtempSync(join(tmpdir(), "rastrata-read-only-export-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const f = await safetyFixture({
    directory: root,
    open: { safety: false, exports: { directory: join(root, "scratch", "exports") } },
  });
  await f.post(2, "R");
  const http = new ApplicationHttp(f.service, {
    bookId: f.service.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  const control = http.serviceAccess("control");
  const call = async (name: string, input: unknown, as: ApplicationAccess, id: string) => {
    const response = await http.fetch(
      new Request(`http://127.0.0.1:4010/v1/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: "local-book",
          input,
          operationId: id,
        }),
      }),
      as,
    );
    return { status: response.status, body: (await response.json()) as Json };
  };
  await call(
    "members.add",
    { userId: user(1), email: "owner@example.com", role: "owner" },
    control,
    operationId(),
  );
  await call("book.access", { readOnly: true }, control, operationId());
  const owner = http.memberAccess(user(1));
  if (owner === null) throw new Error("the owner is not in the book");
  expect(owner.readOnly).toBeDefined();

  const id = operationId();
  let job: Json | undefined;
  for (let attempt = 0; attempt < 600; attempt++) {
    const made = await call("export.create", {}, owner, id);
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    if (made.body.data.state !== "running") {
      job = made.body.data;
      break;
    }
    await Bun.sleep(50);
  }
  expect(job?.state).toBe("done");
  const exportId = job?.export?.id as string;
  expect(typeof exportId).toBe("string");
  const zip = await http.fetch(new Request(`http://127.0.0.1:4010/v1/exports/${exportId}`), owner);
  expect(zip.status).toBe(200);
  expect(zip.headers.get("content-type")).toBe("application/zip");
  // And nothing else that writes: the book's own entries cannot be added while it is read-only.
  const refused = await call("inbox.post", {}, owner, operationId());
  expect(refused.body.error.code).toBe("workspace_read_only");
});
