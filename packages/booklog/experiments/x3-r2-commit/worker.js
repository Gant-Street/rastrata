// X3 spike: what R2 costs in latency as the commit point, measured from a pod through a Worker with an R2 binding
// (a lower bound for a pod speaking S3 to R2 directly: no request signing, no public endpoint hop).
const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function authorized(header, env) {
  const match = /^Bearer (.+)$/.exec(header);
  if (!match || !env.TOKEN_SHA256) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(match[1]));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return same(hex, env.TOKEN_SHA256);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const colo = request.cf?.colo || "";
    if (url.pathname === "/ping") return json({ ok: true, colo }, 200, { "x-worker-colo": colo });
    if (!(await authorized(request.headers.get("authorization") || "", env)))
      return json({ error: "unauthorized" }, 401);
    const key = url.searchParams.get("key") || "";
    if (!key.startsWith("x3/")) return json({ error: "key must start with x3/" }, 400);
    const started = Date.now();
    const done = (value) =>
      json(value, 200, {
        "x-worker-colo": colo,
        "server-timing": "r2;dur=" + (Date.now() - started),
      });
    try {
      if (url.pathname === "/put") {
        // Create-only, as the log's commit point would be: refused if the key exists.
        const size = Number(url.searchParams.get("size") || 2048);
        const body = new Uint8Array(size).fill(97);
        const result = await env.BUCKET.put(key, body, { onlyIf: { etagDoesNotMatch: "*" } });
        return done({ created: result !== null });
      }
      if (url.pathname === "/head") {
        const result = await env.BUCKET.head(key);
        return done({ found: result !== null });
      }
      if (url.pathname === "/get") {
        const result = await env.BUCKET.get(key);
        const bytes = result ? (await result.arrayBuffer()).byteLength : 0;
        return done({ found: result !== null, bytes });
      }
      if (url.pathname === "/delete") {
        await env.BUCKET.delete(key);
        return done({ deleted: true });
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
};
