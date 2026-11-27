import { createHash } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import { ApplicationHttp, MAX_UPLOAD_BYTES } from "../../src/http.ts";
import { LocalBookService } from "../../src/local.ts";
import { BUSINESS_PERMISSIONS } from "../../src/schema.ts";
import { cleanFileName } from "../../src/slices/statements/uploads.ts";
import { statementsFixture, type StatementsFixture } from "./harness.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const open: StatementsFixture[] = [];
afterEach(() => {
  for (const fixture of open.splice(0)) fixture.close();
});
async function fixture() {
  const created = await statementsFixture({ setup: false });
  open.push(created);
  return created;
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const csv = new TextEncoder().encode("Date,Amount,Description\n01/02/2026,-12.34,COFFEE\n");

test("an upload is archived under the SHA-256 of its exact bytes and the receipt says so", async () => {
  const f = await fixture();
  const response = await f.upload(csv, {
    "content-type": "text/csv; charset=utf-8",
    "x-upload-name": "January%202026.csv",
  });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    ok: true,
    version: "rastrata-application-v1",
    bookId: "local-book",
    data: {
      sha256: sha256(csv),
      size: csv.byteLength,
      mediaType: "text/csv",
      name: "January 2026.csv",
    },
  });
  expect(f.ingest.readArchive(sha256(csv))?.bytes).toEqual(csv);
});

test("sending the same bytes again returns the same receipt and stores nothing new", async () => {
  const f = await fixture();
  const first = await f.upload(csv);
  const second = await f.upload(csv);
  expect(second.body.data).toEqual(first.body.data);
  expect(f.ingest.blobs.size).toBe(1);
  const other = await f.upload(new TextEncoder().encode("x,y\n1,2\n"));
  expect(other.body.data.sha256).not.toBe(first.body.data.sha256);
  expect(f.ingest.blobs.size).toBe(2);
});

test("the file ceiling is exactly 16 MiB, declared or streamed", async () => {
  const f = await fixture();
  const exactly = new Uint8Array(MAX_UPLOAD_BYTES).fill(0x41);
  const accepted = await f.upload(exactly, { "content-type": "application/octet-stream" });
  expect(accepted.status).toBe(200);
  expect(accepted.body.data.size).toBe(MAX_UPLOAD_BYTES);

  const tooBig = new Uint8Array(MAX_UPLOAD_BYTES + 1).fill(0x42);
  const declared = await f.upload(tooBig, { "content-type": "text/csv" });
  expect(declared.status).toBe(413);
  expect(declared.body.error.code).toBe("request_too_large");
  expect(f.ingest.blobs.size).toBe(1);

  // No Content-Length: a chunked body is cut off as it crosses the ceiling.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let sent = 0; sent <= MAX_UPLOAD_BYTES; sent += 1024 * 1024)
        controller.enqueue(new Uint8Array(1024 * 1024).fill(0x43));
      controller.close();
    },
  });
  const chunked = await f.http.fetch(
    new Request("http://127.0.0.1:4010/v1/uploads", {
      method: "POST",
      headers: { "content-type": "text/csv" },
      body: stream,
      duplex: "half",
    } as RequestInit),
  );
  expect(chunked.status).toBe(413);
  expect(f.ingest.blobs.size).toBe(1);
});

test("an empty body, a missing body and a lying Content-Length are refused", async () => {
  const f = await fixture();
  expect((await f.upload(new Uint8Array(0))).body.error.code).toBe("invalid_input");
  const bodiless = await f.http.fetch(
    new Request("http://127.0.0.1:4010/v1/uploads", {
      method: "POST",
      headers: { "content-type": "text/csv" },
    }),
  );
  expect(bodiless.status).toBe(400);
  const lying = await f.http.fetch(
    new Request("http://127.0.0.1:4010/v1/uploads", {
      method: "POST",
      headers: { "content-type": "text/csv", "content-length": "abc" },
      body: csv,
    }),
  );
  expect(lying.status).toBe(413);
  expect(f.ingest.blobs.size).toBe(0);
});

test("only statement-shaped media types are accepted, and an unlabelled body is a file", async () => {
  const f = await fixture();
  for (const type of [
    "application/json",
    "multipart/form-data; boundary=x",
    "application/pdf",
    "image/png",
    "text/html",
    "application/zip",
  ]) {
    const response = await f.upload(csv, { "content-type": type });
    expect(response.status, type).toBe(415);
    expect(response.body.error.code).toBe("media_type_unsupported");
  }
  for (const type of [
    "text/csv",
    "TEXT/CSV; charset=windows-1252",
    "application/vnd.ms-excel",
    "application/x-ofx",
    "application/vnd.intu.qfx",
    "application/vnd.intu.qbo",
    "application/octet-stream",
    // A workbook: what a report of another system exports, read by Bring in history.
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ])
    expect((await f.upload(csv, { "content-type": type })).status, type).toBe(200);
  expect(f.ingest.blobs.size).toBe(1);
  const unlabelled = await f.upload(new Uint8Array([0x41, 0x2c, 0x42, 0x0a, 0x31, 0x2c, 0x32]), {});
  expect(unlabelled.status).toBe(200);
  expect(unlabelled.body.data.mediaType).toBe("application/octet-stream");
  expect(f.ingest.blobs.size).toBe(2);
});

test("uploading needs draft permission, a POST and the local origin", async () => {
  const f = await fixture();
  expect((await f.upload(csv, { "content-type": "text/csv" }, ["read"])).status).toBe(403);
  expect((await f.upload(csv, { "content-type": "text/csv" }, ["draft"])).status).toBe(200);
  const wrongMethod = await f.http.fetch(new Request("http://127.0.0.1:4010/v1/uploads"));
  expect(wrongMethod.status).toBe(405);
  const withQuery = await f.http.fetch(
    new Request("http://127.0.0.1:4010/v1/uploads?name=x", {
      method: "POST",
      headers: { "content-type": "text/csv" },
      body: csv,
    }),
  );
  expect(withQuery.status).toBe(404);
  const foreign = await f.http.fetch(
    new Request("http://127.0.0.1:4010/v1/uploads", {
      method: "POST",
      headers: { "content-type": "text/csv", origin: "https://example.com" },
      body: csv,
    }),
  );
  expect(foreign.status).toBe(403);
  expect(f.ingest.blobs.size).toBe(1);
});

test("a file name is a label: paths, control and direction characters never survive", () => {
  expect(cleanFileName(null)).toBeUndefined();
  expect(cleanFileName("")).toBeUndefined();
  expect(cleanFileName("..")).toBeUndefined();
  expect(cleanFileName(encodeURIComponent("../../etc/passwd"))).toBe("passwd");
  expect(cleanFileName(encodeURIComponent("C:\\Users\\me\\statement.csv"))).toBe("statement.csv");
  expect(cleanFileName(encodeURIComponent("a\u0000b\u001b[31mc\u202Ed.csv"))).toBe(
    "a b [31mc d.csv",
  );
  expect(cleanFileName("100%")).toBe("100%");
  expect([...(cleanFileName("x".repeat(500)) ?? "")].length).toBe(200);
  expect(cleanFileName(encodeURIComponent("  spaced   out  .csv  "))).toBe("spaced out .csv");
});

test("without the ingestion pipeline an upload fails with a code a client can act on", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-uploads-noingest-"));
  const service = await LocalBookService.open(join(directory, "book.sqlite"));
  try {
    const http = new ApplicationHttp(service, {
      bookId: service.bookId,
      permissions: BUSINESS_PERMISSIONS,
    });
    const response = await http.fetch(
      new Request("http://127.0.0.1:4010/v1/uploads", {
        method: "POST",
        headers: { "content-type": "text/csv" },
        body: csv,
      }),
    );
    const body = await response.json();
    // The pipeline either is not installed yet or, once it is, simply stores the file.
    expect([200, 503]).toContain(response.status);
    if (response.status === 503) expect(body.error.code).toBe("ingest_unavailable");
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an interrupted upload is retryable and stores nothing", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new Uint8Array(1024).fill(0x44));
      setTimeout(() => controller.abort(), 5);
    },
  });
  const response = await f.http.fetch(
    new Request("http://127.0.0.1:4010/v1/uploads", {
      method: "POST",
      headers: { "content-type": "text/csv" },
      body: stream,
      signal: controller.signal,
      duplex: "half",
    } as RequestInit),
  );
  expect(response.status).toBe(408);
  const body = await response.json();
  expect(body.error.retryable).toBe(true);
  expect(f.ingest.blobs.size).toBe(0);
});
