/** The Inbox actions that decide things about lines: categorize, accept, exclude, and set up a source.
 *
 * None of them posts anything. Categorizing or accepting turns a decision into a saved draft with
 * the line's source identity and provenance on it; the draft then goes through prepare and commit
 * like any entry (see posting.ts). Each action is one transaction under the caller's operation
 * identity, so a retried request returns the first answer and a failure leaves nothing half done.
 *
 * A person's choice and a proposer's suggestion are both only ever a set of legs. The pipeline
 * checks them against the chart as it is now before drafting, whoever made them. */
import type { BookedJournal } from "@rastrata/kernel";
import type { JournalDraftData, SavedDraft } from "../../contracts.ts";
import type {
  InboxAcceptInput,
  InboxActionReport,
  InboxActionResult,
  InboxCategorizeInput,
  InboxConfigureSourceInput,
  InboxExcludeInput,
  InboxSourceChange,
} from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { checkProposal, type StoredProposal } from "../../ingest/proposals.ts";
import { sanitizeText } from "../../ingest/text.ts";
import type { IngestLine, ProposedLeg } from "../../ingest-types.ts";
import { formatMoney, parseMoney } from "../../money.ts";
import type { ApplicationService } from "../../service.ts";
import type { ApplicationStore } from "../../storage.ts";
import { type ChartAccount, chartOf, postingProblem } from "./ledger-view.ts";
import { matchIndexFor } from "./match-index.ts";
import { applyCutover, releaseCutover } from "./port.ts";
import { ensureProposals, invalidateNeighbours } from "./proposing.ts";
import { type Eligibility, failed, report, resolveSelection, skipped } from "./selection.ts";
import { syncCovered } from "./covers.ts";
import {
  type ItemRow,
  evidenceReferenceOf,
  ingestRuntime,
  ledgerSourceId,
  parseFlags,
  recordEvent,
  rowById,
} from "./store.ts";
import { sourceView } from "./view.ts";

const DEFAULT_LIMIT = 500;
/** What one call may draft: a call is one entry of the log, which the hosted tail holds to a megabyte as stored, and a payout of Stripe's drafted comes to about three kilobytes of it. A client that
 * asks for more is given this many and told how many remain, as it is when the selection is bigger than its `limit`. */
const DRAFT_LIMIT = 100;
const DRAFT_LIMIT_MAX = 200;

export interface ActionContext {
  readonly service: ApplicationService;
  readonly store: ApplicationStore;
  /** The instant the action happens; one value for the whole call. */
  readonly now: string;
  readonly chart: ReadonlyMap<string, ChartAccount>;
  readonly journals: Pick<ReadonlyMap<string, BookedJournal>, "get">;
  /** The book's currency. */
  readonly currency: string | null;
  /** Who is acting: "owner", or "agent:<tokenId>". */
  readonly principal: string;
}

/** Read what an action needs from the ledger before its transaction starts: the chart as it is now
 * and, for matches, the posted entries. */
export async function actionContext(
  service: ApplicationService,
  principal: string,
  options: { readonly journals?: boolean } = {},
): Promise<ActionContext> {
  const runtime = ingestRuntime(service);
  const { aggregate } = await service.readAggregate();
  return {
    service,
    store: runtime.store,
    now: runtime.now(),
    chart: chartOf(aggregate.state),
    journals: options.journals
      ? { get: (id: string) => matchIndexFor(aggregate.state).journal(id) }
      : new Map<string, BookedJournal>(),
    currency: service.setupState()?.currency ?? null,
    principal,
  };
}

/** After a decision on an event, bring the lines it books (a payout's balance transactions) in line. */
function cascade(ctx: ActionContext, id: string): void {
  const row = rowById(ctx.store, id);
  if (row?.kind === "event") syncCovered(ctx.store, ctx.now, row);
}

export const lineOf = (row: ItemRow): IngestLine => JSON.parse(row.line) as IngestLine;
const textOf = (row: ItemRow): string => {
  const line = lineOf(row);
  return line.kind === "event" ? line.summary : line.description;
};

/** Legs, signed from the book's view, as the debit and credit lines a draft holds. */
function draftLines(legs: readonly ProposedLeg[]): JournalDraftData["lines"] {
  return legs.map((leg) => {
    const cents = parseMoney(leg.amount);
    return cents > 0n
      ? { accountId: leg.accountId, debit: formatMoney(cents), credit: "" }
      : { accountId: leg.accountId, debit: "", credit: formatMoney(-cents) };
  });
}

/** The draft for a line. Every piece of text in it is derived through `sanitizeText`; the line's
 * verbatim text stays on the item and in the archived file. The source identity makes the ledger
 * refuse a second journal for the same line (the line's own identity, or its next generation after
 * an undo: see `ledgerSourceId`), and the evidence reference names the file and row. */
export function draftData(
  row: ItemRow,
  legs: readonly ProposedLeg[],
  narration?: string,
): JournalDraftData {
  const text = textOf(row);
  const reference = sanitizeText(text, 80) || sanitizeText(row.provider_id ?? "", 80);
  return {
    date: row.posted_on,
    reference,
    narration: sanitizeText(narration ?? text, 1000) || reference || "Bank line",
    source: {
      id: ledgerSourceId(row),
      description: sanitizeText(
        `${row.provider} ${row.posted_on} ${row.amount} ${row.currency} ${text}`,
        1000,
      ),
      evidenceReference: evidenceReferenceOf(row),
    },
    lines: draftLines(legs),
  };
}

const decisionJson = (decision: Record<string, unknown>): string => JSON.stringify(decision);

/** The entry the Inbox found for a line that is already in the books, if it found one: the stored
 * match proposal of an open line. Anything that would book the line again is refused for it. */
function existingMatch(ctx: ActionContext, itemId: string): StoredProposal | null {
  const found = ctx.store
    .query(
      "SELECT body FROM app_ingest_proposals WHERE item_id = ? AND kind = 'match' ORDER BY rank LIMIT 1",
    )
    .get(itemId) as { body: string } | null;
  return found ? (JSON.parse(found.body) as StoredProposal) : null;
}

/** Said to a person or an agent whose action was about to book a payment twice: which entry, and
 * the two ways forward. The line is left exactly as it was. */
function matchRefusal(ctx: ActionContext, row: ItemRow, match: StoredProposal): InboxActionResult {
  const booked = ctx.journals.get(match.matchJournalId ?? "");
  const what = booked
    ? `“${sanitizeText(booked.journal.narration, 80)}” dated ${booked.journal.accountingDate as string}`
    : "an entry";
  return skipped(
    row,
    "match_exists",
    `This line matches ${what}, which is already in your books, so booking it again would count the payment twice. Accept the match instead (it books nothing new). If it really is a second payment, say so on purpose and a second entry is drafted.`,
  );
}

/** Create the draft and move the line (and its paired line, for a transfer) to drafted. */
function draftRows(
  ctx: ActionContext,
  rows: readonly ItemRow[],
  legs: readonly ProposedLeg[],
  decision: Record<string, unknown>,
  event: { readonly kind: string; readonly actor: string },
  narration?: string,
): SavedDraft {
  const [first, pair] = rows;
  if (!first) throw new Error("draftRows needs a line");
  const draft = ctx.service.createDraft(draftData(first, legs, narration));
  for (const row of rows) {
    const updated = ctx.store
      .query(
        `UPDATE app_ingest_items SET status='drafted', draft_id=?, draft_version=?, decision=?,
           pair_item_id=?, post_error=NULL, post_error_code=NULL
         WHERE id=? AND status IN ('new', 'proposed')`,
      )
      .run(
        draft.id,
        draft.version,
        decisionJson(decision),
        pair ? (row === first ? pair.id : first.id) : null,
        row.id,
      );
    if (updated.changes !== 1) throw new Error("An Inbox item changed while it was being drafted");
    recordEvent(ctx.store, row.id, ctx.now, event.kind, event.actor, { draftId: draft.id });
  }
  invalidateNeighbours(ctx.store, rows);
  return draft;
}

const drafted = (row: ItemRow, draft: SavedDraft): InboxActionResult => ({
  itemId: row.id,
  outcome: "applied",
  status: "drafted",
  draftId: draft.id,
});

/** Why a line cannot be booked at all, or null. Bank lines only; events carry their own legs. */
function bankLineProblem(ctx: ActionContext, row: ItemRow): InboxActionResult | null {
  if (row.kind !== "bankLine")
    return skipped(
      row,
      "not_a_bank_line",
      "This is an event from a provider. Accept its proposal; it has no account to choose.",
    );
  if (row.ledger_account_id === null)
    return skipped(
      row,
      "source_unmapped",
      "Choose which chart account this provider account belongs to first (inbox.configureSource).",
    );
  if (parseFlags(row.flags).includes("foreign_currency"))
    return skipped(
      row,
      "foreign_currency",
      `This line is in ${row.currency} and the book is in ${ctx.currency ?? "another currency"}. Rastrata does not convert currencies. Exclude it, or book it by hand.`,
    );
  if (parseMoney(row.amount) === 0n)
    return skipped(row, "zero_amount", "A line of 0.00 cannot be posted. Exclude it.");
  const problem = postingProblem(ctx.chart.get(row.ledger_account_id), row.posted_on);
  return problem ? failed(row, "account_unavailable", problem) : null;
}

/** Run one item's work, turning a refused draft into a result instead of aborting the call. */
function guarded(row: ItemRow, work: () => InboxActionResult): InboxActionResult {
  try {
    return work();
  } catch (error) {
    if (error instanceof ApplicationError) return failed(row, error.code, error.message);
    if (error instanceof TypeError) return failed(row, "draft_invalid", error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// categorize

export async function categorizeItems(
  service: ApplicationService,
  input: InboxCategorizeInput,
  operationId: string,
  principal: string,
): Promise<InboxActionReport> {
  const choices = (input.accountId !== undefined ? 1 : 0) + (input.splits !== undefined ? 1 : 0);
  if (choices !== 1)
    throw new ApplicationError("invalid_input", "Choose either one accountId or a list of splits.");
  if (input.splits !== undefined && (input.itemIds?.length ?? 0) !== 1)
    throw new ApplicationError(
      "invalid_input",
      "Splits divide one line's amount, so they apply to one item at a time.",
    );
  // The matches the Inbox has found must be current: a line that is already in the books is not
  // categorized into a second entry unless that is asked for.
  await ensureProposals(service);
  const ctx = await actionContext(service, principal, { journals: true });
  return service.retainRequest(operationId, "inbox.categorize", input, () => {
    const eligible: Eligibility = {
      statuses: ["new", "proposed"],
      sql: "i.kind = 'bankLine' AND s.ledger_account_id IS NOT NULL AND i.flags NOT LIKE '%\"foreign_currency\"%' AND i.cents != 0",
    };
    const resolved = resolveSelection(ctx.store, input, eligible, DRAFT_LIMIT, DRAFT_LIMIT_MAX);
    const results = [...resolved.results];
    for (const stale of resolved.rows) {
      const row = rowById(ctx.store, stale.id);
      if (!row || (row.status !== "new" && row.status !== "proposed")) {
        results.push(skipped(stale, "wrong_status", "This item changed while the action ran."));
        continue;
      }
      const match = input.allowDuplicate === true ? null : existingMatch(ctx, row.id);
      if (match) {
        results.push(matchRefusal(ctx, row, match));
        continue;
      }
      results.push(guarded(row, () => categorizeRow(ctx, row, input)));
    }
    return report(results, resolved.remaining);
  });
}

/** Categorize one line that is open, to one account: what `categorizeItems` does for one line, without
 * what it does first and for all of them (bringing every open line's suggestions up to date, and
 * refusing a line the Inbox has found an entry for), and under no identity of its own. For a caller that
 * has just taken the line's own entry back (a change of account), whose retry finds the line already
 * drafted and goes on. It is one transaction: the draft is made and the line moves to drafted together,
 * or neither. A refusal is the result. */
export function categorizeOne(
  ctx: ActionContext,
  itemId: string,
  accountId: string,
): InboxActionResult {
  return ctx.store.transaction(() => {
    const row = rowById(ctx.store, itemId);
    if (!row) return failed({ id: itemId }, "item_not_found", "That Inbox item does not exist.");
    if (row.status !== "new" && row.status !== "proposed")
      return skipped(row, "wrong_status", "This item changed while the action ran.");
    return guarded(row, () => categorizeRow(ctx, row, { accountId }));
  });
}

function categorizeRow(
  ctx: ActionContext,
  row: ItemRow,
  choice: InboxCategorizeInput,
): InboxActionResult {
  const early = bankLineProblem(ctx, row);
  if (early) return early;
  const own = row.ledger_account_id as string;
  const cents = parseMoney(row.amount);
  const targets =
    choice.accountId !== undefined
      ? [{ accountId: choice.accountId, amount: formatMoney(cents < 0n ? -cents : cents) }]
      : (choice.splits ?? []).map((split) => ({
          accountId: split.accountId,
          amount: split.amount,
        }));
  let total = 0n;
  for (const target of targets) {
    if (target.accountId === own)
      return failed(
        row,
        "same_account",
        "A line cannot be categorized to its own account. To move money between two of your accounts, accept a transfer.",
      );
    const problem = postingProblem(ctx.chart.get(target.accountId), row.posted_on);
    if (problem) return failed(row, "account_unavailable", problem);
    const amount = parseMoney(target.amount);
    if (amount <= 0n)
      return failed(row, "split_invalid", "Every split needs an amount greater than 0.00.");
    total += amount;
  }
  const size = cents < 0n ? -cents : cents;
  if (total !== size)
    return failed(
      row,
      "split_mismatch",
      `The splits add up to ${formatMoney(total)} but the line is ${formatMoney(size)}.`,
    );
  // Money out of the account debits the categories; money in credits them.
  const legs: ProposedLeg[] = [
    { accountId: own, amount: formatMoney(cents) },
    ...targets.map((target) => ({
      accountId: target.accountId,
      amount: formatMoney(cents < 0n ? parseMoney(target.amount) : -parseMoney(target.amount)),
    })),
  ];
  const decision = {
    kind: "categorize",
    by: "manual",
    principal: ctx.principal,
    at: ctx.now,
    legs,
    ...(choice.narration ? { narration: sanitizeText(choice.narration, 1000) } : {}),
  };
  const draft = draftRows(
    ctx,
    [row],
    legs,
    decision,
    { kind: "categorize", actor: ctx.principal },
    choice.narration,
  );
  return drafted(row, draft);
}

// ---------------------------------------------------------------------------------------------
// accept

const likeEscape = (value: string): string => value.replace(/[\\%_]/g, "\\$&");

/** The family of a proposer name: "rule" covers "rule:42", and a full name covers itself. */
const proposerMatches = (name: string, wanted: string): boolean =>
  name === wanted || name.startsWith(`${wanted}:`);

export async function acceptItems(
  service: ApplicationService,
  input: InboxAcceptInput,
  operationId: string,
  principal: string,
): Promise<InboxActionReport> {
  if (input.proposalId !== undefined && (input.itemIds?.length ?? 0) !== 1)
    throw new ApplicationError(
      "invalid_input",
      "A proposal id names one proposal on one item. Select that item by itemIds.",
    );
  // Suggestions are made when the Inbox is read; accept works from them, so make sure they are
  // current even if nobody has looked at the list since the last import.
  await ensureProposals(service);
  const ctx = await actionContext(service, principal, { journals: true });
  return service.retainRequest(operationId, "inbox.accept", input, () => {
    const minimum = input.minConfidence ?? 0;
    const constraint =
      input.proposer !== undefined ? "AND (q.proposer = ? OR q.proposer LIKE ? ESCAPE '\\')" : "";
    const eligible: Eligibility = {
      statuses: ["proposed"],
      sql: `EXISTS (SELECT 1 FROM app_ingest_proposals q WHERE q.item_id = i.id AND q.confidence >= ? ${constraint})`,
      bindings: [
        minimum,
        ...(input.proposer !== undefined
          ? [input.proposer, `${likeEscape(input.proposer)}:%`]
          : []),
      ],
    };
    const resolved = resolveSelection(ctx.store, input, eligible, DRAFT_LIMIT, DRAFT_LIMIT_MAX);
    // A line that is waiting but has nothing suggested is not in the wrong state: say what to do.
    const results = resolved.results.map((result) =>
      result.code === "wrong_status" && result.status === "new"
        ? {
            ...result,
            code: "no_proposal",
            message:
              "Nothing has been suggested for this line. Categorize it yourself, or write a rule.",
          }
        : result,
    );
    for (const stale of resolved.rows) {
      const row = rowById(ctx.store, stale.id);
      if (!row || (row.status !== "new" && row.status !== "proposed")) {
        results.push(
          skipped(
            stale,
            "wrong_status",
            "This item changed while the action ran, for example as the other side of a transfer.",
          ),
        );
        continue;
      }
      const stored = ctx.store
        .query("SELECT body FROM app_ingest_proposals WHERE item_id = ? ORDER BY rank")
        .all(row.id) as { body: string }[];
      const proposals = stored.map((entry) => JSON.parse(entry.body) as StoredProposal);
      const chosen = proposals.find(
        (proposal) =>
          (input.proposalId === undefined || proposal.id === input.proposalId) &&
          proposal.confidence >= minimum &&
          (input.proposer === undefined || proposerMatches(proposal.proposer, input.proposer)),
      );
      if (!chosen) {
        results.push(
          skipped(
            row,
            "no_proposal",
            input.proposalId !== undefined
              ? "That suggestion is no longer on this item. Look at the item again."
              : "No suggestion on this item meets the proposer and confidence you asked for.",
          ),
        );
        continue;
      }
      // A suggestion that would make a new entry is not taken for a line the Inbox has found an
      // entry for, however it was chosen (by proposer, by confidence or by name): only a person
      // saying so on purpose (allowDuplicate) books the payment a second time.
      const makesEntry = chosen.kind !== "match" && chosen.kind !== "exclude";
      if (makesEntry && input.allowDuplicate !== true) {
        const match = proposals.find((proposal) => proposal.kind === "match");
        if (match) {
          results.push(matchRefusal(ctx, row, match));
          continue;
        }
      }
      results.push(guarded(row, () => acceptOne(ctx, row, chosen)));
    }
    return report(results, resolved.remaining);
  });
}

/** Re-check the proposal against the chart and the line as they are now: it may be hours old. */
function acceptOne(ctx: ActionContext, row: ItemRow, proposal: StoredProposal): InboxActionResult {
  const line = lineOf(row);
  const decisionBase = {
    by: proposal.proposer,
    principal: ctx.principal,
    at: ctx.now,
    proposalId: proposal.id,
  };
  if (proposal.kind === "exclude") {
    const reason = sanitizeText(proposal.reasons.join(" "), 500) || "Excluded by a suggestion.";
    excludeRow(ctx, row, reason, proposal.proposer, { ...decisionBase, kind: "exclude", reason });
    cascade(ctx, row.id);
    return { itemId: row.id, outcome: "applied", status: "excluded" };
  }
  if (proposal.kind === "match") return acceptMatch(ctx, row, proposal, decisionBase);

  if (line.kind === "bankLine") {
    const early = bankLineProblem(ctx, row);
    if (early) return early;
  } else if (parseFlags(row.flags).includes("foreign_currency"))
    return skipped(
      row,
      "foreign_currency",
      `This event is in ${row.currency} and the book is in ${ctx.currency ?? "another currency"}. Rastrata does not convert currencies.`,
    );
  const checked = checkProposal(
    {
      proposer: proposal.proposer,
      kind: proposal.kind,
      confidence: proposal.confidence / 100,
      reasons: proposal.reasons,
      legs: proposal.legs,
      ...(proposal.narration ? { narration: proposal.narration } : {}),
    },
    {
      ownAccountId: row.ledger_account_id,
      line,
      date: row.posted_on,
      cents: parseMoney(row.amount),
      accountProblem: (accountId, date) => postingProblem(ctx.chart.get(accountId), date),
    },
  );
  if (!checked.ok)
    return failed(
      row,
      "proposal_stale",
      `This suggestion no longer fits: ${checked.problem}. Refresh the Inbox.`,
    );
  const legs = checked.proposal.legs ?? [];
  const decision = {
    ...decisionBase,
    kind: "accept",
    legs,
    ...(proposal.narration ? { narration: proposal.narration } : {}),
    ...(proposal.links ? { links: proposal.links } : {}),
  };
  const event = { kind: "accept", actor: proposal.proposer };

  if (proposal.kind === "transfer" && proposal.pairItemId !== undefined) {
    const pair = rowById(ctx.store, proposal.pairItemId);
    const counter = legs.find((leg) => leg.accountId !== row.ledger_account_id);
    if (
      !pair ||
      (pair.status !== "new" && pair.status !== "proposed") ||
      pair.kind !== "bankLine" ||
      pair.ledger_account_id === null ||
      pair.ledger_account_id !== counter?.accountId ||
      parseMoney(pair.amount) !== -parseMoney(row.amount) ||
      pair.currency !== row.currency
    )
      return failed(
        row,
        "proposal_stale",
        "The other side of this transfer is no longer waiting in the Inbox. Refresh and look again.",
      );
    const early = bankLineProblem(ctx, pair);
    if (early)
      return failed(
        row,
        early.code ?? "pair_unavailable",
        early.message ?? "The other side cannot be booked.",
      );
    const draft = draftRows(ctx, [row, pair], legs, decision, event, proposal.narration);
    return drafted(row, draft);
  }
  const draft = draftRows(ctx, [row], legs, decision, event, proposal.narration);
  cascade(ctx, row.id);
  return drafted(row, draft);
}

/** A match records that the line is the bank's side of an entry that is already booked. The entry
 * must still exist, still move the line's account by exactly the line's amount, and not be linked
 * to another line. Nothing is posted: the line is simply accounted for. */
function acceptMatch(
  ctx: ActionContext,
  row: ItemRow,
  proposal: StoredProposal,
  base: { readonly by: string; readonly at: string; readonly proposalId: string },
): InboxActionResult {
  const journalId = proposal.matchJournalId ?? "";
  const booked = ctx.journals.get(journalId);
  if (!booked || row.ledger_account_id === null)
    return failed(
      row,
      "proposal_stale",
      "The entry this line matched no longer exists. Refresh the Inbox.",
    );
  const moved = booked.journal.postings
    .filter((posting) => posting.accountId === row.ledger_account_id)
    .reduce((total, posting) => total + posting.bookValue.amount.coefficient, 0n);
  if (moved !== parseMoney(row.amount))
    return failed(
      row,
      "proposal_stale",
      "That entry no longer moves this account by the line's amount.",
    );
  const taken = ctx.store
    .query("SELECT id FROM app_ingest_items WHERE matched_journal_id = ? OR journal_id = ?")
    .get(journalId, journalId) as { id: string } | null;
  if (taken) return failed(row, "already_matched", "That entry is already linked to another line.");
  const updated = ctx.store
    .query(
      `UPDATE app_ingest_items SET status='posted', matched_journal_id=?, decision=?, post_error=NULL, post_error_code=NULL
       WHERE id=? AND status IN ('new', 'proposed')`,
    )
    .run(journalId, decisionJson({ ...base, kind: "match" }), row.id);
  if (updated.changes !== 1) throw new Error("An Inbox item changed while it was being matched");
  recordEvent(ctx.store, row.id, ctx.now, "match", proposal.proposer, { journalId });
  invalidateNeighbours(ctx.store, [row]);
  cascade(ctx, row.id);
  return { itemId: row.id, outcome: "applied", status: "posted", journalId };
}

// ---------------------------------------------------------------------------------------------
// exclude

function excludeRow(
  ctx: ActionContext,
  row: ItemRow,
  reason: string,
  actor: string,
  decision: Record<string, unknown>,
): void {
  const updated = ctx.store
    .query(
      `UPDATE app_ingest_items SET status='excluded', exclusion_code='manual', exclusion_reason=?,
         exclusion_at=?, decision=?, post_error=NULL, post_error_code=NULL
       WHERE id=? AND status IN ('new', 'proposed')`,
    )
    .run(reason, ctx.now, decisionJson(decision), row.id);
  if (updated.changes !== 1) throw new Error("An Inbox item changed while it was being excluded");
  recordEvent(ctx.store, row.id, ctx.now, "exclude", actor, { reason });
  invalidateNeighbours(ctx.store, [row]);
}

export async function excludeItems(
  service: ApplicationService,
  input: InboxExcludeInput,
  operationId: string,
  principal: string,
): Promise<InboxActionReport> {
  const reason = sanitizeText(input.reason, 500);
  if (reason === "")
    throw new ApplicationError("invalid_input", "Say why these lines are being set aside.");
  const ctx = await actionContext(service, principal);
  return service.retainRequest(operationId, "inbox.exclude", input, () => {
    const resolved = resolveSelection(
      ctx.store,
      input,
      { statuses: ["new", "proposed"] },
      DEFAULT_LIMIT,
    );
    const results = [...resolved.results];
    for (const stale of resolved.rows) {
      const row = rowById(ctx.store, stale.id);
      if (!row || (row.status !== "new" && row.status !== "proposed")) {
        results.push(skipped(stale, "wrong_status", "This item changed while the action ran."));
        continue;
      }
      excludeRow(ctx, row, reason, ctx.principal, {
        kind: "exclude",
        by: "manual",
        principal: ctx.principal,
        at: ctx.now,
        reason,
      });
      cascade(ctx, row.id);
      results.push({ itemId: row.id, outcome: "applied", status: "excluded" });
    }
    return report(results, resolved.remaining);
  });
}

// ---------------------------------------------------------------------------------------------
// sources

export async function configureSource(
  service: ApplicationService,
  input: InboxConfigureSourceInput,
  operationId: string,
  principal: string,
): Promise<InboxSourceChange> {
  if (input.ledgerAccountId === undefined && input.startOn === undefined)
    throw new ApplicationError("invalid_input", "Give a chart account, a cutover date, or both.");
  const ctx = await actionContext(service, principal);
  if (input.ledgerAccountId !== undefined) {
    const account = ctx.chart.get(input.ledgerAccountId);
    if (!account)
      throw new ApplicationError("account_not_found", "That chart account does not exist.", 404);
    if (account.role !== "asset" && account.role !== "liability")
      throw new ApplicationError(
        "account_role_invalid",
        "A provider account belongs to a bank, card or loan account: an asset or a liability.",
      );
  }
  return service.retainRequest(operationId, "inbox.configureSource", input, () => {
    const store = ctx.store;
    const stored = store
      .query(
        "SELECT ledger_account_id, start_on FROM app_ingest_sources WHERE provider=? AND account_key=?",
      )
      .get(input.provider, input.accountKey) as {
      ledger_account_id: string | null;
      start_on: string | null;
    } | null;
    if (!stored)
      store
        .query(
          "INSERT INTO app_ingest_sources (provider, account_key, ledger_account_id, start_on, created_at) VALUES (?, ?, NULL, NULL, ?)",
        )
        .run(input.provider, input.accountKey, ctx.now);
    const before = stored ?? { ledger_account_id: null, start_on: null };
    let excludedBeforeCutover = 0;
    let restored = 0;
    if (input.ledgerAccountId !== undefined && input.ledgerAccountId !== before.ledger_account_id) {
      const busy = store
        .query(
          "SELECT COUNT(*) AS n FROM app_ingest_items WHERE provider=? AND account_key=? AND status IN ('drafted', 'posted')",
        )
        .get(input.provider, input.accountKey) as { n: number };
      if (busy.n > 0)
        throw new ApplicationError(
          "source_has_activity",
          "Lines of this account already have drafts or posted entries, so its chart account can no longer change. Restore the drafts first, or book the difference with a journal entry.",
          409,
        );
      store
        .query(
          "UPDATE app_ingest_sources SET ledger_account_id=? WHERE provider=? AND account_key=?",
        )
        .run(input.ledgerAccountId, input.provider, input.accountKey);
    }
    if (input.startOn !== undefined && input.startOn !== before.start_on) {
      if (before.start_on === null || input.startOn > before.start_on)
        excludedBeforeCutover = applyCutover(
          store,
          input.provider,
          input.accountKey,
          input.startOn,
          ctx.now,
        );
      else restored = releaseCutover(store, input.provider, input.accountKey, input.startOn);
      store
        .query("UPDATE app_ingest_sources SET start_on=? WHERE provider=? AND account_key=?")
        .run(input.startOn, input.provider, input.accountKey);
    }
    // The mapping and the cutover change what can be proposed for this account's open lines.
    store
      .query(
        "UPDATE app_ingest_items SET proposed_rev=NULL WHERE provider=? AND account_key=? AND status IN ('new', 'proposed')",
      )
      .run(input.provider, input.accountKey);
    const view = sourceView(store, input.provider, input.accountKey);
    if (!view) throw new Error("The source was not stored");
    return { source: view, excludedBeforeCutover, restored };
  });
}
