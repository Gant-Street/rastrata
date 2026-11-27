/** The Inbox's read operations: list, get, summary, sources and balance checks. They read product
 * state and, where a balance needs the books, the verified ledger. Reading brings stale proposals up
 * to date first, so what a person sees always reflects the current rules and entries. */
import { ApplicationError } from "../../errors.ts";
import type {
  InboxBalanceCheck,
  InboxBalanceCheckList,
  InboxDetail,
  InboxFilter,
  InboxListInput,
  InboxPage,
  InboxSourceList,
  InboxSummary,
  InboxTexts,
  InboxTextsInput,
} from "../../client-contracts.gen.ts";
import type { BalanceCheck, IngestLine } from "../../ingest-types.ts";
import type { ApplicationService } from "../../service.ts";
import { findLines } from "./find.ts";
import { balanceResult } from "./port.ts";
import { reconcileDrafts } from "./posting.ts";
import { ensureProposals } from "./proposing.ts";
import { reconciledLines } from "./reconciled.ts";
import {
  ITEM_COLUMNS,
  ITEM_FROM,
  type ItemRow,
  evidenceReferenceOf,
  ingestRuntime,
  ledgerSourceId,
} from "./store.ts";
import {
  inboxCounts,
  coversFor,
  proposalsFor,
  sourcesView,
  toInboxItem,
  toInboxLine,
  toInboxProposal,
} from "./view.ts";

const DEFAULT_PAGE_SIZE = 50;

export async function listInbox(
  service: ApplicationService,
  input: InboxListInput,
): Promise<InboxPage> {
  reconcileDrafts(service);
  await ensureProposals(service, { prepare: true });
  const store = ingestRuntime(service).store;
  const filter: InboxFilter = input.filter ?? {};
  const page = input.page ?? 1;
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? DEFAULT_PAGE_SIZE));
  // How many match is a sum over the days when the filter says only what the day tally counts by, and the lines
  // that wait are read in the order of their days from the index of them: neither is a pass over the lines that
  // match. Any other filter is answered by looking at the lines.
  const { total, rows } = findLines(store, filter, input.sort, page, pageSize);
  const extras = proposalsFor(
    store,
    rows.map((row) => row.id),
  );
  const covers = coversFor(store, rows);
  const reconciled = reconciledLines(service, rows);
  return {
    items: rows.map((row) =>
      toInboxItem(row, {
        ...(extras.get(row.id) ?? { proposalCount: 0 }),
        cover: row.covered_by
          ? covers.get(`${row.provider}\u0000${row.account_key}\u0000${row.covered_by}`)
          : null,
        reconciled: reconciled.get(row.id),
      }),
    ),
    count: total,
    page,
    pageSize,
    counts: inboxCounts(store),
  };
}

/** The text behind each posted journal, by a stable cursor: what the reports that name who a journal was
 * paid to read, without paging the whole Inbox. A line a payout books is evidence for the payout's one
 * journal and is left out; a line matched to an entry that was written by hand gives that entry's id. */
export function inboxTexts(service: ApplicationService, input: InboxTextsInput): InboxTexts {
  reconcileDrafts(service);
  const store = ingestRuntime(service).store;
  const size = Math.min(MAX_TEXTS_PAGE, Math.max(1, input.pageSize ?? DEFAULT_TEXTS_PAGE));
  const after = input.after === undefined ? 0 : Number(input.after);
  const rows = store
    .query(
      `SELECT seq, kind, provider, COALESCE(journal_id, matched_journal_id) AS journal_id, line
       FROM app_ingest_items
       WHERE status = 'posted' AND covered_by IS NULL
         AND COALESCE(journal_id, matched_journal_id) IS NOT NULL
         AND posted_on >= ? AND posted_on <= ? AND seq > ?
       ORDER BY seq LIMIT ?`,
    )
    .all(input.from, input.to, Number.isSafeInteger(after) ? after : 0, size + 1) as {
    seq: number;
    kind: "bankLine" | "event";
    provider: string;
    journal_id: string;
    line: string;
  }[];
  const page = rows.slice(0, size);
  return {
    items: page.map((row) => {
      const wire = toInboxLine(JSON.parse(row.line) as IngestLine);
      return {
        journalId: row.journal_id,
        kind: row.kind,
        provider: row.provider,
        counterparty: wire.counterparty ?? "",
        description: wire.description,
      };
    }),
    next: rows.length > size ? String((page.at(-1) as { seq: number }).seq) : null,
  };
}

const DEFAULT_TEXTS_PAGE = 2000;
const MAX_TEXTS_PAGE = 5000;

export function itemRow(service: ApplicationService, itemId: string): ItemRow {
  const row = ingestRuntime(service)
    .store.query(`SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE i.id = ?`)
    .get(itemId) as ItemRow | null;
  if (!row) throw new ApplicationError("item_not_found", "That Inbox item does not exist.", 404);
  return row;
}

export async function getInboxItem(
  service: ApplicationService,
  itemId: string,
): Promise<InboxDetail> {
  reconcileDrafts(service);
  await ensureProposals(service, { prepare: true });
  const store = ingestRuntime(service).store;
  const row = itemRow(service, itemId);
  const stored = store
    .query("SELECT body FROM app_ingest_proposals WHERE item_id = ? ORDER BY rank")
    .all(row.id) as { body: string }[];
  const batch = store.query("SELECT * FROM app_ingest_batches WHERE id = ?").get(row.batch_id) as {
    raw_sha256: string;
    raw_name: string | null;
    raw_media_type: string;
    raw_size: number;
    fetched_at: string;
    submitted_at: string;
  };
  const draft = row.draft_id ? service.draft(row.draft_id) : null;
  const history = (
    store
      .query("SELECT at, kind, actor, detail FROM app_ingest_events WHERE item_id = ? ORDER BY seq")
      .all(row.id) as { at: string; kind: string; actor: string; detail: string }[]
  )
    .slice(-200)
    .map((entry) => {
      const detail = JSON.parse(entry.detail) as {
        reason?: string;
        draftId?: string;
        journalId?: string;
        reversalJournalId?: string;
      };
      return {
        at: entry.at,
        kind: entry.kind,
        by: entry.actor,
        ...(detail.reason ? { reason: detail.reason } : {}),
        ...(detail.draftId ? { draftId: detail.draftId } : {}),
        ...(detail.journalId ? { journalId: detail.journalId } : {}),
        ...(detail.reversalJournalId ? { reversalJournalId: detail.reversalJournalId } : {}),
      };
    });
  const proposals = stored.map((entry) => toInboxProposal(entry.body));
  const [top] = proposals;
  const covers = coversFor(store, [row]);
  const covered = store
    .query(
      "SELECT COUNT(*) AS n FROM app_ingest_items WHERE provider=? AND account_key=? AND covered_by=?",
    )
    .get(row.provider, row.account_key, row.provider_id ?? "") as { n: number };
  return {
    item: toInboxItem(row, {
      cover: row.covered_by
        ? covers.get(`${row.provider}\u0000${row.account_key}\u0000${row.covered_by}`)
        : null,
      proposalCount: proposals.length,
      reconciled: reconciledLines(service, [row]).get(row.id),
      ...(top ? { suggestion: JSON.parse(stored[0]?.body ?? "{}") } : {}),
    }),
    proposals,
    proposalProblems: JSON.parse(row.proposal_problems) as string[],
    coveredCount: covered.n,
    provenance: {
      batchId: row.batch_id,
      provider: row.provider,
      accountKey: row.account_key,
      rawIndex: row.raw_index,
      rawSha256: batch.raw_sha256,
      ...(batch.raw_name ? { rawName: batch.raw_name } : {}),
      rawMediaType: batch.raw_media_type,
      rawSize: batch.raw_size,
      fetchedAt: batch.fetched_at,
      submittedAt: batch.submitted_at,
      evidenceReference: evidenceReferenceOf(row),
      // The ledger source the entry is posted under. A transfer is one entry for two lines, under the
      // identity of the line the person acted on, so the other line reports that one: it is the source
      // the ledger holds (a line's own identity is only reserved for it, and unused by the entry).
      sourceEventId: draft?.data.source?.id ?? ledgerSourceId(row),
      ...(row.excerpt ? { excerpt: row.excerpt } : {}),
    },
    ...(draft ? { draft: { id: draft.id, version: draft.version, status: draft.status } } : {}),
    history,
  };
}

export async function inboxSummary(service: ApplicationService): Promise<InboxSummary> {
  reconcileDrafts(service);
  await ensureProposals(service, { prepare: true });
  const store = ingestRuntime(service).store;
  const unmapped = store
    .query(
      `SELECT COUNT(*) AS n FROM app_ingest_sources s WHERE s.ledger_account_id IS NULL AND EXISTS (
         SELECT 1 FROM app_ingest_items i WHERE i.provider = s.provider AND i.account_key = s.account_key
           AND i.kind = 'bankLine' AND i.status IN ('new', 'proposed'))`,
    )
    .get() as { n: number };
  const oldest = store
    .query("SELECT MIN(posted_on) AS day FROM app_ingest_items WHERE status IN ('new', 'proposed')")
    .get() as { day: string | null };
  const last = store.query("SELECT MAX(submitted_at) AS at FROM app_ingest_batches").get() as {
    at: string | null;
  };
  return {
    counts: inboxCounts(store),
    sources: sourcesView(store),
    unmapped: unmapped.n,
    oldestToReviewOn: oldest.day,
    lastSubmittedAt: last.at,
  };
}

export function inboxSources(service: ApplicationService): InboxSourceList {
  return { sources: sourcesView(ingestRuntime(service).store) };
}

/** The newest balance each provider account reported, set against the books as they are now. */
export async function inboxBalanceChecks(
  service: ApplicationService,
  input: { readonly provider?: string; readonly accountKey?: string },
): Promise<InboxBalanceCheckList> {
  const store = ingestRuntime(service).store;
  const batches = store
    .query(
      "SELECT seq, id, provider, balances FROM app_ingest_batches WHERE balances != '[]' ORDER BY seq",
    )
    .all() as { seq: number; id: string; provider: string; balances: string }[];
  const newest = new Map<string, { provider: string; batchId: string; balance: BalanceCheck }>();
  for (const batch of batches)
    for (const balance of JSON.parse(batch.balances) as BalanceCheck[]) {
      if (input.provider !== undefined && batch.provider !== input.provider) continue;
      if (input.accountKey !== undefined && balance.accountKey !== input.accountKey) continue;
      const key = `${batch.provider}\u0000${balance.accountKey}`;
      const known = newest.get(key);
      if (!known || balance.asOf >= known.balance.asOf)
        newest.set(key, { provider: batch.provider, batchId: batch.id, balance });
    }
  if (newest.size === 0) return { checks: [] };
  const { aggregate } = await service.readAggregate();
  const checks: InboxBalanceCheck[] = [];
  for (const entry of [...newest.values()].sort((a, b) =>
    `${a.provider}${a.balance.accountKey}` < `${b.provider}${b.balance.accountKey}` ? -1 : 1,
  )) {
    const source = store
      .query(
        "SELECT ledger_account_id, start_on FROM app_ingest_sources WHERE provider=? AND account_key=?",
      )
      .get(entry.provider, entry.balance.accountKey) as {
      ledger_account_id: string | null;
      start_on: string | null;
    } | null;
    const result = balanceResult(
      store,
      aggregate.state,
      {
        provider: entry.provider,
        accountKey: entry.balance.accountKey,
        ledgerAccountId: source?.ledger_account_id ?? null,
        startOn: source?.start_on ?? null,
      },
      entry.balance,
    );
    checks.push({
      provider: entry.provider,
      accountKey: result.accountKey,
      asOf: result.asOf,
      reported: result.reported,
      ledgerAccountId: source?.ledger_account_id ?? null,
      ledger: result.ledger,
      waiting: result.waiting,
      excluded: result.excluded,
      difference: result.difference,
      batchId: entry.batchId,
    });
  }
  return { checks };
}
