/** Turns stored rows into the shapes the Inbox operations return, and answers the counting
 * questions (how many lines in each status, per source). Nothing here changes anything. */
import type {
  InboxCounts,
  InboxDecision,
  InboxItem,
  InboxLine,
  InboxProposal,
  InboxSource,
} from "../../client-contracts.gen.ts";
import type { StoredProposal } from "../../ingest/proposals.ts";
import { sanitizeText } from "../../ingest/text.ts";
import type { BankLine, IngestLine, LedgerEvent } from "../../ingest-types.ts";
import type { ApplicationStore } from "../../storage.ts";
import type { ReconciledLine } from "./reconciled.ts";
import { type ItemRow, type ItemStatus, parseFlags } from "./store.ts";

export function toInboxLine(line: IngestLine): InboxLine {
  if (line.kind === "event") {
    const event = line as LedgerEvent;
    return {
      kind: "event",
      provider: event.provider,
      accountKey: event.accountKey,
      providerId: event.providerId,
      rawIndex: event.rawIndex,
      date: event.eventOn,
      amount: event.amount ?? "0.00",
      currency: event.currency,
      description: event.summary,
      legs: event.legs.map((leg) => ({
        role: leg.role,
        amount: leg.amount,
        ...(leg.memo ? { memo: leg.memo } : {}),
      })),
      links: Object.entries(event.links ?? {}).map(([key, value]) => ({ key, value })),
    };
  }
  const bank = line as BankLine;
  return {
    kind: "bankLine",
    provider: bank.provider,
    accountKey: bank.accountKey,
    ...(bank.providerId !== undefined ? { providerId: bank.providerId } : {}),
    rawIndex: bank.rawIndex,
    date: bank.postedOn,
    amount: bank.amount,
    currency: bank.currency,
    description: bank.description,
    ...(bank.counterparty !== undefined ? { counterparty: bank.counterparty } : {}),
    ...(bank.reference !== undefined ? { reference: bank.reference } : {}),
    ...(bank.runningBalance !== undefined ? { runningBalance: bank.runningBalance } : {}),
  };
}

export interface ItemExtras {
  readonly suggestion?: StoredProposal | undefined;
  readonly proposalCount: number;
  /** The item of the event that books this line, when it has been imported. */
  readonly cover?: { readonly itemId: string; readonly status: ItemStatus } | null | undefined;
  /** The reconciliation a posted line is on, when it is on one. */
  readonly reconciled?: ReconciledLine | undefined;
}

export function toInboxItem(row: ItemRow, extras: ItemExtras): InboxItem {
  const line = JSON.parse(row.line) as IngestLine;
  const wire = toInboxLine(line);
  // An event's display amount is stored with the row; the line may omit it.
  const withAmount = row.kind === "event" ? { ...wire, amount: row.amount } : wire;
  const journalId = row.journal_id ?? row.matched_journal_id;
  return {
    id: row.id,
    status: row.status,
    line: withAmount,
    ledgerAccountId: row.ledger_account_id,
    batchId: row.batch_id,
    flags: parseFlags(row.flags),
    ...(extras.suggestion
      ? {
          suggestion: {
            proposalId: extras.suggestion.id,
            proposer: extras.suggestion.proposer,
            kind: extras.suggestion.kind,
            confidence: extras.suggestion.confidence,
            reason: sanitizeText(extras.suggestion.reasons[0] ?? "", 300),
            ...(extras.suggestion.legs && extras.suggestion.legs.length > 0
              ? { legs: extras.suggestion.legs.map((leg) => ({ ...leg })) }
              : {}),
          },
        }
      : {}),
    proposalCount: extras.proposalCount,
    ...(row.exclusion_code && row.exclusion_at
      ? {
          exclusion: {
            code: row.exclusion_code,
            reason: row.exclusion_reason ?? "",
            at: row.exclusion_at,
          },
        }
      : {}),
    ...(row.decision ? { decision: toInboxDecision(row.decision) } : {}),
    ...(row.draft_id ? { draftId: row.draft_id } : {}),
    ...(journalId ? { journalId } : {}),
    ...(row.pair_item_id ? { pairItemId: row.pair_item_id } : {}),
    ...(row.post_error ? { postError: row.post_error } : {}),
    ...(row.covered_by
      ? {
          coveredBy: {
            providerId: row.covered_by,
            ...(extras.cover ? { itemId: extras.cover.itemId, status: extras.cover.status } : {}),
          },
        }
      : {}),
    ...(extras.reconciled ? { reconciled: extras.reconciled } : {}),
    ingestedAt: row.ingested_at,
  };
}

/** The decision as the wire carries it. Only the known fields are copied, so a field a later
 * release stores can never make the whole list fail its output check. */
export function toInboxDecision(stored: string): InboxDecision {
  const decision = JSON.parse(stored) as Record<string, unknown>;
  const text = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined;
  const legs = Array.isArray(decision.legs)
    ? (decision.legs as { accountId: string; amount: string }[]).map((leg) => ({
        accountId: leg.accountId,
        amount: leg.amount,
      }))
    : undefined;
  const links = Array.isArray(decision.links)
    ? (decision.links as { key: string; value: string }[]).map((link) => ({
        key: link.key,
        value: link.value,
      }))
    : undefined;
  const kind = text(decision.kind) as InboxDecision["kind"];
  return {
    kind,
    by: text(decision.by) ?? "manual",
    at: text(decision.at) ?? "",
    ...(text(decision.principal) !== undefined
      ? { principal: text(decision.principal) as string }
      : {}),
    ...(text(decision.proposalId) !== undefined
      ? { proposalId: text(decision.proposalId) as string }
      : {}),
    ...(legs ? { legs } : {}),
    ...(text(decision.narration) !== undefined
      ? { narration: text(decision.narration) as string }
      : {}),
    ...(text(decision.reason) !== undefined ? { reason: text(decision.reason) as string } : {}),
    ...(text(decision.coveredBy) !== undefined
      ? { coveredBy: text(decision.coveredBy) as string }
      : {}),
    ...(links ? { links } : {}),
  };
}

export function toInboxProposal(body: string): InboxProposal {
  const stored = JSON.parse(body) as StoredProposal;
  return {
    id: stored.id,
    proposer: stored.proposer,
    kind: stored.kind,
    confidence: stored.confidence,
    reasons: stored.reasons,
    ...(stored.legs ? { legs: stored.legs } : {}),
    ...(stored.matchJournalId ? { matchJournalId: stored.matchJournalId } : {}),
    ...(stored.pairItemId ? { pairItemId: stored.pairItemId } : {}),
    ...(stored.narration ? { narration: stored.narration } : {}),
    ...(stored.links ? { links: stored.links } : {}),
  };
}

/** The event items that book a page's covered lines, in one query per provider account. */
export function coversFor(
  store: ApplicationStore,
  rows: readonly ItemRow[],
): Map<string, { itemId: string; status: ItemStatus }> {
  const found = new Map<string, { itemId: string; status: ItemStatus }>();
  const wanted = new Map<string, Set<string>>();
  for (const row of rows)
    if (row.covered_by) {
      const key = `${row.provider}\u0000${row.account_key}`;
      const set = wanted.get(key) ?? new Set<string>();
      set.add(row.covered_by);
      wanted.set(key, set);
    }
  for (const [key, ids] of wanted) {
    const [provider = "", accountKey = ""] = key.split("\u0000");
    const list = [...ids];
    const covers = store
      .query(
        `SELECT id, provider_id, status FROM app_ingest_items WHERE provider=? AND account_key=? AND provider_id IN (${list.map(() => "?").join(", ")})`,
      )
      .all(provider, accountKey, ...list) as {
      id: string;
      provider_id: string;
      status: ItemStatus;
    }[];
    for (const cover of covers)
      found.set(`${key}\u0000${cover.provider_id}`, { itemId: cover.id, status: cover.status });
  }
  return found;
}

/** Top proposal and proposal count for a page of items, in two queries. */
export function proposalsFor(
  store: ApplicationStore,
  ids: readonly string[],
): Map<string, ItemExtras> {
  const result = new Map<string, ItemExtras>(ids.map((id) => [id, { proposalCount: 0 }]));
  if (ids.length === 0) return result;
  const marks = ids.map(() => "?").join(", ");
  const tops = store
    .query(
      `SELECT item_id, body FROM app_ingest_proposals WHERE rank = 0 AND item_id IN (${marks})`,
    )
    .all(...ids) as { item_id: string; body: string }[];
  const counts = store
    .query(
      `SELECT item_id, COUNT(*) AS n FROM app_ingest_proposals WHERE item_id IN (${marks}) GROUP BY item_id`,
    )
    .all(...ids) as { item_id: string; n: number }[];
  for (const row of counts) result.set(row.item_id, { proposalCount: row.n });
  for (const row of tops)
    result.set(row.item_id, {
      proposalCount: result.get(row.item_id)?.proposalCount ?? 1,
      suggestion: JSON.parse(row.body) as StoredProposal,
    });
  return result;
}

const EMPTY: InboxCounts = {
  total: 0,
  new: 0,
  proposed: 0,
  drafted: 0,
  posted: 0,
  excluded: 0,
  toReview: 0,
  covered: 0,
  postable: 0,
  beforeCutover: 0,
};

/** Counts by status for the lines of the whole Inbox, of one provider, or of one provider account, from the
 * tally the database keeps beside the lines (`app_ingest_tally`): a few rows however many lines there are.
 * They are the counts a pass over the lines gives, and `test/ingest-tally.test.ts` holds them to that. */
export function inboxCounts(
  store: ApplicationStore,
  scope: { readonly provider?: string; readonly accountKey?: string } = {},
): InboxCounts {
  const rows = store
    .query(
      `SELECT status, covered, held, SUM(n) AS n FROM app_ingest_tally
       WHERE (? IS NULL OR provider = ?) AND (? IS NULL OR account_key = ?)
       GROUP BY status, covered, held`,
    )
    .all(
      scope.provider ?? null,
      scope.provider ?? null,
      scope.accountKey ?? null,
      scope.accountKey ?? null,
    ) as { status: ItemStatus; covered: number; held: number; n: number }[];
  const counts: { -readonly [K in keyof InboxCounts]: number } = { ...EMPTY };
  let covered = 0;
  let coveredDrafted = 0;
  for (const row of rows) {
    counts[row.status] += row.n;
    counts.total += row.n;
    if (row.covered === 1 && (row.status === "new" || row.status === "proposed")) covered += row.n;
    if (row.covered === 1 && row.status === "drafted") coveredDrafted += row.n;
    if (row.held === 1) counts.beforeCutover += row.n;
  }
  counts.covered = covered;
  counts.postable = counts.drafted - coveredDrafted;
  counts.toReview = counts.new + counts.proposed - covered;
  return counts;
}

/** One provider account with its mapping, cutover date and counts, or null if it is unknown. */
export function sourceView(
  store: ApplicationStore,
  provider: string,
  accountKey: string,
): InboxSource | null {
  const source = store
    .query(
      "SELECT provider, account_key, ledger_account_id, start_on FROM app_ingest_sources WHERE provider=? AND account_key=?",
    )
    .get(provider, accountKey) as {
    provider: string;
    account_key: string;
    ledger_account_id: string | null;
    start_on: string | null;
  } | null;
  if (!source) return null;
  // The first and the last day are two statements of their own: one statement asking for both reads every line
  // of the account, and each alone is a step to the end of an index.
  const range = store
    .query(
      `SELECT
         (SELECT MIN(posted_on) FROM app_ingest_items WHERE provider=? AND account_key=?) AS first,
         (SELECT MAX(posted_on) FROM app_ingest_items WHERE provider=? AND account_key=?) AS last`,
    )
    .get(source.provider, source.account_key, source.provider, source.account_key) as {
    first: string | null;
    last: string | null;
  };
  const batches = store
    .query(
      `SELECT COUNT(*) AS n, MAX(b.submitted_at) AS last FROM app_ingest_batch_sources x
         JOIN app_ingest_batches b ON b.id = x.batch_id WHERE x.provider=? AND x.account_key=?`,
    )
    .get(source.provider, source.account_key) as { n: number; last: string | null };
  return {
    provider: source.provider,
    accountKey: source.account_key,
    ledgerAccountId: source.ledger_account_id,
    startOn: source.start_on,
    counts: inboxCounts(store, { provider: source.provider, accountKey: source.account_key }),
    firstLineOn: range.first,
    lastLineOn: range.last,
    batches: batches.n,
    lastSubmittedAt: batches.last,
    needsAccount:
      source.ledger_account_id === null &&
      (
        store
          .query(
            "SELECT COUNT(*) AS n FROM app_ingest_items WHERE provider=? AND account_key=? AND kind='bankLine' AND status IN ('new', 'proposed')",
          )
          .get(source.provider, source.account_key) as { n: number }
      ).n > 0,
  };
}

/** Every provider account the pipeline has seen. */
export function sourcesView(store: ApplicationStore): InboxSource[] {
  const keys = store
    .query("SELECT provider, account_key FROM app_ingest_sources ORDER BY provider, account_key")
    .all() as { provider: string; account_key: string }[];
  return keys.flatMap((key) => {
    const view = sourceView(store, key.provider, key.account_key);
    return view ? [view] : [];
  });
}
