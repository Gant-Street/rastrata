import type { ApplicationService } from "../../service.ts";
import { ingestRuntime } from "./store.ts";

/** The chart accounts a bank or card statement is imported for: an Inbox source mapped to the account,
 * whatever the account is tagged. A payment provider's own events (Stripe's) are not a statement and do
 * not count. The reconcile lane reads this to treat such an account as one to reconcile, as it does an
 * account tagged as cash, so a credit card nobody tagged as cash is still checked at a close. */
export function statementAccountIds(service: ApplicationService): ReadonlySet<string> {
  const rows = ingestRuntime(service)
    .store.query(
      "SELECT DISTINCT ledger_account_id AS id FROM app_ingest_sources WHERE ledger_account_id IS NOT NULL AND provider <> 'stripe'",
    )
    .all() as { id: string }[];
  return new Set(rows.map((row) => row.id));
}
