/** For review: how each entry that was posted from a bank line was decided. The ledger says an entry was
 * posted and by whom; the Inbox keeps what decided its category (a person's choice, a rule, the classifier,
 * a match to an entry already in the books) and who decided it. Read through `inbox.list`, a page of
 * entries at a time, so the cost is the lines around the entries on the page and not the Inbox.
 *
 * The decision is added to the sentence for how the change was made. It is not who made the change: the
 * maker is whoever committed the posting, and the one who decided can be another. */
import { actorOf } from "../../../changes/actors.ts";
import type { ChangeRecord, InboxItem, InboxPage } from "../../../client-contracts.gen.ts";
import { ApplicationError } from "../../../errors.ts";
import { sanitizeText } from "../../../ingest/text.ts";
import { addDays } from "../../../reports/dates.ts";
import type { SliceContext } from "../../types.ts";
import { callOperation } from "../call.ts";
import type { ChangesState } from "../store.ts";

/** The days around the entries' dates that are read: a line's date can differ from its entry's. */
const SLACK_DAYS = 31;
/** At most this many pages of 200 lines are read for one page of the list. */
const MAX_PAGES = 20;

export interface ReviewOutcome {
  readonly read: boolean;
  readonly reason: string | null;
  /** How many entries were told how they were decided. */
  readonly annotated: number;
}

const proposerWords = (proposer: string): string => {
  if (proposer === "classifier") return "the classifier";
  if (proposer === "transfer") return "the transfer matcher";
  if (proposer === "stripe") return "the Stripe matcher";
  if (proposer === "rule" || proposer.startsWith("rule:")) return "a rule";
  return sanitizeText(proposer, 40) || "a proposer";
};

function whoWords(principal: string | undefined, state: ChangesState): string {
  if (principal === undefined || principal === "") return "";
  const actor = actorOf(principal, state.labelFor(principal));
  if (actor.kind === "owner") return " by the owner";
  if (actor.kind === "agent") return ` by the agent ${actor.label}`;
  if (actor.kind === "person") return " by a member";
  return "";
}

function decisionWords(item: InboxItem, state: ChangesState): string | null {
  const decision = item.decision;
  if (decision === undefined) return null;
  const who = whoWords(decision.principal, state);
  switch (decision.kind) {
    case "categorize":
      return `its category was chosen by hand${who}`;
    case "accept":
      return `a suggestion from ${proposerWords(decision.by)} was accepted${who}`;
    case "match":
      return `it was matched to an entry that was already in the books${who}`;
    default:
      return null;
  }
}

/** Add to each posted entry of this page how it was decided. `records` is the page, as built. */
export async function annotateFromReview(
  context: SliceContext,
  records: readonly ChangeRecord[],
  state: ChangesState,
): Promise<{ readonly records: readonly ChangeRecord[]; readonly outcome: ReviewOutcome }> {
  const posted = records.filter((record) => record.kind === "entry.posted" && record.entry);
  if (posted.length === 0) return { records, outcome: { read: true, reason: null, annotated: 0 } };
  const dates = posted.map((record) => record.entry?.date ?? "").sort();
  const from = addDays(dates[0] as string, -SLACK_DAYS);
  const to = addDays(dates.at(-1) as string, SLACK_DAYS);
  const wanted = new Set(posted.map((record) => record.entry?.journalId));
  const found = new Map<string, InboxItem>();
  try {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const answer = await callOperation<InboxPage>(context, "inbox.list", {
        filter: { status: ["posted"], covered: false, from, to },
        sort: "date_asc",
        page,
        pageSize: 200,
      });
      for (const item of answer.items)
        if (item.journalId && wanted.has(item.journalId)) found.set(item.journalId, item);
      if (found.size >= wanted.size) break;
      if (answer.items.length === 0 || page * answer.pageSize >= answer.count) break;
      if (page === MAX_PAGES)
        return {
          records,
          outcome: {
            read: false,
            reason:
              "There are more lines around these entries than one list reads, so some are not told how they were decided.",
            annotated: 0,
          },
        };
    }
  } catch (error) {
    const reason =
      error instanceof ApplicationError && error.code === "permission_denied"
        ? "This sign-in may not read the transactions waiting for review, so entries are not told how they were decided."
        : "The transactions waiting for review could not be read, so entries are not told how they were decided.";
    return { records, outcome: { read: false, reason, annotated: 0 } };
  }
  let annotated = 0;
  const out = records.map((record) => {
    const item = record.entry ? found.get(record.entry.journalId) : undefined;
    const words = item ? decisionWords(item, state) : null;
    if (words === null) return record;
    annotated += 1;
    return { ...record, how: sanitizeText(`${record.how}; ${words}`, 240) };
  });
  return { records: out, outcome: { read: true, reason: null, annotated } };
}
