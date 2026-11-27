// What the Agents page does on a service with accounts (src/agent-keys-controller.ts), against a stand-in for the account layer.
import { expect, test } from "bun:test";
import type {
  AgentKeyList,
  AgentKeySummary,
  AgentScope,
  Member,
  Person,
  Result,
  Role,
  WorkspaceDetail,
} from "../../src/account";
import {
  AgentKeysController,
  type AgentKeysState,
  type AgentKeysView,
  CHOICES,
} from "../../src/agent-keys-controller";

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const no = (status: number, code: string, message = "Refused."): Result<never> => ({
  ok: false,
  status,
  code,
  message,
  retryAfter: null,
});

const GRANT: Readonly<Record<Role, readonly AgentScope[]>> = {
  owner: ["read", "draft", "post", "configure", "correct", "close"],
  admin: ["read", "draft", "post", "configure", "correct", "close"],
  accountant: ["read", "draft", "post", "correct", "close"],
  member: ["read", "draft"],
};

const NOW = Date.parse("2026-11-17T17:00:00.000Z");

const key = (id: string, over: Partial<AgentKeySummary> = {}): AgentKeySummary => ({
  id,
  prefix: `rsa_${id}`,
  workspace: "wsp_acme",
  userId: "user_ann",
  name: `Key ${id}`,
  scopes: ["read", "draft"],
  createdAt: "2026-10-15T12:00:00.000Z",
  expiresAt: "2027-01-13T12:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  revokedReason: null,
  status: "active",
  ...over,
});

const MEMBERS: readonly Member[] = [
  { userId: "user_ann", email: "ann@acme.example", role: "owner", ready: true },
  { userId: "user_bob", email: "bob@acme.example", role: "member", ready: true },
];

function setUp(
  options: {
    role?: Role;
    scope?: string | null;
    keys?: AgentKeySummary[];
    choice?: "draft" | "read-only" | "bookkeeper";
    session?: () => Result<Person | null>;
    code?: (scopes: readonly AgentScope[]) => Result<{ code: string; expiresAt: string }>;
    revoke?: () => Result<unknown>;
    read?: () => Result<AgentKeyList> | undefined;
  } = {},
) {
  const role = options.role ?? "owner";
  const held = options.keys ?? [key("0000000000000001")];
  const calls: string[] = [];
  const clock = { now: NOW };
  const account = {
    scope: () => (options.scope === undefined ? "wsp_acme" : options.scope),
    agentKeys: async (workspace: string) => {
      calls.push(`list ${workspace}`);
      return (
        options.read?.() ??
        ok({
          keys: [...held],
          grantable: GRANT[role],
          defaultExpiryDays: 90,
          maxExpiryDays: 365,
        })
      );
    },
    workspace: async () =>
      ok({
        workspace: { id: "wsp_acme", name: "Acme", role, state: "ready" },
        members: MEMBERS,
      } satisfies WorkspaceDetail),
    session: async () => options.session?.() ?? ok({ id: "user_ann", email: "ann@acme.example" }),
    createAgentCode: async (workspace: string, scopes: readonly AgentScope[]) => {
      calls.push(`code ${workspace} ${scopes.join("+")}`);
      return (
        options.code?.(scopes) ??
        ok({
          code: "R7K2-9QDM-4XHT",
          expiresAt: new Date(clock.now + 600_000).toISOString(),
        })
      );
    },
    revokeAgentKey: async (id: string, reason?: string) => {
      calls.push(`revoke ${id}${reason ? ` ${reason}` : ""}`);
      const answer = options.revoke?.() ?? ok({ ok: true });
      if (answer.ok) {
        const at = held.findIndex((item) => item.id === id);
        if (at >= 0) held[at] = { ...(held[at] as AgentKeySummary), status: "revoked" };
      }
      return answer;
    },
  };
  const controller = new AgentKeysController({
    account,
    now: () => new Date(clock.now),
    choice: options.choice,
  });
  const states: AgentKeysState[] = [];
  controller.subscribe((state) => states.push(state));
  const view = (): AgentKeysView => {
    if (controller.state.step !== "ready") throw new Error(controller.state.step);
    return controller.state.view;
  };
  return { controller, calls, states, view, held, clock };
}

test("the list is what is connected, by name and what it may do, and a choice is offered only if every permission in it may be given", async () => {
  const owner = setUp({ role: "owner" });
  expect(owner.controller.state.step).toBe("loading");
  await owner.controller.load();
  expect(owner.calls).toEqual(["list wsp_acme"]);
  expect(owner.view().rows).toEqual([
    {
      id: "0000000000000001",
      name: "Key 0000000000000001",
      permissions: ["read", "draft"],
      status: "active",
      expiresAt: "2027-01-13T12:00:00.000Z",
      lastUsedAt: null,
      owner: undefined,
    },
  ]);
  // The usual choice first, and it is the one chosen.
  expect(owner.view().choices).toEqual(CHOICES);
  expect(owner.view().choices.map((choice) => choice.id)).toEqual([
    "draft",
    "read-only",
    "bookkeeper",
  ]);
  expect(owner.view().choice).toBe("draft");
  expect(owner.view().canSeeChanges).toBe(true);
  expect(owner.view().code).toBeNull();

  // A member may give read and draft: running the books is not offered, and what agents changed is the owner's to read.
  const member = setUp({ role: "member" });
  await member.controller.load();
  expect(member.view().choices.map((choice) => choice.id)).toEqual(["draft", "read-only"]);
  expect(member.view().canSeeChanges).toBe(false);
  const accountant = setUp({ role: "accountant" });
  await accountant.controller.load();
  expect(accountant.view().choices.map((choice) => choice.id)).toEqual([
    "draft",
    "read-only",
    "bookkeeper",
  ]);
});

test("one a person disconnected is not listed, one that ran out stays a month with no more, and another person's says whose it is", async () => {
  const { controller, view } = setUp({
    keys: [
      key("0000000000000001"),
      key("0000000000000002", { status: "revoked", revokedAt: "2026-11-01T00:00:00.000Z" }),
      key("0000000000000003", { status: "expired", expiresAt: "2026-11-10T00:00:00.000Z" }),
      key("0000000000000004", { status: "expired", expiresAt: "2026-09-10T00:00:00.000Z" }),
      key("0000000000000005", { userId: "user_bob" }),
      key("0000000000000006", { userId: "user_gone" }),
    ],
  });
  await controller.load();
  expect(view().rows.map((row) => [row.id.slice(-1), row.status, row.owner])).toEqual([
    ["1", "active", undefined],
    ["3", "expired", undefined],
    ["5", "active", "bob@acme.example"],
    ["6", "active", "a former member"],
  ]);
});

test("the list is still drawn when who is signed in cannot be read: the person's own are then shown by their address", async () => {
  const { controller, view } = setUp({ session: () => no(503, "unavailable") });
  await controller.load();
  expect(view().rows[0]?.owner).toBe("ann@acme.example");
});

test("with no workspace open, or a list that cannot be read, the page says so; a list that cannot be read again leaves the one on the screen", async () => {
  const none = setUp({ scope: null });
  await none.controller.load();
  expect(none.controller.state).toEqual({ step: "problem", message: "No workspace is open." });

  let fail = true;
  const failing = setUp({ read: () => (fail ? no(503, "unavailable", "Try again.") : undefined) });
  await failing.controller.load();
  expect(failing.controller.state).toEqual({ step: "problem", message: "Try again." });
  fail = false;
  await failing.controller.load();
  expect(failing.view().rows).toHaveLength(1);
  fail = true;
  await failing.controller.load();
  expect(failing.view().rows).toHaveLength(1);
});

test("the button asks for a code with the choice's permissions, once however often it is pressed, and the code is what the page shows", async () => {
  const { controller, calls, view, states } = setUp();
  await controller.load();
  controller.choose("bookkeeper");
  expect(view().choice).toBe("bookkeeper");
  const [first, second] = await Promise.all([controller.getCommand(), controller.getCommand()]);
  expect([first, second]).toEqual([true, false]);
  expect(calls.filter((call) => call.startsWith("code"))).toEqual([
    "code wsp_acme read+draft+post",
  ]);
  expect(view().code).toEqual({
    code: "R7K2-9QDM-4XHT",
    expiresAt: new Date(NOW + 600_000).toISOString(),
  });
  expect(view().getting).toBe(false);
  // While it was asked for, the page said so.
  expect(states.some((state) => state.step === "ready" && state.view.getting)).toBe(true);

  // Changing the choice takes the code away: it was made for the other one.
  controller.choose("read-only");
  expect(view().code).toBeNull();
  expect(view().choice).toBe("read-only");
  // A choice that is not offered is not taken.
  controller.choose("nonsense" as never);
  expect(view().choice).toBe("read-only");
});

test("a sign-in that is too old is said as that, with the way to fix it; any other refusal is said in the service's words", async () => {
  let refusal = no(403, "session_not_fresh", "Sign in again first.");
  const { controller, view } = setUp({ code: () => refusal });
  await controller.load();
  expect(await controller.getCommand()).toBe(false);
  expect(view().needsSignIn).toBe(true);
  expect(view().problem).toBeNull();
  expect(view().code).toBeNull();
  refusal = no(429, "too_many_requests", "You have asked for a lot of codes just now.");
  expect(await controller.getCommand()).toBe(false);
  expect(view().needsSignIn).toBe(false);
  expect(view().problem).toBe("You have asked for a lot of codes just now.");
});

test("a person who comes back from signing in again finds the choice they had made", async () => {
  const { controller, view } = setUp({ choice: "bookkeeper" });
  await controller.load();
  expect(view().choice).toBe("bookkeeper");
  // One their role does not offer falls back to the first that it does.
  const member = setUp({ role: "member", choice: "bookkeeper" });
  await member.controller.load();
  expect(member.view().choice).toBe("draft");
});

test("while a code shows, the page asks whether it was used: the agent that used it is named and listed, and the code goes", async () => {
  const { controller, view, held, calls } = setUp();
  await controller.load();
  // With no code there is nothing to ask.
  expect(await controller.check()).toBe(false);
  expect(calls.filter((call) => call.startsWith("list"))).toHaveLength(1);

  await controller.getCommand();
  expect(await controller.check()).toBe(true);
  expect(view().code).not.toBeNull();
  // Another person's agent, connected meanwhile, is not this code's.
  held.push(key("00000000000000b0", { userId: "user_bob", name: "Bob's agent" }));
  expect(await controller.check()).toBe(true);
  expect(view().connected).toBeNull();
  expect(view().rows).toHaveLength(2);
  // The command line used the code.
  held.unshift(key("00000000000000a0", { name: "Agent on studio-mac" }));
  expect(await controller.check()).toBe(false);
  expect(view().code).toBeNull();
  expect(view().connected).toBe("Agent on studio-mac");
  expect(view().announcement).toBe("Agent on studio-mac is connected");
  expect(view().rows.map((row) => row.name)).toContain("Agent on studio-mac");
  // Asking for another clears what was said about the last.
  await controller.getCommand();
  expect(view().connected).toBeNull();
});

test("a code that ran out is taken off the screen, and the page says so until another is asked for", async () => {
  const { controller, view, clock } = setUp();
  await controller.load();
  await controller.getCommand();
  clock.now += 599_000;
  expect(await controller.check()).toBe(true);
  clock.now += 2_000;
  expect(await controller.check()).toBe(false);
  expect(view().code).toBeNull();
  expect(view().ranOut).toBe(true);
  await controller.getCommand();
  expect(view().ranOut).toBe(false);
  expect(view().code).not.toBeNull();
});

test("disconnecting asks first, ends the key, reads the list again, and a failure leaves it listed and says so", async () => {
  let fail = true;
  const { controller, calls, view } = setUp({
    revoke: () => (fail ? no(503, "unavailable") : ok({ ok: true })),
  });
  await controller.load();
  const row = view().rows[0];
  if (!row) throw new Error("no row");
  // Nothing is ended until it is confirmed.
  expect(await controller.disconnect()).toBe(false);
  controller.askDisconnect(row);
  expect(view().disconnecting).toEqual(row);
  expect(await controller.disconnect()).toBe(false);
  expect(view().disconnectFailed).toBe(true);
  expect(view().disconnecting).toEqual(row);
  expect(view().rows).toHaveLength(1);
  fail = false;
  expect(await controller.disconnect()).toBe(true);
  expect(calls.filter((call) => call.startsWith("revoke"))).toEqual([
    "revoke 0000000000000001",
    "revoke 0000000000000001",
  ]);
  expect(view().disconnecting).toBeNull();
  expect(view().rows).toEqual([]);
  expect(view().announcement).toBe("Key 0000000000000001 was disconnected");

  // Changing one's mind ends nothing.
  const other = setUp();
  await other.controller.load();
  other.controller.askDisconnect(other.view().rows[0] as never);
  other.controller.cancelDisconnect();
  expect(other.view().disconnecting).toBeNull();
  expect(await other.controller.disconnect()).toBe(false);
  expect(other.calls.some((call) => call.startsWith("revoke"))).toBe(false);
});
