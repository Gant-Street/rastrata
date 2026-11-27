/** What the Inbox knows of the journals it posted: the text a bank wrote, or the provider that made the
 * entry. It is read through the Inbox's own operation, `inbox.texts`, and never through the Inbox's
 * tables. (It was paged through `inbox.list` first, which costs a page of everything for each 200
 * lines: 2.5 seconds at 20,000 lines, where this read costs about a tenth of that; the figures are in
 * the lane's document.)
 *
 * A journal posted from a line is found by the journal id the Inbox recorded when it posted. The lines
 * a payout books (a Stripe balance transaction) are evidence for the payout's one journal and are not
 * read; the payout is. The window is a little wider than the range because a journal's date can differ
 * from its line's. */
import type { InboxTexts } from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { sanitizeText } from "../../ingest/text.ts";
import type { JournalText } from "../../payees/totals.ts";
import { addDays } from "../../reports/dates.ts";
import { callOperation } from "../tax/operations.ts";
import type { SliceContext } from "../types.ts";

/** Rows to a page of the Inbox's text read. */
const PAGE = 2000;

/** How a provider is named when it made an entry from its own source ("stripe" is "Stripe"). */
export function providerName(provider: string): string {
  if (provider === "stripe") return "Stripe";
  const clean = sanitizeText(provider, 32);
  return clean === "" ? "Unknown source" : `${clean.charAt(0).toUpperCase()}${clean.slice(1)}`;
}

export interface JournalTexts {
  readonly texts: Map<string, JournalText>;
  /** False when the Inbox could not be read: every journal is then matched on its narration. */
  readonly read: boolean;
  /** How many pages of the Inbox it took, for the measurements. */
  readonly pages: number;
}

export async function readJournalTexts(
  context: SliceContext,
  from: string,
  to: string,
): Promise<JournalTexts> {
  const texts = new Map<string, JournalText>();
  let pages = 0;
  try {
    for (let after: string | undefined; ; ) {
      const result = await callOperation<InboxTexts>(context, "inbox.texts", {
        from: addDays(from, -31),
        to: addDays(to, 31),
        pageSize: PAGE,
        ...(after !== undefined ? { after } : {}),
      });
      pages += 1;
      for (const item of result.items)
        texts.set(
          item.journalId,
          item.kind === "event"
            ? { counterparty: "", description: "", connector: providerName(item.provider) }
            : { counterparty: item.counterparty, description: item.description },
        );
      if (result.next === null) break;
      after = result.next;
    }
    return { texts, read: true, pages };
  } catch (error) {
    if (error instanceof ApplicationError) return { texts: new Map(), read: false, pages };
    throw error;
  }
}
