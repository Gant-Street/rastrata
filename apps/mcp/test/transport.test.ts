import { expect, test } from "bun:test";
import { APPLICATION_API_VERSION, operationCatalog } from "@rastrata/application/schema";
import { readText } from "../src/body.ts";
import { ApplicationClient, localApiUrl } from "../src/client.ts";
import { toolDescription } from "../src/tools.ts";

const get = operationCatalog.find((item) => item.name === "book.get");
const create = operationCatalog.find((item) => item.name === "drafts.create");
if (!get || !create) throw new Error("Missing canonical operations");

test("the API target is fixed loopback and permissions cannot be enlarged by runtime input", () => {
  expect(localApiUrl("http://127.0.0.1:4010").origin).toBe("http://127.0.0.1:4010");
  for (const url of [
    "https://example.com",
    "http://example.com",
    "http://127.0.0.1:4010/v1/",
    "http://user:secret@localhost:4010",
    "http://localhost:4010/?token=secret",
  ])
    expect(() => localApiUrl(url)).toThrow();
  expect(() => new ApplicationClient("http://localhost:4010", "another book", ["read"])).toThrow();
  expect(() => new ApplicationClient("http://localhost:4010", "local-book", ["post"])).toThrow();
});

test("redirects cannot turn the local adapter into an arbitrary HTTP caller", async () => {
  let redirected = 0;
  const destination = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      redirected++;
      return new Response("Private");
    },
  });
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.redirect(destination.url, 307);
    },
  });
  try {
    const client = new ApplicationClient(upstream.url.toString(), "local-book", ["read"]);
    expect(await client.call(get, {})).toMatchObject({
      ok: false,
      error: { code: "service_unavailable" },
    });
    expect(redirected).toBe(0);
  } finally {
    await upstream.stop(true);
    await destination.stop(true);
  }
});

test("invalid upstream scope, envelopes and output contracts remain uncertain writes, with no automatic retry", async () => {
  const id = crypto.randomUUID();
  const variants = [
    { version: APPLICATION_API_VERSION, bookId: "other-book", ok: true, operationId: id, data: {} },
    { version: "future-version", bookId: "local-book", ok: true, operationId: id, data: {} },
    {
      version: APPLICATION_API_VERSION,
      bookId: "local-book",
      ok: true,
      operationId: crypto.randomUUID(),
      data: {},
    },
    { version: APPLICATION_API_VERSION, bookId: "local-book", ok: true, operationId: id, data: {} },
  ];
  let attempts = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.json(variants[attempts++]);
    },
  });
  try {
    const client = new ApplicationClient(upstream.url.toString(), "local-book", ["read", "draft"]);
    const input = {
      data: {
        date: "2026-01-01",
        reference: "Fixture",
        narration: "Opening",
        lines: [
          { accountId: "1000", debit: "0.10", credit: "" },
          { accountId: "3000", debit: "", credit: "0.10" },
        ],
      },
    };
    for (let i = 0; i < variants.length; i++)
      expect(await client.call(create, input, id)).toMatchObject({
        ok: false,
        operationId: id,
        error: { code: "operation_unresolved", retryable: true },
      });
    expect(attempts).toBe(variants.length);
  } finally {
    await upstream.stop(true);
  }
});

test("stream bounds reject overflow, invalid UTF-8 and a stalled upload", async () => {
  await expect(readText(new Response("12345").body, 4, AbortSignal.timeout(1000))).rejects.toThrow(
    "size limit",
  );
  await expect(
    readText(new Response(new Uint8Array([0xff])).body, 10, AbortSignal.timeout(1000)),
  ).rejects.toThrow();
  await expect(readText(new ReadableStream(), 10, AbortSignal.timeout(20))).rejects.toThrow(
    "interrupted",
  );
});

test("a deprecated operation says so first in the tool description a model reads", () => {
  expect(
    toolDescription(
      { deprecated: "Since 2027-03-01; use new_thing. Removed in v2." },
      "Does a thing.",
      true,
    ),
  ).toBe(
    "Deprecated: Since 2027-03-01; use new_thing. Removed in v2. Does a thing. Retain operationId and reuse it with identical input on retries.",
  );
  expect(toolDescription({}, "Reads a thing.", false)).toBe("Reads a thing.");
});
