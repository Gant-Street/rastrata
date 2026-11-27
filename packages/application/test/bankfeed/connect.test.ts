import { afterEach, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type CredentialStore, memoryCredentialStore } from "../../src/bankfeed/credentials.ts";
import { configureBankfeedRuntime } from "../../src/slices/bankfeed/runtime.ts";
import { FIXTURE_PASSWORD, FIXTURE_USER } from "./fake-bridge.ts";
import { closeWorlds, uuid, world } from "./support.ts";

afterEach(closeWorlds);

/** Everything a credential can be spelled as: none of it may be found anywhere but the one private file. */
const secretsOf = (setupToken: string): string[] => [
  FIXTURE_PASSWORD,
  FIXTURE_USER,
  btoa(`${FIXTURE_USER}:${FIXTURE_PASSWORD}`),
  `${FIXTURE_USER}:${FIXTURE_PASSWORD}@`,
  setupToken,
  atob(setupToken),
];

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

test("connecting claims the token once and keeps the access URL in a private file, and nothing else", async () => {
  const w = await world();
  const token = w.bridge.setupToken();
  const reply = await w.call("bankfeed.connect", { setupToken: token }, uuid());
  expect(reply.status).toBe(200);
  expect(reply.body.data).toMatchObject({
    connected: true,
    host: "beta-bridge.simplefin.org",
    accountsError: null,
  });
  expect(reply.body.data.accounts.map((a: { id: string }) => a.id)).toEqual([
    "ACT-checking-0001",
    "ACT-savings-0002",
  ]);
  // One claim, one listing of balances only.
  expect(w.bridge.requests("claim")).toHaveLength(1);
  const listing = w.bridge.requests("accounts");
  expect(listing).toHaveLength(1);
  expect(listing[0]?.query["balances-only"]).toEqual(["1"]);
  // The file: where the book is, readable by its owner only, holding the access URL.
  const mode = statSync(w.credentialPath).mode & 0o777;
  expect(mode).toBe(0o600);
  expect(readFileSync(w.credentialPath, "utf8").trim()).toBe(w.bridge.accessUrl());
  // The answer to the call, to a later status and to every other call carries no secret.
  const status = await w.ok("bankfeed.status", {});
  for (const body of [JSON.stringify(reply.body), JSON.stringify(status)])
    for (const secret of secretsOf(token)) expect(body).not.toContain(secret);
  expect(status.connected).toBe(true);
  expect(status.credential).toEqual({
    present: true,
    host: "beta-bridge.simplefin.org",
    problem: null,
  });
});

test("the credential is in no file of the data directory but its own, not even the book or its journals", async () => {
  const w = await world({ connected: true });
  // Give the book rows in every table this lane writes.
  const accounts = await w.ok("accounts.list", {});
  const checkingId = accounts.accounts.find((a: { code: string }) => a.code === "1000").id;
  await w.ok("bankfeed.link", { accountId: "ACT-checking-0001", ledgerAccountId: checkingId });
  await w.ok("bankfeed.sync", {});
  await w.ok("bankfeed.settings", { dailySync: true, dailyAt: "06:17" });
  const token = w.bridge.setupToken();
  const checked: string[] = [];
  for (const file of filesUnder(w.directory)) {
    if (file === w.credentialPath) continue;
    const bytes = readFileSync(file);
    const text = bytes.toString("latin1");
    for (const secret of secretsOf(token))
      expect(text.includes(secret), `${file} holds a secret`).toBe(false);
    checked.push(file);
  }
  // The book itself was among the files read.
  expect(checked.some((file) => file.endsWith("book.sqlite"))).toBe(true);
});

test("a second connect while one works is refused, and nothing is claimed", async () => {
  const w = await world({ connected: true });
  const before = w.bridge.log.length;
  const again = await w.call(
    "bankfeed.connect",
    { setupToken: w.bridge.setupToken("ANOTHER-CODE-0002") },
    uuid(),
  );
  expect(again.status).toBe(409);
  expect(again.body.error.code).toBe("bankfeed_already_connected");
  expect(w.bridge.log.length).toBe(before);
});

test("a setup token that is not one, or points elsewhere, is refused before anything is sent", async () => {
  const w = await world();
  const garbage = await w.call(
    "bankfeed.connect",
    { setupToken: "this is not a setup token at all really" },
    uuid(),
  );
  expect(garbage.status).toBe(400);
  expect(garbage.body.error.code).toBe("bankfeed_token_invalid");
  expect(JSON.stringify(garbage.body)).not.toContain("this is not a setup token");
  const evil = btoa("https://evil.example/simplefin/claim/AB-CD-1234");
  const refused = await w.call("bankfeed.connect", { setupToken: evil }, uuid());
  expect(refused.status).toBe(422);
  expect(refused.body.error.code).toBe("bankfeed_host_refused");
  expect(JSON.stringify(refused.body)).not.toContain("evil.example");
  expect(w.bridge.log).toHaveLength(0);
  // An oversized token is the schema's refusal.
  const huge = await w.call("bankfeed.connect", { setupToken: "A".repeat(5000) }, uuid());
  expect(huge.status).toBe(400);
});

test("a token the Bridge refuses says it may be compromised and what to do, and no file is written", async () => {
  const w = await world();
  w.bridge.claimed = true;
  const reply = await w.call("bankfeed.connect", { setupToken: w.bridge.setupToken() }, uuid());
  expect(reply.status).toBe(409);
  expect(reply.body.error.code).toBe("bankfeed_token_rejected");
  expect(reply.body.error.message).toContain("compromised");
  expect(reply.body.error.message).toContain("disable it");
  expect(() => statSync(w.credentialPath)).toThrow();
  expect((await w.ok("bankfeed.status", {})).connected).toBe(false);
});

test("the place the access URL goes is proven writable before a token that works only once is spent", async () => {
  const w = await world();
  const refusing: CredentialStore = {
    read: () => null,
    probe: () =>
      "Rastrata cannot write to /somewhere, so it has nowhere private to keep the connection.",
    write() {
      throw new Error("never reached");
    },
    remove() {},
  };
  configureBankfeedRuntime(w.service, { credentials: refusing });
  const reply = await w.call("bankfeed.connect", { setupToken: w.bridge.setupToken() }, uuid());
  expect(reply.status).toBe(409);
  expect(reply.body.error.code).toBe("bankfeed_credential_unwritable");
  // Nothing was claimed: the token is still good.
  expect(w.bridge.log).toHaveLength(0);
  expect(w.bridge.claimed).toBe(false);
});

test("if the access URL cannot be saved after the claim, the message says the token is used up", async () => {
  const w = await world();
  const held = memoryCredentialStore();
  configureBankfeedRuntime(w.service, {
    credentials: {
      ...held,
      write: () => {
        throw new Error(`disk full while writing ${w.bridge.accessUrl()}`);
      },
    },
  });
  const reply = await w.call("bankfeed.connect", { setupToken: w.bridge.setupToken() }, uuid());
  expect(reply.status).toBe(500);
  expect(reply.body.error.code).toBe("bankfeed_credential_unwritable");
  expect(reply.body.error.message).toContain("used up");
  for (const secret of secretsOf(w.bridge.setupToken()))
    expect(JSON.stringify(reply.body)).not.toContain(secret);
  expect(w.bridge.claimed).toBe(true);
});

test("a lost reply is the same answer again, not a second claim", async () => {
  const w = await world();
  const operationId = uuid();
  const first = await w.call(
    "bankfeed.connect",
    { setupToken: w.bridge.setupToken() },
    operationId,
  );
  const claims = w.bridge.requests("claim").length;
  const again = await w.call(
    "bankfeed.connect",
    { setupToken: w.bridge.setupToken() },
    operationId,
  );
  expect(again.body).toEqual(first.body);
  expect(w.bridge.requests("claim")).toHaveLength(claims);
  // The same identity with another token is a conflict, never a second claim.
  const other = await w.call(
    "bankfeed.connect",
    { setupToken: w.bridge.setupToken("OTHER-CODE-0003") },
    operationId,
  );
  expect(other.status).toBe(409);
  expect(other.body.error.code).toBe("operation_identity_conflict");
});

test("if the accounts cannot be listed right after connecting, it is still connected and says why", async () => {
  const w = await world();
  // The claim goes through; the listing (and its retry) fail.
  w.bridge.overrides.push(() => null);
  w.bridge.respondOnce(500, "down");
  w.bridge.respondOnce(500, "down");
  const reply = await w.call("bankfeed.connect", { setupToken: w.bridge.setupToken() }, uuid());
  expect(reply.status).toBe(200);
  expect(reply.body.data.connected).toBe(true);
  expect(reply.body.data.accounts).toEqual([]);
  expect(reply.body.data.accountsError).toContain("Bridge");
  expect((await w.ok("bankfeed.status", {})).connected).toBe(true);
});

test("disconnecting deletes the file and keeps the links, the cursors and every imported line", async () => {
  const w = await world({ connected: true });
  const accounts = await w.ok("accounts.list", {});
  const checkingId = accounts.accounts.find((a: { code: string }) => a.code === "1000").id;
  await w.ok("bankfeed.link", { accountId: "ACT-checking-0001", ledgerAccountId: checkingId });
  await w.ok("bankfeed.sync", {});
  const imported = (await w.ok("inbox.list", { filter: { provider: "simplefin" } })).count;
  expect(imported).toBe(5);

  const reply = await w.ok("bankfeed.disconnect", {});
  expect(reply).toEqual({ connected: false, removed: true });
  expect(() => statSync(w.credentialPath)).toThrow();
  const status = await w.ok("bankfeed.status", {});
  expect(status.connected).toBe(false);
  expect(status.linked).toBe(1);
  expect(status.accounts[0].link.through).not.toBeNull();
  expect((await w.ok("inbox.list", { filter: { provider: "simplefin" } })).count).toBe(5);
  // Disconnecting again is not an error.
  expect(await w.ok("bankfeed.disconnect", {})).toEqual({ connected: false, removed: false });
  // Syncing needs a connection and says so.
  const refused = await w.call("bankfeed.sync", {}, uuid());
  expect(refused.status).toBe(409);
  expect(refused.body.error.code).toBe("bankfeed_not_connected");
});

test("after disconnecting, a new setup token carries on from the saved cursor", async () => {
  const w = await world({ connected: true });
  const accounts = await w.ok("accounts.list", {});
  const checkingId = accounts.accounts.find((a: { code: string }) => a.code === "1000").id;
  await w.ok("bankfeed.link", { accountId: "ACT-checking-0001", ledgerAccountId: checkingId });
  await w.ok("bankfeed.sync", {});
  const through = (await w.ok("bankfeed.status", {})).accounts[0].link.through;
  await w.ok("bankfeed.disconnect", {});
  // The Bridge hands out a new connection: a new setup token and a new access URL.
  w.bridge.claimed = false;
  await w.ok("bankfeed.connect", { setupToken: w.bridge.setupToken() });
  const status = await w.ok("bankfeed.status", {});
  expect(status.connected).toBe(true);
  expect(
    status.accounts.find((a: { id: string }) => a.id === "ACT-checking-0001").link.through,
  ).toBe(through);
});

test("a book copied to another place has no connection: the access URL does not travel with it", async () => {
  const w = await world({ connected: true });
  const accounts = await w.ok("accounts.list", {});
  const checkingId = accounts.accounts.find((a: { code: string }) => a.code === "1000").id;
  await w.ok("bankfeed.link", { accountId: "ACT-checking-0001", ledgerAccountId: checkingId });
  // Remove only the private file, as copying the database alone would.
  configureBankfeedRuntime(w.service, { credentials: memoryCredentialStore() });
  const status = await w.ok("bankfeed.status", {});
  expect(status.connected).toBe(false);
  expect(status.linked).toBe(1);
  expect(status.attention.map((a: { code: string }) => a.code)).toContain("credential_missing");
  expect(
    status.attention.find((a: { code: string }) => a.code === "credential_missing").message,
  ).toContain("new setup token");
});
