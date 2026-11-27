/** Matching a Xero chart onto the book's chart.
 *
 * The book's chart was built from a template (or by hand), and the Xero chart was built over years,
 * so codes mean different things in each: Xero's default "200 Sales" is not the template's "4000
 * Sales", and a code that happens to be equal is weak evidence. The matcher therefore reads a name
 * as the stronger evidence and a code as a hint, and says how sure it is:
 *
 * - `certain`: chosen by a person (a saved mapping or an override), or the same code and the same
 *   name, in the same kind of account.
 * - `likely`: the same name, or the same code with a name that is close.
 * - `check`: a name that is close, or only the same code. Shown, never applied without a person.
 *
 * An account of the book can stand for one Xero account at a time here (a second claim goes to the
 * better match, and the other is left unmapped with the reason). Several Xero accounts may be mapped
 * to one account of the book on purpose, by a person; the tie-out sums them.
 *
 * Nothing is guessed about money: a role that disagrees with the Xero type is reported, not fixed. */
import { ADD_ONS, TEMPLATES } from "../../chart/templates.ts";
import { normalizeForKey, tokens } from "../../ingest/text.ts";
import type { CashFlowClass } from "../../account-tags.ts";
import type { OpeningRole } from "../opening.ts";
import type { XeroAccount } from "./chart.ts";
import { xeroType } from "./types.ts";

export interface BookAccount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly role: OpeningRole;
  readonly closedOn: string | null;
  readonly roleKey: string | null;
}

export type MatchBasis = "override" | "saved" | "code" | "name" | "similar" | "none";
export type Confidence = "certain" | "likely" | "check" | "none";

/** What a person decided about one Xero account: an account of the book, or to leave it out. */
export interface Choice {
  readonly accountId: string | null;
  readonly skip: boolean;
}

export type MappingProblem =
  | "target_missing"
  | "target_closed"
  | "role_differs"
  | "target_taken"
  | "unknown_role";

export interface Suggestion {
  readonly role: OpeningRole;
  readonly cashFlowClass: CashFlowClass | null;
  readonly roleKey: string | null;
  /** The template account the suggestion follows, so the owner can see why. */
  readonly like: string | null;
}

export interface Proposal {
  readonly xero: XeroAccount;
  readonly accountId: string | null;
  readonly skip: boolean;
  readonly basis: MatchBasis;
  readonly confidence: Confidence;
  /** Other accounts of the book that could be it, best first. */
  readonly candidates: readonly string[];
  readonly problems: readonly MappingProblem[];
  /** For an account with no counterpart: what to create, from the Xero type and the templates. */
  readonly suggestion: Suggestion | null;
}

const INCOME_LIKE: ReadonlySet<OpeningRole> = new Set(["income", "gain", "unrealizedGain"]);

/** Whether a Xero account of this role could be this account of the book. An unknown role could be
 * any. Income, gains and unrealized gains are one kind of account. A bank account in Xero is a
 * card in the book when it is a liability: Xero keeps credit cards as bank accounts. */
export function compatible(xero: OpeningRole | null, book: OpeningRole, bank = false): boolean {
  if (xero === null || xero === book) return true;
  if (bank && book === "liability") return true;
  return INCOME_LIKE.has(xero) && INCOME_LIKE.has(book);
}

const STOP = new Set(["and", "the", "for", "from", "with", "account", "accounts"]);

function words(name: string): Set<string> {
  return new Set(tokens(name, 12).filter((word) => !STOP.has(word)));
}

/** 0 to 1: how alike two account names are, by the words they share. Equal after normalising is 1;
 * one name's words all inside the other's is 0.8 at most. */
export function similarity(a: string, b: string): number {
  if (normalizeForKey(a) === normalizeForKey(b)) return 1;
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  if (shared === 0) return 0;
  const union = left.size + right.size - shared;
  const jaccard = shared / union;
  const contained = shared === left.size || shared === right.size;
  return contained ? Math.max(jaccard, 0.8) : jaccard;
}

interface Reference {
  readonly name: string;
  readonly role: OpeningRole;
  readonly flow: CashFlowClass | null;
  readonly roleKey: string | null;
}

/** The accounts the chart templates and add-ons define, for suggesting what an unmatched Xero
 * account should become. Names repeat across templates; the first of each is kept. */
const REFERENCES: readonly Reference[] = (() => {
  const seen = new Set<string>();
  const out: Reference[] = [];
  for (const spec of [...TEMPLATES, ...ADD_ONS])
    for (const account of spec.accounts) {
      const key = normalizeForKey(account.name);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name: account.name,
        role: account.role,
        flow: account.flow ?? null,
        roleKey: account.roleKey ?? null,
      });
    }
  return out;
})();

/** What an unmatched Xero account would be in the book: the role its type gives, and when a template
 * account has a close name, that account's cash-flow class and role key (so Stripe and the other
 * lanes find it). Tax lines are not suggested. */
export function suggest(xero: XeroAccount, flow: CashFlowClass | null): Suggestion | null {
  const best = REFERENCES.map((reference) => ({
    reference,
    score: similarity(xero.name, reference.name),
  }))
    .filter((item) => item.score >= 0.8 && compatible(xero.role, item.reference.role))
    .sort((a, b) => b.score - a.score)[0];
  const role = xero.role ?? best?.reference.role ?? null;
  if (role === null) return null;
  return {
    role,
    cashFlowClass: best?.reference.flow ?? flow,
    roleKey: best?.reference.roleKey ?? null,
    like: best?.reference.name ?? null,
  };
}

export interface MatchInput {
  readonly xero: readonly XeroAccount[];
  readonly book: readonly BookAccount[];
  readonly saved: ReadonlyMap<string, Choice>;
  readonly overrides: ReadonlyMap<string, Choice>;
  /** The cash-flow class to suggest for an account with no counterpart; by default the one the
   * templates give that kind of account. */
  readonly flowOf?: (account: XeroAccount) => CashFlowClass | null;
}

interface Scored {
  readonly account: BookAccount;
  readonly score: number;
  readonly basis: MatchBasis;
  readonly confidence: Confidence;
}

const keyOf = (code: string): string => code.trim().toLowerCase();

function scoreOf(xero: XeroAccount, book: BookAccount): Scored | null {
  if (!compatible(xero.role, book.role, xero.bank)) return null;
  const name = similarity(xero.name, book.name);
  const sameCode = keyOf(xero.code) === keyOf(book.code);
  if (name === 1 && sameCode)
    return { account: book, score: 1, basis: "name", confidence: "certain" };
  if (name === 1) return { account: book, score: 0.9, basis: "name", confidence: "likely" };
  if (sameCode && name >= 0.5)
    return { account: book, score: 0.5 + name / 2, basis: "code", confidence: "likely" };
  if (sameCode) return { account: book, score: 0.5, basis: "code", confidence: "check" };
  if (name >= 0.5)
    return { account: book, score: name * 0.8, basis: "similar", confidence: "check" };
  return null;
}

/** One proposal per Xero account, in the file's order. */
export function matchChart(input: MatchInput): Proposal[] {
  const byId = new Map(input.book.map((account) => [account.id, account]));
  const flowOf = input.flowOf ?? ((account: XeroAccount) => xeroType(account.type)?.flow ?? null);
  const results = new Map<string, Proposal>();
  const taken = new Map<string, { code: string; score: number }>();

  const decided = (xero: XeroAccount, choice: Choice, basis: MatchBasis): Proposal => {
    if (choice.skip)
      return {
        xero,
        accountId: null,
        skip: true,
        basis,
        confidence: "certain",
        candidates: [],
        problems: [],
        suggestion: null,
      };
    const target = choice.accountId === null ? undefined : byId.get(choice.accountId);
    const problems: MappingProblem[] = [];
    if (!target) problems.push("target_missing");
    else {
      if (target.closedOn !== null) problems.push("target_closed");
      if (!compatible(xero.role, target.role, xero.bank)) problems.push("role_differs");
    }
    return {
      xero,
      accountId: target?.id ?? null,
      skip: false,
      basis,
      confidence: target ? "certain" : "none",
      candidates: [],
      problems,
      suggestion: null,
    };
  };

  // People's decisions first: they are never displaced by an automatic match.
  for (const xero of input.xero) {
    const choice = input.overrides.get(keyOf(xero.code)) ?? input.saved.get(keyOf(xero.code));
    if (!choice) continue;
    const proposal = decided(
      xero,
      choice,
      input.overrides.has(keyOf(xero.code)) ? "override" : "saved",
    );
    results.set(xero.code, proposal);
    if (proposal.accountId) taken.set(proposal.accountId, { code: xero.code, score: 2 });
  }

  // Then the automatic matches, best first, so a better match is not lost to an earlier row.
  const candidates = input.xero
    .filter((xero) => !results.has(xero.code))
    .map((xero) => ({
      xero,
      scored: input.book
        .map((account) => scoreOf(xero, account))
        .filter((item): item is Scored => item !== null)
        .sort((a, b) => b.score - a.score || (a.account.code < b.account.code ? -1 : 1)),
    }));
  const order = [...candidates].sort(
    (a, b) => (b.scored[0]?.score ?? -1) - (a.scored[0]?.score ?? -1),
  );
  for (const { xero, scored } of order) {
    const alternatives = scored.map((item) => item.account.id);
    const open = scored.find(
      (item) => !taken.has(item.account.id) && item.account.closedOn === null,
    );
    const best = scored[0];
    if (open && open.confidence !== "check") {
      taken.set(open.account.id, { code: xero.code, score: open.score });
      results.set(xero.code, {
        xero,
        accountId: open.account.id,
        skip: false,
        basis: open.basis,
        confidence: open.confidence,
        candidates: alternatives.filter((id) => id !== open.account.id).slice(0, 3),
        problems: [],
        suggestion: null,
      });
      continue;
    }
    // Nothing sure enough to apply: show the best guess as a candidate, and what to create.
    const problems: MappingProblem[] = [];
    if (best && taken.has(best.account.id) && best.confidence !== "check")
      problems.push("target_taken");
    if (xero.role === null) problems.push("unknown_role");
    results.set(xero.code, {
      xero,
      accountId: null,
      skip: false,
      basis: "none",
      confidence: "none",
      candidates: alternatives.slice(0, 3),
      problems,
      suggestion: suggest(xero, flowOf(xero)),
    });
  }
  return input.xero.map((xero) => results.get(xero.code) as Proposal);
}
