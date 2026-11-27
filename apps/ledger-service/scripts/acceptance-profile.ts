/** Counters and I/O wall timers for the isolated acceptance Worker only.
 * Workers clocks do not measure synchronous CPU; never label these as CPU ms. */
import { AsyncLocalStorage } from "node:async_hooks";
import { BookAuthorizer, type SqliteStorage } from "@rastrata/ledger";

export interface RequestProfile {
  verifications: number;
  verificationMs: number;
  syncMs: number[];
  sqlCalls: number;
  rowsRead: number;
  rowsWritten: number;
  transactions: number;
}
const active = new AsyncLocalStorage<RequestProfile>();
const verify = BookAuthorizer.prototype.verify;
BookAuthorizer.prototype.verify = async function (token) {
  const profile = active.getStore(),
    start = performance.now();
  if (profile) profile.verifications++;
  try {
    return await verify.call(this, token);
  } finally {
    if (profile) profile.verificationMs += performance.now() - start;
  }
};

export function profileRequest(work: () => Promise<Response>, header: string) {
  const profile: RequestProfile = {
    verifications: 0,
    verificationMs: 0,
    syncMs: [],
    sqlCalls: 0,
    rowsRead: 0,
    rowsWritten: 0,
    transactions: 0,
  };
  return active.run(profile, async () => {
    const original = await work();
    const response = new Response(original.body, original);
    response.headers.set(header, JSON.stringify(profile));
    return response;
  });
}

export function profileStorage(storage: DurableObjectStorage): SqliteStorage {
  return {
    sql: {
      exec(query, ...bindings) {
        const profile = active.getStore();
        const cursor = storage.sql.exec(query, ...bindings);
        if (!profile) return cursor;
        profile.sqlCalls++;
        const read = cursor.rowsRead,
          written = cursor.rowsWritten;
        profile.rowsRead += read;
        profile.rowsWritten += written;
        return {
          *[Symbol.iterator]() {
            try {
              yield* cursor;
            } finally {
              profile.rowsRead += cursor.rowsRead - read;
              profile.rowsWritten += cursor.rowsWritten - written;
            }
          },
        };
      },
    },
    transactionSync(work) {
      const profile = active.getStore();
      if (profile) profile.transactions++;
      return storage.transactionSync(work);
    },
    async sync() {
      const profile = active.getStore(),
        start = performance.now();
      try {
        await storage.sync();
      } finally {
        profile?.syncMs.push(performance.now() - start);
      }
    },
  };
}
