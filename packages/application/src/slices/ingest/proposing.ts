/** Proposing: asking every registered proposer what an open item could be, checking what comes
 * back, and keeping the answers so the Inbox can show them without asking again.
 *
 * Proposals are stored per item (`app_ingest_proposals`) and go stale in three ways, each handled
 * without a "refresh everything" button:
 * - a proposer's own inputs changed (rules were edited, the classifier retrained): the proposer's
 *   `revision` string changes, and so does the combined revision every item is stamped with;
 * - the ledger gained an entry nobody linked to a line (a person booked something by hand that a
 *   bank line might be): the combined revision includes a key of those entries;
 * - the Inbox itself changed (new lines arrived, a line was drafted or excluded): the lines this
 *   could affect (the other side of a transfer, a line with the same amount) are marked stale.
 * An item with no stamp, or a different one, is proposed again the next time the Inbox is read.
 * A proposer that learns from the book (the classifier) is given the start of a reader's run to
 * learn again (`prepare`), so the run's revision already reflects what it learned.
 *
 * The built-in proposers are here too: the transfer matcher and the matcher to existing entries.
 * They are ordinary registrations; nothing about them is special to the pipeline. */
import type { BookState } from "@rastrata/kernel";
import { addDays, sanitizeText } from "../../ingest/text.ts";
import { sha256Hex, stableStringify } from "../../ingest/hash.ts";
import {
  DEFAULT_MATCH_CONFIG,
  chooseTransfer,
  journalConfidence,
  rankJournals,
  type MatchConfig,
} from "../../ingest/match.ts";
import { checkProposal, orderProposals, type StoredProposal } from "../../ingest/proposals.ts";
import type {
  IngestItem,
  NearbyQuery,
  Proposal,
  ProposalContext,
  Proposer,
} from "../../ingest-types.ts";
import { formatMoney, isMoney, parseMoney } from "../../money.ts";
import {
  deltaOf,
  positionOf,
  revisionsAfter,
  type Position,
} from "../../reports/ledger-history.ts";
import type { ApplicationService } from "../../service.ts";
import type { ApplicationStore } from "../../storage.ts";
import { observeIngest } from "../../telemetry.ts";
import { chartOf, postingProblem } from "./ledger-view.ts";
import { type MatchEntry, matchIndexFor } from "./match-index.ts";
import { registerProposer, registeredProposers, type ProposerRegistration } from "./proposers.ts";
import { ITEM_COLUMNS, ITEM_FROM, type ItemRow, ingestRuntime, toIngestItem } from "./store.ts";

export interface RefreshReport {
  readonly examined: number;
  readonly proposed: number;
  readonly problems: number;
}

const MAX_PROPOSALS_PER_ITEM = 20;
const MAX_PROBLEMS_PER_ITEM = 10;
const CHUNK = 200;
/** The widest window any built-in matcher looks across, for marking neighbours stale. */
const NEIGHBOUR_DAYS = 10;
/** The most days either side of a line's date that the matcher to entries looks across: the limit a
 * stored configuration is held to (`matchConfig`), which is what an entry that comes or goes can reach. */
const JOURNAL_WINDOW_MAX = 60;
/** The most entries and links one reading takes into account one at a time. A longer run of changes (a
 * history import) marks every open line instead, which is also what a book it cannot follow gets. */
const MAX_TARGETED = 256;

/** Matcher configuration: the defaults, overridden by `app_ingest_settings` key "match" when a
 * person has tuned it. Unknown or out-of-range values are ignored, never trusted. */
export function matchConfig(store: ApplicationStore): MatchConfig {
  const row = store.query("SELECT value FROM app_ingest_settings WHERE key='match'").get() as {
    value: string;
  } | null;
  if (!row) return DEFAULT_MATCH_CONFIG;
  try {
    const stored = JSON.parse(row.value) as Partial<{
      transfer: Partial<MatchConfig["transfer"]>;
      journal: Partial<Omit<MatchConfig["journal"], "weights">> & {
        weights?: Partial<MatchConfig["journal"]["weights"]>;
      };
    }>;
    const number = (value: unknown, fallback: number, min: number, max: number) =>
      typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
        ? value
        : fallback;
    const base = DEFAULT_MATCH_CONFIG;
    const weights = stored.journal?.weights ?? {};
    return {
      transfer: {
        windowDays: number(stored.transfer?.windowDays, base.transfer.windowDays, 0, 30),
      },
      journal: {
        windowDays: number(
          stored.journal?.windowDays,
          base.journal.windowDays,
          0,
          JOURNAL_WINDOW_MAX,
        ),
        nearDays: number(stored.journal?.nearDays, base.journal.nearDays, 0, 30),
        minScore: number(stored.journal?.minScore, base.journal.minScore, 0, 100),
        weights: {
          amountExact: number(weights.amountExact, base.journal.weights.amountExact, 0, 20),
          sameDay: number(weights.sameDay, base.journal.weights.sameDay, 0, 20),
          nearDays: number(weights.nearDays, base.journal.weights.nearDays, 0, 20),
          inWindow: number(weights.inWindow, base.journal.weights.inWindow, 0, 20),
          reference: number(weights.reference, base.journal.weights.reference, 0, 20),
          wordsMany: number(weights.wordsMany, base.journal.weights.wordsMany, 0, 20),
          wordsOne: number(weights.wordsOne, base.journal.weights.wordsOne, 0, 20),
        },
      },
    };
  } catch {
    return DEFAULT_MATCH_CONFIG;
  }
}

const accountName = (context: ProposalContext, id: string): string => {
  const account = context.accounts.find((item) => item.id === id);
  return account ? sanitizeText(`${account.code} ${account.name}`, 80) : id;
};

/** The other side of a transfer between two of the book's own accounts. */
function transferProposer(config: MatchConfig): Proposer {
  return {
    name: "transfer",
    propose(item: IngestItem, context: ProposalContext): readonly Proposal[] {
      const line = item.line;
      if (line.kind !== "bankLine" || item.ledgerAccountId === null || !context.nearby) return [];
      if (item.flags?.includes("foreign_currency") || !isMoney(line.amount)) return [];
      const cents = parseMoney(line.amount);
      if (cents === 0n) return [];
      const negated = formatMoney(-cents);
      const window = config.transfer.windowDays;
      const others = context
        .nearby({
          amount: negated,
          from: addDays(line.postedOn, -window),
          to: addDays(line.postedOn, window),
          kind: "bankLine",
          statuses: ["new", "proposed"],
          limit: 50,
        })
        .filter(
          (other) =>
            other.id !== item.id &&
            other.ledgerAccountId !== null &&
            other.ledgerAccountId !== item.ledgerAccountId &&
            other.line.kind === "bankLine" &&
            other.line.currency === line.currency,
        );
      const choice = chooseTransfer(
        { accountId: item.ledgerAccountId, date: line.postedOn, amount: line.amount },
        others.flatMap((other) =>
          other.line.kind === "bankLine" && other.ledgerAccountId !== null
            ? [{ itemId: other.id, accountId: other.ledgerAccountId, date: other.line.postedOn }]
            : [],
        ),
        config,
      );
      if (!choice) return [];
      const counter = others.find((other) => other.id === choice.itemId);
      if (!counter || counter.ledgerAccountId === null) return [];
      const from = cents < 0n ? item.ledgerAccountId : counter.ledgerAccountId;
      const to = cents < 0n ? counter.ledgerAccountId : item.ledgerAccountId;
      return [
        {
          proposer: "transfer",
          kind: "transfer",
          confidence: choice.confidence / 100,
          reasons: choice.reasons,
          legs: [
            { accountId: item.ledgerAccountId, amount: line.amount },
            { accountId: counter.ledgerAccountId, amount: negated },
          ],
          pairItemId: choice.itemId,
          narration: `Transfer from ${accountName(context, from)} to ${accountName(context, to)}`,
        },
      ];
    },
  };
}

/** A bank line that is the bank's record of an entry already booked by hand or by an agent. */
function journalProposer(config: MatchConfig): Proposer {
  return {
    name: "journal-match",
    propose(item: IngestItem, context: ProposalContext): readonly Proposal[] {
      const line = item.line;
      if (line.kind !== "bankLine" || item.ledgerAccountId === null || !context.journalsNear)
        return [];
      if (item.flags?.includes("foreign_currency") || !isMoney(line.amount)) return [];
      if (parseMoney(line.amount) === 0n) return [];
      const window = config.journal.windowDays;
      const candidates = context.journalsNear({
        accountId: item.ledgerAccountId,
        amount: line.amount,
        from: addDays(line.postedOn, -window),
        to: addDays(line.postedOn, window),
        around: line.postedOn,
        limit: 20,
      });
      const ranked = rankJournals(
        line.amount,
        {
          date: line.postedOn,
          text: `${line.description} ${line.counterparty ?? ""}`,
          ...(line.reference ? { reference: line.reference } : {}),
        },
        candidates.map((candidate) => ({
          id: candidate.id,
          date: candidate.date,
          narration: candidate.narration,
        })),
        config,
      );
      const best = ranked[0];
      if (!best) return [];
      const reasons = [...best.reasons];
      const close = ranked.slice(1).filter((other) => other.score >= best.score - 1).length;
      if (close > 0)
        reasons.push(
          `${close} other ${close === 1 ? "entry matches" : "entries match"} almost as well; check this is the right one.`,
        );
      return [
        {
          proposer: "journal-match",
          kind: "match",
          confidence: journalConfidence(ranked) / 100,
          reasons,
          matchJournalId: best.journalId,
        },
      ];
    },
  };
}

const configRevision = (service: ApplicationService): string =>
  sha256Hex(stableStringify(matchConfig(service.store))).slice(0, 16);

export const BUILTIN_PROPOSERS: readonly ProposerRegistration[] = [
  {
    name: "journal-match",
    create: (service) => journalProposer(matchConfig(service.store)),
    revision: configRevision,
  },
  {
    name: "transfer",
    create: (service) => transferProposer(matchConfig(service.store)),
    revision: configRevision,
  },
];
for (const registration of BUILTIN_PROPOSERS) registerProposer(registration);

/** Mark open items stale so the next read proposes them again. `provider` limits it to one source
 * (a Stripe sync that brought in payouts). */
export function invalidateProposals(
  service: ApplicationService,
  filter: { readonly provider?: string } = {},
): number {
  const store = ingestRuntime(service).store;
  return store
    .query(
      `UPDATE app_ingest_items SET proposed_rev=NULL
       WHERE status IN ('new', 'proposed') AND proposed_rev IS NOT NULL
         AND (? IS NULL OR provider=?)`,
    )
    .run(filter.provider ?? null, filter.provider ?? null).changes;
}

/** After a line's status changed, mark the open lines it could affect: the other side of a
 * transfer (opposite amount) and entries with the same amount, near in time. */
export function invalidateNeighbours(
  store: ApplicationStore,
  changed: readonly { readonly amount: string; readonly posted_on: string }[],
): void {
  for (const item of changed) {
    const cents = parseMoney(item.amount);
    store
      .query(
        `UPDATE app_ingest_items SET proposed_rev=NULL
         WHERE status IN ('new', 'proposed') AND proposed_rev IS NOT NULL
           AND cents IN (?, ?) AND posted_on BETWEEN ? AND ?`,
      )
      .run(
        cents,
        -cents,
        addDays(item.posted_on, -NEIGHBOUR_DAYS),
        addDays(item.posted_on, NEIGHBOUR_DAYS),
      );
  }
}

function safeRevision(registration: ProposerRegistration, service: ApplicationService): string {
  try {
    return registration.revision ? registration.revision(service) : "";
  } catch {
    return "revision-failed";
  }
}

function nearbyFor(store: ApplicationStore): NonNullable<ProposalContext["nearby"]> {
  return (query: NearbyQuery): readonly IngestItem[] => {
    const clauses = ["i.posted_on BETWEEN ? AND ?"];
    const bindings: (string | bigint | number)[] = [query.from, query.to];
    if (query.amount !== undefined) {
      if (!isMoney(query.amount)) return [];
      clauses.push("i.cents = ?");
      bindings.push(parseMoney(query.amount));
    }
    if (query.provider !== undefined) {
      clauses.push("i.provider = ?");
      bindings.push(query.provider);
    }
    if (query.kind !== undefined) {
      clauses.push("i.kind = ?");
      bindings.push(query.kind);
    }
    if (query.statuses && query.statuses.length > 0) {
      clauses.push(`i.status IN (${query.statuses.map(() => "?").join(", ")})`);
      bindings.push(...query.statuses);
    }
    const limit = Math.min(200, Math.max(1, Math.trunc(query.limit ?? 50)));
    const rows = store
      .query(
        `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE ${clauses.join(" AND ")} ORDER BY i.posted_on, i.seq LIMIT ?`,
      )
      .all(...bindings, limit) as ItemRow[];
    return rows.map(toIngestItem);
  };
}

/** The refresh in progress, if any, so readers that arrive together share one run. A reader's run
 * (`prepare: true`) first lets the proposers bring their own state up to date; a change's refresh
 * (the default) proposes with what they have. */
export async function ensureProposals(
  service: ApplicationService,
  options: { readonly prepare?: boolean } = {},
): Promise<RefreshReport> {
  const runtime = ingestRuntime(service);
  while (runtime.refreshing) await runtime.refreshing.catch(() => undefined);
  const run: Promise<RefreshReport> = observeIngest("propose", undefined, () =>
    refreshNow(service, options.prepare ?? false),
  ).finally(() => {
    if (runtime.refreshing === run) runtime.refreshing = null;
  });
  runtime.refreshing = run;
  return run;
}

/** What the proposals have been made current to: the place in the book's hash chain whose entries have
 * been taken into account, and the last change in the Inbox taken into account (`app_ingest_changes`). */
interface Through {
  readonly position: Position;
  readonly changes: number;
}

const THROUGH_KEY = "proposals_through";
/** The revision of the proposers the stored suggestions were made under, as the last reading saw it. */
const REVISION_KEY = "proposals_revision";

function readThrough(store: ApplicationStore): Through | null {
  const row = store.query("SELECT value FROM app_ingest_settings WHERE key=?").get(THROUGH_KEY) as {
    value: string;
  } | null;
  if (!row) return null;
  try {
    const stored = JSON.parse(row.value) as {
      revision?: unknown;
      chainHash?: unknown;
      changes?: unknown;
    };
    if (typeof stored.revision !== "string" || typeof stored.changes !== "number") return null;
    const hash = stored.chainHash as Position["chainHash"] | undefined;
    if (hash !== null && (typeof hash !== "object" || typeof hash?.digest !== "string"))
      return null;
    return {
      position: { revision: BigInt(stored.revision), chainHash: hash ?? null },
      changes: stored.changes,
    };
  } catch {
    return null;
  }
}

function writeThrough(store: ApplicationStore, through: Through): void {
  store
    .query(
      "INSERT INTO app_ingest_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(
      THROUGH_KEY,
      JSON.stringify({
        revision: through.position.revision.toString(),
        chainHash: through.position.chainHash,
        changes: through.changes,
      }),
    );
}

/** Every open line is proposed again the next time the Inbox is read. */
function invalidateAll(store: ApplicationStore): void {
  store
    .query(
      "UPDATE app_ingest_items SET proposed_rev=NULL WHERE status IN ('new', 'proposed') AND proposed_rev IS NOT NULL",
    )
    .run();
}

/** The open lines an entry could be a match for, proposed again at the next reading: the lines on the
 * chart account it posts to, for exactly the amount of its posting there, dated within the widest window
 * the matcher looks across. A line this does not name has nothing in its suggestions that depends on
 * the entry. */
function invalidateAround(store: ApplicationStore, entries: readonly MatchEntry[]): void {
  const update = store.query(
    `UPDATE app_ingest_items SET proposed_rev=NULL
     WHERE status IN ('new', 'proposed') AND proposed_rev IS NOT NULL
       AND cents = ? AND posted_on BETWEEN ? AND ?
       AND EXISTS (SELECT 1 FROM app_ingest_sources s
         WHERE s.provider = app_ingest_items.provider AND s.account_key = app_ingest_items.account_key
           AND s.ledger_account_id = ?)`,
  );
  for (const entry of entries) {
    if (entry.cents === 0n) continue;
    update.run(
      entry.cents,
      addDays(entry.date, -JOURNAL_WINDOW_MAX),
      addDays(entry.date, JOURNAL_WINDOW_MAX),
      entry.accountId,
    );
  }
}

const sameChain = (left: Position["chainHash"], right: Position["chainHash"]): boolean =>
  left === null || right === null ? left === right : left.digest === right.digest;

/** Bring the stored suggestions up to date with what happened since they were last made current, by
 * marking the lines whose suggestions that could change, and no others. What the entry matcher reads of
 * the book is the entries in effect and whether each is linked to a line, so what matters is the entries
 * the ledger gained or lost (a new one, a reversal or a correction that took one out) and the entries a
 * line was linked to or let go of. Anything it cannot follow (a book that is not the one it was last made
 * current to, a calendar or a chart that changed, a long run of changes) marks every open line, as every
 * change used to. The work is the size of what changed, not of the book. */
function keepProposalsCurrent(store: ApplicationStore, state: BookState): void {
  const index = matchIndexFor(state);
  const at = positionOf(state);
  const latest =
    (store.query("SELECT MAX(seq) AS seq FROM app_ingest_changes").get() as { seq: number | null })
      .seq ?? 0;
  const through = readThrough(store);
  if (
    through !== null &&
    through.changes === latest &&
    through.position.revision === at.revision &&
    sameChain(through.position.chainHash, at.chainHash)
  )
    return;
  store.transaction(() => {
    let everything = through === null;
    const touched: MatchEntry[] = [];
    if (through !== null) {
      const revisions = revisionsAfter(state, through.position);
      if (revisions === null) everything = true;
      else if (revisions.length > 0) {
        const delta = deltaOf(revisions);
        if (
          delta.configurations.length > 0 ||
          delta.journals.length + delta.links.length > MAX_TARGETED
        )
          everything = true;
        else {
          for (const booked of delta.journals)
            touched.push(...(index.entriesOf(booked.journal.id as string) ?? []));
          for (const link of delta.links) {
            touched.push(...(index.entriesOf(link.originalJournalId) ?? []));
            if (link.kind === "reversal")
              touched.push(...(index.entriesOf(link.correctionJournalId) ?? []));
          }
        }
      }
      if (!everything && latest > through.changes) {
        const linked = store
          .query(
            "SELECT DISTINCT journal_id AS id FROM app_ingest_changes WHERE seq > ? AND journal_id IS NOT NULL",
          )
          .all(through.changes) as { id: string }[];
        if (linked.length > MAX_TARGETED) everything = true;
        else
          for (const { id } of linked) {
            const entries = index.entriesOf(id);
            if (entries === undefined) everything = true;
            else touched.push(...entries);
          }
      }
    }
    if (everything) invalidateAll(store);
    else invalidateAround(store, touched);
    writeThrough(store, { position: at, changes: latest });
  });
}

async function refreshNow(service: ApplicationService, prepare: boolean): Promise<RefreshReport> {
  const runtime = ingestRuntime(service);
  const store = runtime.store;
  const open = store
    .query(
      "SELECT COALESCE(SUM(n), 0) AS n FROM app_ingest_tally WHERE status IN ('new', 'proposed')",
    )
    .get() as { n: number };
  if (open.n === 0) return { examined: 0, proposed: 0, problems: 0 };

  const registrations = registeredProposers();
  // For a reader, a proposer that keeps derived state brings it up to date first, so the revision
  // below, and the suggestions, reflect the book as it is now. One that cannot goes on with what it has.
  if (prepare)
    for (const registration of registrations)
      if (registration.prepare)
        try {
          await registration.prepare(service);
        } catch {
          // Its own status says it is behind; the run is not stopped for it.
        }
  const { aggregate } = await service.readAggregate();
  const state = aggregate.state;
  const chart = chartOf(state);

  // The lines the book's changes since the last time could touch are marked, so that what is stale below
  // is those and not everything.
  keepProposalsCurrent(store, state);
  const index = matchIndexFor(state);
  const revision = sha256Hex(
    stableStringify(
      registrations.map((registration) => [registration.name, safeRevision(registration, service)]),
    ),
  ).slice(0, 32);

  // What the proposers read changing (a rule edited, a threshold, the tags) makes every line stale. That is
  // done once, when the revision is seen to have changed, and a line then is stale exactly when it has no
  // revision: the lines to propose for are found through an index of those, not by looking at every line.
  const known = store
    .query("SELECT value FROM app_ingest_settings WHERE key=?")
    .get(REVISION_KEY) as {
    value: string;
  } | null;
  if (known?.value !== revision)
    store.transaction(() => {
      invalidateAll(store);
      store
        .query(
          "INSERT INTO app_ingest_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(REVISION_KEY, revision);
    });
  const stale = () =>
    store
      .query(
        `SELECT ${ITEM_COLUMNS}
         FROM app_ingest_items i INDEXED BY app_ingest_items_unproposed
           LEFT JOIN app_ingest_sources s ON s.provider = i.provider AND s.account_key = i.account_key
         WHERE i.status IN ('new', 'proposed') AND i.proposed_rev IS NULL
         ORDER BY i.seq LIMIT ${CHUNK}`,
      )
      .all() as ItemRow[];
  let rows = stale();
  if (rows.length === 0) return { examined: 0, proposed: 0, problems: 0 };

  const startup: string[] = [];
  // A proposer of last resort goes after the others and is asked only when they found nothing.
  const proposers: { readonly proposer: Proposer; readonly fallback: boolean }[] = [];
  for (const registration of [
    ...registrations.filter((item) => item.fallback !== true),
    ...registrations.filter((item) => item.fallback === true),
  ])
    try {
      proposers.push({
        proposer: registration.create(service),
        fallback: registration.fallback === true,
      });
    } catch {
      startup.push(`${registration.name}: could not start, so it made no suggestions`);
    }
  // Whether an entry is linked to a line of the Inbox, asked of the lines when it matters.
  const linkedByJournal = store.query(
    "SELECT 1 AS yes FROM app_ingest_items WHERE journal_id = ? LIMIT 1",
  );
  const linkedByMatch = store.query(
    "SELECT 1 AS yes FROM app_ingest_items WHERE matched_journal_id = ? LIMIT 1",
  );
  const isLinked = (journalId: string): boolean =>
    linkedByJournal.get(journalId) !== null || linkedByMatch.get(journalId) !== null;
  const context: ProposalContext = {
    accounts: [...chart.values()].map((account) => ({
      id: account.id,
      code: account.code,
      name: account.name,
      role: account.role,
      closedOn: account.closedOn,
      openedOn: account.openedOn,
      postingAllowed: account.postingAllowed,
    })),
    currency: service.setupState()?.currency ?? "",
    nearby: nearbyFor(store),
    journalsNear: (query) => index.near(query, isLinked),
  };

  let examined = 0;
  let proposed = 0;
  let problemItems = 0;
  while (rows.length > 0) {
    const results = rows.map((row) => {
      const item = toIngestItem(row);
      const problems = [...startup];
      const found: StoredProposal[] = [];
      // A covered line is booked with its payout and decides nothing on its own.
      const skip = item.flags?.includes("foreign_currency") === true || row.covered_by !== null;
      for (const { proposer, fallback } of skip ? [] : proposers) {
        if (fallback && found.length > 0) continue;
        let output: readonly Proposal[];
        try {
          output = proposer.propose(item, context);
          if (!Array.isArray(output)) throw new TypeError("not a list");
        } catch {
          problems.push(
            `${sanitizeText(proposer.name, 60)}: failed on this line, so it made no suggestion`,
          );
          continue;
        }
        for (const raw of output) {
          const checked = checkProposal(raw, {
            ownAccountId: row.ledger_account_id,
            line: item.line,
            date: row.posted_on,
            cents: parseMoney(row.amount),
            accountProblem: (accountId, date) => postingProblem(chart.get(accountId), date),
          });
          if (!checked.ok) {
            problems.push(checked.problem);
            continue;
          }
          const proposal = checked.proposal;
          if (proposal.kind === "match" && !index.has(proposal.matchJournalId ?? "")) {
            problems.push(`${proposal.proposer}: the entry it matches does not exist`);
            continue;
          }
          if (proposal.matchJournalId !== undefined && isLinked(proposal.matchJournalId)) {
            problems.push(`${proposal.proposer}: that entry is already linked to another line`);
            continue;
          }
          if (!found.some((existing) => existing.id === proposal.id)) found.push(proposal);
        }
      }
      return {
        row,
        proposals: orderProposals(found).slice(0, MAX_PROPOSALS_PER_ITEM),
        problems: problems.slice(0, MAX_PROBLEMS_PER_ITEM),
      };
    });
    store.transaction(() => {
      for (const { row, proposals, problems } of results) {
        const updated = store
          .query(
            "UPDATE app_ingest_items SET status=?, proposed_rev=?, proposal_problems=? WHERE id=? AND status IN ('new', 'proposed')",
          )
          .run(
            proposals.length > 0 ? "proposed" : "new",
            revision,
            JSON.stringify(problems),
            row.id,
          );
        store.query("DELETE FROM app_ingest_proposals WHERE item_id=?").run(row.id);
        if (updated.changes !== 1) continue;
        for (const [rank, proposal] of proposals.entries())
          store
            .query(
              "INSERT INTO app_ingest_proposals (item_id, rank, id, proposer, kind, confidence, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              row.id,
              rank,
              proposal.id,
              proposal.proposer,
              proposal.kind,
              proposal.confidence,
              JSON.stringify(proposal),
            );
      }
    });
    examined += results.length;
    proposed += results.filter((result) => result.proposals.length > 0).length;
    problemItems += results.filter((result) => result.problems.length > 0).length;
    rows = stale();
  }
  return { examined, proposed, problems: problemItems };
}
