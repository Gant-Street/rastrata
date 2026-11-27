/** The status of the accounts to reconcile, read two ways, for the tests that hold what the application keeps current
 * (`slices/reconcile/figures.ts`) to what looking at every posting of each account says. Test support. */
import { ApplicationHttp } from "../../src/http.ts";
import type { LocalBookService } from "../../src/local.ts";
import { formatMoney } from "../../src/money.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../../src/schema.ts";
import { effect, isReconcilable } from "../../src/slices/reconcile/book.ts";
import { reconcileState } from "../../src/slices/reconcile/state.ts";

export interface AccountFigures {
  bookBalance: string;
  unclearedCount: number;
  unclearedTotal: string;
  oldestUnclearedDate: string | null;
}

/** What the status said before its figures were kept: every posting of each account looked at. */
export async function lookedAtEveryPosting(
  service: LocalBookService,
): Promise<Record<string, AccountFigures>> {
  const rs = reconcileState(service);
  const book = await rs.readBook();
  const out: Record<string, AccountFigures> = {};
  for (const account of [...book.accounts.values()].filter(isReconcilable)) {
    const cleared = rs.store.activeIds(account.id);
    let books = 0n;
    let unclearedTotal = 0n;
    let uncleared = 0;
    let oldest: string | null = null;
    for (const posting of book.postings.get(account.id) ?? []) {
      const amount = effect(posting, account);
      books += amount;
      if (cleared.has(posting.postingId)) continue;
      uncleared += 1;
      unclearedTotal += amount;
      oldest ??= posting.date;
    }
    out[account.id] = {
      bookBalance: formatMoney(books),
      unclearedCount: uncleared,
      unclearedTotal: formatMoney(unclearedTotal),
      oldestUnclearedDate: oldest,
    };
  }
  return out;
}

/** What the status says, for every account to reconcile. */
export async function reportedStatus(
  service: LocalBookService,
): Promise<Record<string, AccountFigures>> {
  const http = new ApplicationHttp(service, {
    bookId: service.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  const response = await http.fetch(
    new Request("http://127.0.0.1:4010/v1/reconcile.status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: service.bookId,
        input: { all: true },
      }),
    }),
  );
  const reply = (await response.json()) as {
    ok: boolean;
    data: { accounts: ({ account: { id: string } } & AccountFigures)[] };
  };
  if (!reply.ok) throw new Error(`reconcile.status failed: ${JSON.stringify(reply)}`);
  return Object.fromEntries(
    reply.data.accounts.map((row) => [
      row.account.id,
      {
        bookBalance: row.bookBalance,
        unclearedCount: row.unclearedCount,
        unclearedTotal: row.unclearedTotal,
        oldestUnclearedDate: row.oldestUnclearedDate,
      },
    ]),
  );
}

/** A book reconciled every month has most of its cash account's postings cleared. This is that, for a book of journals
 * posted straight to the ledger (`bulkInboxBook`): one completed reconciliation that cleared the cash posting of
 * the first `share` of them, written as the reconciliation writes its records. */
export function clearMostOfCash(service: LocalBookService, journals: number, share = 0.9): void {
  const store = reconcileState(service).store;
  const cleared = Math.floor(journals * share);
  const inserted = service.store.transaction(() => {
    const insert = service.store.query(
      "INSERT INTO recon_active (posting_id, session_id, account_id, journal_id, amount) VALUES (?, 'cleared-most', '1000', ?, ?)",
    );
    // The first posting of an entry is the debit to cash, and each was for 10.00 or more; the amount is what the
    // reconciliation recorded, which the status does not read.
    for (let n = 1; n <= cleared; n += 1) insert.run(`bulk-${n}-0`, `bulk-${n}`, "10.00");
    service.store
      .query(
        "INSERT INTO recon_sessions (id, account_id, account_code, account_name, account_role, normal_side, currency, status, statement_date, statement_balance, version, last_operation, baseline, snapshot_sequence, snapshot_revision, created_at, updated_at, seq, completed_at) VALUES ('cleared-most', '1000', '1000', 'Cash', 'asset', 'debit', 'USD', 'completed', '2026-06-30', '0.00', 1, 'op', '0', '0', '0', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 1, '2026-07-01T00:00:00.000Z')",
      )
      .run();
    return cleared;
  });
  if (inserted !== cleared || store.activeIds("1000").size !== cleared)
    throw new Error("The cleared postings were not written");
}
