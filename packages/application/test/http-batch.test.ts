// `POST /v1/batch` (src/http.ts): reads carried together, for what a page shows. Each one is answered as its own route would answer it, a write is refused without being run, and the
// credential is looked at once and each read for its permission.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationHttp, MAX_BATCHED_READS } from "../src/http.ts";
import { LocalBookService } from "../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../src/schema.ts";
import type { BusinessPermission } from "../src/schema.ts";

const book = {
  name: "Batch Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Cash", role: "asset" },
    { code: "3000", name: "Capital", role: "equity" },
    { code: "4000", name: "Sales", role: "income" },
    { code: "5000", name: "Expense", role: "expense" },
  ],
};

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

async function fixture(permissions: readonly BusinessPermission[] = BUSINESS_PERMISSIONS) {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-api-batch-"));
  const service = await LocalBookService.open(join(directory, "book.sqlite"));
  const http = new ApplicationHttp(service, { bookId: service.bookId, permissions });
  cleanup.push(() => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const body = (input: unknown) => ({
    version: APPLICATION_API_VERSION,
    bookId: service.bookId,
    input,
  });
  /** One operation by its own route. */
  const alone = async (name: string, input: unknown = {}, operationId?: string) => {
    const response = await http.fetch(
      new Request(`http://127.0.0.1:4010/v1/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body(input), ...(operationId ? { operationId } : {}) }),
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  /** Several together; `raw` replaces the whole body. */
  const together = async (
    requests: readonly { name: string; body: unknown }[],
    options: { raw?: unknown; method?: string; type?: string; version?: string } = {},
  ) => {
    const response = await http.fetch(
      new Request("http://127.0.0.1:4010/v1/batch", {
        method: options.method ?? "POST",
        headers: { "content-type": options.type ?? "application/json" },
        ...((options.method ?? "POST") === "POST"
          ? {
              body: JSON.stringify(
                options.raw ?? { version: options.version ?? APPLICATION_API_VERSION, requests },
              ),
            }
          : {}),
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  return { alone, together, body, service };
}

const setupOnce = async (world: Awaited<ReturnType<typeof fixture>>) => {
  const made = await world.alone("book.setup", book, crypto.randomUUID());
  expect(made.status).toBe(200);
};

test("each read in a batch is answered as its own route answers it, in the order asked", async () => {
  const world = await fixture();
  await setupOnce(world);
  const asked = [
    { name: "book.get", input: {} },
    { name: "accounts.list", input: {} },
    { name: "periods.list", input: {} },
    { name: "accounts.list", input: {} },
  ];
  const separate = [];
  for (const item of asked) separate.push(await world.alone(item.name, item.input));
  const batch = await world.together(
    asked.map((item) => ({ name: item.name, body: world.body(item.input) })),
  );
  expect(batch.status).toBe(200);
  expect(batch.body).toMatchObject({ ok: true, version: APPLICATION_API_VERSION });
  expect(batch.body.data.responses).toEqual(separate);
  expect(batch.body.data.responses.map((item: { status: number }) => item.status)).toEqual([
    200, 200, 200, 200,
  ]);
});

test("a write named in a batch is refused without being run, and the reads around it are answered", async () => {
  const world = await fixture();
  const batch = await world.together([
    { name: "book.get", body: world.body({}) },
    { name: "book.setup", body: { ...world.body(book), operationId: crypto.randomUUID() } },
    { name: "capabilities.get", body: world.body({}) },
  ]);
  expect(batch.status).toBe(200);
  const [first, second, third] = batch.body.data.responses;
  expect(first.status).toBe(200);
  expect(second).toMatchObject({
    status: 400,
    body: { ok: false, error: { code: "batch_reads_only", retryable: false } },
  });
  expect(third.status).toBe(200);
  // The book was not set up by it.
  const after = await world.alone("book.get");
  expect(after.body.data.setup).toBeNull();
});

test("an operation that does not exist is not found for its place only", async () => {
  const world = await fixture();
  const batch = await world.together([
    { name: "no.such.thing", body: world.body({}) },
    { name: "book.get", body: world.body({}) },
  ]);
  expect(batch.status).toBe(200);
  expect(batch.body.data.responses[0]).toMatchObject({
    status: 404,
    body: { ok: false, error: { code: "route_not_found" } },
  });
  expect(batch.body.data.responses[1].status).toBe(200);
});

test("each read is checked for its permission as it would be alone", async () => {
  const world = await fixture(["read"]);
  const batch = await world.together([
    { name: "book.get", body: world.body({}) },
    { name: "tokens.list", body: world.body({}) },
    { name: "capabilities.get", body: world.body({}) },
  ]);
  expect(batch.status).toBe(200);
  const [first, second, third] = batch.body.data.responses;
  expect(first.status).toBe(200);
  expect(second).toMatchObject({ status: 403, body: { error: { code: "permission_denied" } } });
  expect(third.status).toBe(200);
  expect(second).toEqual(await world.alone("tokens.list"));
});

test("a read with a bad request is refused for its place only, with the answer its own route gives", async () => {
  const world = await fixture();
  const batch = await world.together([
    { name: "book.get", body: { ...world.body({}), bookId: "another-book" } },
    { name: "book.get", body: world.body({}) },
  ]);
  expect(batch.status).toBe(200);
  expect(batch.body.data.responses[0]).toMatchObject({
    status: 403,
    body: { error: { code: "book_scope_mismatch" } },
  });
  expect(batch.body.data.responses[1].status).toBe(200);
});

test("a batch has between one and the most requests, and the rest of the request is as strict as any other", async () => {
  const world = await fixture();
  const one = { name: "book.get", body: world.body({}) };
  const code = (answer: { body: { error?: { code: string } } }) => answer.body.error?.code;
  expect(code(await world.together([]))).toBe("invalid_input");
  expect(code(await world.together(Array.from({ length: MAX_BATCHED_READS + 1 }, () => one)))).toBe(
    "invalid_input",
  );
  expect((await world.together(Array.from({ length: MAX_BATCHED_READS }, () => one))).status).toBe(
    200,
  );
  expect(code(await world.together([one], { version: "0" }))).toBe("version_unsupported");
  expect(
    code(
      await world.together([one], {
        raw: { version: APPLICATION_API_VERSION, requests: [one], more: 1 },
      }),
    ),
  ).toBe("invalid_input");
  expect(code(await world.together([one], { raw: [one] }))).toBe("invalid_input");
  expect(code(await world.together([one], { type: "text/plain" }))).toBe("media_type_unsupported");
  expect(code(await world.together([one], { method: "GET" }))).toBe("method_not_allowed");
});
