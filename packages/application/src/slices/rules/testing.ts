import type { BankLine, Proposal } from "../../ingest-types.ts";
import { formatMoney } from "../../money.ts";
import {
  buildProposal,
  compileEntry,
  firstMatch,
  type PreparedLine,
  prepareLine,
  type RuleEntry,
} from "../../rules/engine.ts";
import { asBankLine, type PostedLine } from "../../rules/history.ts";
import { clip } from "../../rules/text.ts";
import type { ChartAccount, RuleDefinition } from "../../rules/types.ts";
import type { InboxView } from "./inbox.ts";
import type { StoredRule } from "./store.ts";

/** Dry-running a rule: the same engine that proposes, pointed at the open inbox and at posted
 * history, counting what a rule would do without doing it. "Matches 14 of your last 90 days" is
 * `history.matched` out of `history.considered`.
 *
 * A line that a rule matches can still not be decided by it, and the test says why:
 * - shadowed: an earlier rule matches too and, being earlier, decides instead;
 * - unusable: this rule decides, but its action cannot be carried out on that line (an account
 *   closed since, a split that does not add up).
 * Counts add up: matched = applies + shadowed + unusable. */

export interface TestSample {
  itemId?: string;
  date: string;
  description: string;
  counterparty?: string;
  amount: string;
  accountId?: string;
  outcome: "applies" | "shadowed" | "unusable";
  shadowedBy?: string;
  reason?: string;
  bookedTo?: string;
  /** History, when the line was booked to one account: which, and whether the rule would book it
   * there too. Absent when the rule or the booking is not comparable (a split, a transfer). */
  bookedAccountId?: string;
  agrees?: boolean;
  /** For "applies": the entry the rule would propose, bank side included. */
  legs?: { accountId: string; amount: string }[];
  narration?: string;
}

export interface TestSection {
  considered: number;
  matched: number;
  applies: number;
  shadowed: number;
  unusable: number;
  truncated: boolean;
  samples: TestSample[];
}

export interface TestOutput {
  position: number;
  inbox: TestSection;
  history: TestSection;
  agreement: { agreed: number; differed: number; notComparable: number };
  notes: string[];
}

export interface TestArgs {
  readonly candidate: RuleDefinition;
  readonly candidateId: string | null;
  /** 1-based place of the candidate among the active rules. */
  readonly position: number;
  /** The active rules other than the candidate, in priority order. */
  readonly others: readonly StoredRule[];
  readonly chart: ReadonlyMap<string, ChartAccount>;
  readonly currency: string;
  /** Posted history already limited to the window. */
  readonly history: readonly PostedLine[];
  readonly inbox: InboxView;
  readonly samples: number;
  /** False while the action is unfinished (no account chosen yet): the test then counts what the
   * conditions match and does not try to carry the action out. */
  readonly actionComplete: boolean;
}

function validDate(value: string): boolean {
  if (value.length !== 10 || value[4] !== "-" || value[7] !== "-") return false;
  for (const [index, char] of [...value].entries())
    if (index !== 4 && index !== 7 && (char < "0" || char > "9")) return false;
  return true;
}

export const emptySection = (): TestSection => ({
  considered: 0,
  matched: 0,
  applies: 0,
  shadowed: 0,
  unusable: 0,
  truncated: false,
  samples: [],
});

interface Source {
  readonly line: BankLine;
  readonly accountId: string | null;
  readonly itemId?: string;
  readonly bookedTo?: string;
  readonly bookedAccountId?: string;
}

export function runRuleTest(args: TestArgs): TestOutput {
  const label = (id: string): string => {
    const account = args.chart.get(id);
    return account ? `${account.code} ${account.name}` : id;
  };
  const candidate: RuleEntry = compileEntry({
    ...args.candidate,
    id: args.candidateId ?? "candidate",
    priority: args.position,
  });
  const before = args.others.slice(0, Math.max(0, args.position - 1)).map(compileEntry);
  const notes: string[] = [];
  const agreement = { agreed: 0, differed: 0, notComparable: 0 };
  let unreadable = 0;

  const scan = (sources: readonly Source[], history: boolean): TestSection => {
    const section = emptySection();
    // Newest first, so the samples are the lines a person most recently saw.
    const ordered = [...sources].sort((a, b) =>
      a.line.postedOn < b.line.postedOn ? 1 : a.line.postedOn > b.line.postedOn ? -1 : 0,
    );
    for (const source of ordered) {
      const line: PreparedLine = prepareLine(source.line, source.accountId);
      if (line.cents === null || !validDate(source.line.postedOn)) {
        unreadable++;
        continue;
      }
      section.considered++;
      if (!candidate.matches(line)) continue;
      section.matched++;
      const earlier = firstMatch(before, line);
      let outcome: TestSample["outcome"] = "applies";
      let reason: string | undefined;
      let proposed: Proposal | undefined;
      let agrees: boolean | undefined;
      if (earlier) {
        outcome = "shadowed";
        section.shadowed++;
      } else {
        const built = !args.actionComplete
          ? ({ ok: true } as const)
          : line.accountId
            ? buildProposal(candidate, line, args.chart)
            : ({ ok: false, reason: "The line's source is not mapped to an account yet" } as const);
        if (built.ok) {
          if ("proposal" in built) proposed = built.proposal;
          section.applies++;
          if (history) {
            const action = args.candidate.action;
            if (
              action.kind === "categorize" &&
              action.accountId !== undefined &&
              source.bookedAccountId !== undefined
            )
              if (source.bookedAccountId === action.accountId) {
                agreement.agreed++;
                agrees = true;
              } else {
                agreement.differed++;
                agrees = false;
              }
            else agreement.notComparable++;
          }
        } else {
          outcome = "unusable";
          reason = built.reason;
          section.unusable++;
          if (history) agreement.notComparable++;
        }
      }
      if (section.samples.length < args.samples) {
        const counterparty = source.line.counterparty;
        section.samples.push({
          ...(source.itemId !== undefined ? { itemId: source.itemId } : {}),
          date: source.line.postedOn,
          description: clip(source.line.description, 300),
          ...(counterparty ? { counterparty: clip(counterparty, 300) } : {}),
          amount: formatMoney(line.cents),
          ...(source.accountId ? { accountId: source.accountId } : {}),
          outcome,
          ...(earlier ? { shadowedBy: clip(earlier.name, 120) } : {}),
          ...(reason ? { reason: clip(reason, 300) } : {}),
          ...(source.bookedTo !== undefined ? { bookedTo: clip(source.bookedTo, 200) } : {}),
          ...(source.bookedAccountId !== undefined
            ? { bookedAccountId: source.bookedAccountId }
            : {}),
          ...(agrees !== undefined ? { agrees } : {}),
          ...(proposed?.legs ? { legs: proposed.legs.map((leg) => ({ ...leg })) } : {}),
          ...(proposed?.narration ? { narration: proposed.narration } : {}),
        });
      }
    }
    return section;
  };

  const inbox = args.inbox.available
    ? scan(
        args.inbox.items.flatMap((item): Source[] =>
          item.line.kind === "bankLine"
            ? [{ line: item.line, accountId: item.ledgerAccountId, itemId: item.id }]
            : [],
        ),
        false,
      )
    : emptySection();
  inbox.truncated = args.inbox.truncated;
  if (!args.inbox.available)
    notes.push("The Inbox could not be read, so the counts below are posted history only.");
  else if (args.inbox.truncated)
    notes.push("The Inbox has more lines than one test reads; the counts cover the first ones.");
  else if (inbox.considered === 0)
    notes.push("Nothing is waiting in the Inbox, so the counts below are posted history only.");
  const history = scan(
    args.history.map(
      (line): Source => ({
        line: asBankLine(line, args.currency),
        accountId: line.bankAccountId,
        bookedTo: label(line.categoryId),
        ...(line.split ? {} : { bookedAccountId: line.categoryId }),
      }),
    ),
    true,
  );
  if (!args.actionComplete)
    notes.push(
      "The rule's action is not finished (see the problems above), so the counts show what its conditions match.",
    );
  if (unreadable > 0)
    notes.push(
      `${unreadable} line${unreadable === 1 ? " has" : "s have"} an unreadable date or amount and ${unreadable === 1 ? "was" : "were"} skipped.`,
    );
  if (history.considered === 0)
    notes.push(
      "No posted history falls in this window, so there is nothing to compare the rule with.",
    );
  return { position: args.position, inbox, history, agreement, notes };
}

/** A line typed or pasted in, with the account it is on already decided. */
export interface TypedLine {
  readonly description: string;
  readonly counterparty?: string;
  readonly reference?: string;
  readonly amount: string;
  readonly accountId: string;
  readonly provider: string;
}

export interface LineResult {
  index: number;
  accountId: string;
  outcome: "applies" | "shadowed" | "unusable" | "no_match";
  reason?: string;
  held: string[];
  missed: string[];
  shadowedBy?: string;
  kind?: "categorize" | "transfer" | "exclude";
  legs?: { accountId: string; amount: string }[];
  narration?: string;
}

/** Try a rule on lines a person typed, and say why each did or did not match. The same engine as
 * every other test and as the proposer: a line that "applies" here is a line the Inbox would
 * propose for. The text is compared and never evaluated. */
export function checkTypedLines(
  args: Pick<
    TestArgs,
    "candidate" | "candidateId" | "position" | "others" | "chart" | "actionComplete"
  >,
  lines: readonly TypedLine[],
): LineResult[] {
  const label = (id: string): string => {
    const account = args.chart.get(id);
    return account ? `${account.code} ${account.name}` : id;
  };
  const candidate = compileEntry({
    ...args.candidate,
    id: args.candidateId ?? "candidate",
    priority: args.position,
  });
  const before = args.others.slice(0, Math.max(0, args.position - 1)).map(compileEntry);
  return lines.map((typed, index): LineResult => {
    const line = prepareLine(
      {
        kind: "bankLine",
        provider: typed.provider,
        accountKey: `typed:${typed.accountId}`,
        rawIndex: index,
        postedOn: "1970-01-01",
        amount: typed.amount,
        currency: "USD",
        description: typed.description,
        ...(typed.counterparty ? { counterparty: typed.counterparty } : {}),
        ...(typed.reference ? { reference: typed.reference } : {}),
      },
      typed.accountId,
    );
    const base = { index, accountId: typed.accountId };
    if (!candidate.inScope(typed.accountId)) {
      const scoped = args.candidate.accountIds.map(label).join(", ");
      return {
        ...base,
        outcome: "no_match",
        held: [],
        missed: [`the line is on ${label(typed.accountId)}; this rule applies only to ${scoped}`],
      };
    }
    if (!candidate.conditionsHold(line))
      return {
        ...base,
        outcome: "no_match",
        held: [],
        missed: candidate.missedConditions(line, label).slice(0, 20),
      };
    const held = candidate.heldConditions(line, label).slice(0, 20);
    const earlier = firstMatch(before, line);
    if (earlier)
      return {
        ...base,
        outcome: "shadowed",
        held,
        missed: [],
        shadowedBy: clip(earlier.name, 120),
      };
    if (!args.actionComplete) return { ...base, outcome: "applies", held, missed: [] };
    const built = buildProposal(candidate, line, args.chart);
    if (!built.ok)
      return { ...base, outcome: "unusable", held, missed: [], reason: clip(built.reason, 500) };
    const proposal = built.proposal;
    return {
      ...base,
      outcome: "applies",
      held,
      missed: [],
      ...(proposal.kind === "categorize" ||
      proposal.kind === "transfer" ||
      proposal.kind === "exclude"
        ? { kind: proposal.kind }
        : {}),
      ...(proposal.legs ? { legs: proposal.legs.map((leg) => ({ ...leg })) } : {}),
      ...(proposal.narration ? { narration: proposal.narration } : {}),
    };
  });
}
