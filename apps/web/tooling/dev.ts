import index from "../index.html";
import { fontFor } from "./fonts";
import { helpContentFor } from "./help";
import { disconnectedBookResponse, isDocumentRequest, serverPort, webHealthResponse } from "./http";
import { createLegacyBookHandler } from "@rastrata/application/legacy-http";
import { readOwnerKey } from "@rastrata/application/agent/local";

const configuredEndpoint =
  process.env.RASTRATA_API_URL ??
  (process.env.RASTRATA_LOCAL_DEV === "1" ? "http://127.0.0.1:4010" : null);
const endpoint = configuredEndpoint ? new URL(configuredEndpoint) : null;
if (
  endpoint &&
  (endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash)
)
  throw new Error("The initial web application endpoint must be an explicit loopback HTTP origin");
const disconnected = createLegacyBookHandler(null);
// When the API runs with RASTRATA_OWNER_KEY_FILE, this server acts for its owner (the person using
// the browser) by sending the key with requests that carry no credentials of their own. A request
// that brings a token or a key keeps it, so a token is never upgraded here. Anything that can reach
// this port can use it as the owner: the lock is not a boundary against another program on this
// computer (see docs/explanation/agent-access.md).
const ownerKeyFile = process.env.RASTRATA_OWNER_KEY_FILE;

async function applicationProxy(request: Request): Promise<Response> {
  const url = new URL(request.url),
    origin = request.headers.get("origin");
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || (origin && origin !== url.origin))
    return Response.json({ error: "Local application origin denied" }, { status: 403 });
  if (!endpoint)
    return url.pathname.startsWith("/v1/")
      ? (disconnectedBookResponse(request) ??
          Response.json({ error: "Application is disconnected" }, { status: 503 }))
      : disconnected(request);
  try {
    const headers = new Headers(request.headers);
    headers.delete("origin");
    headers.delete("host");
    if (ownerKeyFile && !headers.has("authorization")) {
      try {
        headers.set("authorization", `Bearer ${readOwnerKey(ownerKeyFile)}`);
      } catch {
        return Response.json(
          { error: "RASTRATA_OWNER_KEY_FILE is set but cannot be used; start the API first" },
          { status: 503 },
        );
      }
    }
    return await fetch(new URL(`${url.pathname}${url.search}`, endpoint), {
      method: request.method,
      headers,
      ...(request.method !== "GET" && request.method !== "HEAD" ? { body: request.body } : {}),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
    });
  } catch {
    return Response.json(
      { error: "Application service unavailable; start bun run dev:api" },
      { status: 503 },
    );
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: serverPort(process.env.PORT, 4000),
  // Hot reloading for a person at the keyboard. The browser suites set RASTRATA_WEB_HMR=0 and get the bundle as it
  // ships: the hot-reload runtime loads modules lazily, and a cycle of imports that is fine in a browser (TanStack's
  // router-core keeps its reload hook in such a cycle) comes back as null there.
  development: process.env.RASTRATA_WEB_HMR === "0" ? false : { hmr: true, console: true },
  routes: {
    "/": index,
    "/journal": index,
    "/journal/new": index,
    "/accounts": index,
    "/periods": index,
    "/ledger": index,
    "/reports": index,
    "/api/book": applicationProxy,
    "/api/book/setup": applicationProxy,
    "/licenses/inter.txt": () =>
      new Response(Bun.file(new URL(import.meta.resolve("@rastrata/ui/inter-license")))),
    "/licenses/jetbrains-mono.txt": () =>
      new Response(Bun.file(new URL(import.meta.resolve("@rastrata/ui/jetbrains-mono-license")))),
  },
  fetch(request): Response | Promise<Response> {
    const health = webHealthResponse(request);
    if (health) return health;
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/") || path.startsWith("/v1/")) return applicationProxy(request);
    // Help's topics, made from docs/ as they are asked for (the build writes them as files).
    if (path.startsWith("/help-content/")) {
      const topic = helpContentFor(path);
      return topic === null
        ? new Response("Not found", { status: 404 })
        : new Response(topic, {
            headers: {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
            },
          });
    }
    // The faces of the scripts that are not Latin are files, as they are in the build (tooling/fonts.ts).
    const face = fontFor(path);
    if (face !== null)
      return new Response(Bun.file(face), { headers: { "content-type": "font/woff2" } });
    if (isDocumentRequest(request))
      return fetch(new URL("/", server.url), { headers: { Accept: "text/html" } });
    return new Response("Not found", { status: 404 });
  },
});
console.info(`Rastrata: ${server.url}`);
