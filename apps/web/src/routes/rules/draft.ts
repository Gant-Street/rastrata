import type {
  ClassifierRatio,
  ClassifierStatus,
  RuleAction as WireAction,
  RuleCondition as WireCondition,
  RuleInput,
  RuleRecord,
  RuleRevision,
  RuleTestLineResult,
  RuleTestResult,
  RuleTestSample,
  RuleTestSection,
  RuleUsage,
} from "@rastrata/application/client-contracts";
import { formatMoney, parseMoney } from "@rastrata/application/money";
import { formatDate, formatInstant, formatMoney as showMoney } from "@rastrata/ui/format";
import {
  allocate,
  type AllocationSpec,
  type RuleDefinition,
  type RuleProblem,
  validateRule,
} from "@rastrata/application/rules-browser";
import {
  type ClassifierRatioView,
  type ClassifierView,
  type RuleActionDraft,
  type RuleConditionDraft,
  type RuleDraft,
  type RuleFormError,
  type RulePartDraft,
  type RulePreviewData,
  type RuleRevisionRow,
  type RuleRow,
  type RuleSampleLeg,
  type RuleSampleRow,
  type RuleSection,
  type RuleSplitPreview,
  type RuleTryResult,
  draftKey,
  fieldId,
  splitOp,
  words,
} from "@rastrata/ui/rules-logic";
import type { ChartView } from "./chart.ts";

/** Everything between what the editor holds (a draft: strings as typed, rows with identities) and
 * what the service speaks (a rule: exact fields), and between what the service answers and what the
 * components show. It is plain functions over plain data, so it is tested without a browser.
 *
 * The same `validateRule` the service runs checks the draft here, so the editor says at once what
 * the service would say. The service still checks every write. */

const TEXT_FIELDS: readonly string[] = ["description", "counterparty", "reference"];

// ---- A draft becomes a rule ---------------------------------------------------------------------

function conditionOf(draft: RuleConditionDraft): WireCondition {
  const { operator, negate } = splitOp(draft.op);
  const base = { field: draft.field, ...(negate ? { negate: true } : {}) };
  if (TEXT_FIELDS.includes(draft.field))
    return { ...base, operator: operator as WireCondition["operator"], value: draft.value };
  if (draft.field === "amount") {
    // An empty box is sent empty, so the check says which box needs an amount, rather than the
    // condition quietly turning into a different test.
    switch (operator) {
      case "exactly":
        return { ...base, operator: "equals", value: draft.value.trim() };
      case "atLeast":
        return { ...base, operator: "range", min: draft.min.trim() };
      case "atMost":
        return { ...base, operator: "range", max: draft.max.trim() };
      default:
        return { ...base, operator: "range", min: draft.min.trim(), max: draft.max.trim() };
    }
  }
  return { ...base, operator: "is", value: draft.value };
}

function actionOf(draft: RuleActionDraft): WireAction {
  const narration = draft.narration.trim() === "" ? {} : { narration: draft.narration };
  switch (draft.kind) {
    case "categorize":
    case "transfer":
      // No account chosen yet is no account, not an empty one: the service refuses an empty id
      // before it can say "choose an account".
      return {
        kind: draft.kind,
        ...(draft.accountId ? { accountId: draft.accountId } : {}),
        ...narration,
      };
    case "split":
      return {
        kind: "split",
        allocations: draft.parts.map((part) => {
          const value = part.value.trim();
          return part.kind === "percent"
            ? { accountId: part.accountId, percent: value }
            : part.kind === "amount"
              ? { accountId: part.accountId, amount: value }
              : { accountId: part.accountId, rest: true };
        }),
        ...narration,
      };
    default: {
      const reason = draft.reason.trim();
      return { kind: "exclude", ...(reason ? { reason } : {}) };
    }
  }
}

/** The rule a draft describes, with every default filled in. It is what is validated, and what is
 * sent. */
export function ruleOf(draft: RuleDraft, name = draft.name.trim()): RuleDefinition {
  const note = draft.note.trim();
  return {
    name,
    enabled: draft.enabled,
    accountIds: draft.scope === "some" ? [...draft.accountIds] : [],
    match: draft.match,
    conditions: draft.conditions.map(conditionOf),
    groups: draft.groups.map((group) => ({
      mode: group.mode,
      conditions: group.conditions.map(conditionOf),
    })),
    action: actionOf(draft.action),
    ...(note ? { note } : {}),
  };
}

/** The request for a draft. A rule being checked before it has a name is checked under a
 * placeholder, since the name has nothing to do with what a rule matches. */
export const inputOf = (draft: RuleDraft, name?: string): RuleInput => ruleOf(draft, name);

// ---- A rule becomes a draft -----------------------------------------------------------------------

function conditionDraftOf(condition: WireCondition): RuleConditionDraft {
  const prefix = condition.negate ? "not:" : "";
  const base = { key: draftKey(), field: condition.field, value: "", min: "", max: "" };
  if (TEXT_FIELDS.includes(condition.field))
    return { ...base, op: `${prefix}${condition.operator}`, value: condition.value ?? "" };
  if (condition.field === "amount") {
    if (condition.operator === "equals")
      return { ...base, op: `${prefix}exactly`, value: condition.value ?? "" };
    const op =
      condition.min !== undefined && condition.max === undefined
        ? "atLeast"
        : condition.max !== undefined && condition.min === undefined
          ? "atMost"
          : "between";
    return { ...base, op: `${prefix}${op}`, min: condition.min ?? "", max: condition.max ?? "" };
  }
  return { ...base, op: `${prefix}is`, value: condition.value ?? "" };
}

function actionDraftOf(action: WireAction): RuleActionDraft {
  const parts: RulePartDraft[] = (action.allocations ?? []).map((allocation) => ({
    key: draftKey(),
    accountId: allocation.accountId,
    kind: allocation.rest ? "rest" : allocation.percent !== undefined ? "percent" : "amount",
    value: allocation.rest ? "" : (allocation.percent ?? allocation.amount ?? ""),
  }));
  return {
    kind: action.kind,
    accountId: action.accountId ?? "",
    parts,
    narration: action.narration ?? "",
    reason: action.reason ?? "",
  };
}

/** The draft for a rule: a stored one being edited, or one a suggestion offers. */
export function draftOf(rule: RuleInput): RuleDraft {
  const accountIds = [...(rule.accountIds ?? [])];
  return {
    name: rule.name,
    note: rule.note ?? "",
    enabled: rule.enabled ?? true,
    scope: accountIds.length > 0 ? "some" : "all",
    accountIds,
    match: rule.match ?? "all",
    conditions: (rule.conditions ?? []).map(conditionDraftOf),
    groups: (rule.groups ?? []).map((group) => ({
      key: draftKey(),
      mode: group.mode,
      conditions: group.conditions.map(conditionDraftOf),
    })),
    action: actionDraftOf(rule.action),
  };
}

/** A stored rule as a request, field for field, with only what is asked changed. Switching a rule
 * on or off must not rewrite the rest of it, or a no-op would look like a change in its history. */
export function inputFromRecord(rule: RuleRecord, change: { enabled?: boolean } = {}): RuleInput {
  return {
    name: rule.name,
    enabled: change.enabled ?? rule.enabled,
    accountIds: rule.accountIds,
    match: rule.match,
    conditions: rule.conditions,
    groups: rule.groups,
    action: rule.action,
    ...(rule.note !== undefined ? { note: rule.note } : {}),
  };
}

// ---- Problems ---------------------------------------------------------------------------------------

export const problemsOf = (draft: RuleDraft, chart: ChartView): RuleProblem[] =>
  validateRule(ruleOf(draft), chart.validation);

const STRUCTURAL = ["conditions", "groups", "accountIds"];

/** A problem with what the rule matches, as opposed to what it does. The live check waits for
 * these to be fixed; the rest do not stop it from counting matches. */
export const isStructural = (problem: RuleProblem): boolean =>
  STRUCTURAL.some(
    (part) =>
      problem.path === part ||
      problem.path.startsWith(`${part}[`) ||
      problem.path.startsWith(`${part}.`),
  );

/** The control a problem is shown at. Some problems are about a part of the form that has no
 * control of its own for each item. */
function anchor(path: string): string {
  if (path.startsWith("accountIds")) return "accountIds";
  if (path === "groups") return "conditions";
  return path;
}

export function errorsOf(problems: readonly RuleProblem[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const problem of problems) {
    const at = anchor(problem.path);
    out[at] = out[at] ? `${out[at]}; ${problem.message}` : problem.message;
  }
  return out;
}

export const summaryOf = (problems: readonly RuleProblem[]): RuleFormError[] =>
  problems.map((problem) => ({
    id: fieldId(anchor(problem.path)),
    message: problem.message,
  }));

// ---- The list ------------------------------------------------------------------------------------------

export function describeAction(action: WireAction, chart: ChartView): string {
  switch (action.kind) {
    case "categorize":
      return action.accountId
        ? words.doesBook(chart.label(action.accountId))
        : words.doesNothingYet;
    case "transfer":
      return action.accountId
        ? words.doesTransfer(chart.label(action.accountId))
        : words.doesNothingYet;
    case "split":
      return words.doesSplit(action.allocations?.length ?? 0);
    default:
      return words.doesExclude;
  }
}

/** When a rule applies, in words: `Description contains “GITHUB” and Amount is at least 10.00`. A group is in
 * brackets, and a rule with no condition applies to every transaction. Typed text is shown as it was typed. */
export function describeWhen(rule: RuleRecord, chart: ChartView): string {
  const draft = draftOf(inputFromRecord(rule));
  const joiner = (mode: "all" | "any") => ` ${mode === "all" ? words.whenAnd : words.whenOr} `;
  const clause = (condition: RuleConditionDraft): string => {
    const field = words.fieldNames[condition.field];
    if (TEXT_FIELDS.includes(condition.field))
      return `${field} ${words.textOps[condition.op] ?? condition.op} “${condition.value}”`;
    if (condition.field === "amount") {
      const op = words.amountOps[condition.op] ?? condition.op;
      const amount = (value: string) => showMoney(value);
      switch (splitOp(condition.op).operator) {
        case "exactly":
          return `${field} ${op} ${amount(condition.value)}`;
        case "atLeast":
          return `${field} ${op} ${amount(condition.min)}`;
        case "atMost":
          return `${field} ${op} ${amount(condition.max)}`;
        default:
          return `${field} ${op} ${amount(condition.min)} ${words.whenAnd} ${amount(condition.max)}`;
      }
    }
    const negated = splitOp(condition.op).negate;
    if (condition.field === "direction") {
      const phrase = condition.value === "in" ? words.directionIn : words.directionOut;
      return negated
        ? `${words.fieldNames.direction} ${words.isOps["not:is"]} ${phrase.toLowerCase()}`
        : phrase;
    }
    const value =
      condition.field === "account"
        ? chart.label(condition.value)
        : (words.providers[condition.value] ?? condition.value);
    return `${field} ${words.isOps[condition.op] ?? condition.op} ${value}`;
  };
  const parts = [
    ...draft.conditions.map(clause),
    ...draft.groups.map((group) => {
      const inner = group.conditions.map(clause).join(joiner(group.mode));
      return group.conditions.length > 1 ? `(${inner})` : inner;
    }),
  ].filter((part) => part !== "");
  return parts.length > 0 ? parts.join(joiner(draft.match)) : words.whenAlways;
}

function scopeOf(accountIds: readonly string[], chart: ChartView): string {
  const [only] = accountIds;
  if (only === undefined) return words.scopeAll;
  return accountIds.length === 1 ? chart.label(only) : words.scopeSomeAccounts(accountIds.length);
}

export function rowOf(rule: RuleRecord, chart: ChartView, usage?: RuleUsage): RuleRow {
  return {
    id: rule.id,
    href: `/rules/${encodeURIComponent(rule.id)}`,
    name: rule.name,
    when: describeWhen(rule, chart),
    does: describeAction(rule.action, chart),
    scope: scopeOf(rule.accountIds, chart),
    ...(rule.accountIds.length > 0 ? { scopeNote: scopeOf(rule.accountIds, chart) } : {}),
    enabled: rule.enabled,
    note: rule.note,
    usage: usage
      ? {
          matched: usage.matched,
          decided: usage.decided,
          overridden: usage.shadowed,
          lastMatchedOn: usage.lastMatchedOn,
        }
      : null,
    madeBy: { kind: rule.createdBy.kind, name: rule.createdBy.name },
    changedOn: formatDate(rule.updatedAt),
    problems: rule.problems.map((problem) => problem.message),
  };
}

/** "2026-10-04T07:50:12.000Z" as "Oct 4, 2026, 7:50 AM" on the viewer's clock. */
export const stamp = formatInstant;

export function revisionsOf(history: readonly RuleRevision[]): RuleRevisionRow[] {
  return [...history]
    .sort((left, right) => right.revision - left.revision)
    .map((revision) => ({
      revision: revision.revision,
      by: { kind: revision.madeBy.kind, name: revision.madeBy.name },
      at: stamp(revision.madeAt),
      changed: revision.changed,
      note: revision.note,
    }));
}

// ---- Splits ------------------------------------------------------------------------------------------------

/** The exact parts a split makes of an example amount, by the engine's own arithmetic. */
export function splitPreview(
  draft: RuleDraft,
  example: string,
  chart: ChartView,
): RuleSplitPreview | null {
  if (draft.action.kind !== "split") return null;
  let total: bigint;
  try {
    total = parseMoney(example.trim());
  } catch {
    return { problem: words.splitExampleInvalid };
  }
  if (total <= 0n) return { problem: words.splitExampleInvalid };
  // Parts without an account yet still need to be told apart, or the split would be refused for
  // naming the same account twice.
  const specs: AllocationSpec[] = draft.action.parts.map((part, index) => {
    const accountId = part.accountId || `part-${index + 1}`;
    const value = part.value.trim();
    return part.kind === "percent"
      ? { accountId, percent: value }
      : part.kind === "amount"
        ? { accountId, amount: value }
        : { accountId, rest: true };
  });
  const result = allocate(total, specs);
  if (!result.ok) return { problem: result.reason };
  const nameOf = (id: string) =>
    id.startsWith("part-") && !draft.action.parts.some((part) => part.accountId === id)
      ? words.splitPartDefault(Number(id.slice("part-".length)))
      : chart.label(id);
  return {
    total: formatMoney(total),
    parts: result.parts.map((part) => ({
      account: nameOf(part.accountId),
      amount: formatMoney(part.cents),
    })),
  };
}

// ---- The live check ------------------------------------------------------------------------------------------

const unsigned = (amount: string) => (amount.startsWith("-") ? amount.slice(1) : amount);

/** The suggested entry without the line's own bank side, as a person reads it: where the money is
 * booked to, and how much. */
function legsOf(
  legs: readonly { accountId: string; amount: string }[] | undefined,
  bankAccountId: string | undefined,
  chart: ChartView,
): RuleSampleLeg[] {
  return (legs ?? [])
    .filter((leg) => leg.accountId !== bankAccountId)
    .map((leg) => ({ account: chart.label(leg.accountId), amount: unsigned(leg.amount) }));
}

function sampleOf(sample: RuleTestSample, index: number, chart: ChartView): RuleSampleRow {
  return {
    key: sample.itemId ?? `${sample.date}-${index}`,
    date: sample.date,
    description: sample.description,
    counterparty: sample.counterparty,
    amount: sample.amount,
    outcome: sample.outcome,
    detail:
      sample.outcome === "shadowed" && sample.shadowedBy
        ? words.shadowedBy(sample.shadowedBy)
        : sample.outcome === "unusable"
          ? sample.reason
          : undefined,
    wouldBook: legsOf(sample.legs, sample.accountId, chart),
    // Named the way the rest of the screen names accounts when the service says which account it
    // was, and as the service words it (a split, say) when it does not.
    bookedTo: sample.bookedAccountId ? chart.label(sample.bookedAccountId) : sample.bookedTo,
    // The service decides whether a posted line agrees with the rule; the screen only shows it.
    differs: sample.agrees === false,
    narration: sample.narration,
  };
}

function sectionOf(section: RuleTestSection, chart: ChartView): RuleSection {
  return {
    considered: section.considered,
    matched: section.matched,
    applies: section.applies,
    shadowed: section.shadowed,
    unusable: section.unusable,
    truncated: section.truncated,
    samples: section.samples.map((sample, index) => sampleOf(sample, index, chart)),
  };
}

export function previewOf(result: RuleTestResult, chart: ChartView): RulePreviewData {
  return {
    days: result.days,
    position: result.position,
    inbox: sectionOf(result.inbox, chart),
    history: sectionOf(result.history, chart),
    agreement: result.agreement,
    notes: result.notes,
  };
}

/** The narration the rule would give the first line it applies to. */
export function firstNarration(preview: RulePreviewData | null | undefined): string | undefined {
  for (const section of [preview?.inbox, preview?.history])
    for (const sample of section?.samples ?? [])
      if (sample.outcome === "applies" && sample.narration) return sample.narration;
  return undefined;
}

export function tryOf(line: RuleTestLineResult, chart: ChartView): RuleTryResult {
  return {
    outcome: line.outcome,
    detail:
      line.outcome === "shadowed"
        ? line.shadowedBy
        : line.outcome === "unusable"
          ? line.reason
          : undefined,
    held: line.held,
    missed: line.missed,
    wouldBook: legsOf(line.legs, line.accountId, chart),
    narration: line.narration,
    kind: line.kind ? words.tryKinds[line.kind] : undefined,
  };
}

// ---- The classifier ------------------------------------------------------------------------------------------

const ratioOf = (ratio: ClassifierRatio): ClassifierRatioView => ({
  numerator: ratio.numerator,
  denominator: ratio.denominator,
  basisPoints: ratio.basisPoints,
});

export function classifierOf(status: ClassifierStatus, chart: ChartView): ClassifierView {
  const evaluation = status.evaluation;
  return {
    ready: status.ready,
    config: { ...status.config },
    examples: status.examples,
    accounts: status.accounts,
    posted: status.sources.posted,
    decisions: status.sources.decisions,
    trainedAt: status.trainedAt ? stamp(status.trainedAt) : null,
    heldBack: status.heldBack,
    notes: status.notes,
    evaluation: evaluation
      ? {
          scored: evaluation.scored,
          proposed: evaluation.proposed,
          correct: evaluation.correct,
          precision: ratioOf(evaluation.precision),
          recall: ratioOf(evaluation.recall),
          coverage: ratioOf(evaluation.coverage),
          thresholds: evaluation.thresholds.map((row) => ({
            minConfidence: row.minConfidence,
            proposed: row.proposed,
            correct: row.correct,
            precision: ratioOf(row.precision),
            recall: ratioOf(row.recall),
          })),
          accounts: evaluation.accounts.map((row) => ({
            account: chart.label(row.accountId),
            scored: row.scored,
            proposed: row.proposed,
            correct: row.correct,
            precision: ratioOf(row.precision),
            recall: ratioOf(row.recall),
          })),
          confusions: evaluation.confusions.map((row) => ({
            actual: chart.label(row.actual),
            predicted: chart.label(row.predicted),
            count: row.count,
          })),
        }
      : null,
  };
}
