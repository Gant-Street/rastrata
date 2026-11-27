import type { DecidedItem, IngestItem } from "../../ingest-types.ts";
import type { ApplicationService } from "../../service.ts";
import { decidedItems, listItems } from "../ingest/read.ts";

/** What the rules lane reads from the ingest lane: the open Inbox, to test a rule against, and the
 * decisions people made there, to learn from. The ingest lane owns its tables; this is the only
 * place the rules lane looks at them, and it goes through the read functions the ingest lane
 * exports (`slices/ingest/read.ts`), never its SQL. */

/** The most Inbox lines one test reads. */
export const INBOX_SCAN_LIMIT = 20000;
const PAGE = 1000;

export interface InboxView {
  /** False when the Inbox could not be read; the caller says so rather than showing zero. */
  readonly available: boolean;
  /** Lines still awaiting review: new or proposed, in the order they arrived. */
  readonly items: readonly IngestItem[];
  /** True when there were more than `INBOX_SCAN_LIMIT`. */
  readonly truncated: boolean;
}

export function readInbox(service: ApplicationService): InboxView {
  const items: IngestItem[] = [];
  let after: string | undefined;
  for (;;) {
    const page = listItems(service, {
      statuses: ["new", "proposed"],
      limit: PAGE,
      ...(after !== undefined ? { after } : {}),
    });
    items.push(...page.items);
    if (page.next === null) return { available: true, items, truncated: false };
    if (items.length >= INBOX_SCAN_LIMIT) return { available: true, items, truncated: true };
    after = page.next;
  }
}

/** Lines a person or a proposer has decided (drafted or posted) with the entry they chose. */
export function readDecisions(service: ApplicationService): readonly DecidedItem[] {
  return decidedItems(service);
}
