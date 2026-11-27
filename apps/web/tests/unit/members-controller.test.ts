// What the Members page does (src/members-controller.ts), against a stand-in for the account layer.
import { expect, test } from "bun:test";
import type {
  Member,
  PendingInvitation,
  Person,
  Result,
  Role,
  WorkspaceDetail,
} from "../../src/account";
import {
  mayManage,
  MembersController,
  type MembersState,
  type MembersView,
  rolesToGive,
  rolesToInvite,
} from "../../src/members-controller";

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const no = (status: number, code: string, message = "Refused."): Result<never> => ({
  ok: false,
  status,
  code,
  message,
  retryAfter: null,
});

const ANN: Person = { id: "user_ann", email: "ann@example.com" };
const BOB: Member = {
  userId: "user_bob",
  email: "bob@example.com",
  role: "accountant",
  ready: true,
};
const CAL: Member = { userId: "user_cal", email: "cal@example.com", role: "member", ready: true };
const DEE: Member = { userId: "user_dee", email: "dee@example.com", role: "admin", ready: true };
/** A person of the workspace as the control plane lists them: a signed-in person (`id`) or one already listed (`userId`), in a role. */
const member = (who: Person | Member, role: Role, ready = true): Member => ({
  userId: "userId" in who ? who.userId : who.id,
  email: who.email,
  role,
  ready,
});
const PENDING: PendingInvitation = {
  id: "inv_1",
  email: "eve@example.com",
  role: "member",
  expiresAt: "2026-10-21T00:00:00.000Z",
};

/** A workspace as the control plane would show it to `me`, with the people and invitations a test chooses. */
function detail(
  me: Role,
  members: readonly Member[],
  invitations: readonly PendingInvitation[] | undefined,
): WorkspaceDetail {
  return {
    workspace: { id: "wsp_acme", name: "Acme", role: me, state: "ready" },
    members,
    ...(invitations ? { invitations } : {}),
  };
}

function setUp(
  options: {
    me?: Person | null;
    scope?: string | null;
    read?: () => Result<WorkspaceDetail>;
    answers?: Partial<Record<string, () => Result<unknown>>>;
  } = {},
) {
  const asked: string[] = [];
  let forgot = 0;
  const went: string[] = [];
  const answer = (name: string): Result<unknown> => options.answers?.[name]?.() ?? ok({});
  const controller = new MembersController({
    account: {
      scope: () => (options.scope === undefined ? "wsp_acme" : options.scope),
      session: async () => ok(options.me === undefined ? ANN : options.me),
      workspace: async (id: string) => {
        asked.push(`workspace(${id})`);
        return (options.read ?? (() => ok(detail("owner", [member(ANN, "owner")], []))))();
      },
      invite: async (...args) => {
        asked.push(`invite(${args.join(", ")})`);
        return answer("invite") as never;
      },
      revokeInvitation: async (id) => {
        asked.push(`revokeInvitation(${id})`);
        return answer("revokeInvitation");
      },
      changeRole: async (...args) => {
        asked.push(`changeRole(${args.join(", ")})`);
        return answer("changeRole");
      },
      removeMember: async (...args) => {
        asked.push(`removeMember(${args.join(", ")})`);
        return answer("removeMember");
      },
    },
    go: (path) => went.push(path),
    forget: () => {
      forgot += 1;
    },
    startPath: "/start",
  });
  const states: MembersState[] = [];
  controller.subscribe((state) => states.push(state));
  const view = (): MembersView => {
    const state = controller.state;
    if (state.step !== "ready") throw new Error(`not ready: ${state.step}`);
    return state.view;
  };
  return { controller, asked, went, states, view, forgot: () => forgot };
}

test("an owner may do anything about anyone's access, an administrator only about accountants and members, the rest nothing", () => {
  const roles: Role[] = ["owner", "admin", "accountant", "member"];
  expect(roles.map((target) => mayManage("owner", target))).toEqual([true, true, true, true]);
  expect(roles.map((target) => mayManage("admin", target))).toEqual([false, false, true, true]);
  expect(roles.map((target) => mayManage("accountant", target))).toEqual([
    false,
    false,
    false,
    false,
  ]);
  expect(roles.map((target) => mayManage("member", target))).toEqual([false, false, false, false]);
  // Nobody is invited as an owner; an owner changes someone to owner from a member.
  expect(rolesToInvite("owner")).toEqual(["admin", "accountant", "member"]);
  expect(rolesToInvite("admin")).toEqual(["accountant", "member"]);
  expect(rolesToInvite("accountant")).toEqual([]);
  expect(rolesToGive("owner", "member")).toEqual(["owner", "admin", "accountant", "member"]);
  expect(rolesToGive("admin", "member")).toEqual(["accountant", "member"]);
  expect(rolesToGive("admin", "admin")).toEqual([]);
  expect(rolesToGive("member", "member")).toEqual([]);
});

test("the owner sees everyone, can change every role and take out anyone but the only owner, and sees who has been asked in", async () => {
  const { controller, view, asked } = setUp({
    read: () => ok(detail("owner", [member(ANN, "owner"), BOB, CAL, DEE], [PENDING])),
  });
  expect(controller.state.step).toBe("loading");
  await controller.load();
  expect(asked).toEqual(["workspace(wsp_acme)"]);
  const rows = view().members;
  expect(rows.map((row) => [row.email, row.you])).toEqual([
    ["ann@example.com", true],
    ["bob@example.com", false],
    ["cal@example.com", false],
    ["dee@example.com", false],
  ]);
  // The only owner can neither leave nor be taken out; everyone else can be.
  expect(rows.map((row) => row.canRemove)).toEqual([false, true, true, true]);
  // The only owner's own role is not offered to be changed: it cannot be, a workspace keeps an owner.
  expect(rows[0]?.roles).toEqual([]);
  expect(rows[1]?.roles).toEqual(["owner", "admin", "accountant", "member"]);
  expect(view().invitations).toEqual([PENDING]);
  expect(view().inviteAs).toEqual(["admin", "accountant", "member"]);
  expect(view().soleOwner).toBe(true);
  expect(view().waiting).toBe(false);
  expect(view().role).toBe("owner");
});

test("with a second owner the first may leave", async () => {
  const { controller, view } = setUp({
    read: () => ok(detail("owner", [member(ANN, "owner"), member(BOB, "owner")], [])),
  });
  await controller.load();
  expect(view().soleOwner).toBe(false);
  expect(view().members.map((row) => row.canRemove)).toEqual([true, true]);
  // With another owner an owner may step down.
  expect(view().members[0]?.roles).toEqual(["owner", "admin", "accountant", "member"]);
});

test("an administrator may change and take out accountants and members and no one above them, and may leave", async () => {
  const { controller, view } = setUp({
    me: ANN,
    read: () =>
      ok(detail("admin", [member(DEE, "owner"), member(ANN, "admin"), BOB, CAL], [PENDING])),
  });
  await controller.load();
  const byEmail = Object.fromEntries(view().members.map((row) => [row.email, row]));
  expect(byEmail["dee@example.com"]?.roles).toEqual([]);
  expect(byEmail["dee@example.com"]?.canRemove).toBe(false);
  expect(byEmail["ann@example.com"]?.roles).toEqual([]);
  expect(byEmail["ann@example.com"]?.canRemove).toBe(true); // leaving
  expect(byEmail["bob@example.com"]?.roles).toEqual(["accountant", "member"]);
  expect(byEmail["bob@example.com"]?.canRemove).toBe(true);
  expect(view().inviteAs).toEqual(["accountant", "member"]);
  expect(view().soleOwner).toBe(false);
});

test("an accountant or a member sees the people and can only leave: no form, no invitations, no role to change", async () => {
  for (const role of ["accountant", "member"] as const) {
    const { controller, view } = setUp({
      read: () => ok(detail(role, [member(DEE, "owner"), member(ANN, role)], undefined)),
    });
    await controller.load();
    expect(view().inviteAs).toEqual([]);
    expect(view().invitations).toEqual([]);
    expect(view().members.map((row) => [row.email, row.roles.length, row.canRemove])).toEqual([
      ["dee@example.com", 0, false],
      ["ann@example.com", 0, true],
    ]);
  }
});

test("while someone is still being put into the books the view is told to look again", async () => {
  let ready = false;
  const { controller, view } = setUp({
    read: () => ok(detail("owner", [member(ANN, "owner"), member(BOB, "member", ready)], [])),
  });
  await controller.load();
  expect(view().waiting).toBe(true);
  expect(view().members[1]?.ready).toBe(false);
  ready = true;
  await controller.refresh();
  expect(view().waiting).toBe(false);
});

test("nothing is shown for a failed first read, with the control plane's reason, and no workspace open is said", async () => {
  const failed = setUp({ read: () => no(503, "unavailable", "Try again in a moment.") });
  await failed.controller.load();
  expect(failed.controller.state).toEqual({ step: "problem", message: "Try again in a moment." });

  const none = setUp({ scope: null });
  await none.controller.load();
  expect(none.controller.state).toEqual({ step: "problem", message: "No workspace is open." });
  expect(none.asked).toEqual([]);

  const out = setUp({ me: null });
  await out.controller.load();
  expect(out.controller.state.step).toBe("problem");
});

test("a read that fails after the page is shown leaves the list and says so above it", async () => {
  let down = false;
  const { controller, view } = setUp({
    read: () =>
      down
        ? no(503, "unavailable", "Try again in a moment.")
        : ok(detail("owner", [member(ANN, "owner")], [])),
  });
  await controller.load();
  down = true;
  await controller.refresh();
  expect(view().members).toHaveLength(1);
  expect(view().error).toBe("Try again in a moment.");
});

test("an invitation: the address is checked first, the role must be one the person may give, and the list is read again after", async () => {
  const { controller, view, asked } = setUp({
    read: () => ok(detail("admin", [member(ANN, "admin")], [])),
    answers: { invite: () => ok(PENDING) },
  });
  await controller.load();
  asked.length = 0;

  expect(await controller.invite("not an address", "member")).toBe(false);
  expect(view().error).toBe("Enter the email address of the person to invite.");
  expect(await controller.invite("bob@example.com", "admin")).toBe(false);
  expect(view().error).toBe("You may not invite someone with that role.");
  expect(asked).toEqual([]);

  expect(await controller.invite("  bob@example.com ", "accountant")).toBe(true);
  expect(asked).toEqual(["invite(wsp_acme, bob@example.com, accountant)", "workspace(wsp_acme)"]);
  expect(view().notice).toBe(
    "We sent an invitation to bob@example.com. The link works for seven days.",
  );
  expect(view().error).toBeUndefined();
});

test("an invitation the control plane refuses shows its reason and reads the list again", async () => {
  const { controller, view, asked } = setUp({
    answers: {
      invite: () => no(409, "member_limit", "A workspace has room for 25 people."),
    },
  });
  await controller.load();
  asked.length = 0;
  expect(await controller.invite("bob@example.com", "member")).toBe(false);
  expect(view().error).toBe("A workspace has room for 25 people.");
  expect(view().notice).toBeUndefined();
  expect(asked).toEqual(["invite(wsp_acme, bob@example.com, member)", "workspace(wsp_acme)"]);
});

test("taking an invitation back asks for that one and says so", async () => {
  const { controller, view, asked } = setUp({
    read: () => ok(detail("owner", [member(ANN, "owner")], [PENDING])),
  });
  await controller.load();
  asked.length = 0;
  expect(await controller.revoke("inv_1")).toBe(true);
  expect(asked).toEqual(["revokeInvitation(inv_1)", "workspace(wsp_acme)"]);
  expect(view().notice).toBe("The invitation was taken back.");
});

test("a role is changed through the control plane only to one the person may give, and only when it changes", async () => {
  const { controller, view, asked } = setUp({
    read: () => ok(detail("admin", [member(DEE, "owner"), member(ANN, "admin"), BOB], [])),
  });
  await controller.load();
  asked.length = 0;

  expect(await controller.setRole("user_bob", "accountant")).toBe(false); // already is
  expect(await controller.setRole("user_bob", "admin")).toBe(false); // not the administrator's to give
  expect(view().error).toBe("You may not give that role.");
  expect(await controller.setRole("user_dee", "member")).toBe(false); // not theirs to change
  expect(asked).toEqual([]);

  expect(await controller.setRole("user_bob", "member")).toBe(true);
  expect(asked).toEqual(["changeRole(wsp_acme, user_bob, member)", "workspace(wsp_acme)"]);
  expect(view().notice).toBe("bob@example.com is now member.");
});

test("someone is taken out; the only owner is not offered and not taken out", async () => {
  const { controller, view, asked, forgot, went } = setUp({
    read: () => ok(detail("owner", [member(ANN, "owner"), BOB], [])),
  });
  await controller.load();
  asked.length = 0;

  expect(await controller.remove("user_ann")).toBe(false);
  expect(view().error).toBe("That person cannot be taken out.");
  expect(asked).toEqual([]);

  expect(await controller.remove("user_bob")).toBe(true);
  expect(asked).toEqual(["removeMember(wsp_acme, user_bob)", "workspace(wsp_acme)"]);
  expect(view().notice).toBe("bob@example.com no longer has access.");
  expect(forgot()).toBe(0);
  expect(went).toEqual([]);
});

test("leaving forgets the workspace and goes to the page that lets a person choose one", async () => {
  const { controller, asked, forgot, went } = setUp({
    read: () =>
      ok(detail("accountant", [member(DEE, "owner"), member(ANN, "accountant")], undefined)),
  });
  await controller.load();
  asked.length = 0;
  expect(await controller.remove("user_ann")).toBe(true);
  expect(asked).toEqual(["removeMember(wsp_acme, user_ann)"]);
  expect(controller.state).toEqual({ step: "left" });
  expect(forgot()).toBe(1);
  expect(went).toEqual(["/start"]);
});

test("a refusal to leave keeps the person where they are, with the reason", async () => {
  const { controller, view, forgot, went } = setUp({
    read: () => ok(detail("member", [member(DEE, "owner"), member(ANN, "member")], undefined)),
    answers: { removeMember: () => no(503, "unavailable", "Try again in a moment.") },
  });
  await controller.load();
  expect(await controller.remove("user_ann")).toBe(false);
  expect(view().error).toBe("Try again in a moment.");
  expect(forgot()).toBe(0);
  expect(went).toEqual([]);
});
