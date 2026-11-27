// The application the page talks to, in this process: the real book service on a book of its own and the real
// request handler in front of it, with the page's `fetch` answered by it. Nothing is listening on a port, and a test
// can slow a request or answer it itself to see what the page does then.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationHttp } from "@rastrata/application/http";
import { createLegacyBookHandler } from "@rastrata/application/legacy-http";
import { LocalBookService } from "@rastrata/application/local";
import { BUSINESS_PERMISSIONS } from "@rastrata/application/schema";

export type Book = Awaited<ReturnType<typeof openBook>>;

/** What the page's requests meet before the application: a reply of the test's own, or undefined to go on. */
export type Interceptor = (
  request: Request,
  proceed: () => Promise<Response>,
) => Promise<Response | undefined> | Response | undefined;

const ORIGIN = "http://127.0.0.1:4000";

export async function openBook() {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-dom-"));
  const service = await LocalBookService.open(join(directory, "book.sqlite"));
  const application = new ApplicationHttp(service, {
    bookId: service.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  // The older routes under /api/ (uploads, the bank tiles' reads), as the service answers them (apps/api/src/server.ts).
  const legacy = createLegacyBookHandler(service);
  const interceptors: Interceptor[] = [];
  const watchers = new Set<(request: Request, response: Response) => void>();
  const asked: string[] = [];

  /** The service itself: the application's routes and the little the page asks of the web server. */
  const serve = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname.startsWith("/v1/")) return application.fetch(request);
    if (url.pathname.startsWith("/api/")) {
      const refusal = await application.guardLegacy(request);
      return refusal ?? legacy(request);
    }
    return new Response("Not found", { status: 404 });
  };

  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const base = input instanceof Request ? input.url : String(input);
    const request = new Request(new URL(base, window.location.href), init);
    const url = new URL(request.url);
    if (url.pathname.startsWith("/v1/")) asked.push(url.pathname.slice(4));
    // The newest interceptor first, as Playwright's routes are; each can let the request go on.
    const run = async (index: number): Promise<Response> => {
      const next = interceptors[index];
      if (!next) return serve(request.clone());
      const answer = await next(request.clone(), () => run(index + 1));
      return answer ?? run(index + 1);
    };
    const response = await run(0);
    for (const watcher of watchers) watcher(request, response.clone());
    return response;
  }) as typeof fetch;

  return {
    service,
    /** Every operation the page asked for, in order. */
    asked,
    intercept(interceptor: Interceptor): () => void {
      interceptors.unshift(interceptor);
      return () => {
        const at = interceptors.indexOf(interceptor);
        if (at >= 0) interceptors.splice(at, 1);
      };
    },
    clearInterceptors() {
      interceptors.length = 0;
    },
    watch(watcher: (request: Request, response: Response) => void): () => void {
      watchers.add(watcher);
      return () => watchers.delete(watcher);
    },
    /** Hold the requests named back by `ms` (all of them when no names are given); returns the way to stop. */
    slow(ms: number, ...names: string[]): () => void {
      return this.intercept(async (request) => {
        const name = new URL(request.url).pathname.replace(/^\/v1\//, "");
        if (names.length === 0 || names.includes(name))
          await new Promise((done) => setTimeout(done, ms));
        return undefined;
      });
    },
    /** The service as a program outside the page reaches it (Playwright's `request`): no interceptor applies. */
    serve(request: Request): Promise<Response> {
      return serve(request);
    },
    origin: ORIGIN,
    /** Ask the application directly, as a test's own setup does. */
    async call<T = unknown>(name: string, input: unknown): Promise<T> {
      const response = await serve(
        new Request(`${ORIGIN}/v1/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: "rastrata-application-v1",
            bookId: service.bookId,
            operationId: crypto.randomUUID(),
            input,
          }),
        }),
      );
      const body = (await response.json()) as { ok: boolean; data: T; error?: { message: string } };
      if (!body.ok) throw new Error(`${name}: ${body.error?.message}`);
      return body.data;
    },
    async close() {
      globalThis.fetch = original;
      await (service as { close?: () => Promise<void> | void }).close?.();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
