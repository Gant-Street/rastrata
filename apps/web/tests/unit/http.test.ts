import { expect, test } from "bun:test";
import {
  disconnectedBookResponse,
  isDocumentRequest,
  serverPort,
  webHealthResponse,
} from "../../tooling/http";

test("only HTML navigations may fall back to the application", () => {
  const request = (path: string, accept = "text/html", method = "GET") =>
    new Request(`http://localhost${path}`, { headers: { accept }, method });
  expect(isDocumentRequest(request("/journal"))).toBe(true);
  expect(isDocumentRequest(request("/unknown/nested", "text/html", "HEAD"))).toBe(true);
  for (const path of ["/missing.js", "/.env", "/missing.css", "/api", "/api/books"]) {
    expect(isDocumentRequest(request(path))).toBe(false);
  }
  expect(isDocumentRequest(request("/journal", "*/*"))).toBe(false);
  expect(isDocumentRequest(request("/journal", "text/html", "POST"))).toBe(false);
});

test("server ports accept zero for isolated tests and reject malformed input", () => {
  expect(serverPort(undefined, 4000)).toBe(4000);
  expect(serverPort("0", 4000)).toBe(0);
  expect(serverPort("65535", 4000)).toBe(65535);
  for (const value of ["", "NaN", "-1", "4000.5", "65536", "4000x"]) {
    expect(() => serverPort(value, 4000)).toThrow();
  }
});

test("a server with no application answers book.get honestly and nothing else", async () => {
  const post = (path: string, method = "POST") =>
    new Request(`http://localhost${path}`, method === "POST" ? { method, body: "{}" } : { method });
  const response = disconnectedBookResponse(post("/v1/book.get"));
  expect(response?.status).toBe(200);
  const body = (await response?.json()) as { ok: boolean; data: { enabled: boolean; setup: null } };
  expect(body.ok).toBe(true);
  expect(body.data.enabled).toBe(false);
  expect(body.data.setup).toBeNull();
  expect(disconnectedBookResponse(post("/v1/accounts.list"))).toBeNull();
  expect(disconnectedBookResponse(post("/v1/book.get", "GET"))).toBeNull();
});

test("the development and preview servers answer /health, so the footer's question is not a failed request", async () => {
  const get = (path: string, method = "GET") => new Request(`http://localhost${path}`, { method });
  const answer = webHealthResponse(get("/health"));
  expect(answer?.status).toBe(200);
  expect(await answer?.json()).toEqual({ ok: true, service: "rastrata-web" });
  expect(answer?.headers.get("cache-control")).toBe("no-store");
  // Only that question, only as a GET.
  expect(webHealthResponse(get("/health", "POST"))).toBeNull();
  expect(webHealthResponse(get("/healthy"))).toBeNull();
  expect(webHealthResponse(get("/api/health"))).toBeNull();
});
