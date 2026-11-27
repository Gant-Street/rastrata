/** What the pipeline will accept from a proposer. A proposer is code written by another lane (rules,
 * the classifier, the Stripe payout matcher) and may be wrong, so its output is checked here before
 * anything stores or shows it: a suggestion that cannot balance to the cent, names an account that
 * is not open, or comes with no reason is dropped, and the item shows why. Nothing here posts. */
import type { IngestLine, Proposal, ProposedLeg } from "../ingest-types.ts";
import { formatMoney, isMoney, parseMoney } from "../money.ts";
import { sha256Hex, stableStringify } from "./hash.ts";
import { sanitizeText } from "./text.ts";

export type ProposalKind = Proposal["kind"];
const KINDS: readonly ProposalKind[] = ["categorize", "transfer", "match", "exclude", "event"];

/** A proposal as the pipeline stores and shows it (the wire shape). */
export interface StoredProposal {
  readonly id: string;
  readonly proposer: string;
  readonly kind: ProposalKind;
  /** A whole percent, 0 to 100. */
  readonly confidence: number;
  readonly reasons: readonly string[];
  readonly legs?: readonly { readonly accountId: string; readonly amount: string }[];
  readonly matchJournalId?: string;
  readonly pairItemId?: string;
  readonly narration?: string;
  readonly links?: readonly { readonly key: string; readonly value: string }[];
}

export interface ProposalCheck {
  /** The line's own chart account, when it has one: a bank leg must carry the line's amount. */
  readonly ownAccountId: string | null;
  readonly line: IngestLine;
  readonly date: string;
  /** The line's signed amount in cents (for a bank line). */
  readonly cents: bigint;
  /** A reason a posting to this account on `date` is not possible, or null when it is. */
  readonly accountProblem: (accountId: string, date: string) => string | null;
}

export type ProposalOutcome =
  | { readonly ok: true; readonly proposal: StoredProposal }
  | { readonly ok: false; readonly problem: string };

const bad = (proposer: string, message: string): ProposalOutcome => ({
  ok: false,
  problem: `${sanitizeText(proposer, 60) || "A proposer"}: ${message}`,
});

export function proposalId(proposal: Omit<StoredProposal, "id">): string {
  return `p_${sha256Hex(
    stableStringify({
      proposer: proposal.proposer,
      kind: proposal.kind,
      legs: proposal.legs,
      matchJournalId: proposal.matchJournalId,
      pairItemId: proposal.pairItemId,
      narration: proposal.narration,
    }),
  ).slice(0, 16)}`;
}

export function checkProposal(raw: unknown, check: ProposalCheck): ProposalOutcome {
  if (raw === null || typeof raw !== "object") return bad("", "a suggestion was not an object");
  const input = raw as Partial<Proposal>;
  const proposer = typeof input.proposer === "string" ? sanitizeText(input.proposer, 100) : "";
  if (!proposer) return bad("", "a suggestion did not say who made it");
  if (!KINDS.includes(input.kind as ProposalKind))
    return bad(proposer, "its kind is not one of categorize, transfer, match, exclude or event");
  const kind = input.kind as ProposalKind;
  if (typeof input.confidence !== "number" || !Number.isFinite(input.confidence))
    return bad(proposer, "its confidence is not a number");
  const confidence = Math.min(100, Math.max(0, Math.round(input.confidence * 100)));
  const reasons = Array.isArray(input.reasons)
    ? input.reasons
        .filter((reason): reason is string => typeof reason === "string")
        .map((reason) => sanitizeText(reason, 300))
        .filter((reason) => reason.length > 0)
        .slice(0, 8)
    : [];
  if (reasons.length === 0) return bad(proposer, "it gave no reason, and every suggestion must");
  const narration =
    typeof input.narration === "string" ? sanitizeText(input.narration, 1000) : undefined;

  let legs: { accountId: string; amount: string }[] | undefined;
  if (kind === "categorize" || kind === "transfer" || kind === "event") {
    const given = input.legs as readonly ProposedLeg[] | undefined;
    if (!Array.isArray(given) || given.length < 2 || given.length > 100)
      return bad(proposer, `a ${kind} needs between 2 and 100 legs`);
    legs = [];
    let total = 0n;
    let own = 0n;
    for (const leg of given) {
      if (
        !leg ||
        typeof leg.accountId !== "string" ||
        typeof leg.amount !== "string" ||
        !isMoney(leg.amount)
      )
        return bad(proposer, "a leg needs an account and a two-place amount");
      const cents = parseMoney(leg.amount);
      if (cents === 0n) return bad(proposer, "a leg of 0.00 cannot be posted");
      const problem = check.accountProblem(leg.accountId, check.date);
      if (problem) return bad(proposer, problem);
      total += cents;
      if (leg.accountId === check.ownAccountId) own += cents;
      legs.push({ accountId: leg.accountId, amount: formatMoney(cents) });
    }
    if (total !== 0n) return bad(proposer, "its legs do not add up to exactly 0.00");
    if (check.line.kind === "bankLine") {
      if (check.ownAccountId === null)
        return bad(proposer, "the line's account has no chart account yet");
      if (own !== check.cents)
        return bad(
          proposer,
          `its entry must move the line's own account by exactly ${formatMoney(check.cents)}`,
        );
    }
  } else if (input.legs !== undefined && (!Array.isArray(input.legs) || input.legs.length > 0)) {
    return bad(proposer, `a ${kind} suggestion carries no legs`);
  }
  let matchJournalId: string | undefined;
  if (kind === "match") {
    if (typeof input.matchJournalId !== "string" || input.matchJournalId.length === 0)
      return bad(proposer, "a match needs the entry it matches");
    matchJournalId = input.matchJournalId;
  }
  const pairItemId =
    kind === "transfer" && typeof input.pairItemId === "string" ? input.pairItemId : undefined;
  let links: { key: string; value: string }[] | undefined;
  if (input.links !== undefined) {
    if (input.links === null || typeof input.links !== "object" || Array.isArray(input.links))
      return bad(proposer, "its links are not an object");
    links = Object.entries(input.links)
      .filter(([key, value]) => typeof value === "string" && key.length > 0)
      .map(([key, value]) => ({
        key: sanitizeText(key, 64),
        value: sanitizeText(value as string, 256),
      }))
      .filter((link) => link.key.length > 0)
      .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
      .slice(0, 20);
  }
  const body = {
    proposer,
    kind,
    confidence,
    reasons,
    ...(legs ? { legs } : {}),
    ...(matchJournalId ? { matchJournalId } : {}),
    ...(pairItemId ? { pairItemId } : {}),
    ...(narration ? { narration } : {}),
    ...(links && links.length > 0 ? { links } : {}),
  };
  return { ok: true, proposal: { id: proposalId(body), ...body } };
}

/** Best first. A match to an entry that is already booked always comes first, whatever else is
 * suggested: every other suggestion would make a new entry for a payment that is already in the
 * books, so what a person sees and accepts first must be the one that makes none. Then more
 * confident, then by proposer and kind so ties are stable, then by id. */
export function orderProposals(proposals: readonly StoredProposal[]): StoredProposal[] {
  const makesNoEntry = (proposal: StoredProposal): number => (proposal.kind === "match" ? 0 : 1);
  return [...proposals].sort(
    (left, right) =>
      makesNoEntry(left) - makesNoEntry(right) ||
      right.confidence - left.confidence ||
      (left.proposer < right.proposer ? -1 : left.proposer > right.proposer ? 1 : 0) ||
      (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
}
