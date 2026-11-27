import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ROLE_PERMISSIONS,
  SERVICE_CALL,
  WORKSPACE_ROLES,
  type WorkspaceRole,
} from "../src/agent/member.ts";
import type { ApplicationAccess } from "../src/agent/principal.ts";
import { issueOwnerKey, issueToken } from "../src/agent/token.ts";
import { ApplicationHttp } from "../src/http.ts";
import { LocalBookService } from "../src/local.ts";
import { LOCAL_BOOK_SCOPE } from "../src/local/ledger.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../src/schema.ts";
import { memberState } from "../src/slices/members/store.ts";

const book = {
  name: "Members Co",
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
});

let counter = 0;
const operationId = (): string => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const user = (n: number): string => `user_${String(n).padStart(10, "0")}`;

async function fixture(options: { ownerKey?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-members-"));
  const service = await LocalBookService.open(join(directory, "book.sqlite"));
  let now = START;
  const http = new ApplicationHttp(
    service,
    { bookId: service.bookId, permissions: BUSINESS_PERMISSIONS },
    { clock: () => now, ...(options.ownerKey ? { ownerKey: options.ownerKey } : {}) },
  );
  cleanup.push(() => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function send(
    name: string,
    input: unknown,
    as?: ApplicationAccess,
    extra: { credential?: string; id?: string | null } = {},
  ) {
    const id = extra.id === null ? undefined : (extra.id ?? operationId());
    const response = await http.fetch(
      new Request(`http://127.0.0.1:4010/v1/${name}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(extra.credential ? { authorization: `Bearer ${extra.credential}` } : {}),
        },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: "local-book",
          input,
          ...(id ? { operationId: id } : {}),
        }),
      }),
      as,
    );
    return { status: response.status, body: (await response.json()) as Json };
  }
  const control = http.serviceAccess("control");
  const add = (n: number, role: WorkspaceRole, email = `person${n}@example.com`) =>
    send("members.add", { userId: user(n), email, role }, control);
  return {
    service,
    http,
    send,
    control,
    add,
    tick: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    memberAccess: (n: number) => http.memberAccess(user(n)),
  };
}

test("the control plane fills the member table before the owner has set the book up, and nothing else works before setup", async () => {
  const world = await fixture();
  const added = await world.add(1, "owner", "Ann@Example.com");
  expect(added.status).toBe(200);
  expect(added.body.data).toMatchObject({
    userId: user(1),
    email: "ann@example.com",
    role: "owner",
  });
  // The book is not set up: the people are readable, and other operations still say the book is not configured.
  const listed = await world.send("members.list", {}, world.control, { id: null });
  expect(listed.status).toBe(200);
  expect(listed.body.data.members).toHaveLength(1);
  const other = await world.send("accounts.list", {}, undefined, { id: null });
  expect(other.status).toBe(409);
  expect(other.body.error.code).toBe("book_not_configured");
  // The control plane's own access never reaches an operation that is not about who is in the book, set up or not.
  const refused = await world.send("accounts.list", {}, world.control, { id: null });
  expect(refused.status).toBe(403);
  expect(refused.body.error.code).toBe("permission_denied");
});

test("adding a person twice, by a retry or by asking again, changes nothing the second time", async () => {
  const world = await fixture();
  const id = operationId();
  const first = await world.send(
    "members.add",
    { userId: user(2), email: "bo@example.com", role: "member" },
    world.control,
    { id },
  );
  const retried = await world.send(
    "members.add",
    { userId: user(2), email: "bo@example.com", role: "member" },
    world.control,
    { id },
  );
  expect(retried.body).toEqual(first.body);
  expect(memberState(world.service).list()).toHaveLength(1);

  world.tick(60_000);
  const again = await world.add(2, "member", "bo@example.com");
  expect(again.body.data.changedAt).toBe(first.body.data.changedAt);
  // A new address or a new role is a change, and says who made it.
  world.tick(60_000);
  const moved = await world.add(2, "accountant", "bo@elsewhere.example");
  expect(moved.body.data).toMatchObject({ email: "bo@elsewhere.example", role: "accountant" });
  expect(moved.body.data.changedAt).not.toBe(first.body.data.changedAt);
  expect(moved.body.data.addedAt).toBe(first.body.data.addedAt);
  expect(memberState(world.service).get(user(2))?.changedBy).toBe("service:control");
  expect(memberState(world.service).get(user(2))?.addedBy).toBe("service:control");
});

test("each role is what the table says: its permissions, its principal, and the book says who they are without widening what it named", async () => {
  const world = await fixture();
  await world.send("book.setup", book, undefined);
  for (const [at, role] of WORKSPACE_ROLES.entries()) await world.add(10 + at, role);
  for (const [at, role] of WORKSPACE_ROLES.entries()) {
    const access = world.memberAccess(10 + at);
    expect(access?.principal).toEqual({ kind: "member", userId: user(10 + at), role });
    expect(access?.permissions).toEqual(ROLE_PERMISSIONS[role]);
    const context = await world.send("book.get", {}, access ?? undefined, { id: null });
    expect(context.status).toBe(200);
    expect(context.body.data.member).toEqual({ userId: user(10 + at), role });
    // The frozen choice of two kinds is not widened: a member is told by `member`, and `principal` is absent.
    expect(context.body.data.principal).toBeUndefined();
    expect(context.body.data.permissions).toEqual(ROLE_PERMISSIONS[role]);
  }
  // The owner and an agent are told as they always were.
  const owner = await world.send("book.get", {}, undefined, { id: null });
  expect(owner.body.data.principal).toEqual({ kind: "owner" });
  expect(owner.body.data.member).toBeUndefined();
});

test("what a member may do is what their role allows, and members never change who is in the book unless they are the owner", async () => {
  const world = await fixture();
  await world.send("book.setup", book, undefined);
  await world.add(1, "owner");
  await world.add(2, "admin");
  await world.add(3, "accountant");
  await world.add(4, "member");
  const as = (n: number) => world.memberAccess(n) ?? undefined;

  // Reading: everyone.
  for (const n of [1, 2, 3, 4])
    expect((await world.send("accounts.list", {}, as(n), { id: null })).status, `reader ${n}`).toBe(
      200,
    );
  const list = await world.send("members.list", {}, as(4), { id: null });
  expect(list.body.data.members.map((m: { role: string }) => m.role)).toEqual([
    "owner",
    "admin",
    "accountant",
    "member",
  ]);

  // `configure` (changing the chart): the owner and an admin, not an accountant or a member.
  const create = (n: number) =>
    world.send(
      "accounts.prepareCreate",
      { code: "5000", name: "Supplies", role: "expense", effectiveOn: "2026-10-01" },
      as(n),
    );
  expect((await create(4)).status).toBe(403);
  expect((await create(3)).status).toBe(403);
  expect((await create(2)).status).toBe(200);
  expect((await create(1)).status).toBe(200);
  expect((await create(4)).body.error.code).toBe("permission_denied");

  // `provision` (who is in the book): the owner, and nobody below.
  for (const n of [2, 3, 4]) {
    const refused = await world.send(
      "members.add",
      { userId: user(20), email: "x@example.com", role: "member" },
      as(n),
    );
    expect(refused.status, `member ${n}`).toBe(403);
    expect(refused.body.error.code).toBe("permission_denied");
  }
  expect(
    (
      await world.send(
        "members.add",
        { userId: user(20), email: "x@example.com", role: "member" },
        as(1),
      )
    ).status,
  ).toBe(200);
});

test("an agent token, which can never hold provision, cannot change who is in the book either", async () => {
  const key = issueOwnerKey();
  const world = await fixture({ ownerKey: key });
  await world.send("book.setup", book, undefined, { credential: key });
  const created = await world.send(
    "tokens.create",
    { label: "bot", permissions: ["read", "draft", "post"] },
    undefined,
    { credential: key },
  );
  const token = created.body.data.secret as string;
  const refused = await world.send(
    "members.add",
    { userId: user(30), email: "y@example.com", role: "owner" },
    undefined,
    { credential: token },
  );
  expect(refused.status).toBe(403);
  expect(refused.body.error.code).toBe("permission_denied");
  expect(memberState(world.service).list()).toHaveLength(0);
  void issueToken;
});

test("a removed member has no access, and coming back is the same row", async () => {
  const world = await fixture();
  await world.add(1, "owner");
  await world.add(2, "member");
  const before = memberState(world.service).get(user(2));
  world.tick(1000);
  const removed = await world.send("members.remove", { userId: user(2) }, world.control);
  expect(removed.body.data).toEqual({ userId: user(2), removed: true });
  expect(world.memberAccess(2)).toBeNull();
  expect(
    memberState(world.service)
      .list()
      .map((m) => m.userId),
  ).toEqual([user(1)]);
  // Taking out someone who is not in changes nothing, and says so.
  const again = await world.send("members.remove", { userId: user(2) }, world.control);
  expect(again.body.data).toEqual({ userId: user(2), removed: false });
  expect(
    (await world.send("members.remove", { userId: user(99) }, world.control)).body.data.removed,
  ).toBe(false);

  world.tick(1000);
  await world.add(2, "accountant");
  expect(world.memberAccess(2)?.principal).toMatchObject({ role: "accountant" });
  expect(memberState(world.service).get(user(2))?.addedAt).not.toBe(before?.addedAt);
});

test("a workspace always has an owner: the only one cannot be demoted or taken out, and a second owner makes it possible", async () => {
  const world = await fixture();
  await world.add(1, "owner");
  await world.add(2, "admin");
  const refusals = [
    await world.send("members.setRole", { userId: user(1), role: "admin" }, world.control),
    await world.send("members.remove", { userId: user(1) }, world.control),
    await world.add(1, "member"),
  ];
  for (const refusal of refusals) {
    expect(refusal.status).toBe(409);
    expect(refusal.body.error.code).toBe("last_owner");
  }
  expect(memberState(world.service).get(user(1))?.role).toBe("owner");

  await world.send("members.setRole", { userId: user(2), role: "owner" }, world.control);
  expect(
    (await world.send("members.setRole", { userId: user(1), role: "admin" }, world.control)).status,
  ).toBe(200);
  // Now user 2 is the only owner.
  expect((await world.send("members.remove", { userId: user(2) }, world.control)).status).toBe(409);
});

test("a role that is not one, an address that is not one, and a person who is not in the book are refused plainly", async () => {
  const world = await fixture();
  await world.add(1, "owner");
  for (const input of [
    { userId: user(5), email: "z@example.com", role: "superuser" },
    { userId: user(5), email: "not an address", role: "member" },
    { userId: user(5), email: "z@example.com" },
    { userId: "x y", email: "z@example.com", role: "member" },
    { userId: user(5), email: "z@example.com", role: "member", extra: 1 },
  ]) {
    const refused = await world.send("members.add", input, world.control);
    expect(refused.status, JSON.stringify(input)).toBe(400);
  }
  const missing = await world.send(
    "members.setRole",
    { userId: user(77), role: "admin" },
    world.control,
  );
  expect(missing.status).toBe(404);
  expect(missing.body.error.code).toBe("member_not_found");
  expect(memberState(world.service).list()).toHaveLength(1);
});

test("the browser's older routes, which have no permissions, are the owner's alone", async () => {
  const world = await fixture();
  await world.add(1, "owner");
  const legacy = (as?: ApplicationAccess) =>
    world.http.guardLegacy(new Request("http://127.0.0.1:4010/api/book"), as);
  expect(await legacy()).toBeNull();
  for (const access of [world.memberAccess(1), world.control]) {
    const refusal = await legacy(access ?? undefined);
    if (!refusal) throw new Error("the older browser routes let a non-owner through");
    expect(refusal.status).toBe(403);
    expect(((await refusal.json()) as { code: string }).code).toBe("scope_denied");
  }
});

test("a member's request is the member's whatever Authorization header it carries, and leaves no agent activity", async () => {
  const key = issueOwnerKey();
  const world = await fixture({ ownerKey: key });
  await world.send("book.setup", book, undefined, { credential: key });
  await world.add(1, "owner");
  const as = world.memberAccess(1) ?? undefined;
  const answer = await world.send("book.get", {}, as, {
    credential: "rst_0000000000000000_garbage",
    id: null,
  });
  expect(answer.status).toBe(200);
  expect(answer.body.data.member).toMatchObject({ userId: user(1) });
  const activity = await world.send("tokens.activity", {}, undefined, {
    credential: key,
    id: null,
  });
  expect(activity.body.data.count).toBe(0);
  // Without the runtime's word, no credentials is no access.
  const none = await world.send("book.get", {}, undefined, { id: null });
  expect(none.status).toBe(401);
});

test("every access the runtime hands out is a subset of its own, and a person who is not in the book gets none", async () => {
  const world = await fixture();
  expect(world.memberAccess(1)).toBeNull();
  await world.add(1, "owner");
  for (const access of [world.memberAccess(1), world.control]) {
    for (const permission of access?.permissions ?? [])
      expect(BUSINESS_PERMISSIONS).toContain(permission);
  }
  // The control plane's key reads, provisions, and drafts: it may draft only for Stripe's answers (stripe.receive and the upload of a bundle), which its list of operations and the upload's own check hold to.
  expect(world.control.permissions).toEqual(["read", "provision", "draft"]);
  expect(world.control.operations).toContain("stripe.receive");
  expect(world.control.operations).not.toContain("stripe.sync");
  expect(world.control.operations).not.toContain("inbox.post");
  expect(world.control.principal).toEqual({ kind: "service", name: "control" });
});

test("the constants the control plane speaks to a pod with are the application's own", () => {
  // The Worker that makes the call carries these, not the application's schema; this holds them to it.
  expect(SERVICE_CALL.version).toBe(APPLICATION_API_VERSION);
  expect(LOCAL_BOOK_SCOPE.bookId).toBe(SERVICE_CALL.applicationBookId);
  expect(SERVICE_CALL.bookHeader).toBe("x-rastrata-book");
});

test("a book being deleted lets no member in and keeps the people as they were, and the control plane's key can say so, read it, and take it back", async () => {
  const world = await fixture();
  await world.send("book.setup", book, undefined);
  await world.add(1, "owner");
  await world.add(2, "admin");
  await world.add(3, "member");
  const before = memberState(world.service).list();
  expect(world.http.retired()).toBe(false);
  expect(
    (await world.send("members.list", {}, world.control, { id: null })).body.data.retiredAt,
  ).toBeNull();

  const retired = await world.send("book.retire", {}, world.control);
  expect(retired.status, JSON.stringify(retired.body)).toBe(200);
  expect(retired.body.data).toEqual({ retired: true, retiredAt: START.toISOString() });
  expect(world.http.retired()).toBe(true);
  // Nobody is let in: not the owner, not an admin, not a member; each is the same refusal at the door, which asks the application only whether the person has access.
  for (const n of [1, 2, 3]) expect(world.memberAccess(n), `person ${n}`).toBeNull();
  // The people and what they were are as they were: nobody was taken out and nobody was changed.
  expect(memberState(world.service).list()).toEqual(before);
  // The control plane's key still reads who is in and says the book is retired, and can take it back.
  const listed = await world.send("members.list", {}, world.control, { id: null });
  expect(listed.body.data.members).toHaveLength(3);
  expect(listed.body.data.retiredAt).toBe(START.toISOString());

  // Asking again, later, is the same answer with the first time in it.
  world.tick(3_600_000);
  const again = await world.send("book.retire", {}, world.control);
  expect(again.body.data).toEqual({ retired: true, retiredAt: START.toISOString() });
  // The same request sent again (a retry) is the same answer too.
  const id = operationId();
  const first = await world.send("book.retire", {}, world.control, { id });
  expect(await world.send("book.retire", {}, world.control, { id })).toEqual(first);

  const restored = await world.send("book.unretire", {}, world.control);
  expect(restored.body.data).toEqual({ retired: false, retiredAt: null });
  expect(world.http.retired()).toBe(false);
  for (const n of [1, 2, 3]) expect(world.memberAccess(n), `person ${n}`).not.toBeNull();
  expect(world.memberAccess(2)?.principal).toEqual({
    kind: "member",
    userId: user(2),
    role: "admin",
  });
  expect(memberState(world.service).list()).toEqual(before);
  // Restoring a book that is not retired changes nothing, and retiring it again starts a new time.
  expect((await world.send("book.unretire", {}, world.control)).body.data).toEqual({
    retired: false,
    retiredAt: null,
  });
  world.tick(60_000);
  expect((await world.send("book.retire", {}, world.control)).body.data.retiredAt).toBe(
    new Date(START.getTime() + 3_600_000 + 60_000).toISOString(),
  );
});

test("only who holds provision can retire a book or take it back: the owner and the control plane's key, never a person below the owner, never an agent's token", async () => {
  const key = issueOwnerKey();
  const world = await fixture({ ownerKey: key });
  await world.send("book.setup", book, undefined, { credential: key });
  await world.add(1, "owner");
  await world.add(2, "admin");
  await world.add(3, "accountant");
  await world.add(4, "member");
  for (const name of ["book.retire", "book.unretire"])
    for (const n of [2, 3, 4]) {
      const refused = await world.send(name, {}, world.memberAccess(n) ?? undefined);
      expect(refused.status, `${name} by ${n}`).toBe(403);
      expect(refused.body.error.code).toBe("permission_denied");
    }
  expect(world.http.retired()).toBe(false);
  const created = await world.send(
    "tokens.create",
    { label: "bot", permissions: ["read", "draft", "post"] },
    undefined,
    { credential: key },
  );
  const refusedByToken = await world.send("book.retire", {}, undefined, {
    credential: created.body.data.secret as string,
  });
  expect(refusedByToken.status).toBe(403);
  expect(world.http.retired()).toBe(false);
  // The owner, as a member, may (the control plane acts for them), and so may the owner's key.
  expect((await world.send("book.retire", {}, world.memberAccess(1) ?? undefined)).status).toBe(
    200,
  );
  expect(world.http.retired()).toBe(true);
  expect((await world.send("book.unretire", {}, undefined, { credential: key })).status).toBe(200);
  expect(world.http.retired()).toBe(false);
});

test("a book can be retired before the owner has set it up (a workspace deleted at once), and the control plane's key still reaches nothing but the people of a book and its retirement", async () => {
  const world = await fixture();
  await world.add(1, "owner");
  expect((await world.send("book.retire", {}, world.control)).status).toBe(200);
  expect((await world.send("book.unretire", {}, world.control)).status).toBe(200);
  const refused = await world.send("accounts.list", {}, world.control, { id: null });
  expect(refused.status).toBe(403);
});

test("taking a person out erases their address from the book and keeps their number and the times; the only owner of a book being deleted can be taken out, of any other cannot", async () => {
  const world = await fixture();
  await world.send("book.setup", book, undefined);
  await world.add(1, "owner", "ann@example.com");
  await world.add(2, "member", "mo@example.com");
  const row = (n: number) =>
    world.service.store.query("SELECT * FROM members WHERE user_id = ?").get(user(n)) as Json;
  expect(row(2)).toMatchObject({ email: "mo@example.com", removed_at: null });
  world.tick(1000);
  expect((await world.send("members.remove", { userId: user(2) }, world.control)).status).toBe(200);
  // Out: the row says who and when, and not who they were.
  expect(row(2)).toMatchObject({
    user_id: user(2),
    email: "",
    role: "member",
    changed_by: "service:control",
  });
  expect(row(2).removed_at).toBe(new Date(START.getTime() + 1000).toISOString());
  expect(JSON.stringify(world.service.store.query("SELECT * FROM members").all())).not.toContain(
    "mo@example.com",
  );
  // Taking out someone already out changes nothing, and the address stays gone.
  world.tick(1000);
  await world.send("members.remove", { userId: user(2) }, world.control);
  expect(row(2).email).toBe("");
  expect(row(2).removed_at).toBe(new Date(START.getTime() + 1000).toISOString());
  // Back in, they have the address they are given now.
  await world.add(2, "member", "mo@new.example.com");
  expect(row(2)).toMatchObject({ email: "mo@new.example.com", removed_at: null });

  // The only owner: refused while the book is in use; allowed once it is being deleted (nobody is let in), and the address goes with them.
  const refused = await world.send("members.remove", { userId: user(1) }, world.control);
  expect(refused.status).toBe(409);
  expect(refused.body.error.code).toBe("last_owner");
  expect(row(1).email).toBe("ann@example.com");
  expect((await world.send("book.retire", {}, world.control)).status).toBe(200);
  expect((await world.send("members.remove", { userId: user(1) }, world.control)).status).toBe(200);
  expect(row(1)).toMatchObject({ email: "", role: "owner" });
  expect(row(1).removed_at).not.toBeNull();
  // Bringing the book back does not bring the owner back: someone has to be put in.
  await world.send("book.unretire", {}, world.control);
  expect(world.memberAccess(1)).toBeNull();
});
