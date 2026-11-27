export function isDocumentRequest(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    (request.headers.get("accept") ?? "").includes("text/html") &&
    !pathname.includes(".") &&
    pathname !== "/api" &&
    !pathname.startsWith("/api/")
  );
}

/** What the development and preview servers say for GET /health. The footer asks it of whatever serves
 * the page, to learn whether the installed service is still reading the book; these are not that
 * service, so there is nothing to wait for. Answering keeps a failed request (a 404 in the console)
 * off every page. */
export function webHealthResponse(request: Request): Response | null {
  const { pathname } = new URL(request.url);
  if (request.method !== "GET" || pathname !== "/health") return null;
  return Response.json(
    { ok: true, service: "rastrata-web" },
    { headers: { "cache-control": "no-store" } },
  );
}

export function serverPort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error("PORT must be an integer between 0 and 65535");
  const port = Number(value);
  if (port > 65535) throw new Error("PORT must be an integer between 0 and 65535");
  return port;
}

/** What a server with no application behind it says for `book.get`: a valid, honest answer
 * instead of an error, so the Home screen can say "not connected" without a failed request in
 * the console. Every other operation still fails, because nothing can answer it. */
export function disconnectedBookResponse(request: Request): Response | null {
  const { pathname } = new URL(request.url);
  if (request.method !== "POST" || pathname !== "/v1/book.get") return null;
  return Response.json({
    version: "rastrata-application-v1",
    bookId: "local-book",
    ok: true,
    data: {
      enabled: false,
      bookId: "local-book",
      setup: null,
      mode: "disconnected",
      permissions: [],
      head: null,
    },
  });
}
