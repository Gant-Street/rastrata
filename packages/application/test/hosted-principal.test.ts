import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueOwnerKey } from "../src/agent/token.ts";
import {
  type HostedService,
  openHostedService,
  PRINCIPAL_HEADER,
  vouch,
} from "../src/local/hosted.ts";
import { APPLICATION_API_VERSION } from "../src/schema.ts";

const SECRET = "process-secret-process-secret-process-secret-1234";
// biome-ignore lint/suspicious/noExplicitAny: decoded JSON in a test
type Json = Record<string, any>;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

let counter = 0;
async function open(
  principalSecret: string | null = SECRET,
): Promise<{ hosted: HostedService; key: string }> {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-vouch-"));
  const db = new Database(":memory:");
  const key = issueOwnerKey();
  const hosted = await openHostedService(db, directory, {
    ownerKey: key,
    ...(principalSecret ? { principalSecret } : {}),
  });
  cleanup.push(() => {
    hosted.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { hosted, key };
}

const call = (
  hosted: HostedService,
  name: string,
  input: unknown,
  headers: Record<string, string>,
) =>
  hosted
    .fetch(
      new Request(`http://127.0.0.1:4010/v1/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: "local-book",
          input,
          operationId: `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
        }),
      }),
    )
    .then(async (response) => ({
      status: response.status,
      body: (await response.json()) as Json,
    }));

const control = { [PRINCIPAL_HEADER]: vouch(SECRET, { kind: "service", name: "control" }) };
const member = (n: number) => ({
  [PRINCIPAL_HEADER]: vouch(SECRET, {
    kind: "member",
    userId: `user_${String(n).padStart(10, "0")}`,
  }),
});

test("the process that serves the book can say who is calling, with its own secret, and the application then acts for them", async () => {
  const { hosted } = await open();
  const added = await call(
    hosted,
    "members.add",
    { userId: "user_0000000001", email: "a@example.com", role: "owner" },
    control,
  );
  expect(added.status).toBe(200);
  // A person it vouches for who is in the book is let in as their role; one who is not is told so.
  const listed = await call(hosted, "members.list", {}, member(1));
  expect(listed.status).toBe(200);
  expect(listed.body.data.members).toHaveLength(1);
  const stranger = await call(hosted, "members.list", {}, member(2));
  expect(stranger.status).toBe(403);
  expect(stranger.body.error).toMatchObject({ code: "not_a_member", retryable: false });
  // A person's access is theirs: the owner of the workspace may add a member through the book, a lesser role may not.
  await call(
    hosted,
    "members.add",
    { userId: "user_0000000002", email: "b@example.com", role: "accountant" },
    control,
  );
  const refused = await call(
    hosted,
    "members.add",
    { userId: "user_0000000003", email: "c@example.com", role: "member" },
    member(2),
  );
  expect(refused.status).toBe(403);
  expect(refused.body.error.code).toBe("permission_denied");
});

test("a vouching that does not carry the process's secret is refused, whatever it names, and so is any when the process has no secret", async () => {
  const { hosted } = await open();
  for (const header of [
    "wrong-secret.service.control",
    `${SECRET}.service`,
    `${SECRET}.root.control`,
    `${SECRET}.member.user_0000000001.extra`,
    "",
    ".service.control",
  ]) {
    const refused = await call(hosted, "members.list", {}, { [PRINCIPAL_HEADER]: header });
    expect(refused.status, header).toBe(401);
    expect(refused.body.error.code).toBe("token_invalid");
  }
  const { hosted: bare } = await open(null);
  const without = await call(bare, "members.list", {}, control);
  expect(without.status).toBe(401);
});

test("the header goes no further than the application: what it vouched for is not left for a handler to read", async () => {
  const { hosted, key } = await open();
  // The owner key with a header that names a service is the owner's own request, not the service's: the header is a vouching or it is nothing.
  const answer = await call(hosted, "members.list", {}, { authorization: `Bearer ${key}` });
  expect(answer.status).toBe(200);
  await call(
    hosted,
    "members.add",
    { userId: "user_0000000001", email: "a@example.com", role: "owner" },
    control,
  );
  const seen = await call(hosted, "book.get", {}, { ...member(1), authorization: `Bearer ${key}` });
  // `book.get` is not an operation a vouched member can call before the book is set up, but it is the member's request all the same.
  expect(seen.body.data?.principal ?? seen.body.data?.member).toBeDefined();
  expect(JSON.stringify(seen.body)).not.toContain(SECRET);
});

// ---- an agent key the process has vouched for ---------------------------------------------------------------------------------

const BOOK = {
  name: "Agents Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Cash", role: "asset" },
    { code: "3000", name: "Capital", role: "equity" },
    { code: "5000", name: "Supplies", role: "expense" },
  ],
};
const KEY_ID = "0123456789abcdef";
const ENDS = Math.floor(Date.parse("2027-01-13T12:00:00Z") / 1000);
const NAME = "Claude on my laptop";
const agent = (n: number, scopes: readonly string[], keyId = KEY_ID): Record<string, string> => ({
  [PRINCIPAL_HEADER]: vouch(SECRET, {
    kind: "agent",
    userId: `user_${String(n).padStart(10, "0")}`,
    keyId,
    scopes,
    name: NAME,
    expires: ENDS,
  }),
});
const DRAFT = {
  data: {
    date: "2026-03-02",
    reference: "agent-draft",
    narration: "agent-draft",
    lines: [
      { accountId: "5000", debit: "5.00", credit: "" },
      { accountId: "1000", debit: "", credit: "5.00" },
    ],
  },
};

async function bookWithPeople(): Promise<{ hosted: HostedService; key: string }> {
  const world = await open();
  expect(
    (await call(world.hosted, "book.setup", BOOK, { authorization: `Bearer ${world.key}` })).status,
  ).toBe(200);
  const add = (n: number, role: string) =>
    call(
      world.hosted,
      "members.add",
      { userId: `user_${String(n).padStart(10, "0")}`, email: `p${n}@example.com`, role },
      control,
    );
  expect((await add(1, "owner")).status).toBe(200);
  expect((await add(2, "accountant")).status).toBe(200);
  expect((await add(3, "member")).status).toBe(200);
  return world;
}

test("an agent key acts as the person who made it with the permissions it was given and no more, and the actor is the key", async () => {
  const { hosted } = await bookWithPeople();
  // Owner's key with read and draft: it reads, it drafts, and the book says it is a token (not a person) with those permissions only.
  const context = await call(hosted, "book.get", {}, agent(1, ["read", "draft"]));
  expect(context.status).toBe(200);
  expect(context.body.data.permissions).toEqual(["read", "draft"]);
  // The key is known by the name its person gave it and by its own end, as a token of the book is; the five minutes of the token it came in are not told to the book.
  expect(context.body.data.principal).toEqual({
    kind: "token",
    tokenId: KEY_ID,
    label: NAME,
    expiresAt: "2027-01-13T12:00:00.000Z",
  });
  expect(context.body.data.member).toBeUndefined();
  const drafted = await call(hosted, "drafts.create", DRAFT, agent(1, ["read", "draft"]));
  expect(drafted.status).toBe(200);
  // It does not post, though its person (the owner) may: the key was not given `post`.
  const posted = await call(hosted, "journal.post", DRAFT, agent(1, ["read", "draft"]));
  expect(posted.status).toBe(403);
  expect(posted.body.error.code).toBe("permission_denied");
  // Never what only the owner holds: a key cannot change who is in the book or make more keys, whatever it names.
  const added = await call(
    hosted,
    "members.add",
    { userId: "user_0000000009", email: "z@example.com", role: "member" },
    agent(1, ["read", "draft", "post", "configure", "correct", "close"]),
  );
  expect(added.status).toBe(403);
  const minted = await call(
    hosted,
    "tokens.create",
    { label: "more", permissions: ["read"] },
    agent(1, ["read", "draft", "post", "configure", "correct", "close"]),
  );
  expect(minted.status).toBe(403);
});

test("a key never has more than its person has now: a scope is cut by the role in the book, and a person who is gone or never was takes their keys with them", async () => {
  const { hosted } = await bookWithPeople();
  // A member's key given `post` still cannot post: a member may read and draft.
  const everything = ["read", "draft", "post", "configure", "correct", "close"];
  const context = await call(hosted, "book.get", {}, agent(3, everything));
  expect(context.body.data.permissions).toEqual(["read", "draft"]);
  expect((await call(hosted, "journal.post", DRAFT, agent(3, everything))).status).toBe(403);
  // An accountant's key keeps what an accountant has and what it was given.
  const accountant = await call(hosted, "book.get", {}, agent(2, ["read", "post", "configure"]));
  expect(accountant.body.data.permissions).toEqual(["read", "post"]);
  // A person who is not in the book (any more) is not let in by a key of theirs.
  const gone = await call(hosted, "book.get", {}, agent(7, ["read"]));
  expect(gone.status).toBe(403);
  expect(gone.body.error.code).toBe("not_a_member");
  await call(hosted, "members.remove", { userId: "user_0000000003" }, control);
  const removed = await call(hosted, "book.get", {}, agent(3, ["read"]));
  expect(removed.status).toBe(403);
  expect(removed.body.error.code).toBe("not_a_member");
});

test("what a key did is in the book's trail under the key's identifier, denied calls included", async () => {
  const { hosted, key } = await bookWithPeople();
  const owner = { authorization: `Bearer ${key}` };
  expect((await call(hosted, "drafts.create", DRAFT, agent(1, ["read", "draft"]))).status).toBe(
    200,
  );
  expect((await call(hosted, "journal.post", DRAFT, agent(1, ["read", "draft"]))).status).toBe(403);
  const trail = await call(hosted, "tokens.activity", {}, owner);
  expect(trail.status).toBe(200);
  const events = trail.body.data.events as {
    tokenId: string;
    operation: string;
    outcome: string;
  }[];
  expect(events.map((event) => [event.tokenId, event.operation, event.outcome])).toEqual([
    [KEY_ID, "journal.post", "denied"],
    [KEY_ID, "drafts.create", "ok"],
  ]);
});

test("a vouching for an agent that is not well formed is refused, and so is one of a book being deleted", async () => {
  const { hosted } = await bookWithPeople();
  const good = vouch(SECRET, {
    kind: "agent",
    userId: "user_0000000001",
    keyId: KEY_ID,
    scopes: ["read"],
    name: NAME,
    expires: ENDS,
  });
  const name = Buffer.from(NAME).toString("base64url");
  for (const header of [
    `${SECRET}.agent.user_0000000001`,
    `${SECRET}.agent.user_0000000001.${KEY_ID}.read`,
    `${SECRET}.agent.user_0000000001.${KEY_ID}.read.${ENDS}`,
    `${SECRET}.agent.user_0000000001.${KEY_ID}.read.${ENDS}.${name}.extra`,
    `${SECRET}.agent.user_0000000001.NOTAKEYID.read.${ENDS}.${name}`,
    `${SECRET}.agent.user_0000000001.${KEY_ID}.read.soon.${name}`,
    // A name that is not a name: empty, padded, two lines, not base64url at all.
    `${SECRET}.agent.user_0000000001.${KEY_ID}.read.${ENDS}.`,
    `${SECRET}.agent.user_0000000001.${KEY_ID}.read.${ENDS}.${Buffer.from(" padded ").toString("base64url")}`,
    `${SECRET}.agent.user_0000000001.${KEY_ID}.read.${ENDS}.${Buffer.from("two\nlines").toString("base64url")}`,
    `${SECRET}.agent.user_0000000001.${KEY_ID}.read.${ENDS}.not*base64`,
    good.replace(SECRET, "wrong-secret"),
  ]) {
    const refused = await call(hosted, "book.get", {}, { [PRINCIPAL_HEADER]: header });
    expect(refused.status, header).toBe(401);
  }
  expect((await call(hosted, "book.get", {}, { [PRINCIPAL_HEADER]: good })).status).toBe(200);
  // A book that is being deleted lets nobody in, a key included, and says why.
  expect((await call(hosted, "book.retire", {}, control)).status).toBe(200);
  const retired = await call(hosted, "book.get", {}, { [PRINCIPAL_HEADER]: good });
  expect(retired.status).toBe(410);
  expect(retired.body.error.code).toBe("book_retired");
});
