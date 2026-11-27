import { expect, test } from "bun:test";
import { API_VERSION } from "@rastrata/application/client-contracts";
import {
  ApplicationRequestError,
  BrowserApplicationClient,
  type ApplicationFetch,
} from "../../src/application-client";
import { postQuickEntry, quickPostOutcome } from "../../src/routes/entries/quick-post";

const WORKFLOW = "quick-entry";
const DATA = {
  date: "2026-03-02",
  reference: "Lunch",
  narration: "Lunch",
  lines: [
    { accountId: "5100", debit: "12.00", credit: "" },
    { accountId: "1000", debit: "", credit: "12.00" },
  ],
};
const draft = (version = 1, status = "draft") => ({ id: "draft-1", version, status, data: DATA });
const plan = (valid = true, id = crypto.randomUUID()) => ({
  disposition: "prepared",
  operationId: id,
  outcomeSequence: null,
  diagnostics: valid ? [] : ["Account 5100 is not active"],
  problems: valid
    ? []
    : [{ code: "invalid_chart_or_account", message: "Account 5100 is not active" }],
  planId: id,
  planHash: "a".repeat(64),
  bookRevision: "3",
  kind: "postDraft",
  valid,
  effects: {
    journals: [{ id: "journal-1", date: "2026-03-02", narration: "Lunch", lines: [] }],
    accounts: [],
    periods: [],
  },
});
const receipt = (id: string, disposition = "committed") => ({
  disposition,
  operationId: id,
  outcomeSequence: disposition === "committed" ? "4" : null,
  diagnostics: [],
  problems:
    disposition === "committed"
      ? []
      : [{ code: "stale_book_revision", message: "The book changed" }],
});

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

/** A service that answers each request with `answer(body)`, and the requests it was sent. */
function service(
  answer: (request: { operationId: string; input: Record<string, unknown> }) => unknown,
) {
  const sent: { path: string; body: { operationId: string; input: Record<string, unknown> } }[] =
    [];
  const fetcher = (async (url, init) => {
    const body = JSON.parse(String(init?.body));
    sent.push({ path: String(url), body });
    return Response.json({
      version: API_VERSION,
      bookId: "local-book",
      ok: true,
      operationId: body.operationId,
      data: answer(body),
    });
  }) as ApplicationFetch;
  return { sent, fetcher };
}

test("a Post is one request, however many steps it takes in the service, and its retained write is gone when it ends", async () => {
  const store = storage();
  const { sent, fetcher } = service(() => {
    const prepared = plan();
    return {
      draft: draft(1, "posted"),
      plan: prepared,
      receipt: receipt(prepared.planId),
      refusal: null,
    };
  });
  const client = new BrowserApplicationClient(store, fetcher);
  const outcome = await postQuickEntry(client, WORKFLOW, DATA, null);
  expect(outcome.kind).toBe("posted");
  expect(sent.map((request) => request.path)).toEqual(["/v1/journal.post"]);
  expect(sent[0]?.body.input).toEqual({ data: DATA });
  expect(sent[0]?.body.operationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  expect(client.pending(WORKFLOW)).toBeNull();
});

test("a second try sends the draft it holds and its version, in the same one request", async () => {
  const { sent, fetcher } = service(() => {
    const prepared = plan();
    return {
      draft: draft(2, "posted"),
      plan: prepared,
      receipt: receipt(prepared.planId),
      refusal: null,
    };
  });
  const client = new BrowserApplicationClient(storage(), fetcher);
  await postQuickEntry(client, WORKFLOW, DATA, draft(1) as never);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.body.input).toEqual({ data: DATA, draftId: "draft-1", expectedVersion: 1 });
});

test("what the service answered is read as the dialog needs it: posted, not valid, refused, or stopped with the draft", async () => {
  const prepared = plan();
  expect(
    quickPostOutcome({
      draft: draft(1, "posted"),
      plan: prepared,
      receipt: receipt(prepared.planId),
      refusal: null,
    } as never),
  ).toMatchObject({ kind: "posted" });
  const invalid = plan(false);
  const unposted = quickPostOutcome({
    draft: draft(),
    plan: invalid,
    receipt: null,
    refusal: null,
  } as never);
  expect(unposted).toMatchObject({ kind: "invalid" });
  if (unposted.kind !== "invalid") throw new Error("not invalid");
  expect(unposted.plan.problems[0]?.message).toBe("Account 5100 is not active");
  const turned = quickPostOutcome({
    draft: draft(2),
    plan: prepared,
    receipt: receipt(prepared.planId, "rejected"),
    refusal: null,
  } as never);
  expect(turned).toMatchObject({ kind: "refused", draft: { version: 2, status: "draft" } });
  // A date the books cannot take (before the book's first day): an error the dialog shows in the books'
  // words, and the draft is the dialog's, not lost to the error.
  const stopped = quickPostOutcome({
    draft: draft(),
    plan: null,
    receipt: null,
    refusal: {
      code: "calendar_not_configured",
      message: "2019-06-01 is before the first day of the book's fiscal calendar.",
      details: [
        { path: "input.data.date", message: "2019-06-01 is not covered by a fiscal period" },
      ],
      retryable: false,
    },
  } as never);
  expect(stopped.kind).toBe("stopped");
  if (stopped.kind !== "stopped") throw new Error("not stopped");
  expect(stopped.draft.id).toBe("draft-1");
  expect(stopped.error).toBeInstanceOf(ApplicationRequestError);
  // (A date in a message is written the way a person reads it, as every message of the client is.)
  expect((stopped.error as ApplicationRequestError).message).toBe(
    "Jun 1, 2019 is before the first day of the book's fiscal calendar.",
  );
});

test("a reply that lost its answer is resumed with the same request, once, and gives the same outcome", async () => {
  const store = storage();
  let lost = true;
  let retained = "";
  const prepared = plan();
  const fetcher = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (lost) {
      lost = false;
      retained = String(init?.body);
      throw new Error("Lost response");
    }
    expect(String(init?.body)).toBe(retained);
    return Response.json({
      version: API_VERSION,
      bookId: "local-book",
      ok: true,
      operationId: body.operationId,
      data: {
        draft: draft(1, "posted"),
        plan: prepared,
        receipt: receipt(prepared.planId),
        refusal: null,
      },
    });
  }) as ApplicationFetch;
  const client = new BrowserApplicationClient(store, fetcher);
  await expect(postQuickEntry(client, WORKFLOW, DATA, null)).rejects.toMatchObject({
    uncertain: true,
  });
  expect(client.pending(WORKFLOW)?.name).toBe("journal.post");
  const resumed = await client.resume(WORKFLOW);
  expect(resumed.name).toBe("journal.post");
  if (resumed.name !== "journal.post") throw new Error("not a post");
  expect(quickPostOutcome(resumed.data).kind).toBe("posted");
  expect(client.pending(WORKFLOW)).toBeNull();
});

test("a reply that is not a whole answer leaves the write unresolved instead of showing it", async () => {
  const prepared = plan();
  for (const data of [
    { draft: draft(), plan: null, receipt: null, refusal: null },
    {
      draft: draft(),
      plan: { ...prepared, planId: crypto.randomUUID() },
      receipt: null,
      refusal: null,
    },
    { draft: draft(), plan: prepared, receipt: receipt(crypto.randomUUID()), refusal: null },
    { draft: { id: "x" }, plan: prepared, receipt: null, refusal: null },
    { draft: draft(), plan: null, receipt: null, refusal: { code: 7 } },
    {
      draft: draft(),
      plan: prepared,
      receipt: {
        disposition: "maybe",
        operationId: prepared.planId,
        diagnostics: [],
        problems: [],
      },
      refusal: null,
    },
    { draft: draft() },
  ]) {
    const client = new BrowserApplicationClient(storage(), service(() => data).fetcher);
    await expect(postQuickEntry(client, WORKFLOW, DATA, null)).rejects.toMatchObject({
      uncertain: true,
    });
    expect(client.pending(WORKFLOW)).not.toBeNull();
  }
});
