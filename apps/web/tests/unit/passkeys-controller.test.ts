// The person's passkeys on the list of workspaces (src/passkeys-controller.ts): read, add on this device, remove; against stand-ins for the control plane and the browser's WebAuthn.
import { expect, test } from "bun:test";
import type { PasskeySummary, Result } from "../../src/account";
import { PasskeyCancelled, type WebAuthn } from "../../src/passkeys";
import { PasskeysController } from "../../src/passkeys-controller";

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const no = (status: number, code: string, message: string): Result<never> => ({
  ok: false,
  status,
  code,
  message,
  retryAfter: null,
});
const passkey = (id: string, name = "Passkey"): PasskeySummary => ({
  id,
  name,
  createdAt: "2026-10-15T12:00:00.000Z",
  synced: false,
});

function setup(
  options: {
    held?: PasskeySummary[];
    register?: () => Result<unknown>;
    add?: () => Result<unknown>;
    remove?: () => Result<unknown>;
    create?: () => Promise<unknown>;
    available?: boolean;
  } = {},
) {
  const held = options.held ?? [];
  const asked: string[] = [];
  const webauthn: WebAuthn = {
    available: () => options.available ?? true,
    onThisDevice: async () => true,
    inSuggestions: async () => false,
    get: async () => ({}),
    create: async (given) => {
      asked.push(`create(${JSON.stringify(given)})`);
      return options.create ? options.create() : { id: "made" };
    },
  };
  const controller = new PasskeysController({
    webauthn,
    account: {
      passkeys: async () => {
        asked.push("passkeys");
        return ok([...held]);
      },
      passkeyRegisterOptions: async () => {
        asked.push("passkeyRegisterOptions");
        return options.register ? options.register() : ok({ challenge: "c" });
      },
      addPasskey: async (response: unknown) => {
        asked.push(`addPasskey(${JSON.stringify(response)})`);
        const answer = options.add ? options.add() : ok({});
        if (answer.ok) held.push(passkey(`p${held.length + 1}`));
        return answer;
      },
      removePasskey: async (id: string) => {
        asked.push(`removePasskey(${id})`);
        const answer = options.remove ? options.remove() : ok({});
        if (answer.ok) held.splice(0, held.length, ...held.filter((p) => p.id !== id));
        return answer;
      },
    },
  });
  return { controller, asked, held };
}

test("the passkeys are read, and a browser that cannot do passkeys is not offered the section", async () => {
  const { controller } = setup({ held: [passkey("p1", "Laptop")] });
  expect(controller.state).toEqual({ step: "loading" });
  await controller.load();
  expect(controller.state).toEqual({
    step: "ready",
    passkeys: [passkey("p1", "Laptop")],
    busy: null,
  });
  expect(controller.available).toBe(true);
  expect(setup({ available: false }).controller.available).toBe(false);
});

test("a passkey is made on this device: the options, the browser's dialog, the answer back, the list read again with a word about it", async () => {
  const { controller, asked } = setup();
  await controller.load();
  const states: string[] = [];
  controller.subscribe(
    (state) => void states.push(state.step === "ready" ? `ready:${state.busy}` : state.step),
  );
  await controller.add();
  expect(asked).toEqual([
    "passkeys",
    "passkeyRegisterOptions",
    'create({"challenge":"c"})',
    'addPasskey({"id":"made"})',
    "passkeys",
  ]);
  expect(states[0]).toBe("ready:adding");
  expect(controller.state).toMatchObject({
    step: "ready",
    busy: null,
    notice: "The passkey was added.",
  });
  expect(controller.state.step === "ready" && controller.state.passkeys).toHaveLength(1);
});

test("a dismissed dialog adds nothing and says so, a device that cannot make one says so, and the control plane's refusals have their remedies", async () => {
  const dismissed = setup({
    create: () => {
      throw new PasskeyCancelled();
    },
  });
  await dismissed.controller.load();
  await dismissed.controller.add();
  expect(dismissed.controller.state).toMatchObject({ busy: null, notice: "No passkey was added." });
  expect(dismissed.asked.some((line) => line.startsWith("addPasskey"))).toBe(false);

  const broken = setup({
    create: () => Promise.reject(new Error("no authenticator")),
  });
  await broken.controller.load();
  await broken.controller.add();
  expect(broken.controller.state).toMatchObject({ error: "This device could not make a passkey." });

  const stale = setup({ register: () => no(403, "SESSION_NOT_FRESH", "Session is not fresh") });
  await stale.controller.load();
  await stale.controller.add();
  expect(stale.controller.state).toMatchObject({
    error:
      "To add a passkey, sign in again first: it asks for a sign-in from the last few minutes.",
  });
  expect(stale.asked.some((line) => line.startsWith("create"))).toBe(false);

  const unchecked = setup({
    add: () =>
      no(400, "passkey_needs_verification", "This passkey does not check who is using it."),
  });
  await unchecked.controller.load();
  await unchecked.controller.add();
  expect(unchecked.controller.state).toMatchObject({
    error:
      "This passkey would not check who is using it. Use one that asks for your screen lock or a biometric check.",
  });
  // The library's own refusal, which comes first since it requires the check itself.
  const unverified = setup({
    add: () => no(400, "FAILED_TO_VERIFY_REGISTRATION", "Failed to verify registration"),
  });
  await unverified.controller.load();
  await unverified.controller.add();
  expect(unverified.controller.state).toMatchObject({
    error:
      "This passkey could not be verified. Use one that asks for your screen lock or a biometric check.",
  });

  const many = setup({
    add: () => no(400, "too_many_passkeys", "You can have 10 passkeys. Remove one first."),
  });
  await many.controller.load();
  await many.controller.add();
  expect(many.controller.state).toMatchObject({
    error: "You can have 10 passkeys. Remove one first.",
  });
});

test("a passkey is removed and the list read again; a refusal is shown in the control plane's words; nothing is asked twice at once or before the list is read", async () => {
  const { controller, asked } = setup({ held: [passkey("p1"), passkey("p2")] });
  // Before the list is read there is nothing to act on.
  await controller.remove("p1");
  expect(asked).toEqual([]);
  await controller.load();
  await controller.remove("p1");
  expect(asked).toEqual(["passkeys", "removePasskey(p1)", "passkeys"]);
  expect(controller.state).toMatchObject({ notice: "The passkey was removed." });
  expect(controller.state.step === "ready" && controller.state.passkeys.map((p) => p.id)).toEqual([
    "p2",
  ]);

  const refused = setup({
    held: [passkey("p1")],
    remove: () => no(401, "PASSKEY_NOT_FOUND", "Passkey not found"),
  });
  await refused.controller.load();
  await refused.controller.remove("p1");
  expect(refused.controller.state).toMatchObject({ busy: null, error: "Passkey not found" });

  // A second press while the first is waiting is the first.
  const slow = setup({ held: [passkey("p1")] });
  await slow.controller.load();
  const first = slow.controller.add();
  await slow.controller.add();
  await first;
  expect(slow.asked.filter((line) => line === "passkeyRegisterOptions")).toHaveLength(1);
});
