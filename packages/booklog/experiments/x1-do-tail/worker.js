// X1 spike: the booklog LogTier served by one SQLite-backed Durable Object per book.
//
// SUPERSEDED by apps/tail-worker, the production Worker made from this one. Kept as the record of what
// bench.ts and results-2026-10-10.jsonl measured: bench.ts's hop, group-commit and location phases need
// the operations below that the production Worker does not have (echo, echof, where, stat, append_many).
//
// Protocol: packages/booklog/src/tier-durable.ts (POST /v1/books/<book>/<op>, bearer token, JSON,
// byte strings as base64). Semantics: ported from packages/booklog/src/tier-memory.ts, the reference tail.
// Two additions that are NOT part of that protocol and exist to be measured: append_many (several
// entries under one fence in one request and one durable write) and where and stat (diagnostics).
//
// Nothing here sets a timer, an alarm or a socket and nothing awaits inside the object but its own
// return, so an idle object can hibernate and is not billed for duration while it waits.
import { DurableObject } from "cloudflare:workers";

const GENESIS = "0".repeat(64);

export class BookTail extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.rowsRead = 0;
    this.rowsWritten = 0;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS book_head (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL, hash TEXT NOT NULL, sealed_through INTEGER NOT NULL, sealed_hash TEXT NOT NULL, fence INTEGER NOT NULL, holder TEXT, expires_at INTEGER)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS book_log (seq INTEGER PRIMARY KEY, prev_hash TEXT NOT NULL, hash TEXT NOT NULL, fence INTEGER NOT NULL, body TEXT NOT NULL, written_at INTEGER NOT NULL)",
    );
    this.sql.exec(
      "INSERT OR IGNORE INTO book_head (id, seq, hash, sealed_through, sealed_hash, fence, holder, expires_at) VALUES (1, 0, ?, 0, ?, 0, NULL, NULL)",
      GENESIS,
      GENESIS,
    );
  }

  #q(query, ...bindings) {
    const cursor = this.sql.exec(query, ...bindings);
    const rows = cursor.toArray();
    this.rowsRead += cursor.rowsRead;
    this.rowsWritten += cursor.rowsWritten;
    return rows;
  }

  #row() {
    return this.#q(
      "SELECT seq, hash, sealed_through, sealed_hash, fence, holder, expires_at FROM book_head WHERE id = 1",
    )[0];
  }

  #live(row, now) {
    return row.holder !== null && row.expires_at !== null && row.expires_at > now;
  }

  #view(row, now) {
    const live = this.#live(row, now);
    return {
      seq: row.seq,
      hash: row.hash,
      sealedThrough: row.sealed_through,
      sealedHash: row.sealed_hash,
      fence: row.fence,
      leaseHolder: live ? row.holder : null,
      leaseExpiresAt: live ? row.expires_at : null,
      now,
    };
  }

  #grant(row, now) {
    return {
      holder: row.holder,
      fence: row.fence,
      ttlMs: row.ttl,
      expiresAt: row.expires_at,
      head: this.#view(row, now),
    };
  }

  // Spike only: the same hop over fetch instead of RPC, to tell the two apart.
  async fetch() {
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }

  // One request, one answer. The whole body is synchronous, so the object handles nothing else
  // meanwhile, and the response is held back until the writes it made are durable.
  async call(op, body) {
    this.rowsRead = 0;
    this.rowsWritten = 0;
    const now = Date.now();
    const result = this.#dispatch(op, body, now);
    return { result: await result, rows: { read: this.rowsRead, written: this.rowsWritten } };
  }

  #dispatch(op, body, now) {
    switch (op) {
      case "echo":
        return {};
      case "head":
        return this.#view(this.#row(), now);
      case "read": {
        const limit = body.limit === undefined ? -1 : body.limit;
        const entries = this.#q(
          "SELECT seq, prev_hash AS prevHash, hash, fence, body, written_at AS writtenAt FROM book_log WHERE seq >= ? ORDER BY seq LIMIT ?",
          body.seq,
          limit,
        );
        return { entries, head: this.#view(this.#row(), now) };
      }
      case "append": {
        const row = this.#row();
        const refuse = (reason) => ({ ok: false, reason, head: this.#view(row, now) });
        if (!(body.fence > 0) || body.fence !== row.fence) return refuse("fence");
        if (body.seq === row.seq && body.hash === row.hash)
          return { ok: true, duplicate: true, head: this.#view(row, now) };
        if (body.seq !== row.seq + 1) return refuse("seq");
        if (body.prevHash !== row.hash) return refuse("prev");
        this.ctx.storage.transactionSync(() => {
          this.#q(
            "INSERT INTO book_log (seq, prev_hash, hash, fence, body, written_at) VALUES (?, ?, ?, ?, ?, ?)",
            body.seq,
            body.prevHash,
            body.hash,
            body.fence,
            body.body,
            now,
          );
          this.#q("UPDATE book_head SET seq = ?, hash = ? WHERE id = 1", body.seq, body.hash);
        });
        return {
          ok: true,
          duplicate: false,
          head: this.#view({ ...row, seq: body.seq, hash: body.hash }, now),
        };
      }
      case "append_many": {
        // Not in the protocol: the group commit. Every entry must chain from the one before; if one does
        // not, nothing is written and the refusal names the first that failed.
        const row = this.#row();
        const refuse = (reason, at) => ({ ok: false, reason, at, head: this.#view(row, now) });
        if (!(body.fence > 0) || body.fence !== row.fence) return refuse("fence", 0);
        let seq = row.seq;
        let hash = row.hash;
        for (let i = 0; i < body.entries.length; i += 1) {
          const entry = body.entries[i];
          if (entry.seq !== seq + 1) return refuse("seq", i);
          if (entry.prevHash !== hash) return refuse("prev", i);
          seq = entry.seq;
          hash = entry.hash;
        }
        this.ctx.storage.transactionSync(() => {
          for (const entry of body.entries)
            this.#q(
              "INSERT INTO book_log (seq, prev_hash, hash, fence, body, written_at) VALUES (?, ?, ?, ?, ?, ?)",
              entry.seq,
              entry.prevHash,
              entry.hash,
              body.fence,
              entry.body,
              now,
            );
          this.#q("UPDATE book_head SET seq = ?, hash = ? WHERE id = 1", seq, hash);
        });
        return {
          ok: true,
          count: body.entries.length,
          head: this.#view({ ...row, seq, hash }, now),
        };
      }
      case "acquire": {
        const row = this.#row();
        const live = this.#live(row, now);
        if (live && row.holder !== body.holder)
          return {
            ok: false,
            heldBy: row.holder,
            expiresInMs: row.expires_at - now,
            head: this.#view(row, now),
          };
        // The same holder asking again inside its lease keeps its token; anyone else, or the same
        // holder after a lapse, begins a new tenure with the next token.
        const fence = live && row.holder === body.holder ? row.fence : row.fence + 1;
        const next = {
          ...row,
          fence,
          holder: body.holder,
          expires_at: now + body.ttlMs,
          ttl: body.ttlMs,
        };
        this.#q(
          "UPDATE book_head SET fence = ?, holder = ?, expires_at = ? WHERE id = 1",
          next.fence,
          next.holder,
          next.expires_at,
        );
        return { ok: true, lease: this.#grant(next, now) };
      }
      case "renew": {
        const row = this.#row();
        const refuse = (reason) => ({ ok: false, reason, head: this.#view(row, now) });
        if (row.holder !== body.holder || row.fence !== body.fence) return refuse("taken");
        if (row.expires_at === null || row.expires_at <= now) return refuse("expired");
        const next = { ...row, expires_at: now + body.ttlMs, ttl: body.ttlMs };
        this.#q("UPDATE book_head SET expires_at = ? WHERE id = 1", next.expires_at);
        return { ok: true, lease: this.#grant(next, now) };
      }
      case "release": {
        const row = this.#row();
        if (row.holder === body.holder && row.fence === body.fence)
          // The token dies with the lease: a late append from the one who let go is refused too.
          this.#q(
            "UPDATE book_head SET fence = fence + 1, holder = NULL, expires_at = ? WHERE id = 1",
            now,
          );
        return {};
      }
      case "seal": {
        const row = this.#row();
        if (body.upTo > row.seq) return { ok: false, reason: "ahead", head: this.#view(row, now) };
        if (body.upTo <= row.sealed_through)
          return { ok: true, trimmed: 0, head: this.#view(row, now) };
        let trimmed = 0;
        this.ctx.storage.transactionSync(() => {
          const cursor = this.sql.exec("DELETE FROM book_log WHERE seq <= ?", body.upTo);
          cursor.toArray();
          trimmed = cursor.rowsWritten;
          this.rowsWritten += cursor.rowsWritten;
          this.rowsRead += cursor.rowsRead;
          this.#q(
            "UPDATE book_head SET sealed_through = ?, sealed_hash = ? WHERE id = 1",
            body.upTo,
            body.manifest.lastHash,
          );
        });
        return {
          ok: true,
          trimmed,
          head: this.#view(
            { ...row, sealed_through: body.upTo, sealed_hash: body.manifest.lastHash },
            now,
          ),
        };
      }
      case "adopt": {
        const row = this.#row();
        const held = this.#q("SELECT 1 AS one FROM book_log LIMIT 1").length > 0;
        if (row.seq !== 0 || row.sealed_through !== 0 || held || this.#live(row, now))
          return { ok: false, reason: "not_empty", head: this.#view(row, now) };
        const next = {
          ...row,
          seq: body.seq,
          hash: body.hash,
          sealed_through: body.seq,
          sealed_hash: body.hash,
          fence: Math.max(row.fence, body.fence),
          holder: null,
          expires_at: null,
        };
        this.#q(
          "UPDATE book_head SET seq = ?, hash = ?, sealed_through = ?, sealed_hash = ?, fence = ?, holder = NULL, expires_at = NULL WHERE id = 1",
          next.seq,
          next.hash,
          next.sealed_through,
          next.sealed_hash,
          next.fence,
        );
        return { ok: true, head: this.#view(next, now) };
      }
      case "stat": {
        const [count] = this.#q(
          "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(body)), 0) AS bytes FROM book_log",
        );
        return { entries: count.n, bodyBytes: count.bytes, databaseSize: this.sql.databaseSize };
      }
      case "where":
        return this.#where();
      default:
        throw new Error("unknown operation " + op);
    }
  }

  // Diagnostic: which Cloudflare location this object is running in (its outbound trace says).
  async #where() {
    const response = await fetch("https://cloudflare.com/cdn-cgi/trace");
    const text = await response.text();
    const field = (name) => (new RegExp("^" + name + "=(.*)$", "m").exec(text) || [])[1] || null;
    return { colo: field("colo"), loc: field("loc") };
  }
}

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

const ROUTE =
  /^\/v1\/books\/([^/]+)\/(head|read|append|append_many|acquire|renew|release|seal|adopt|where|stat|echo|echof)$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const colo = request.cf?.colo || "";
    if (url.pathname === "/ping")
      return json({ ok: true, colo, country: request.cf?.country || null }, 200, {
        "x-worker-colo": colo,
      });
    if (!(await authorized(request.headers.get("authorization") || "", env)))
      return json({ error: "unauthorized" }, 401);
    const match = ROUTE.exec(url.pathname);
    if (!match || request.method !== "POST") return json({ error: "not found" }, 404);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad json" }, 400);
    }
    const book = decodeURIComponent(match[1]);
    // Spike only: ?hint=enam creates the object with a location hint (it matters only for the first request).
    const hint = url.searchParams.get("hint");
    const stub = hint
      ? env.TAIL.get(env.TAIL.idFromName(book), { locationHint: hint })
      : env.TAIL.get(env.TAIL.idFromName(book));
    const started = Date.now();
    try {
      if (match[2] === "echof") {
        await (await stub.fetch("https://do.invalid/echo")).text();
        return json({}, 200, {
          "x-worker-colo": colo,
          "server-timing": "tail;dur=" + (Date.now() - started),
        });
      }
      const out = await stub.call(match[2], normalize(match[2], body));
      const took = Date.now() - started;
      return json(out.result, 200, {
        "x-worker-colo": colo,
        "server-timing": "tail;dur=" + took,
        "x-rows": "r=" + out.rows.read + ";w=" + out.rows.written,
      });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500, {
        "x-worker-colo": colo,
      });
    }
  },
};

// The wire carries numbers as JSON numbers; make sure the object never sees a string where it compares.
function normalize(op, body) {
  const out = { ...body };
  for (const key of ["seq", "fence", "ttlMs", "upTo", "limit"])
    if (out[key] !== undefined) out[key] = Number(out[key]);
  if (op === "append_many")
    out.entries = (out.entries || []).map((e) => ({ ...e, seq: Number(e.seq) }));
  return out;
}
