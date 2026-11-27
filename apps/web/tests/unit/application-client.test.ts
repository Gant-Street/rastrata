import { expect, test } from "bun:test";
import { shown } from "../support/shown";
import { API_VERSION } from "@rastrata/application/client-contracts";
import {
  ApplicationRequestError,
  BrowserApplicationClient,
  type ApplicationFetch,
} from "../../src/application-client";

const input = { draftId: "draft", expectedVersion: 1, postingOperationId: crypto.randomUUID() };
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

test("browser retains exact recovery input before sending, resumes across reload, and blocks replacements", async () => {
  const store = storage();
  let retainedBody = "";
  const broken = (async (_url, init) => {
    retainedBody = String(init?.body);
    expect(store.getItem(`rastrata:${API_VERSION}:local-book:journal:pending`)).not.toBeNull();
    throw new Error("Lost response");
  }) as ApplicationFetch;
  const first = new BrowserApplicationClient(store, broken);
  await expect(first.write("drafts.recover", input, "journal")).rejects.toThrow("uncertain");
  await expect(
    first.write("drafts.recover", { ...input, expectedVersion: 2 }, "journal"),
  ).rejects.toThrow("Resume the original");
  const working = (async (_url, init) => {
    expect(String(init?.body)).toBe(retainedBody);
    const request = JSON.parse(retainedBody);
    return Response.json({
      version: API_VERSION,
      bookId: "local-book",
      ok: true,
      operationId: request.operationId,
      data: {
        id: "draft",
        version: 2,
        status: "draft",
        data: {},
        recoveredFromOperationId: input.postingOperationId,
      },
    });
  }) as ApplicationFetch;
  const reopened = new BrowserApplicationClient(store, working);
  expect((await reopened.resume("journal")).name).toBe("drafts.recover");
  expect(reopened.pending("journal")).toBeNull();
});

test("untracked writes cannot be sent when browser storage fails", async () => {
  let sent = false;
  const client = new BrowserApplicationClient(
    {
      ...storage(),
      setItem() {
        throw new Error("Storage unavailable");
      },
    },
    (async () => {
      sent = true;
      return new Response();
    }) as ApplicationFetch,
  );
  await expect(client.write("drafts.recover", input, "journal")).rejects.toThrow(
    "Storage unavailable",
  );
  expect(sent).toBe(false);
});

test("malformed receipts and error envelopes leave the original browser write unresolved", async () => {
  for (const response of [
    { ok: true, data: { disposition: "committed" } },
    { ok: false, error: { code: "made_up" } },
  ]) {
    const store = storage();
    const client = new BrowserApplicationClient(store, (async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return Response.json(
        {
          version: API_VERSION,
          bookId: "local-book",
          operationId: request.operationId,
          ...response,
        },
        { status: response.ok ? 200 : 400 },
      );
    }) as ApplicationFetch);
    await expect(
      client.write(
        "operations.commit",
        { planId: crypto.randomUUID(), planHash: "0".repeat(64) },
        "journal",
      ),
    ).rejects.toThrow("uncertain");
    expect(client.pending("journal")).not.toBeNull();
  }
});

test("two browser clients cannot replace a retained write while its reply is unresolved", async () => {
  const store = storage();
  let gate: Promise<unknown> = Promise.resolve();
  const lock: import("../../src/application-client").ApplicationLock = (_key, work) => {
    const result = gate.then(work);
    gate = result.catch(() => {});
    return result;
  };
  let sends = 0;
  const lost: ApplicationFetch = async () => {
    sends++;
    throw new Error("Lost response");
  };
  const first = new BrowserApplicationClient(store, lost, "local-book", lock);
  const second = new BrowserApplicationClient(store, lost, "local-book", lock);
  const result = await Promise.allSettled([
    first.write("drafts.recover", input, "journal"),
    second.write("drafts.recover", { ...input, expectedVersion: 2 }, "journal"),
  ]);
  expect(result.map((item) => item.status)).toEqual(["rejected", "rejected"]);
  expect(sends).toBe(1);
  expect(JSON.parse(first.pending("journal")?.body ?? "{}").input).toEqual(input);
});

test("a revoked grant cannot discard the retained identity of an earlier write", async () => {
  for (const name of ["drafts.recover", "book.setup"] as const) {
    const store = storage();
    const client = new BrowserApplicationClient(store, async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return Response.json(
        {
          version: API_VERSION,
          bookId: "local-book",
          operationId: request.operationId,
          ok: false,
          error: {
            code: "permission_denied",
            message: "Grant revoked",
            retryable: false,
            details: [],
          },
        },
        { status: 403 },
      );
    });
    const inputs =
      name === "drafts.recover"
        ? input
        : {
            name: "Fixture",
            currency: "USD" as const,
            fiscalYear: 2026,
            periodModel: "monthly" as const,
            accounts: [],
          };
    await expect(client.write(name, inputs, "journal")).rejects.toThrow("Grant revoked");
    const retained = client.pending("journal");
    expect(retained).not.toBeNull();
    await expect(client.resume("journal")).rejects.toThrow("Grant revoked");
    expect(client.pending("journal")).toEqual(retained);
  }
});

test("a failure's message is written like the screen: its dates, instants and amounts", () => {
  const error = new ApplicationRequestError(
    "2028-01-05 is after the end of the book's fiscal calendar. Debits are 12500.00 and credits are -3.50, last read 2026-10-04T18:57:24.887Z.",
    "calendar_not_configured",
  );
  expect(error.message).toBe(
    `${shown.date("2028-01-05")} is after the end of the book's fiscal calendar. Debits are ${shown.money("12500.00")} and credits are ${shown.money("-3.50")}, last read ${shown.instant("2026-10-04T18:57:24.887Z")}.`,
  );
  // The service's field-level details are data, not words: they are left as they came.
  const withDetails = new ApplicationRequestError(
    "Not covered.",
    "calendar_not_configured",
    false,
    [{ path: "calendar", message: "2026-01-01 to 2027-12-31" }],
  );
  expect(withDetails.details).toEqual([{ path: "calendar", message: "2026-01-01 to 2027-12-31" }]);
});

/** A service that answers a read as each of `answers` says, in turn, and counts how often it was asked. */
function reading(answers: readonly ("ok" | "busy" | "moving" | "denied" | "silent" | "page")[]) {
  let asked = 0;
  const times: number[] = [];
  const fetcher = (async () => {
    const kind = answers[Math.min(asked, answers.length - 1)];
    asked += 1;
    times.push(performance.now());
    const envelope = { version: API_VERSION, bookId: "local-book" };
    if (kind === "silent") throw new TypeError("Failed to fetch");
    // An error page of whatever stands in front of the service is not the service speaking.
    if (kind === "page") return new Response("<html>502</html>", { status: 502 });
    if (kind === "ok") return Response.json({ ...envelope, ok: true, data: { waiting: 3 } });
    const refusal =
      kind === "denied"
        ? {
            code: "permission_denied",
            message: "Not yours to read.",
            retryable: false,
            status: 403,
          }
        : kind === "busy"
          ? {
              code: "rate_limited",
              message: "Too many requests for the book.",
              retryable: true,
              status: 429,
            }
          : {
              code: "book_busy",
              message: "The book is held elsewhere.",
              retryable: true,
              status: 503,
            };
    return Response.json(
      {
        ...envelope,
        ok: false,
        error: {
          code: refusal.code,
          message: refusal.message,
          retryable: refusal.retryable,
          details: [],
        },
      },
      { status: refusal.status },
    );
  }) as ApplicationFetch;
  return { fetcher, asked: () => asked, times };
}
const fresh = { fresh: true } as const;

test("a read that the service says to send again is sent again, and the person is told nothing of it: a book passing from one server to another, a limit of the moment, no answer, an answer that is not the service's", async () => {
  for (const first of ["moving", "busy", "silent", "page"] as const) {
    const service = reading([first, "ok"]);
    const client = new BrowserApplicationClient(storage(), service.fetcher);
    expect(await client.read("inbox.summary", {}, fresh)).toEqual({ waiting: 3 } as never);
    expect(service.asked()).toBe(2);
    // Not at once: a quarter of a second later.
    expect((service.times[1] as number) - (service.times[0] as number)).toBeGreaterThanOrEqual(240);
  }
});

test("a read is asked four times at most, further apart each time, and then the person is told what the service said", async () => {
  const service = reading(["moving"]);
  const client = new BrowserApplicationClient(storage(), service.fetcher);
  const began = performance.now();
  const failed = await client.read("inbox.summary", {}, fresh).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failed).toBeInstanceOf(ApplicationRequestError);
  expect((failed as ApplicationRequestError).code).toBe("book_busy");
  expect(service.asked()).toBe(4);
  // 250, 750 and 1,500 ms between them.
  expect(performance.now() - began).toBeGreaterThanOrEqual(2450);
  expect(performance.now() - began).toBeLessThan(4000);
});

test("a refusal that asking again would not change is said at once: not this sign-in's to read", async () => {
  const service = reading(["denied", "ok"]);
  const client = new BrowserApplicationClient(storage(), service.fetcher);
  await expect(client.read("inbox.summary", {}, fresh)).rejects.toMatchObject({
    code: "permission_denied",
  });
  expect(service.asked()).toBe(1);
});

test("a read that the page has given up on is not asked again", async () => {
  const service = reading(["moving", "ok"]);
  const client = new BrowserApplicationClient(storage(), service.fetcher);
  const leaving = new AbortController();
  const read = client.read("inbox.summary", {}, { fresh: true, signal: leaving.signal });
  await Bun.sleep(50);
  leaving.abort();
  await expect(read).rejects.toBeInstanceOf(ApplicationRequestError);
  await Bun.sleep(400);
  expect(service.asked()).toBe(1);
});

test("a write is never sent again by the page of its own accord when the service says it is busy: its request is kept, and the person or the page's own resume sends it", async () => {
  let asked = 0;
  const store = storage();
  const client = new BrowserApplicationClient(store, (async (_url, init) => {
    asked += 1;
    const request = JSON.parse(String(init?.body));
    return Response.json(
      {
        version: API_VERSION,
        bookId: "local-book",
        operationId: request.operationId,
        ok: false,
        error: {
          code: "book_busy",
          message: "The book is held elsewhere.",
          retryable: true,
          details: [],
        },
      },
      { status: 503 },
    );
  }) as ApplicationFetch);
  await expect(client.write("drafts.recover", input, "journal")).rejects.toMatchObject({
    code: "book_busy",
    uncertain: true,
  });
  expect(asked).toBe(1);
});
