import { afterEach, expect, test } from "bun:test";
import { API_VERSION } from "@rastrata/application/client-contracts";
import {
  ApplicationRequestError,
  BrowserApplicationClient,
  type ApplicationFetch,
} from "../../src/application-client";
import {
  announceSignInRequired,
  rememberSignIn,
  SESSION_ENDED_MESSAGE,
  SESSION_KEPT_WITHIN_MS,
  SIGN_IN_REQUIRED_EVENT,
  signIn,
  signInJustTaken,
  signOut,
  wantsSignIn,
} from "../../src/session";
import { UploadError, uploadStatement } from "../../src/routes/statements/upload";

const answer = (body: unknown, init: ResponseInit = {}) =>
  (async () => Response.json(body, init)) as unknown as typeof fetch;
const KEY = "rso_this-key-must-not-appear-anywhere-in-what-the-page-says00";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

/** A window that only listens, for the event the page raises when the service wants a sign-in. */
const originalWindow = (globalThis as { window?: unknown }).window;
function listening() {
  const target = new EventTarget();
  (globalThis as { window?: unknown }).window = target;
  let heard = 0;
  target.addEventListener(SIGN_IN_REQUIRED_EVENT, () => {
    heard += 1;
  });
  return () => heard;
}
afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

test("signing in sends the key in a JSON body to the sign-in route, and every answer is a message that is not the key", async () => {
  let sent:
    | { url: string; method: string | undefined; body: string; headers: Record<string, string> }
    | undefined;
  const ask = (status: number) =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent = {
        url: String(input),
        method: init?.method,
        body: String(init?.body),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      };
      return Response.json({ ok: status < 300 }, { status });
    }) as unknown as typeof fetch;

  expect(await signIn(`  ${KEY}\n`, ask(200))).toEqual({ ok: true });
  expect(sent).toMatchObject({ url: "/session/owner", method: "POST" });
  // The key trimmed, in the body, never in the address.
  expect(JSON.parse(sent?.body ?? "")).toEqual({ key: KEY });
  expect(sent?.url).not.toContain("rso_");
  expect(sent?.headers["content-type"]).toBe("application/json");

  const results = await Promise.all(
    [401, 429, 404, 500, 503].map((status) => signIn(KEY, ask(status))),
  );
  expect(results.map((result) => (result.ok ? "ok" : result.reason))).toEqual([
    "refused",
    "limited",
    "unsupported",
    "unavailable",
    "unavailable",
  ]);
  for (const result of results) {
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain("rso_");
  }
  const lost = await signIn(KEY, (async () => {
    throw new Error(`could not reach ${KEY}`);
  }) as unknown as typeof fetch);
  expect(lost).toMatchObject({ ok: false, reason: "unavailable" });
  expect(JSON.stringify(lost)).not.toContain("rso_");
});

test("signing out is the service's DELETE, and says whether it was done", async () => {
  let seen: { url: string; method: string | undefined } | undefined;
  const ask = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = { url: String(input), method: init?.method };
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  expect(await signOut(ask)).toBe(true);
  expect(seen).toEqual({ url: "/session", method: "DELETE" });
  expect(await signOut(answer({ ok: false }, { status: 403 }))).toBe(false);
  expect(
    await signOut((async () => {
      throw new Error("down");
    }) as unknown as typeof fetch),
  ).toBe(false);
});

test("a 401 from the service asks for the sign-in, and a write that met it is kept to be sent again, once, after", async () => {
  const heard = listening();
  const store = storage();
  const requests: { operationId?: string; name: string }[] = [];
  let signedIn = false;
  const service: ApplicationFetch = async (url, init) => {
    const request = JSON.parse(String(init?.body));
    requests.push({ operationId: request.operationId, name: String(url) });
    // What the hosted service says to a caller with no session: the application's own shape, whose identity
    // echo the page has no need of.
    if (!signedIn)
      return Response.json(
        {
          version: API_VERSION,
          bookId: "local-book",
          ok: false,
          error: {
            code: "authentication_required",
            message:
              "This service requires credentials: send the owner key or an agent token as a Bearer token",
            details: [],
            retryable: false,
          },
        },
        { status: 401 },
      );
    return Response.json({
      version: API_VERSION,
      bookId: "local-book",
      ok: true,
      operationId: request.operationId,
      data: { id: "draft", version: 1, status: "draft", data: {} },
    });
  };
  // (The window of this test only listens, so the browser's lock is replaced by one that just runs the work.)
  const client = new BrowserApplicationClient(store, service, "local-book", (_key, work) => work());

  // A read: the service's words are not shown, the page's are, and the code is the one the shell watches for.
  const read = await client.read("book.get", {}).catch((error: unknown) => error);
  expect(read).toBeInstanceOf(ApplicationRequestError);
  expect((read as ApplicationRequestError).message).toBe(SESSION_ENDED_MESSAGE);
  expect(wantsSignIn(read)).toBe(true);
  expect(heard()).toBe(1);

  // A write: refused whole, kept as it was, and said to be one to resume.
  const first = await client
    .write("drafts.create", { data: { date: "2026-03-02", lines: [] } as never }, "quick-entry")
    .catch((error: unknown) => error);
  expect(wantsSignIn(first)).toBe(true);
  expect((first as ApplicationRequestError).uncertain).toBe(true);
  expect(heard()).toBe(2);
  const kept = client.pending("quick-entry");
  expect(kept).not.toBeNull();

  // Signed in, the same request goes out again with the same identity, and is done.
  signedIn = true;
  const done = await client.resume("quick-entry");
  expect(done.name).toBe("drafts.create");
  expect(client.pending("quick-entry")).toBeNull();
  const writes = requests.filter((request) => request.name.endsWith("drafts.create"));
  expect(writes).toHaveLength(2);
  expect(writes[0]?.operationId).toBe(writes[1]?.operationId);
  expect(heard()).toBe(2);
});

test("a 401 that is not the service asking for a sign-in is not taken for one", async () => {
  const heard = listening();
  const refused: ApplicationFetch = async () =>
    Response.json(
      {
        version: API_VERSION,
        bookId: "local-book",
        ok: false,
        error: {
          code: "token_invalid",
          message: "The credentials were not accepted",
          details: [],
          retryable: false,
        },
      },
      { status: 401 },
    );
  const client = new BrowserApplicationClient(storage(), refused);
  const failure = await client.read("book.get", {}).catch((error: unknown) => error);
  expect(wantsSignIn(failure)).toBe(false);
  expect((failure as ApplicationRequestError).code).toBe("token_invalid");
  expect(heard()).toBe(0);
  expect(wantsSignIn(new Error("x"))).toBe(false);
  expect(wantsSignIn(null)).toBe(false);
  expect(wantsSignIn(undefined)).toBe(false);
  // Raising the event with no window (a unit test, a worker) is not an error.
  (globalThis as { window?: unknown }).window = undefined;
  announceSignInRequired();
});

test("an upload that meets the sign-in asks for it too", async () => {
  const heard = listening();
  const file = new File(["a,b\n1,2\n"], "statement.csv", { type: "text/csv" });
  const failure = await uploadStatement(
    file,
    "local-book",
    answer(
      {
        version: API_VERSION,
        bookId: "local-book",
        ok: false,
        error: { code: "authentication_required", message: "x", details: [], retryable: false },
      },
      { status: 401 },
    ),
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(UploadError);
  expect((failure as UploadError).code).toBe("authentication_required");
  expect((failure as UploadError).message).toBe(SESSION_ENDED_MESSAGE);
  expect(heard()).toBe(1);
});

test("the sign-in page notes that the service took the key, and a page that is the sign-in again a moment later says so, once", () => {
  const notes = storage();
  // Nothing noted: a visit like any other.
  expect(signInJustTaken(notes, 5_000)).toBe(false);
  // The key was taken, and the page read again at once is the sign-in again: the session was not kept.
  rememberSignIn(notes, 5_000);
  expect(JSON.stringify([...Object.values(notes)])).not.toContain("rso_");
  expect(signInJustTaken(notes, 5_000 + SESSION_KEPT_WITHIN_MS - 1)).toBe(true);
  // Said once: the note is gone after it is read.
  expect(signInJustTaken(notes, 5_000 + 1)).toBe(false);
  // A note from long ago, or one that is not a time, says nothing.
  rememberSignIn(notes, 5_000);
  expect(signInJustTaken(notes, 5_000 + SESSION_KEPT_WITHIN_MS)).toBe(false);
  notes.setItem("rastrata:signed-in-at", "not a time");
  expect(signInJustTaken(notes, 5_000)).toBe(false);
  // A clock that went back is not a reason to say it.
  rememberSignIn(notes, 9_000);
  expect(signInJustTaken(notes, 1_000)).toBe(false);
});

test("a browser that will not keep a note, or lets it be read and not written, is never the reason a page fails", () => {
  const refusing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  expect(() => rememberSignIn(refusing, 1)).not.toThrow();
  expect(signInJustTaken(refusing, 1)).toBe(false);
  expect(() => rememberSignIn(null, 1)).not.toThrow();
  expect(signInJustTaken(null, 1)).toBe(false);
});
