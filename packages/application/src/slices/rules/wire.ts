import { type ApplicationAccess, describePrincipal } from "../../agent/principal.ts";
import { ApplicationError } from "../../errors.ts";
import { formatPercent, parsePercent } from "../../rules/allocation.ts";
import { clip, plainText } from "../../rules/text.ts";
import type {
  ChartAccount,
  RuleAction,
  RuleAuthor,
  RuleCondition,
  RuleConditionGroup,
  RuleDefinition,
  RuleProblem,
} from "../../rules/types.ts";
import { validateRule } from "../../rules/validate.ts";
import { definitionJson, type RevisionRow, type StoredRule } from "./store.ts";

/** Between the wire (already validated against the schema: shapes, lengths, enums) and the engine's
 * definitions: defaults filled in, text trimmed, and records built for responses. Nothing here
 * invents a value; it only makes the optional explicit. */

export interface RuleInputWire {
  readonly name: string;
  readonly enabled?: boolean;
  readonly accountIds?: readonly string[];
  readonly match?: "all" | "any";
  readonly conditions?: readonly RuleCondition[];
  readonly groups?: readonly RuleConditionGroup[];
  readonly action: RuleAction;
  readonly note?: string;
}

function cleanCondition(condition: RuleCondition): RuleCondition {
  const value = condition.value?.trim();
  return {
    field: condition.field,
    operator: condition.operator,
    ...(value !== undefined ? { value } : {}),
    ...(condition.min !== undefined ? { min: condition.min } : {}),
    ...(condition.max !== undefined ? { max: condition.max } : {}),
    ...(condition.negate === true ? { negate: true } : {}),
  };
}

function cleanAction(action: RuleAction): RuleAction {
  const narration = action.narration?.trim();
  const reason = action.reason?.trim();
  return {
    kind: action.kind,
    ...(action.accountId !== undefined ? { accountId: action.accountId } : {}),
    ...(action.allocations !== undefined
      ? {
          allocations: action.allocations.map((part) => {
            const basis = part.percent !== undefined ? parsePercent(part.percent) : null;
            return {
              accountId: part.accountId,
              ...(part.percent !== undefined
                ? { percent: basis === null ? part.percent : formatPercent(basis) }
                : {}),
              ...(part.amount !== undefined ? { amount: part.amount } : {}),
              ...(part.rest === true ? { rest: true } : {}),
            };
          }),
        }
      : {}),
    ...(narration ? { narration } : {}),
    ...(reason ? { reason } : {}),
  };
}

export function toDefinition(wire: RuleInputWire): RuleDefinition {
  const note = wire.note?.trim();
  return {
    name: wire.name.trim(),
    enabled: wire.enabled ?? true,
    accountIds: wire.accountIds ?? [],
    match: wire.match ?? "all",
    conditions: (wire.conditions ?? []).map(cleanCondition),
    groups: (wire.groups ?? []).map((group) => ({
      mode: group.mode,
      conditions: group.conditions.map(cleanCondition),
    })),
    action: cleanAction(wire.action),
    ...(note ? { note } : {}),
  };
}

/** A definition in the wire's input shape, with every field present. */
export function toInput(definition: RuleDefinition): Record<string, unknown> {
  return JSON.parse(definitionJson(definition)) as Record<string, unknown>;
}

export function cleanAuthor(author: RuleAuthor): RuleAuthor {
  const name = plainText(author.name ?? "").trim();
  return { kind: author.kind, ...(name ? { name: clip(name, 80) } : {}) };
}

/** Who made a change, as the runtime decided and not as the request says.
 *
 * - A scoped agent token is an agent, always. Its record names the token (the owner's label for
 *   it and its public id), so a reviewer can find that token's activity and revoke it. Whatever
 *   `madeBy` the request carries is ignored: an agent cannot present itself as a person, and a
 *   token cannot present itself as another one.
 * - The owner (the web, the CLI, or an agent running through the owner's own access) is a person
 *   unless it says otherwise. That declaration is a self-reported note for a reviewer: with the
 *   owner's own access there is nothing to check it against. */
export function resolveAuthor(access: ApplicationAccess, declared?: RuleAuthor): RuleAuthor {
  const principal = access.principal;
  if (principal?.kind === "token")
    return {
      kind: "agent",
      name: `${clip(principal.label, 50)} (${describePrincipal(principal)})`,
    };
  return cleanAuthor(declared ?? { kind: "person" });
}

/** Which parts of the definition differ, for the revision history. */
export function changedFields(before: RuleDefinition, after: RuleDefinition): string[] {
  const a = JSON.parse(definitionJson(before)) as Record<string, unknown>;
  const b = JSON.parse(definitionJson(after)) as Record<string, unknown>;
  const fields = [
    "name",
    "enabled",
    "accountIds",
    "match",
    "conditions",
    "groups",
    "action",
    "note",
  ];
  return fields.filter((field) => JSON.stringify(a[field]) !== JSON.stringify(b[field]));
}

/** The 400 a person or agent gets for a rule that cannot be saved: every problem, with its path
 * into the request (`input.rule.conditions[0].value`). */
export function invalidRule(
  problems: readonly RuleProblem[],
  base = "input.rule",
): ApplicationError {
  const first = problems[0];
  return new ApplicationError(
    "rule_invalid",
    problems.length === 1 && first
      ? `The rule cannot be saved: ${first.message}`
      : `The rule cannot be saved: ${problems.length} problems, starting with “${first?.message ?? ""}”`,
    400,
    problems.map((problem) => ({ path: `${base}.${problem.path}`, message: problem.message })),
  );
}

/** Check a definition against the chart, throwing `invalidRule` when it is not usable today. */
export function assertUsable(
  definition: RuleDefinition,
  chart: ReadonlyMap<string, ChartAccount>,
): void {
  const problems = validateRule(definition, chart);
  if (problems.length > 0) throw invalidRule(problems);
}

export function toRecord(
  rule: StoredRule,
  chart: ReadonlyMap<string, ChartAccount>,
): Record<string, unknown> {
  const definition = JSON.parse(definitionJson(rule)) as Record<string, unknown>;
  return {
    id: rule.id,
    status: rule.status,
    priority: rule.priority,
    revision: rule.revision,
    ...definition,
    createdBy: rule.createdBy,
    createdAt: rule.createdAt,
    updatedBy: rule.updatedBy,
    updatedAt: rule.updatedAt,
    problems: rule.status === "active" ? validateRule(rule, chart) : [],
  };
}

export function toRevision(row: RevisionRow): Record<string, unknown> {
  return {
    revision: row.revision,
    madeBy: row.madeBy,
    madeAt: row.madeAt,
    changed: [...row.changed],
    ...(row.note ? { note: row.note } : {}),
  };
}
