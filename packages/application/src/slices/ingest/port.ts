/** `IngestPort`: the one door every source uses to hand lines to the pipeline.
 *
 *   archive  keeps the raw payload under its SHA-256 (no batch needed).
 *   preview  runs the whole analysis (identity, overlap, cutover) and writes nothing.
 *   submit   applies a batch in one transaction: either every new line, the batch record and the
 *            source's settings are stored, or nothing is. Submitting the same batch again changes
 *            nothing, and a line is never stored twice: provider identifiers and overlap
 *            occurrences are unique indexes, so the database refuses a duplicate on its own.
 *
 * Nothing here posts anything or decides anything about a line; it records what the source said,
 * what became of each line (new, already imported, kept out on purpose) and why. */
import { ApplicationError } from "../../errors.ts";
import { sha256Hex, stableStringify } from "../../ingest/hash.ts";
import { fingerprintOf, matchOverlap, type StoredCandidate } from "../../ingest/overlap.ts";
import { prepareHeader, prepareLines } from "../../ingest/validate.ts";
import type { BatchHeader, LineCheck, PreparedLine } from "../../ingest/validate.ts";
import type {
  BalanceCheck,
  BalanceCheckResult,
  IngestPort,
  IngestReport,
  LineDisposition,
} from "../../ingest-types.ts";
import { formatMoney, parseMoney } from "../../money.ts";
import type { ApplicationService } from "../../service.ts";
import type { ApplicationStore } from "../../storage.ts";
import { observeIngest } from "../../telemetry.ts";
import { blobInfo, getBlob, putBlob } from "./blobs.ts";
import { syncCovers } from "./covers.ts";
import { type BookState, accountBalanceCents } from "./ledger-view.ts";
import { type ExclusionCode, type IngestRuntime, ingestRuntime, sumCents } from "./store.ts";

interface SourceState {
  readonly provider: string;
  readonly accountKey: string;
  readonly exists: boolean;
  readonly ledgerAccountId: string | null;
  readonly startOn: string | null;
  /** What this batch adds to the stored state, for the upsert. */
  readonly nextLedgerAccountId: string | null;
  readonly nextStartOn: string | null;
}

interface Planned {
  readonly check: Extract<LineCheck, { ok: true }>;
  readonly disposition: LineDisposition;
  readonly insert?: {
    readonly id: string;
    readonly fingerprint: string;
    readonly occurrence: number | null;
    readonly status: "new" | "excluded";
    readonly exclusionCode: ExclusionCode | null;
    readonly exclusionReason: string | null;
    readonly sourceEventId: string;
    readonly flags: readonly string[];
  };
  readonly conflict?: { readonly itemId: string; readonly reason: string };
  /** A repeat of a stored line that names the event booking it: the link is added to the line. */
  readonly link?: { readonly itemId: string; readonly coveredBy: string };
}

interface Analysis {
  readonly header: BatchHeader;
  readonly checks: readonly LineCheck[];
  readonly sources: ReadonlyMap<string, SourceState>;
  readonly planned: readonly Planned[];
  readonly dispositions: readonly LineDisposition[];
  readonly problems: readonly string[];
  readonly report: IngestReport;
  readonly contentHash: string;
  readonly batchId: string;
}

const sourceKeyOf = (provider: string, accountKey: string) => `${provider}\u0000${accountKey}`;

function readSource(store: ApplicationStore, provider: string, accountKey: string) {
  return store
    .query(
      "SELECT ledger_account_id, start_on FROM app_ingest_sources WHERE provider=? AND account_key=?",
    )
    .get(provider, accountKey) as {
    ledger_account_id: string | null;
    start_on: string | null;
  } | null;
}

/** The identity a line is stored under: derived only from where the line came from, never from
 * its text, so the same line always gets the same item id and the same ledger source identity. */
function identityOf(
  provider: string,
  line: PreparedLine,
  fingerprint: string,
  occurrence: number | null,
): { id: string; sourceEventId: string } {
  const parts =
    line.providerId !== null
      ? [provider, line.accountKey, "id", line.providerId]
      : [provider, line.accountKey, "fp", fingerprint, String(occurrence)];
  const digest = sha256Hex(parts.map((part) => `${part.length}:${part}`).join("|"));
  return {
    id: `it_${digest.slice(0, 20)}`,
    sourceEventId: line.sourceId ?? `ingest-${provider}-${digest.slice(0, 32)}`,
  };
}

function analyze(service: ApplicationService, rt: IngestRuntime, input: unknown): Analysis {
  const parsed = prepareHeader(input);
  const header: BatchHeader = {
    provider: parsed.provider,
    sourceKey: parsed.sourceKey,
    raw: parsed.raw,
    fetchedAt: parsed.fetchedAt,
    cursor: parsed.cursor,
    ledgerAccountId: parsed.ledgerAccountId,
    startOn: parsed.startOn,
    catchUp: parsed.catchUp,
    balances: parsed.balances,
  };
  const checks = prepareLines(parsed.rawLines, header.provider);
  const valid = checks.flatMap((check) => (check.ok ? [check.line] : []));
  const store = rt.store;

  // One account key per batch when the batch names a chart account.
  const accountKeys = [
    ...new Set([
      ...valid.map((line) => line.accountKey),
      ...header.balances.map((b) => b.accountKey),
    ]),
  ];
  if (header.ledgerAccountId !== null && accountKeys.length > 1)
    throw new ApplicationError(
      "invalid_batch",
      "A batch that names a chart account must hold the lines and balances of one provider account.",
      400,
    );

  // Sources: what is stored, what this batch would add, and the refusals for a different answer.
  const sources = new Map<string, SourceState>();
  for (const accountKey of accountKeys) {
    const stored = readSource(store, header.provider, accountKey);
    if (
      header.ledgerAccountId !== null &&
      stored?.ledger_account_id &&
      stored.ledger_account_id !== header.ledgerAccountId
    )
      throw new ApplicationError(
        "source_account_conflict",
        `This provider account is already mapped to chart account ${stored.ledger_account_id}, not ${header.ledgerAccountId}. Change the mapping with inbox.configureSource if that is intended.`,
        409,
        [{ path: "ledgerAccountId", message: stored.ledger_account_id }],
      );
    if (header.startOn !== null && stored?.start_on && stored.start_on !== header.startOn)
      throw new ApplicationError(
        "source_start_conflict",
        `This provider account already starts on ${stored.start_on}, not ${header.startOn}. Change the cutover date with inbox.configureSource if that is intended.`,
        409,
        [{ path: "startOn", message: stored.start_on }],
      );
    sources.set(sourceKeyOf(header.provider, accountKey), {
      provider: header.provider,
      accountKey,
      exists: stored !== null,
      ledgerAccountId: stored?.ledger_account_id ?? null,
      startOn: stored?.start_on ?? null,
      nextLedgerAccountId: stored?.ledger_account_id ?? header.ledgerAccountId,
      nextStartOn: stored?.start_on ?? header.startOn,
    });
  }

  const bookCurrency = service.setupState()?.currency ?? null;
  const planned = new Map<number, Planned>();
  const order = new Map<LineCheck, number>();
  for (const [position, check] of checks.entries()) order.set(check, position);

  // Lines with a provider id: the database's unique index decides, comparing financial content.
  const claimedInBatch = new Map<string, { contentKey: string; itemId: string }>();
  const sourceIdsInBatch = new Set<string>();
  const idLess: Extract<LineCheck, { ok: true }>[] = [];
  for (const check of checks) {
    if (!check.ok) continue;
    const line = check.line;
    const fingerprint = fingerprintOf(line.date, line.cents, line.currency);
    if (line.providerId === null) {
      idLess.push(check);
      continue;
    }
    const key = `${sourceKeyOf(header.provider, line.accountKey)}\u0000${line.providerId}`;
    const stored = store
      .query(
        "SELECT id, content_key, posted_on, amount FROM app_ingest_items WHERE provider=? AND account_key=? AND provider_id=?",
      )
      .get(header.provider, line.accountKey, line.providerId) as {
      id: string;
      content_key: string;
      posted_on: string;
      amount: string;
    } | null;
    const earlier = claimedInBatch.get(key);
    if (stored || earlier) {
      const known = stored ? stored.content_key : (earlier?.contentKey ?? "");
      const itemId = stored ? stored.id : (earlier?.itemId ?? "");
      if (known === line.contentKey)
        planned.set(order.get(check) ?? 0, {
          check,
          disposition: {
            rawIndex: line.rawIndex,
            status: "duplicate",
            reason:
              "Already imported: the provider's own id for this line is already in the Inbox.",
            itemId,
          },
          ...(line.coveredBy !== null && stored
            ? { link: { itemId, coveredBy: line.coveredBy } }
            : {}),
        });
      else {
        const was = stored ? `${stored.posted_on} ${stored.amount}` : "earlier in this batch";
        const reason = `The provider now reports this line differently (imported as ${was}, now ${line.date} ${line.amount}). The imported line is kept and flagged; nothing was overwritten.`;
        planned.set(order.get(check) ?? 0, {
          check,
          disposition: { rawIndex: line.rawIndex, status: "invalid", reason, itemId },
          conflict: { itemId, reason },
        });
      }
      continue;
    }
    const identity = identityOf(header.provider, line, fingerprint, null);
    if (line.sourceId !== null) {
      const taken =
        sourceIdsInBatch.has(line.sourceId) ||
        store
          .query("SELECT 1 AS taken FROM app_ingest_items WHERE source_event_id=?")
          .get(line.sourceId) !== null;
      if (taken) {
        planned.set(order.get(check) ?? 0, {
          check,
          disposition: {
            rawIndex: line.rawIndex,
            status: "invalid",
            reason: `The ledger source id ${line.sourceId} is already used by another line, so this line was not imported.`,
          },
        });
        continue;
      }
      sourceIdsInBatch.add(line.sourceId);
    }
    claimedInBatch.set(key, { contentKey: line.contentKey, itemId: identity.id });
    planned.set(
      order.get(check) ?? 0,
      plan(header, sources, bookCurrency, check, identity, fingerprint, null),
    );
  }

  // Lines without one: overlap detection per provider account.
  const byAccount = new Map<string, Extract<LineCheck, { ok: true }>[]>();
  for (const check of idLess) {
    const list = byAccount.get(check.line.accountKey) ?? [];
    list.push(check);
    byAccount.set(check.line.accountKey, list);
  }
  for (const [accountKey, group] of byAccount) {
    const dates = group.map((check) => check.line.date).sort();
    const first = dates[0] ?? "";
    const last = dates.at(-1) ?? "";
    const stored = new Map<string, StoredCandidate[]>();
    const rows = store
      .query(
        "SELECT id, fingerprint, text_key, occurrence FROM app_ingest_items WHERE provider=? AND account_key=? AND provider_id IS NULL AND posted_on BETWEEN ? AND ?",
      )
      .all(header.provider, accountKey, first, last) as {
      id: string;
      fingerprint: string;
      text_key: string;
      occurrence: number;
    }[];
    for (const row of rows) {
      const list = stored.get(row.fingerprint) ?? [];
      list.push({ id: row.id, textKey: row.text_key, occurrence: row.occurrence });
      stored.set(row.fingerprint, list);
    }
    const result = matchOverlap(
      group.map((check, index) => ({
        index,
        fingerprint: fingerprintOf(check.line.date, check.line.cents, check.line.currency),
        textKey: check.line.textKey,
      })),
      stored,
    );
    for (const match of result.matched) {
      const check = group[match.index];
      if (!check) continue;
      planned.set(order.get(check) ?? 0, {
        check,
        disposition: {
          rawIndex: check.line.rawIndex,
          status: "overlap",
          reason: match.sameText
            ? "Already imported: a line with the same date, amount and description is already in the Inbox."
            : "Already imported: a line with the same date and amount is already in the Inbox (its description reads differently now).",
          itemId: match.itemId,
        },
      });
    }
    for (const fresh of result.fresh) {
      const check = group[fresh.index];
      if (!check) continue;
      const fingerprint = fingerprintOf(check.line.date, check.line.cents, check.line.currency);
      const identity = identityOf(header.provider, check.line, fingerprint, fresh.occurrence);
      planned.set(
        order.get(check) ?? 0,
        plan(header, sources, bookCurrency, check, identity, fingerprint, fresh.occurrence),
      );
    }
  }

  // Report, in the order the source listed its lines.
  const dispositions: LineDisposition[] = [];
  const problems: string[] = [];
  const counts = { new: 0, duplicate: 0, overlap: 0, invalid: 0, excluded: 0 };
  checks.forEach((check, position) => {
    if (!check.ok) {
      dispositions.push({
        rawIndex: check.rawIndex ?? position,
        status: "invalid",
        reason: check.reason,
      });
      problems.push(`Line ${(check.rawIndex ?? position) + 1}: ${check.reason}`);
      counts.invalid += 1;
      return;
    }
    const item = planned.get(position);
    if (!item) return;
    dispositions.push(item.disposition);
    counts[item.disposition.status] += 1;
  });
  const contentHash = sha256Hex(
    stableStringify({
      v: 1,
      provider: header.provider,
      sourceKey: header.sourceKey,
      raw: header.raw.sha256,
      lines: valid.map((line) => line.line),
      balances: header.balances,
      cursor: header.cursor,
      ledgerAccountId: header.ledgerAccountId,
      startOn: header.startOn,
      catchUp: header.catchUp,
    }),
  );
  return {
    header,
    checks,
    sources,
    planned: checks.flatMap((_, position) => {
      const item = planned.get(position);
      return item ? [item] : [];
    }),
    dispositions,
    problems,
    report: {
      dispositions,
      newCount: counts.new,
      duplicateCount: counts.duplicate,
      overlapCount: counts.overlap,
      invalidCount: counts.invalid,
      ...(counts.excluded > 0 ? { excludedCount: counts.excluded } : {}),
    },
    contentHash,
    batchId: `bt_${contentHash.slice(0, 20)}`,
  };
}

/** Plan a line that is not already stored: queued, or kept out on purpose. */
function plan(
  header: BatchHeader,
  sources: ReadonlyMap<string, SourceState>,
  bookCurrency: string | null,
  check: Extract<LineCheck, { ok: true }>,
  identity: { id: string; sourceEventId: string },
  fingerprint: string,
  occurrence: number | null,
): Planned {
  const line = check.line;
  const startOn = sources.get(sourceKeyOf(header.provider, line.accountKey))?.nextStartOn ?? null;
  let status: "new" | "excluded" = "new";
  let exclusionCode: ExclusionCode | null = null;
  let reason: string | null = null;
  if (startOn !== null && line.date < startOn) {
    status = "excluded";
    exclusionCode = "before_cutover";
    reason = `Before the cutover date (${startOn}): kept for the record and not queued. Restore it if it belongs in the books.`;
  } else if (header.catchUp) {
    status = "excluded";
    exclusionCode = "catch_up";
    reason = "Caught up: adopted as history so later imports skip it, not queued.";
  }
  const flags = [...line.flags];
  if (bookCurrency !== null && line.currency !== bookCurrency) flags.push("foreign_currency");
  return {
    check,
    disposition: {
      rawIndex: line.rawIndex,
      status,
      ...(reason !== null ? { reason } : {}),
      itemId: identity.id,
    },
    insert: {
      id: identity.id,
      fingerprint,
      occurrence,
      status,
      exclusionCode,
      exclusionReason: reason,
      sourceEventId: identity.sourceEventId,
      flags,
    },
  };
}

function applyBatch(
  service: ApplicationService,
  rt: IngestRuntime,
  clock: () => string,
  input: unknown,
) {
  const store = rt.store;
  return store.transaction(() => {
    const analysis = analyze(service, rt, input);
    if (analysis.problems.length > 0)
      throw new ApplicationError(
        "invalid_batch",
        "The batch has lines that cannot be stored; nothing was imported.",
        400,
        analysis.problems.slice(0, 20).map((message) => ({ path: "lines", message })),
      );
    const { header } = analysis;
    if (!blobInfo(store, header.raw.sha256))
      throw new ApplicationError(
        "raw_not_archived",
        "Archive the raw payload (IngestPort.archive) before submitting its batch.",
        409,
      );
    const existing = store
      .query("SELECT id FROM app_ingest_batches WHERE content_hash=?")
      .get(analysis.contentHash) as { id: string } | null;
    if (existing) return { ...analysis.report, batchId: existing.id };

    const now = clock();
    // Sources first: the mapping and cutover date this batch adds.
    for (const source of analysis.sources.values()) {
      store
        .query(
          `INSERT INTO app_ingest_sources (provider, account_key, ledger_account_id, start_on, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (provider, account_key) DO UPDATE SET
             ledger_account_id = COALESCE(app_ingest_sources.ledger_account_id, excluded.ledger_account_id),
             start_on = COALESCE(app_ingest_sources.start_on, excluded.start_on)`,
        )
        .run(
          source.provider,
          source.accountKey,
          source.nextLedgerAccountId,
          source.nextStartOn,
          now,
        );
      // A cutover date set now also covers lines already queued before it.
      if (source.startOn === null && source.nextStartOn !== null)
        applyCutover(store, source.provider, source.accountKey, source.nextStartOn, now);
    }
    store
      .query(
        `INSERT INTO app_ingest_batches (id, provider, source_key, content_hash, raw_sha256, raw_size,
           raw_media_type, raw_name, fetched_at, submitted_at, cursor, catch_up, line_count, new_count,
           duplicate_count, overlap_count, invalid_count, excluded_count, balances)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        analysis.batchId,
        header.provider,
        header.sourceKey,
        analysis.contentHash,
        header.raw.sha256,
        header.raw.size,
        header.raw.mediaType,
        header.raw.name ?? null,
        header.fetchedAt,
        now,
        header.cursor,
        header.catchUp ? 1 : 0,
        analysis.checks.length,
        analysis.report.newCount,
        analysis.report.duplicateCount,
        analysis.report.overlapCount,
        analysis.report.invalidCount,
        analysis.report.excludedCount ?? 0,
        JSON.stringify(header.balances),
      );
    for (const source of analysis.sources.values())
      store
        .query(
          "INSERT OR IGNORE INTO app_ingest_batch_sources (batch_id, provider, account_key) VALUES (?, ?, ?)",
        )
        .run(analysis.batchId, source.provider, source.accountKey);
    const insert = store.query(
      `INSERT INTO app_ingest_items (id, batch_id, provider, account_key, provider_id, fingerprint,
         occurrence, raw_index, kind, posted_on, cents, amount, currency, content_key, text_key, search,
         line, excerpt, flags, status, exclusion_code, exclusion_reason, exclusion_at, source_event_id,
         ingested_at, covered_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let inserted = 0;
    for (const item of analysis.planned) {
      if (!item.insert) continue;
      const line = item.check.line;
      insert.run(
        item.insert.id,
        analysis.batchId,
        header.provider,
        line.accountKey,
        line.providerId,
        item.insert.fingerprint,
        item.insert.occurrence,
        line.rawIndex,
        line.kind,
        line.date,
        line.cents,
        line.amount,
        line.currency,
        line.contentKey,
        line.textKey,
        line.search,
        JSON.stringify(line.line),
        line.excerpt,
        JSON.stringify(item.insert.flags),
        item.insert.status,
        item.insert.exclusionCode,
        item.insert.exclusionReason,
        item.insert.status === "excluded" ? now : null,
        item.insert.sourceEventId,
        now,
        line.coveredBy,
      );
      inserted += 1;
    }
    // Lines that learn which event books them, and events that books lines already stored: bring
    // the covered lines in line with their payout.
    const covers = new Map<string, Set<string>>();
    const mention = (accountKey: string, providerId: string) => {
      const set = covers.get(accountKey) ?? new Set<string>();
      set.add(providerId);
      covers.set(accountKey, set);
    };
    for (const item of analysis.planned) {
      const line = item.check.line;
      if (line.kind !== "event") continue;
      if (item.link) {
        const linked = store
          .query(
            "UPDATE app_ingest_items SET covered_by=?, proposed_rev=NULL WHERE id=? AND covered_by IS NULL AND status IN ('new', 'proposed')",
          )
          .run(item.link.coveredBy, item.link.itemId);
        if (linked.changes === 1) mention(line.accountKey, item.link.coveredBy);
      }
      if (item.insert) {
        if (line.coveredBy !== null) mention(line.accountKey, line.coveredBy);
        if (line.providerId !== null) mention(line.accountKey, line.providerId);
      }
    }
    for (const [accountKey, providerIds] of covers)
      syncCovers(store, now, header.provider, accountKey, providerIds);
    for (const item of analysis.planned) {
      if (!item.conflict) continue;
      store
        .query(
          "INSERT INTO app_ingest_conflicts (item_id, batch_id, line, reason, seen_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          item.conflict.itemId,
          analysis.batchId,
          JSON.stringify(item.check.line.line),
          item.conflict.reason,
          now,
        );
      flag(store, item.conflict.itemId, "provider_changed");
    }
    // New lines can pair with open ones (a transfer's other side, a payout's deposit): the open
    // lines are proposed again the next time the Inbox is read. Only those that hold a proposal are
    // touched: a row set to what it already is is still a change of the log, whole, and a pull that
    // submits a page at a time would otherwise rewrite the whole Inbox with every page.
    if (inserted > 0)
      store
        .query(
          "UPDATE app_ingest_items SET proposed_rev=NULL WHERE status IN ('new', 'proposed') AND proposed_rev IS NOT NULL",
        )
        .run();
    return { ...analysis.report, batchId: analysis.batchId };
  });
}

function flag(store: ApplicationStore, itemId: string, name: string): void {
  const row = store.query("SELECT flags FROM app_ingest_items WHERE id=?").get(itemId) as {
    flags: string;
  } | null;
  if (!row) return;
  const flags = JSON.parse(row.flags) as string[];
  if (flags.includes(name)) return;
  store
    .query("UPDATE app_ingest_items SET flags=? WHERE id=?")
    .run(JSON.stringify([...flags, name]), itemId);
}

/** Keep queued lines dated before a cutover date out of the queue, with the reason. Lines that
 * already have a draft or a journal, or that a person excluded, are left alone. */
export function applyCutover(
  store: ApplicationStore,
  provider: string,
  accountKey: string,
  startOn: string,
  now: string,
): number {
  const reason = `Before the cutover date (${startOn}): kept for the record and not queued. Restore it if it belongs in the books.`;
  const ids = store
    .query(
      "SELECT id FROM app_ingest_items WHERE provider=? AND account_key=? AND status IN ('new', 'proposed') AND posted_on < ?",
    )
    .all(provider, accountKey, startOn) as { id: string }[];
  for (const { id } of ids) {
    store
      .query(
        "UPDATE app_ingest_items SET status='excluded', exclusion_code='before_cutover', exclusion_reason=?, exclusion_at=?, proposed_rev=NULL WHERE id=?",
      )
      .run(reason, now, id);
    store.query("DELETE FROM app_ingest_proposals WHERE item_id=?").run(id);
  }
  return ids.length;
}

/** Bring back lines the cutover date kept out, when the date moves earlier. */
export function releaseCutover(
  store: ApplicationStore,
  provider: string,
  accountKey: string,
  startOn: string | null,
): number {
  const rows = store
    .query(
      "SELECT id FROM app_ingest_items WHERE provider=? AND account_key=? AND status='excluded' AND exclusion_code='before_cutover' AND (? IS NULL OR posted_on >= ?)",
    )
    .all(provider, accountKey, startOn, startOn) as { id: string }[];
  for (const { id } of rows)
    store
      .query(
        "UPDATE app_ingest_items SET status='new', exclusion_code=NULL, exclusion_reason=NULL, exclusion_at=NULL, proposed_rev=NULL WHERE id=?",
      )
      .run(id);
  return rows.length;
}

/** One provider balance set against the books: the posted balance of the mapped chart account on
 * the date, the lines still waiting, and the lines a person set aside on purpose (the bank balance
 * includes them, the books do not). The difference is what is left unexplained; it is shown, never
 * adjusted. `adding` is what a batch not yet submitted would put in the queue. */
export function balanceResult(
  store: ApplicationStore,
  state: BookState,
  source: {
    readonly provider: string;
    readonly accountKey: string;
    readonly ledgerAccountId: string | null;
    readonly startOn: string | null;
  },
  balance: BalanceCheck,
  adding = 0n,
): BalanceCheckResult {
  if (source.ledgerAccountId === null)
    return {
      accountKey: balance.accountKey,
      asOf: balance.asOf,
      reported: balance.balance,
      ledger: null,
      waiting: null,
      excluded: null,
      difference: null,
    };
  const ledger = accountBalanceCents(state, source.ledgerAccountId, balance.asOf);
  const queued = sumCents(
    store,
    "i.provider=? AND i.account_key=? AND i.kind='bankLine' AND i.status IN ('new', 'proposed', 'drafted') AND i.posted_on<=?",
    source.provider,
    source.accountKey,
    balance.asOf,
  );
  const excluded = sumCents(
    store,
    "i.provider=? AND i.account_key=? AND i.kind='bankLine' AND i.status='excluded' AND i.exclusion_code='manual' AND i.posted_on<=? AND (? IS NULL OR i.posted_on>=?)",
    source.provider,
    source.accountKey,
    balance.asOf,
    source.startOn,
    source.startOn,
  );
  const waiting = queued + adding;
  return {
    accountKey: balance.accountKey,
    asOf: balance.asOf,
    reported: balance.balance,
    ledger: formatMoney(ledger),
    waiting: formatMoney(waiting),
    excluded: formatMoney(excluded),
    difference: formatMoney(parseMoney(balance.balance) - (ledger + waiting + excluded)),
  };
}

async function balancesFor(
  service: ApplicationService,
  rt: IngestRuntime,
  input: unknown,
): Promise<BalanceCheckResult[]> {
  const analysis = analyze(service, rt, input);
  const { aggregate } = await service.readAggregate();
  return analysis.header.balances.map((balance) => {
    const source = analysis.sources.get(sourceKeyOf(analysis.header.provider, balance.accountKey));
    // Lines this batch would add, when it has not been submitted yet.
    let adding = 0n;
    for (const item of analysis.planned)
      if (
        item.insert?.status === "new" &&
        item.check.line.kind === "bankLine" &&
        item.check.line.accountKey === balance.accountKey &&
        item.check.line.date <= balance.asOf
      )
        adding += item.check.line.cents;
    return balanceResult(
      rt.store,
      aggregate.state,
      {
        provider: analysis.header.provider,
        accountKey: balance.accountKey,
        ledgerAccountId: source?.nextLedgerAccountId ?? null,
        startOn: source?.nextStartOn ?? null,
      },
      balance,
      adding,
    );
  });
}

/** The pipeline's port for importers and connectors. `options.now` replaces the clock in tests. */
export function ingestPort(
  service: ApplicationService,
  options: { readonly now?: () => string } = {},
): IngestPort {
  const rt = ingestRuntime(service);
  const now = () => (options.now ?? rt.now)();
  return {
    archive: (bytes, mediaType, name) =>
      observeIngest("archive", { bytes: bytes.byteLength }, () =>
        putBlob(rt.store, now(), bytes, mediaType, name),
      ),
    readArchive: (sha256) => getBlob(rt.store, sha256),
    preview: (batch) =>
      observeIngest(
        "preview",
        { rows: batch.lines.length },
        () => analyze(service, rt, batch).report,
      ),
    submit: (batch) =>
      observeIngest("submit", { rows: batch.lines.length }, () =>
        applyBatch(service, rt, now, batch),
      ),
    checkBalances: (batch) => balancesFor(service, rt, batch),
  };
}
