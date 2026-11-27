import { resolve } from "node:path";
import { disconnectedBookResponse, isDocumentRequest, serverPort, webHealthResponse } from "./http";

const directory = resolve(import.meta.dir, "../dist");
const assets = new Map<string, ReturnType<typeof Bun.file>>();
for await (const path of new Bun.Glob("**/*").scan({ cwd: directory, onlyFiles: true })) {
  assets.set(`/${path}`, Bun.file(resolve(directory, path)));
}
const index = assets.get("/index.html");
if (!index) throw new Error("Run the web production build before preview");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: serverPort(process.env.PORT, 4001),
  fetch(request) {
    const disconnected = disconnectedBookResponse(request);
    if (disconnected) return disconnected;
    const health = webHealthResponse(request);
    if (health) return health;
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/book") return Response.json({ enabled: false, setup: null });
    if (pathname === "/api/journal") return Response.json({ book: null });
    if (pathname === "/api/accounts") return Response.json({ accounts: null });
    if (pathname === "/api/periods") return Response.json({ periods: null });
    const file = assets.get(pathname) ?? (isDocumentRequest(request) ? index : undefined);
    return file
      ? new Response(file, {
          headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
        })
      : new Response("Not found", { status: 404 });
  },
});
console.info(`Rastrata preview: ${server.url}`);
