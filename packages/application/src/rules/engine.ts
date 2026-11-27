import type { BankLine, IngestItem, Proposal, ProposalContext, Proposer } from "../ingest-types.ts";
import { formatMoney, parseMoney } from "../money.ts";
import { allocate, formatPercent, parsePercent } from "./allocation.ts";
import { type NarrationFields, renderNarration } from "./narration.ts";
import { merchantPhrase, titleCase } from "./normalize.ts";
import { canonicalText, clip, type TextOperator, textMatches } from "./text.ts";
import type {
  ChartAccount,
  RuleCondition,
  RuleConditionGroup,
  RuleDefinition,
  TextField,
} from "./types.ts";

/** The rules engine: pure functions from a stored rule set and a bank line to a decision. No
 * clock, no randomness, no I/O. Hostile text only ever reaches `canonicalText` and string
 * comparison; it is never compiled, evaluated or interpolated into anything but a narration, and
 * then only as stripped, clipped data (see narration.ts). There are no regular expressions. */

/** A bank line prepared once for many rules: canonical texts, exact cents, where it belongs. */
export interface PreparedLine {
  readonly line: BankLine;
  readonly description: string;
  readonly counterparty: string;
  readonly reference: string;
  /** Signed cents, or null when the provider's amount is not a two-decimal amount. */
  readonly cents: bigint | null;
  /** The chart account the line's source maps to, or null while the source is unmapped. */
  readonly accountId: string | null;
}

export function prepareLine(line: BankLine, accountId: string | null): PreparedLine {
  let cents: bigint | null = null;
  try {
    cents = parseMoney(line.amount);
  } catch {
    cents = null;
  }
  return {
    line,
    description: canonicalText(line.description),
    counterparty: canonicalText(line.counterparty ?? ""),
    reference: canonicalText(line.reference ?? ""),
    cents,
    accountId,
  };
}

const abs = (cents: bigint): bigint => (cents < 0n ? -cents : cents);

/** A condition ready to run: its test and its plain-language description. */
interface CompiledCondition {
  readonly valid: boolean;
  readonly test: (line: PreparedLine) => boolean;
  readonly describe: (accountLabel: (id: string) => string) => string;
}

const TEXT_PHRASE: Readonly<Record<TextOperator, string>> = {
  contains: "contains",
  equals: "is exactly",
  startsWith: "starts with",
  endsWith: "ends with",
  wholeWord: "has the whole word",
};
const FIELD_LABEL: Readonly<Record<TextField, string>> = {
  description: "the description",
  counterparty: "the counterparty",
  reference: "the reference",
};

function nonNegative(value: string | undefined): bigint | null {
  if (value === undefined) return null;
  try {
    const cents = parseMoney(value);
    return cents >= 0n ? cents : null;
  } catch {
    return null;
  }
}

/** A condition that cannot be understood never matches, and negating it does not make it match:
 * a corrupt stored rule must not start catching every line. */
const invalid: CompiledCondition = {
  valid: false,
  test: () => false,
  describe: () => "an invalid condition",
};

function compileCondition(condition: RuleCondition): CompiledCondition {
  const shown = clip((condition.value ?? "").trim(), 60);
  const compiled = ((): CompiledCondition => {
    switch (condition.field) {
      case "description":
      case "counterparty":
      case "reference": {
        const operator = condition.operator as TextOperator;
        if (!Object.hasOwn(TEXT_PHRASE, operator)) return invalid;
        const needle = canonicalText(condition.value ?? "");
        if (needle === "") return invalid;
        const field = condition.field;
        return {
          valid: true,
          test: (line) => textMatches(operator, line[field], needle),
          describe: () => `${FIELD_LABEL[field]} ${TEXT_PHRASE[operator]} “${shown}”`,
        };
      }
      case "amount": {
        if (condition.operator === "equals") {
          const exact = nonNegative(condition.value);
          if (exact === null) return invalid;
          return {
            valid: true,
            test: (line) => line.cents !== null && abs(line.cents) === exact,
            describe: () => `the amount is ${formatMoney(exact)}`,
          };
        }
        if (condition.operator !== "range") return invalid;
        const min = nonNegative(condition.min);
        const max = nonNegative(condition.max);
        if (condition.min !== undefined && min === null) return invalid;
        if (condition.max !== undefined && max === null) return invalid;
        if (min === null && max === null) return invalid;
        if (min !== null && max !== null && min > max) return invalid;
        return {
          valid: true,
          test: (line) => {
            if (line.cents === null) return false;
            const size = abs(line.cents);
            return (min === null || size >= min) && (max === null || size <= max);
          },
          describe: () =>
            min !== null && max !== null
              ? `the amount is from ${formatMoney(min)} to ${formatMoney(max)}`
              : min !== null
                ? `the amount is at least ${formatMoney(min)}`
                : `the amount is at most ${formatMoney(max as bigint)}`,
        };
      }
      case "direction": {
        if (condition.operator !== "is") return invalid;
        if (condition.value !== "in" && condition.value !== "out") return invalid;
        const wanted = condition.value;
        return {
          valid: true,
          test: (line) =>
            line.cents !== null && (wanted === "in" ? line.cents > 0n : line.cents < 0n),
          describe: () => (wanted === "in" ? "money comes in" : "money goes out"),
        };
      }
      case "account": {
        if (condition.operator !== "is" || !condition.value) return invalid;
        const wanted = condition.value;
        return {
          valid: true,
          test: (line) => line.accountId === wanted,
          describe: (label) => `the account is ${label(wanted)}`,
        };
      }
      case "provider": {
        if (condition.operator !== "is" || !condition.value) return invalid;
        const wanted = condition.value.trim().toLowerCase();
        return {
          valid: true,
          test: (line) => line.line.provider.toLowerCase() === wanted,
          describe: () => `the source is ${clip(wanted, 40)}`,
        };
      }
      default:
        // Stored or wire data is not trusted to stay within the types.
        return invalid;
    }
  })();
  if (!condition.negate || !compiled.valid) return compiled;
  return {
    valid: true,
    test: (line) => !compiled.test(line),
    describe: (label) => `not (${compiled.describe(label)})`,
  };
}

interface CompiledGroup {
  readonly mode: "all" | "any";
  readonly conditions: readonly CompiledCondition[];
}

function compileGroup(group: RuleConditionGroup): CompiledGroup {
  return { mode: group.mode, conditions: group.conditions.map(compileCondition) };
}

/** A rule ready to run against many lines. */
export interface CompiledRule {
  readonly definition: RuleDefinition;
  /** True when the rule applies to lines on this chart account (an empty scope is every account). */
  inScope(accountId: string | null): boolean;
  /** True when the conditions hold, ignoring scope and whether the rule is enabled. */
  conditionsHold(line: PreparedLine): boolean;
  /** Scope and conditions together; ignores `enabled` (callers decide what disabled means). */
  matches(line: PreparedLine): boolean;
  /** The conditions that held, in words, for the reasons shown beside a proposal. */
  heldConditions(line: PreparedLine, accountLabel?: (id: string) => string): string[];
  /** The conditions that did not hold, in words, to say why a line was not matched. */
  missedConditions(line: PreparedLine, accountLabel?: (id: string) => string): string[];
}

const plainLabel = (id: string): string => id;

export function compileRule(definition: RuleDefinition): CompiledRule {
  const flat = definition.conditions.map(compileCondition);
  const groups = definition.groups.map(compileGroup);
  const scope = new Set(definition.accountIds);
  const groupHolds = (group: CompiledGroup, line: PreparedLine): boolean =>
    group.conditions.length > 0 &&
    (group.mode === "all"
      ? group.conditions.every((item) => item.test(line))
      : group.conditions.some((item) => item.test(line)));
  const hold = (line: PreparedLine): boolean => {
    if (flat.length === 0 && groups.length === 0) return false;
    return definition.match === "all"
      ? flat.every((item) => item.test(line)) && groups.every((group) => groupHolds(group, line))
      : flat.some((item) => item.test(line)) || groups.some((group) => groupHolds(group, line));
  };
  const inScope = (accountId: string | null): boolean =>
    scope.size === 0 || (accountId !== null && scope.has(accountId));
  return {
    definition,
    inScope,
    conditionsHold: hold,
    matches: (line) => inScope(line.accountId) && hold(line),
    heldConditions: (line, accountLabel = plainLabel) => {
      const held: string[] = [];
      for (const item of flat) if (item.test(line)) held.push(item.describe(accountLabel));
      for (const group of groups) {
        const parts = group.conditions.filter((item) => item.test(line));
        if (parts.length > 0)
          held.push(
            parts.length === 1
              ? (parts[0] as CompiledCondition).describe(accountLabel)
              : `${group.mode === "all" ? "all" : "one"} of (${parts.map((item) => item.describe(accountLabel)).join("; ")})`,
          );
      }
      return held;
    },
    missedConditions: (line, accountLabel = plainLabel) => {
      const missed: string[] = [];
      for (const item of flat) if (!item.test(line)) missed.push(item.describe(accountLabel));
      for (const group of groups)
        if (!groupHolds(group, line))
          missed.push(
            `${group.mode === "all" ? "all" : "one"} of (${group.conditions.map((item) => item.describe(accountLabel)).join("; ")})`,
          );
      return missed;
    },
  };
}

export interface RuleIdentity {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
}

/** A stored rule as the proposer holds it: its identity and order, compiled. */
export interface RuleEntry extends CompiledRule, RuleIdentity {}

export function compileEntry(rule: RuleDefinition & RuleIdentity): RuleEntry {
  return { ...compileRule(rule), id: rule.id, name: rule.name, priority: rule.priority };
}

/** The first enabled rule, in the order given (priority order), that matches the line. */
export function firstMatch(entries: readonly RuleEntry[], line: PreparedLine): RuleEntry | null {
  for (const entry of entries) if (entry.definition.enabled && entry.matches(line)) return entry;
  return null;
}

/** What building a proposal from a matched rule came to. */
export type ProposalBuild =
  | { readonly ok: true; readonly proposal: Proposal }
  | { readonly ok: false; readonly reason: string };

const labelOf = (account: ChartAccount): string => `${account.code} ${account.name}`;

/** The fields a narration template can use, taken from the line as received. */
export function narrationFields(line: PreparedLine): NarrationFields {
  const source = line.line;
  const merchant = merchantPhrase(source.counterparty || source.description).phrase;
  return {
    description: source.description,
    counterparty: source.counterparty ?? "",
    merchant: titleCase(merchant),
    reference: source.reference ?? "",
    date: source.postedOn,
    amount: line.cents === null ? "" : formatMoney(abs(line.cents)),
  };
}

/** The Inbox shows at most eight reasons of 300 characters per proposal; a longer one is cut here
 * rather than refused there. */
export const REASON_LIMIT = 300;
export const REASON_COUNT = 8;

export function tidyReasons(reasons: readonly string[]): string[] {
  return reasons.slice(0, REASON_COUNT).map((reason) => clip(reason, REASON_LIMIT));
}

/** Turn a matched rule into the full, balanced proposal for a line: the bank leg and the legs the
 * action calls for. Refuses, with a reason, when the action cannot be applied exactly: a target
 * account that is missing or closed, a split that does not add up, a zero amount. */
export function buildProposal(
  entry: RuleEntry,
  line: PreparedLine,
  chart: ReadonlyMap<string, ChartAccount>,
): ProposalBuild {
  const action = entry.definition.action;
  if (line.accountId === null)
    return { ok: false, reason: "The line's source is not mapped to an account yet" };
  const bankId = line.accountId;
  const label = (id: string): string => {
    const account = chart.get(id);
    return account ? labelOf(account) : id;
  };
  const held = entry.heldConditions(line, label);
  const because = `Rule “${clip(entry.name, 60)}” (priority ${entry.priority}) matched: ${held.join("; ") || "its conditions"}`;
  if (action.kind === "exclude")
    return {
      ok: true,
      proposal: {
        proposer: `rule:${entry.id}`,
        kind: "exclude",
        confidence: 1,
        reasons: tidyReasons([
          because,
          action.reason
            ? `Excluded: ${clip(action.reason, 200)}`
            : "The rule marks this line as not a business transaction",
        ]),
      },
    };
  if (line.cents === null || line.cents === 0n)
    return { ok: false, reason: "The line has no usable amount" };
  const cents = line.cents;
  const size = abs(cents);
  const target = (id: string | undefined): ChartAccount | string => {
    if (!id) return "The rule names no account";
    const account = chart.get(id);
    if (!account) return "The rule's account is not in the chart";
    if (account.closedOn !== null) return `${labelOf(account)} is closed`;
    if (account.id === bankId) return "The rule's account is the account the line is on";
    return account;
  };
  const parts: { readonly account: ChartAccount; readonly cents: bigint }[] = [];
  const reasons = [because];
  if (action.kind === "categorize" || action.kind === "transfer") {
    const account = target(action.accountId);
    if (typeof account === "string") return { ok: false, reason: account };
    if (action.kind === "transfer" && account.role !== "asset" && account.role !== "liability")
      return {
        ok: false,
        reason: `${labelOf(account)} is not an asset or liability account, so it cannot take a transfer`,
      };
    parts.push({ account, cents: size });
    reasons.push(
      action.kind === "transfer"
        ? `Treated as a transfer with ${labelOf(account)}`
        : `Booked to ${labelOf(account)}`,
    );
  } else {
    const specs = action.allocations ?? [];
    const result = allocate(size, specs);
    if (!result.ok) return { ok: false, reason: result.reason };
    for (const part of result.parts) {
      const account = target(part.accountId);
      if (typeof account === "string") return { ok: false, reason: account };
      parts.push({ account, cents: part.cents });
    }
    reasons.push(
      `Split ${formatMoney(size)}: ${parts.map((part) => `${labelOf(part.account)} ${formatMoney(part.cents)}`).join(", ")}`,
    );
    const shares = specs.flatMap((spec) =>
      spec.percent === undefined ? [] : [formatPercent(parsePercent(spec.percent) ?? 0n)],
    );
    if (shares.length > 0) reasons.push(`Percentages of what remains: ${shares.join(", ")}`);
  }
  const legs = [
    { accountId: bankId, amount: formatMoney(cents) },
    ...parts.map((part) => ({
      accountId: part.account.id,
      amount: formatMoney(cents > 0n ? -part.cents : part.cents),
    })),
  ];
  const narration = action.narration
    ? renderNarration(action.narration, narrationFields(line))
    : "";
  return {
    ok: true,
    proposal: {
      proposer: `rule:${entry.id}`,
      kind: action.kind === "transfer" ? "transfer" : "categorize",
      confidence: 1,
      reasons: tidyReasons(reasons),
      legs,
      ...(narration ? { narration } : {}),
    },
  };
}

/** The proposer for a snapshot of the rule set. Build it once per proposing run; `rules` must be
 * in priority order. The first enabled rule that matches decides. If its action cannot be applied
 * exactly (its account closed since, a split that no longer adds up) it proposes nothing, rather
 * than letting a lower rule decide in its place; the rules list flags such a rule. */
export function createRulesProposer(rules: readonly (RuleDefinition & RuleIdentity)[]): Proposer {
  const entries = rules.map(compileEntry);
  const charts = new WeakMap<ProposalContext, Map<string, ChartAccount>>();
  const chartOf = (context: ProposalContext): Map<string, ChartAccount> => {
    let chart = charts.get(context);
    if (!chart) {
      chart = new Map(context.accounts.map((account) => [account.id, account]));
      charts.set(context, chart);
    }
    return chart;
  };
  return {
    name: "rules",
    propose(item: IngestItem, context: ProposalContext): readonly Proposal[] {
      if (item.line.kind !== "bankLine") return [];
      if (item.status !== "new" && item.status !== "proposed") return [];
      if (item.ledgerAccountId === null) return [];
      const line = prepareLine(item.line, item.ledgerAccountId);
      const entry = firstMatch(entries, line);
      if (!entry) return [];
      const built = buildProposal(entry, line, chartOf(context));
      return built.ok ? [built.proposal] : [];
    },
  };
}
