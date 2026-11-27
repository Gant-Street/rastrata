// Deleting the account from the list of workspaces (src/delete-account-controller.ts, and Account.deleteAccount): the address is typed, nothing is sent until it is, the only owner
// of a workspace is told which, and a deleted account leaves the page for the sign-in page.
import { expect, test } from "bun:test";
import { Account, type Result } from "../../src/account";
import { DeleteAccountController, sameAddress } from "../../src/delete-account-controller";

const ok = (): Result<unknown> => ({ ok: true, value: { ok: true } });
const no = (
  status: number,
  code: string,
  message: string,
  detail?: Record<string, unknown>,
): Result<never> => ({
  ok: false,
  status,
  code,
  message,
  retryAfter: null,
  ...(detail ? { detail } : {}),
});

function setup(answer: () => Promise<Result<unknown>> | Result<unknown> = ok) {
  const log: string[] = [];
  const controller = new DeleteAccountController({
    account: {
      deleteAccount: async (confirm: string) => {
        log.push(`deleteAccount(${JSON.stringify(confirm)})`);
        return answer();
      },
    },
    address: "Ann@Example.com",
    forget: () => void log.push("forget"),
    go: (path) => void log.push(`go(${JSON.stringify(path)})`),
    leaveFor: "/",
  });
  const states: string[] = [];
  controller.subscribe((state) => void states.push(state.step));
  return { controller, log, states };
}

test("an address is read as the service reads it: without the spaces around it, whatever the case", () => {
  expect(sameAddress("ann@example.com", "Ann@Example.com")).toBe(true);
  expect(sameAddress("  ANN@EXAMPLE.COM ", "ann@example.com")).toBe(true);
  expect(sameAddress("ann@example.co", "ann@example.com")).toBe(false);
  expect(sameAddress("", "ann@example.com")).toBe(false);
  expect(sameAddress("ann @example.com", "ann@example.com")).toBe(false);
});

test("nothing is sent until the address is typed; then the account is deleted, the open workspace is forgotten and the page leaves for the sign-in page", async () => {
  const { controller, log, states } = setup();
  await controller.run("ann@exampl");
  expect(log).toEqual([]);
  expect(controller.state).toEqual({
    step: "failed",
    message: "Type your email address to delete your account.",
  });
  await controller.run(" ann@example.com ");
  expect(log).toEqual(['deleteAccount("ann@example.com")', "forget", 'go("/")']);
  expect(states).toEqual(["failed", "deleting", "done"]);
  expect(controller.state).toEqual({ step: "done" });
});

test("the only owner of a workspace is told which and nothing is done; any other refusal says what the service said; asking twice at once is asking once", async () => {
  const blocked = setup(() =>
    no(409, "sole_owner", "You are the only owner.", {
      workspaces: [
        { id: "wsp_a", name: "Acme Books" },
        { id: "wsp_b", name: "Side Books" },
        { nonsense: true },
      ],
    }),
  );
  await blocked.controller.run("ann@example.com");
  expect(blocked.controller.state).toEqual({
    step: "blocked",
    workspaces: [
      { id: "wsp_a", name: "Acme Books" },
      { id: "wsp_b", name: "Side Books" },
    ],
  });
  expect(blocked.log).toEqual(['deleteAccount("ann@example.com")']);

  // A refusal that names no workspaces is a plain failure with the service's words.
  const odd = setup(() => no(409, "sole_owner", "You are the only owner.", { workspaces: "x" }));
  await odd.controller.run("ann@example.com");
  expect(odd.controller.state).toEqual({ step: "failed", message: "You are the only owner." });

  const down = setup(() => no(0, "unreachable", "The service could not be reached."));
  await down.controller.run("ann@example.com");
  expect(down.controller.state).toEqual({
    step: "failed",
    message: "The service could not be reached.",
  });
  expect(down.log).not.toContain("forget");

  let release: (value: Result<unknown>) => void = () => {};
  const slow = setup(() => new Promise<Result<unknown>>((done) => (release = done)));
  const first = slow.controller.run("ann@example.com");
  await slow.controller.run("ann@example.com");
  release(ok());
  await first;
  expect(slow.log.filter((line) => line.startsWith("deleteAccount"))).toHaveLength(1);
});

test("Account.deleteAccount posts the address typed, forgets the token on success, and gives a refusal's whole body to the page", async () => {
  const seen: { url: string; method: string; body: unknown }[] = [];
  let answer: Response = new Response("{}", { status: 200 });
  const account = new Account({
    ask: (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return answer.clone();
    }) as typeof fetch,
    storage: null,
  });
  expect(await account.deleteAccount("ann@example.com")).toMatchObject({ ok: true });
  expect(seen).toEqual([
    { url: "/auth/account/delete", method: "POST", body: { confirm: "ann@example.com" } },
  ]);
  answer = new Response(
    JSON.stringify({
      message: "You are the only owner.",
      code: "sole_owner",
      workspaces: [{ id: "wsp_a", name: "Acme Books" }],
    }),
    { status: 409, headers: { "content-type": "application/json" } },
  );
  expect(await account.deleteAccount("ann@example.com")).toEqual({
    ok: false,
    status: 409,
    code: "sole_owner",
    message: "You are the only owner.",
    retryAfter: null,
    detail: { workspaces: [{ id: "wsp_a", name: "Acme Books" }] },
  });
});
