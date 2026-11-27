import { createHash } from "node:crypto";
import { identifier } from "@rastrata/kernel";
import { requireLedger } from "./records.ts";
import type { NativeLedgerHead, SqliteLedgerRepository } from "./sqlite-ledger-repository.ts";
import type { SqliteStorage } from "./sqlite.ts";
import { atomicSqlite } from "./sqlite-transaction.ts";

const VERSION = "rastrata-native-projection-audit-v1";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const encoder = new TextEncoder();
export interface NativeProjectionDigest {
  readonly count: string;
  readonly digest: string;
}
export interface NativeProjectionProgress extends NativeProjectionDigest {
  readonly complete: boolean;
}
interface State extends NativeProjectionProgress {
  readonly version: typeof VERSION;
  readonly auditId: string;
  readonly head: NativeLedgerHead;
  readonly after: string | null;
}

/** Owner-only scan of an unavailable, immutable book at an exact head. The
 * admission callback must verify actual retirement or current restore approval.
 * One call consumes at most thirty-two facts and one MiB of fact bodies.
 * The digest includes identity, body, mutability and original outcome sequence.
 * Persist the completed SOURCE digest in the independent catalog before loss;
 * computing a target digest alone is not evidence of complete restoration. */
export async function auditNativeProjection(
  storage: SqliteStorage,
  repository: SqliteLedgerRepository,
  head: NativeLedgerHead,
  auditId: string,
  admit: () => void,
): Promise<NativeProjectionProgress> {
  identifier(auditId);
  requireLedger(encoder.encode(auditId).length <= 1024, "native_projection_audit_invalid");
  const seed = sha(JSON.stringify([VERSION, repository.scope, head]));
  const rows = (query: string, ...bindings: (string | number)[]) =>
    Array.from(storage.sql.exec(query, ...bindings));
  const encode = (state: State) => JSON.stringify(state);
  const load = (): State | null => {
    if (
      !rows(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='ledger_native_projection_audit'",
      ).length
    )
      return null;
    const row = rows(
      "SELECT CASE WHEN length(CAST(body AS BLOB))<=16384 THEN body END AS body, digest FROM ledger_native_projection_audit WHERE singleton=1",
    )[0];
    requireLedger(
      row && typeof row.body === "string" && sha(row.body) === row.digest,
      "native_projection_audit_corrupt",
    );
    const state = JSON.parse(row.body) as State;
    requireLedger(
      state !== null &&
        Object.keys(state).sort().join(",") ===
          "after,auditId,complete,count,digest,head,version" &&
        state.version === VERSION &&
        typeof state.auditId === "string" &&
        typeof state.complete === "boolean" &&
        typeof state.count === "string" &&
        /^(0|[1-9][0-9]{0,18})$/.test(state.count) &&
        typeof state.digest === "string" &&
        /^[a-f0-9]{64}$/.test(state.digest) &&
        (state.after === null ||
          (typeof state.after === "string" && encoder.encode(state.after).length <= 8192)),
      "native_projection_audit_corrupt",
    );
    requireLedger(
      (state.count === "0") === (state.after === null),
      "native_projection_audit_corrupt",
    );
    return state;
  };
  await storage.sync();
  const before = atomicSqlite(storage, () => {
    admit();
    const existing = load();
    if (existing && existing.auditId === auditId) {
      requireLedger(
        same(existing.head, head) && (existing.count !== "0" || existing.digest === seed),
        "native_projection_audit_conflict",
      );
      return existing;
    }
    // A new owner-authorized audit replaces only this derived checkpoint, never
    // canonical rows. Previous completed evidence survives in its catalog.
    const initial: State = {
      version: VERSION,
      auditId,
      head: { ...head },
      after: null,
      count: "0",
      digest: seed,
      complete: false,
    };
    rows(
      "CREATE TABLE IF NOT EXISTS ledger_native_projection_audit (singleton INTEGER PRIMARY KEY CHECK(singleton=1), body TEXT NOT NULL, digest TEXT NOT NULL)",
    );
    rows(
      "INSERT INTO ledger_native_projection_audit VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET body=excluded.body,digest=excluded.digest",
      encode(initial),
      sha(encode(initial)),
    );
    return initial;
  });
  await storage.sync();
  let next = before;
  if (!next.complete) {
    const page = await repository.factPage(next.after, 32, admit);
    requireLedger(same(page.observedTip, head), "native_projection_head_changed");
    for (const fact of page.facts) {
      next = {
        ...next,
        count: (BigInt(next.count) + 1n).toString(),
        digest: sha(JSON.stringify([VERSION, next.digest, fact])),
      };
    }
    // A short byte-limited page is NOT end-of-stream. Only an empty indexed
    // range proves completion; an oversized first row fails in factPage.
    next = { ...next, after: page.nextIdentity, complete: page.facts.length === 0 };
  }
  const current = await repository.outcomePage(head, 1, admit);
  requireLedger(
    same(current.observedTip, head) && current.outcomes.length === 0,
    "native_projection_head_changed",
  );
  atomicSqlite(storage, () => {
    admit();
    requireLedger(same(load(), before), "native_projection_audit_conflict");
    const body = encode(next);
    requireLedger(encoder.encode(body).length <= 16384, "native_projection_audit_invalid");
    rows(
      "UPDATE ledger_native_projection_audit SET body=?,digest=? WHERE singleton=1",
      body,
      sha(body),
    );
  });
  await storage.sync();
  return Object.freeze({ count: next.count, digest: next.digest, complete: next.complete });
}
