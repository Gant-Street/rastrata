import type {
  JournalDraftData,
  JournalPostResult,
  MutationReceipt,
  PreparedOperation,
  SavedDraft,
} from "@rastrata/application/client-contracts";
import { ApplicationRequestError, type BrowserApplicationClient } from "../../application-client";

/** How a Post of the quick entry ended, and the draft the dialog holds afterwards. */
export type QuickPostOutcome =
  /** The entry is in the books. */
  | { readonly kind: "posted"; readonly draft: SavedDraft; readonly plan: PreparedOperation }
  /** The books' preview said no: nothing was committed, and the draft is the dialog's to edit. */
  | { readonly kind: "invalid"; readonly draft: SavedDraft; readonly plan: PreparedOperation }
  /** The ledger turned the posting down; the draft was reopened for a second try. */
  | { readonly kind: "refused"; readonly draft: SavedDraft; readonly receipt: MutationReceipt }
  /** The books or the service said no after the draft was kept (a date before the book began, say). The
   * error is the one the operation that raised it would have given; the draft is the dialog's to edit. */
  | {
      readonly kind: "stopped";
      readonly draft: SavedDraft;
      readonly error: ApplicationRequestError;
    };

/** Read what `journal.post` answered. The same reading serves a reply that was lost and reached by
 * resuming the retained request. */
export function quickPostOutcome(result: JournalPostResult): QuickPostOutcome {
  const { draft, plan, receipt, refusal } = result;
  if (refusal)
    return {
      kind: "stopped",
      draft,
      error: new ApplicationRequestError(
        refusal.message,
        refusal.code,
        refusal.retryable ?? false,
        refusal.details,
      ),
    };
  if (!plan)
    throw new ApplicationRequestError(
      "The service did not say what happened.",
      "invalid_response",
      true,
    );
  if (!receipt) return { kind: "invalid", draft, plan };
  return receipt.disposition === "committed"
    ? { kind: "posted", draft, plan }
    : { kind: "refused", draft, receipt };
}

/** Post an entry the way the quick entry does: the draft, its preparation and its commit in one request,
 * one retained write (a lost reply is resumed, never repeated). `held` is the draft the dialog holds
 * after an earlier try; the service edits it if the words changed and leaves it alone if they did not. */
export async function postQuickEntry(
  client: BrowserApplicationClient,
  workflow: string,
  data: JournalDraftData,
  held: SavedDraft | null,
): Promise<QuickPostOutcome> {
  return quickPostOutcome(
    await client.write(
      "journal.post",
      held ? { data, draftId: held.id, expectedVersion: held.version } : { data },
      workflow,
    ),
  );
}
