// What the sign-in page of a service with accounts does, step by step (src/gate-controller.ts), against a stand-in for the account layer.
import { expect, test } from "bun:test";
import type { InvitationView, Person, Result, WorkspaceSummary } from "../../src/account";
import { GateController, type GateState } from "../../src/gate-controller";
import { PasskeyCancelled, type WebAuthn } from "../../src/passkeys";

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const no = (
  status: number,
  code: string,
  message = "Refused.",
  retryAfter: number | null = null,
): Result<never> => ({
  ok: false,
  status,
  code,
  message,
  retryAfter,
});
const workspace = (
  id: string,
  state: WorkspaceSummary["state"] = "ready",
  name = id,
): WorkspaceSummary => ({
  id,
  name,
  role: "owner",
  state,
});
const ANN: Person = { id: "user_1", email: "ann@example.com" };
const TOKEN = "A".repeat(43);
const invitation = (state: InvitationView["state"] = "pending"): InvitationView => ({
  workspace: "Acme",
  role: "accountant",
  email: "a***@example.com",
  state,
});

/** An account layer whose answers a test sets, and that keeps what it was asked. */
function fake(initial: Partial<Record<string, unknown>> = {}) {
  const asked: string[] = [];
  const answers: Record<string, (...args: never[]) => unknown> = {
    config: () => ok({ captcha: { provider: "turnstile", siteKey: "site" } }),
    session: () => ok(null),
    askForCode: () => ok({}),
    signInWithCode: () => ok({}),
    workspaces: () => ok([]),
    createWorkspace: () => ok(workspace("wsp_new")),
    restoreWorkspace: () => ok(workspace("wsp_a")),
    deleteAccount: () => ok({}),
    signOutEverywhere: () => true,
    passkeyOptions: () => ok({}),
    signInWithPasskey: () => ok({}),
    passkeys: () => ok([]),
    passkeyRegisterOptions: () => ok({ challenge: "r" }),
    addPasskey: () => ok({}),
    restoreHint: () => ok({}),
    peekInvitation: () => ok(invitation()),
    acceptInvitation: () => ok({ ...workspace("wsp_acme"), ready: true }),
    signOut: () => undefined,
    ...(initial as Record<string, (...args: never[]) => unknown>),
  };
  let selected: string | null = null;
  const call =
    (name: string) =>
    async (...args: unknown[]) => {
      asked.push(`${name}(${args.map((a) => JSON.stringify(a)).join(", ")})`);
      return (answers[name] as (...a: unknown[]) => unknown)(...args);
    };
  const account = {
    config: call("config"),
    session: call("session"),
    askForCode: call("askForCode"),
    signInWithCode: call("signInWithCode"),
    workspaces: call("workspaces"),
    createWorkspace: call("createWorkspace"),
    restoreWorkspace: call("restoreWorkspace"),
    deleteAccount: call("deleteAccount"),
    signOutEverywhere: call("signOutEverywhere"),
    passkeyOptions: call("passkeyOptions"),
    signInWithPasskey: call("signInWithPasskey"),
    passkeys: call("passkeys"),
    passkeyRegisterOptions: call("passkeyRegisterOptions"),
    addPasskey: call("addPasskey"),
    restoreHint: call("restoreHint"),
    peekInvitation: call("peekInvitation"),
    acceptInvitation: call("acceptInvitation"),
    signOut: call("signOut"),
    select: (id: string | null) => {
      selected = id;
      asked.push(`select(${JSON.stringify(id)})`);
    },
    scope: () => selected,
  };
  const went: string[] = [];
  const make = (path = "/", extra: { newRequestId?: () => string; choose?: boolean } = {}) =>
    new GateController({ account: account as never, go: (p) => void went.push(p), path, ...extra });
  return {
    account,
    asked,
    went,
    make,
    set: (name: string, answer: (...args: never[]) => unknown) => {
      answers[name] = answer;
    },
    selected: () => selected,
  };
}

const step = (c: GateController): GateState["step"] => c.state.step;
/** The workspaces of the list step, or none when the page is not at it. */
const listedOf = (c: GateController): readonly WorkspaceSummary[] =>
  c.state.step === "workspaces" ? c.state.workspaces : [];
const errorOf = (c: GateController): string | undefined =>
  c.state.step === "workspaces" ? c.state.error : undefined;

test("a stranger is asked for an address, with the bot check the control plane named", async () => {
  const f = fake();
  const gate = f.make("/");
  expect(step(gate)).toBe("loading");
  await gate.start();
  expect(gate.state).toMatchObject({
    step: "email",
    captcha: { provider: "turnstile", siteKey: "site" },
    captchaNonce: 0,
  });
  // Where the control plane has no bot check, the page asks for none.
  const bare = fake({ config: () => ok({ captcha: null }) });
  const page = bare.make("/start");
  await page.start();
  expect(page.state).toMatchObject({ step: "email", captcha: null });
  // A control plane that cannot be asked who is signed in is a problem to retry, not a sign-out.
  const down = fake({ session: () => no(0, "unreachable", "The service could not be reached.") });
  const broken = down.make();
  await broken.start();
  expect(broken.state).toEqual({
    step: "problem",
    message: "The service could not be reached.",
    retry: true,
  });
});

test("an address is checked in the page and asked for with the bot check's token; a token that is missing waits; the answer's words are shown", async () => {
  const f = fake();
  const gate = f.make();
  await gate.start();
  await gate.submitEmail("", "tok");
  expect(gate.state).toMatchObject({ step: "email", error: "Enter your email address." });
  for (const bad of ["ann", "ann@", "@example.com", "ann@example", "a nn@example.com"]) {
    await gate.submitEmail(bad, "tok");
    expect(gate.state, bad).toMatchObject({
      step: "email",
      error: "Enter a valid email address, like name@example.com.",
    });
  }
  await gate.submitEmail("  ann@exam  ", "tok");
  expect(gate.state).toMatchObject({ step: "email", email: "ann@exam" });
  await gate.submitEmail("ann@example.com", null);
  expect(gate.state).toMatchObject({
    step: "email",
    error: expect.stringContaining("Wait for the check"),
    // What was typed comes back with the refusal: the person corrects it and does not type it afresh.
    email: "ann@example.com",
  });
  expect(f.asked.some((line) => line.startsWith("askForCode"))).toBe(false);
  f.set("askForCode", () =>
    no(
      429,
      "too_many_codes",
      "Too many codes have been asked for this address. Try again later.",
      1800,
    ),
  );
  await gate.submitEmail("ann@example.com", "tok");
  expect(gate.state).toMatchObject({
    step: "email",
    error: "Too many codes have been asked for this address. Try again later.",
    captchaNonce: 1,
    email: "ann@example.com",
  });
  f.set("askForCode", () => ok({}));
  await gate.submitEmail("  ann@example.com ", "tok2");
  expect(gate.state).toMatchObject({ step: "code", email: "ann@example.com", captchaNonce: 2 });
  // The view says where the code went; nothing else is said until a new one is sent.
  expect((gate.state as { notice?: string }).notice).toBeUndefined();
  expect(f.asked).toContain('askForCode("ann@example.com", "tok2")');
});

test("a new code for the same address is asked for with a new token, and a wrong code is told in a person's words", async () => {
  const f = fake();
  const gate = f.make();
  await gate.start();
  await gate.submitEmail("ann@example.com", "tok");
  await gate.resend(null);
  expect(gate.state).toMatchObject({
    step: "code",
    error: expect.stringContaining("Wait for the check"),
  });
  await gate.resend("tok2");
  expect(gate.state).toMatchObject({
    step: "code",
    notice: "We sent a new code.",
  });
  expect(f.asked.filter((line) => line.startsWith("askForCode"))).toHaveLength(2);
  for (const bad of ["", "12345", "1234567", "abcdef", "12 34 5a"]) {
    await gate.submitCode(bad);
    expect(gate.state, bad).toMatchObject({ step: "code", error: "The code is six digits." });
  }
  expect(f.asked.some((line) => line.startsWith("signInWithCode"))).toBe(false);
  const words: [string, string][] = [
    ["INVALID_OTP", "That code is not right. Check it and try again."],
    ["OTP_EXPIRED", "That code has run out. Ask for a new one."],
    ["TOO_MANY_ATTEMPTS", "That code has run out. Ask for a new one."],
    ["too_many_tries", "Too many wrong codes from here. Try again later."],
  ];
  for (const [code, message] of words) {
    f.set("signInWithCode", () =>
      no(
        code === "too_many_tries" ? 429 : 400,
        code,
        "Too many wrong codes from here. Try again later.",
      ),
    );
    await gate.submitCode("123456");
    expect(gate.state, code).toMatchObject({ step: "code", error: message });
  }
  // The code is sent with its spaces taken out.
  f.set("signInWithCode", () => no(400, "INVALID_OTP"));
  await gate.submitCode("123 456");
  expect(f.asked.at(-1)).toBe('signInWithCode("ann@example.com", "123456")');
});

test("after the code a person with one workspace is in the application, with several they choose, with none they make one", async () => {
  // One.
  let f = fake({ workspaces: () => ok([workspace("wsp_a")]) });
  let gate = f.make();
  await gate.start();
  f.set("session", () => ok(ANN));
  await gate.submitEmail("ann@example.com", "t");
  await gate.submitCode("123456");
  expect(step(gate)).toBe("done");
  expect(f.selected()).toBe("wsp_a");
  expect(f.went).toEqual(["/"]);
  // Several: the page lists them.
  f = fake({
    session: () => ok(ANN),
    workspaces: () => ok([workspace("wsp_a"), workspace("wsp_b")]),
  });
  gate = f.make("/start");
  await gate.start();
  expect(gate.state).toMatchObject({ step: "workspaces", person: ANN, waiting: false });
  expect(f.went).toEqual([]);
  await gate.open("wsp_b");
  expect(f.selected()).toBe("wsp_b");
  expect(f.went).toEqual(["/"]);
  // The hint was made certain before the page left.
  expect(f.asked.indexOf("restoreHint()")).toBeLessThan(f.asked.indexOf('select("wsp_b")'));
  // Several, one of them the one the browser remembers: it is opened at once.
  f = fake({
    session: () => ok(ANN),
    workspaces: () => ok([workspace("wsp_a"), workspace("wsp_b")]),
  });
  f.account.select("wsp_b");
  gate = f.make("/start");
  await gate.start();
  expect(step(gate)).toBe("done");
  expect(f.selected()).toBe("wsp_b");
  // A remembered workspace the person is no longer in, or one still being prepared, is not opened.
  f = fake({
    session: () => ok(ANN),
    workspaces: () => ok([workspace("wsp_a"), workspace("wsp_b", "provisioning")]),
  });
  f.account.select("wsp_b");
  gate = f.make("/start");
  await gate.start();
  expect(gate.state).toMatchObject({ step: "workspaces", waiting: true });
  // None: the form to make the first.
  f = fake({ session: () => ok(ANN), workspaces: () => ok([]) });
  gate = f.make();
  await gate.start();
  expect(gate.state).toMatchObject({ step: "workspaces", workspaces: [], waiting: false });
  // A list that cannot be read is a problem to try again.
  f = fake({
    session: () => ok(ANN),
    workspaces: () => no(503, "unavailable", "That could not be done just now."),
  });
  gate = f.make();
  await gate.start();
  expect(gate.state).toEqual({
    step: "problem",
    message: "That could not be done just now.",
    retry: true,
  });
});

test("a person who came to choose is never sent into a workspace, however few they have, and can make another", async () => {
  const f = fake({ session: () => ok(ANN), workspaces: () => ok([workspace("wsp_a")]) });
  f.account.select("wsp_a");
  const gate = f.make("/start", { choose: true });
  await gate.start();
  expect(gate.state).toMatchObject({ step: "workspaces", person: ANN, waiting: false });
  expect(f.went).toEqual([]);
  expect(f.selected()).toBe("wsp_a");
  // The form that makes another is the one that made the first: the new workspace is opened when it is ready.
  await gate.createWorkspace("Second");
  expect(f.selected()).toBe("wsp_new");
  expect(f.went).toEqual(["/"]);
});

test("a workspace that is being deleted is listed and never opened by itself; an owner brings it back, the list is read again, and a refusal is shown in the control plane's words", async () => {
  const deleting = (id: string, role: "owner" | "member" = "owner") =>
    ({
      ...workspace(id, "deleting"),
      role,
      deleteAfter: "2026-11-14T00:00:00.000Z",
    }) as WorkspaceSummary;
  let listed: WorkspaceSummary[] = [deleting("wsp_a")];
  const f = fake({ session: () => ok(ANN), workspaces: () => ok(listed) });
  const gate = f.make("/start");
  await gate.start();
  // The only workspace the person has is being deleted: it is not opened, and it is listed with its date.
  expect(gate.state).toMatchObject({ step: "workspaces", waiting: false });
  expect(f.went).toEqual([]);
  expect(listedOf(gate)[0]).toMatchObject({
    state: "deleting",
    deleteAfter: "2026-11-14T00:00:00.000Z",
  });
  // Brought back: asked for, and the list read again (now in use).
  listed = [workspace("wsp_a")];
  await gate.restore("wsp_a");
  expect(f.asked).toContain('restoreWorkspace("wsp_a")');
  expect(listedOf(gate)[0]?.state).toBe("ready");
  expect(errorOf(gate)).toBeUndefined();
  // Too late: the words are the control plane's, and the list stays as it was.
  f.set("restoreWorkspace", () =>
    no(409, "too_late", "It is too late: the books of this workspace are being erased."),
  );
  await gate.restore("wsp_a");
  expect(gate.state).toMatchObject({
    step: "workspaces",
    error: "It is too late: the books of this workspace are being erased.",
  });
  // Nothing happens outside the workspace list.
  const other = f.make("/");
  await other.restore("wsp_a");
  expect(other.state.step).toBe("loading");
});

test("a sign-in the browser did not keep is told, since the next step would otherwise fail without a word", async () => {
  const f = fake();
  const gate = f.make();
  await gate.start();
  await gate.submitEmail("ann@example.com", "t");
  await gate.submitCode("123456");
  expect(gate.state).toMatchObject({
    step: "problem",
    retry: true,
    message: expect.stringContaining("did not keep the sign-in"),
  });
});

test("a workspace is made once however often the form is sent, with a new key when the name changes, and opened when it is ready", async () => {
  const keys = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const f = fake({ session: () => ok(ANN), workspaces: () => ok([]) });
  const gate = f.make("/", { newRequestId: () => keys.shift() as string });
  await gate.start();
  await gate.createWorkspace("   ");
  expect(gate.state).toMatchObject({ step: "workspaces", error: "Give the workspace a name." });
  f.set("createWorkspace", () => no(409, "workspace_limit", "You can have up to 3 workspaces."));
  await gate.createWorkspace(" Acme ");
  expect(gate.state).toMatchObject({
    step: "workspaces",
    error: "You can have up to 3 workspaces.",
  });
  await gate.createWorkspace("Acme");
  await gate.createWorkspace("Acme Two");
  expect(f.asked.filter((line) => line.startsWith("createWorkspace"))).toEqual([
    'createWorkspace("Acme", "11111111-1111-4111-8111-111111111111")',
    'createWorkspace("Acme", "11111111-1111-4111-8111-111111111111")',
    'createWorkspace("Acme Two", "22222222-2222-4222-8222-222222222222")',
  ]);
  // Ready at once: opened.
  f.set("createWorkspace", () => ok(workspace("wsp_made")));
  await gate.createWorkspace("Acme Two");
  expect(f.selected()).toBe("wsp_made");
  expect(f.went).toEqual(["/"]);
});

test("a workspace that is still being prepared is waited for and opened when it is ready", async () => {
  const f = fake({ session: () => ok(ANN), workspaces: () => ok([]) });
  const gate = f.make();
  await gate.start();
  f.set("createWorkspace", () => ok(workspace("wsp_made", "provisioning")));
  f.set("workspaces", () => ok([workspace("wsp_made", "provisioning")]));
  await gate.createWorkspace("Acme");
  expect(gate.state).toMatchObject({ step: "workspaces", waiting: true });
  await gate.refresh();
  expect(gate.state).toMatchObject({ step: "workspaces", waiting: true });
  expect(f.went).toEqual([]);
  f.set("workspaces", () => ok([workspace("wsp_made", "ready")]));
  await gate.refresh();
  expect(step(gate)).toBe("done");
  expect(f.selected()).toBe("wsp_made");
  expect(f.went).toEqual(["/"]);
  // A refresh that fails changes nothing.
  const g2 = fake({
    session: () => ok(ANN),
    workspaces: () => ok([workspace("wsp_a", "provisioning")]),
  });
  const waiting = g2.make();
  await waiting.start();
  g2.set("workspaces", () => no(503, "unavailable"));
  await waiting.refresh();
  expect(waiting.state).toMatchObject({ step: "workspaces", waiting: true });
});

test("another address: a person who is signed in is signed out first", async () => {
  const f = fake({
    session: () => ok(ANN),
    workspaces: () => ok([workspace("wsp_a"), workspace("wsp_b")]),
  });
  const gate = f.make("/start");
  await gate.start();
  await gate.useAnotherAddress();
  expect(f.asked).toContain("signOut()");
  expect(gate.state).toMatchObject({ step: "email" });
});

test("an invitation's link: what it is for is shown, the person signs in and accepts, and the workspace is opened", async () => {
  const f = fake();
  const gate = f.make(`/invite/${TOKEN}`);
  await gate.start();
  expect(f.asked).toContain(`peekInvitation("${TOKEN}")`);
  expect(gate.state).toMatchObject({ step: "email", invitation: invitation() });
  await gate.submitEmail("ann@example.com", "t");
  expect(gate.state).toMatchObject({ step: "code", invitation: invitation() });
  f.set("session", () => ok(ANN));
  await gate.submitCode("123456");
  expect(gate.state).toMatchObject({
    step: "invitation",
    invitation: invitation(),
    token: TOKEN,
    person: ANN,
  });
  await gate.acceptInvitation();
  expect(f.asked).toContain(`acceptInvitation("${TOKEN}")`);
  expect(step(gate)).toBe("done");
  expect(f.selected()).toBe("wsp_acme");
  expect(f.went).toEqual(["/"]);
  // Already signed in when the link is opened: straight to the invitation.
  const g2 = fake({ session: () => ok(ANN) });
  const signedIn = g2.make(`/invite/${TOKEN}`);
  await signedIn.start();
  expect(signedIn.state).toMatchObject({ step: "invitation", person: ANN });
});

test("an invitation that cannot be accepted is told why: another address, run out, used, full, or gone", async () => {
  const f = fake({ session: () => ok(ANN) });
  const gate = f.make(`/invite/${TOKEN}`);
  await gate.start();
  f.set("acceptInvitation", () =>
    no(403, "wrong_account", "This invitation is for a***@example.com. Sign in with that address."),
  );
  await gate.acceptInvitation();
  expect(gate.state).toMatchObject({
    step: "invitation",
    error: "This invitation is for a***@example.com. Sign in with that address.",
  });
  f.set("acceptInvitation", () =>
    no(409, "workspace_full", "This workspace holds up to 25 people."),
  );
  await gate.acceptInvitation();
  expect(gate.state).toMatchObject({
    step: "invitation",
    error: "This workspace holds up to 25 people.",
  });
  for (const code of ["invitation_expired", "invitation_used", "invitation_not_found"]) {
    const g = fake({
      session: () => ok(ANN),
      acceptInvitation: () => no(410, code, `Words for ${code}.`),
    });
    const page = g.make(`/invite/${TOKEN}`);
    await page.start();
    await page.acceptInvitation();
    expect(page.state, code).toEqual({
      step: "problem",
      message: `Words for ${code}.`,
      retry: false,
    });
  }
  // With the wrong address the person can use another.
  f.set("session", () => ok(null));
  await gate.useAnotherAddress();
  expect(gate.state).toMatchObject({ step: "email", invitation: invitation() });
});

test("a link that is not an invitation, or one that has run out, is a problem with no retry, and a peek that fails for another reason can be tried again", async () => {
  const missing = fake({ peekInvitation: () => no(404, "invitation_not_found") });
  const a = missing.make(`/invite/${TOKEN}`);
  await a.start();
  expect(a.state).toMatchObject({
    step: "problem",
    retry: false,
    message: expect.stringContaining("does not exist"),
  });
  const expired = fake({ peekInvitation: () => ok(invitation("expired")) });
  const b = expired.make(`/invite/${TOKEN}`);
  await b.start();
  expect(b.state).toEqual({
    step: "problem",
    message: "This invitation has expired. Ask whoever sent it for a new one.",
    retry: false,
  });
  const used = fake({ peekInvitation: () => ok(invitation("accepted")) });
  const c = used.make(`/invite/${TOKEN}`);
  await c.start();
  expect(c.state).toEqual({
    step: "problem",
    message: "This invitation has been used.",
    retry: false,
  });
  const down = fake({
    peekInvitation: () => no(0, "unreachable", "The service could not be reached."),
  });
  const d = down.make(`/invite/${TOKEN}`);
  await d.start();
  expect(d.state).toMatchObject({ step: "problem", retry: true });
  // A path that only looks like one is the sign-in.
  for (const path of ["/invite/short", `/invite/${TOKEN}/x`, "/invite/", `/invitex/${TOKEN}`]) {
    const g = fake();
    const page = g.make(path);
    await page.start();
    expect(step(page), path).toBe("email");
    expect(g.asked.some((line) => line.startsWith("peekInvitation"))).toBe(false);
  }
});

test("the hint a service reads is made certain before the page leaves for the application, and a failure to make it keeps the person here with a way to try again", async () => {
  const f = fake({
    session: () => ok(ANN),
    workspaces: () => ok([workspace("wsp_a")]),
    restoreHint: () => no(0, "unreachable", "The service could not be reached."),
  });
  const gate = f.make("/");
  await gate.start();
  expect(gate.state).toEqual({
    step: "problem",
    message: "The service could not be reached.",
    retry: true,
  });
  expect(f.went).toEqual([]);
  expect(f.selected()).toBeNull();
  f.set("restoreHint", () => ok({}));
  const again = f.make("/");
  await again.start();
  expect(f.went).toEqual(["/"]);
  expect(f.asked.filter((line) => line === "restoreHint()")).toHaveLength(2);
});

test("the form that deletes the account is for the address the list is shown to; asked with it typed, it forgets the open workspace and leaves for the sign-in page", async () => {
  const f = fake({
    session: () => ok(ANN),
    workspaces: () => ok([workspace("wsp_a"), workspace("wsp_b")]),
  });
  const gate = f.make("/start", { choose: true });
  await gate.start();
  expect(gate.state).toMatchObject({ step: "workspaces", person: ANN });
  f.account.select("wsp_a");
  const form = gate.accountDeletion(ANN.email);
  // Another address asks nothing of the control plane.
  await form.run("someone@example.com");
  expect(f.asked.some((line) => line.startsWith("deleteAccount"))).toBe(false);
  expect(f.selected()).toBe("wsp_a");
  await form.run(" Ann@Example.com ");
  expect(f.asked).toContain('deleteAccount("Ann@Example.com")');
  expect(f.selected()).toBeNull();
  expect(f.went).toEqual(["/"]);
});

test("signing out of every browser ends every session, forgets the open workspace and asks for an address again with a word about it; a refusal is shown on the list", async () => {
  const listed = [workspace("wsp_a"), workspace("wsp_b")];
  const f = fake({ session: () => ok(ANN), workspaces: () => ok(listed) });
  const gate = f.make("/start", { choose: true });
  await gate.start();
  f.account.select("wsp_a");
  await gate.signOutEverywhere();
  expect(f.asked).toContain("signOutEverywhere()");
  expect(f.selected()).toBeNull();
  expect(gate.state).toMatchObject({
    step: "email",
    notice: "You were signed out of every browser.",
  });
  // The control plane did not say it was over: the list stays, with the reason, and the open workspace stays too.
  const refused = fake({
    session: () => ok(ANN),
    workspaces: () => ok(listed),
    signOutEverywhere: () => false,
  });
  const stuck = refused.make("/start", { choose: true });
  await stuck.start();
  refused.account.select("wsp_a");
  await stuck.signOutEverywhere();
  expect(stuck.state).toMatchObject({
    step: "workspaces",
    error: "Could not sign out of every browser. Try again in a moment.",
  });
  expect(refused.selected()).toBe("wsp_a");
  // Nothing happens outside the list.
  const other = f.make("/");
  await other.signOutEverywhere();
  expect(other.state.step).toBe("loading");
});

// ---- passkeys ------------------------------------------------------------------------------------------------

/** A browser's WebAuthn that a test sets: what it can do, and what it answers. */
function webauthn(
  options: {
    available?: boolean;
    get?: (options: unknown, quietly?: AbortSignal) => Promise<unknown>;
    create?: () => Promise<unknown>;
    onThisDevice?: boolean;
    inSuggestions?: boolean;
  } = {},
): WebAuthn {
  return {
    available: () => options.available ?? true,
    onThisDevice: async () => options.onThisDevice ?? false,
    inSuggestions: async () => options.inSuggestions ?? false,
    get: options.get ?? (async () => ({ id: "credential" })),
    create: options.create ?? (async () => ({ id: "made" })),
  };
}

/** A "Not now" that a test reads. */
function memory(said = false) {
  const kept = { said };
  const say = () => {
    kept.said = true;
  };
  return { kept, declined: { said: () => kept.said, say } };
}

test("a browser that can do passkeys is offered one, and one that cannot is not", async () => {
  const f = fake();
  const can = new GateController({
    account: f.account as never,
    go: () => {},
    path: "/",
    webauthn: webauthn(),
  });
  await can.start();
  expect(can.state).toMatchObject({ step: "email", passkeys: true });
  const cannot = new GateController({
    account: fake().account as never,
    go: () => {},
    path: "/",
    webauthn: webauthn({ available: false }),
  });
  await cannot.start();
  expect(cannot.state).toMatchObject({ step: "email", passkeys: false });
});

test("signing in with a passkey: the options, the browser's dialog, the answer, and then as after a code that was right", async () => {
  const f = fake({
    passkeyOptions: () => ok({ challenge: "c" }),
    signInWithPasskey: () => ok({}),
  });
  const gate = new GateController({
    account: f.account as never,
    go: (p) => void f.went.push(p),
    path: "/",
    webauthn: webauthn({ get: async () => ({ id: "credential", response: {} }) }),
  });
  await gate.start();
  // The session is there once the passkey was accepted.
  f.set("session", () => ok(ANN));
  f.set("workspaces", () => ok([workspace("wsp_a")]));
  await gate.signInWithPasskey();
  expect(f.asked).toContain("passkeyOptions()");
  expect(f.asked).toContain('signInWithPasskey({"id":"credential","response":{}})');
  expect(f.selected()).toBe("wsp_a");
  expect(f.went).toEqual(["/"]);
});

test("a passkey that was not used, was not known, or could not be asked for leaves the page at the address with a line that points to the emailed code, and the address typed stays", async () => {
  const ask = async (setUp: {
    get?: () => Promise<unknown>;
    options?: () => unknown;
    entered?: () => unknown;
  }) => {
    const f = fake({
      passkeyOptions: setUp.options ?? (() => ok({ challenge: "c" })),
      signInWithPasskey: setUp.entered ?? (() => ok({})),
    });
    const gate = new GateController({
      account: f.account as never,
      go: () => {},
      path: "/",
      webauthn: webauthn(setUp.get ? { get: setUp.get } : {}),
    });
    await gate.start();
    // An address half typed: it stays through whatever the passkey does.
    await gate.submitEmail("ann", null);
    await gate.signInWithPasskey();
    return { gate, f };
  };
  const dismissed = await ask({
    get: () => {
      throw new PasskeyCancelled();
    },
  });
  expect(dismissed.gate.state).toMatchObject({
    step: "email",
    email: "ann",
    error:
      "No passkey was used. If you do not have one yet, continue with your email and add one after you sign in.",
  });
  const broken = await ask({ get: () => Promise.reject(new Error("no authenticator")) });
  expect(broken.gate.state).toMatchObject({
    error: "This browser could not use a passkey. Ask for a code instead.",
  });
  const unknown = await ask({ entered: () => no(401, "PASSKEY_NOT_FOUND", "Passkey not found") });
  expect(unknown.gate.state).toMatchObject({
    error: "That passkey is not known here. Ask for a code instead.",
  });
  const limited = await ask({
    entered: () =>
      no(429, "too_many_tries", "Too many failed passkey sign-ins from here. Try again later."),
  });
  expect(limited.gate.state).toMatchObject({
    error: "Too many failed passkey sign-ins from here. Try again later.",
  });
  const down = await ask({
    options: () => no(0, "unreachable", "The service could not be reached."),
  });
  expect(down.gate.state).toMatchObject({ error: "The service could not be reached." });
  // Nothing happens outside the address step.
  const f = fake();
  const other = new GateController({ account: f.account as never, go: () => {}, path: "/" });
  await other.signInWithPasskey();
  expect(other.state.step).toBe("loading");
});

test("after a first code, on a device that can make a passkey, the person is offered one; made, they go on as they would have", async () => {
  const f = fake({ session: () => ok(null) });
  const { declined } = memory();
  const gate = new GateController({
    account: f.account as never,
    go: (p) => void f.went.push(p),
    path: "/",
    webauthn: webauthn({ onThisDevice: true }),
    declined,
  });
  await gate.start();
  await gate.submitEmail("ann@example.com", "token");
  f.set("session", () => ok(ANN));
  f.set("workspaces", () => ok([workspace("wsp_a")]));
  await gate.submitCode("123456");
  expect(gate.state).toEqual({ step: "passkey", person: ANN });
  expect(f.asked).toContain("passkeys()");
  await gate.makePasskey();
  expect(f.asked).toContain("passkeyRegisterOptions()");
  expect(f.asked).toContain('addPasskey({"id":"made"})');
  expect(f.selected()).toBe("wsp_a");
  expect(f.went).toEqual(["/"]);
});

test('the offer, dismissed, stays; refused, says why; "Not now" goes on and is not asked again in this browser', async () => {
  const offered = async (
    setUp: { create?: () => Promise<unknown>; added?: () => unknown } = {},
  ) => {
    const f = fake({ ...(setUp.added ? { addPasskey: setUp.added } : {}) });
    const store = memory();
    const gate = new GateController({
      account: f.account as never,
      go: (p) => void f.went.push(p),
      path: "/",
      webauthn: webauthn({ onThisDevice: true, ...(setUp.create ? { create: setUp.create } : {}) }),
      declined: store.declined,
    });
    await gate.start();
    await gate.submitEmail("ann@example.com", "token");
    f.set("session", () => ok(ANN));
    await gate.submitCode("123456");
    return { gate, f, store };
  };
  const dismissed = await offered({
    create: () => Promise.reject(new PasskeyCancelled()),
  });
  await dismissed.gate.makePasskey();
  expect(dismissed.gate.state).toEqual({
    step: "passkey",
    person: ANN,
    notice: "No passkey was made.",
  });
  const refused = await offered({
    added: () =>
      no(400, "passkey_needs_verification", "This passkey does not check who is using it."),
  });
  await refused.gate.makePasskey();
  expect(refused.gate.state).toMatchObject({
    step: "passkey",
    error:
      "This passkey would not check who is using it. Use one that asks for your screen lock or a biometric check.",
  });
  const unverified = await offered({
    added: () => no(400, "FAILED_TO_VERIFY_REGISTRATION", "Failed to verify registration"),
  });
  await unverified.gate.makePasskey();
  expect(unverified.gate.state).toMatchObject({
    step: "passkey",
    error:
      "This passkey could not be verified. Use one that asks for your screen lock or a biometric check.",
  });
  const skipped = await offered();
  await skipped.gate.skipPasskey();
  expect(skipped.store.kept.said).toBe(true);
  expect(skipped.gate.state.step).toBe("workspaces");
  expect(skipped.f.asked.some((a) => a.startsWith("addPasskey"))).toBe(false);
});

test('no offer to a person who has a passkey, on a device that cannot make one, in a browser told "Not now", or after signing in with a passkey', async () => {
  const after = async (setUp: { held?: unknown[]; device?: boolean; said?: boolean }) => {
    const f = fake({ passkeys: () => ok(setUp.held ?? []) });
    const gate = new GateController({
      account: f.account as never,
      go: () => {},
      path: "/",
      webauthn: webauthn({ onThisDevice: setUp.device ?? true }),
      declined: memory(setUp.said).declined,
    });
    await gate.start();
    await gate.submitEmail("ann@example.com", "token");
    f.set("session", () => ok(ANN));
    await gate.submitCode("123456");
    return gate.state.step;
  };
  expect(await after({ held: [{ id: "pk_1" }] })).toBe("workspaces");
  expect(await after({ device: false })).toBe("workspaces");
  expect(await after({ said: true })).toBe("workspaces");
  const f = fake({ passkeyOptions: () => ok({ challenge: "c" }) });
  const gate = new GateController({
    account: f.account as never,
    go: () => {},
    path: "/",
    webauthn: webauthn({ onThisDevice: true }),
    declined: memory().declined,
  });
  await gate.start();
  f.set("session", () => ok(ANN));
  await gate.signInWithPasskey();
  expect(gate.state.step).toBe("workspaces");
  expect(f.asked).not.toContain("passkeys()");
});

test("where the browser suggests passkeys in the email field, there is no passkey button, and a passkey chosen from the suggestions signs the person in", async () => {
  const f = fake({ passkeyOptions: () => ok({ challenge: "c" }) });
  let quietly: AbortSignal | undefined;
  let choose: (value: unknown) => void = () => {};
  const gate = new GateController({
    account: f.account as never,
    go: (p) => void f.went.push(p),
    path: "/",
    webauthn: webauthn({
      inSuggestions: true,
      get: (_options, signal) => {
        quietly = signal;
        return new Promise((resolve) => {
          choose = resolve;
        });
      },
    }),
    later: () => () => {},
  });
  await gate.start();
  expect(gate.state).toMatchObject({ step: "email", passkeys: false });
  await Bun.sleep(0);
  expect(quietly?.aborted).toBe(false);
  f.set("session", () => ok(ANN));
  f.set("workspaces", () => ok([workspace("wsp_a")]));
  choose({ id: "credential", response: {} });
  await Bun.sleep(0);
  await Bun.sleep(0);
  expect(f.asked).toContain('signInWithPasskey({"id":"credential","response":{}})');
  expect(f.went).toEqual(["/"]);
});

test("the wait for a suggested passkey ends when the person asks for a code, and is begun again with a new challenge before the old one runs out", async () => {
  const f = fake({ passkeyOptions: () => ok({ challenge: "c" }) });
  const signals: AbortSignal[] = [];
  let renew: () => void = () => {};
  const gate = new GateController({
    account: f.account as never,
    go: () => {},
    path: "/",
    webauthn: webauthn({
      inSuggestions: true,
      get: (_options, signal) => {
        if (signal) signals.push(signal);
        return new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new PasskeyCancelled())),
        );
      },
    }),
    later: (_milliseconds, then) => {
      renew = then;
      return () => {};
    },
  });
  await gate.start();
  await Bun.sleep(0);
  expect(signals).toHaveLength(1);
  renew();
  await Bun.sleep(0);
  expect(signals).toHaveLength(2);
  expect(signals[0]?.aborted).toBe(true);
  expect(f.asked.filter((a) => a === "passkeyOptions()")).toHaveLength(2);
  await gate.submitEmail("ann@example.com", "token");
  expect(signals[1]?.aborted).toBe(true);
  expect(gate.state.step).toBe("code");
});
