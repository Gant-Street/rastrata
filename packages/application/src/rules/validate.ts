import { parseMoney } from "../money.ts";
import { checkAllocations } from "./allocation.ts";
import { narrationProblem } from "./narration.ts";
import { canonicalText } from "./text.ts";
import {
  type ChartAccount,
  CONDITION_FIELDS,
  type ConditionField,
  MAX_CONDITIONS,
  MAX_GROUPS,
  MAX_NOTE,
  MAX_RULE_NAME,
  MAX_SCOPE_ACCOUNTS,
  MAX_VALUE,
  type RuleCondition,
  type RuleDefinition,
  type RuleProblem,
  TEXT_FIELDS,
  TEXT_OPERATORS,
} from "./types.ts";

/** Everything wrong with a rule definition that can be known from the chart, in words a person can
 * act on. The wire schema has already checked shapes and lengths; this checks meaning: that an
 * operator suits its field, that every value can be understood, that accounts exist and are open,
 * and that a split adds up. An empty list means the rule is usable today. */

const PROVIDER_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789_-";

function isProvider(value: string): boolean {
  if (value.length === 0 || value.length > 40) return false;
  for (const char of value.toLowerCase()) if (!PROVIDER_CHARS.includes(char)) return false;
  return true;
}

function money(value: string | undefined): bigint | null {
  if (value === undefined) return null;
  try {
    return parseMoney(value);
  } catch {
    return null;
  }
}

function checkCondition(
  condition: RuleCondition,
  path: string,
  chart: ReadonlyMap<string, ChartAccount>,
  out: RuleProblem[],
): void {
  const problem = (suffix: string, message: string) =>
    out.push({ path: suffix ? `${path}.${suffix}` : path, message });
  if (!(CONDITION_FIELDS as readonly string[]).includes(condition.field)) {
    problem(
      "field",
      "Choose what to test: description, counterparty, reference, amount, direction, account or provider",
    );
    return;
  }
  const field: ConditionField = condition.field;
  if ((TEXT_FIELDS as readonly string[]).includes(field)) {
    if (!(TEXT_OPERATORS as readonly string[]).includes(condition.operator))
      problem(
        "operator",
        "Text can be tested with contains, equals, starts with, ends with or whole word",
      );
    if (condition.value === undefined || canonicalText(condition.value) === "")
      problem(
        "value",
        "Enter some text with at least one letter or digit; punctuation alone matches nothing",
      );
    else if (condition.value.length > MAX_VALUE)
      problem("value", `Keep the text to ${MAX_VALUE} characters`);
    if (condition.min !== undefined || condition.max !== undefined)
      problem("min", "A text condition has no amount range");
    return;
  }
  if (field === "amount") {
    if (condition.operator === "equals") {
      const cents = money(condition.value);
      if (cents === null || cents < 0n)
        problem("value", "Enter the amount with two decimals, for example 12.00");
      if (condition.min !== undefined || condition.max !== undefined)
        problem("min", "An exact amount has no range");
    } else if (condition.operator === "range") {
      const min = money(condition.min);
      const max = money(condition.max);
      if (condition.min === undefined && condition.max === undefined)
        problem("min", "Enter a smallest amount, a largest amount, or both");
      if (condition.min !== undefined && (min === null || min < 0n))
        problem("min", "Enter the smallest amount with two decimals, for example 10.00");
      if (condition.max !== undefined && (max === null || max < 0n))
        problem("max", "Enter the largest amount with two decimals, for example 99.99");
      if (min !== null && max !== null && min > max)
        problem("max", "The largest amount is below the smallest");
      if (condition.value !== undefined)
        problem("value", "A range uses a smallest and a largest amount");
    } else problem("operator", "An amount can be exactly equal to a value or within a range");
    return;
  }
  if (condition.operator !== "is") problem("operator", `Use “is” to test the ${field}`);
  if (field === "direction") {
    if (condition.value !== "in" && condition.value !== "out")
      problem("value", "Direction is “in” (money into the account) or “out”");
  } else if (field === "account") {
    if (!condition.value || !chart.has(condition.value))
      problem("value", "Choose an account from the chart");
  } else if (!condition.value || !isProvider(condition.value))
    problem("value", "Name the source: csv, ofx, qfx, simplefin, bank or stripe");
}

/** Check a definition against the chart as it is today. `chart` maps account id to account. */
export function validateRule(
  rule: RuleDefinition,
  chart: ReadonlyMap<string, ChartAccount>,
): RuleProblem[] {
  const out: RuleProblem[] = [];
  const add = (path: string, message: string) => out.push({ path, message });
  if (rule.name.trim() === "") add("name", "Give the rule a name");
  if (rule.name.length > MAX_RULE_NAME) add("name", `Keep the name to ${MAX_RULE_NAME} characters`);
  if (rule.note !== undefined && rule.note.length > MAX_NOTE)
    add("note", `Keep the note to ${MAX_NOTE} characters`);
  if (rule.conditions.length === 0 && rule.groups.length === 0)
    add("conditions", "Add at least one condition; a rule with none would match every line");
  if (rule.conditions.length > MAX_CONDITIONS)
    add("conditions", `Use at most ${MAX_CONDITIONS} conditions; put related ones in a group`);
  if (rule.groups.length > MAX_GROUPS) add("groups", `Use at most ${MAX_GROUPS} groups`);
  for (const [index, condition] of rule.conditions.entries())
    checkCondition(condition, `conditions[${index}]`, chart, out);
  for (const [index, group] of rule.groups.entries()) {
    if (group.conditions.length === 0)
      add(`groups[${index}]`, "A group needs at least one condition");
    if (group.conditions.length > MAX_CONDITIONS)
      add(`groups[${index}]`, `Use at most ${MAX_CONDITIONS} conditions in a group`);
    for (const [at, condition] of group.conditions.entries())
      checkCondition(condition, `groups[${index}].conditions[${at}]`, chart, out);
  }
  if (rule.accountIds.length > MAX_SCOPE_ACCOUNTS)
    add(
      "accountIds",
      `Limit a rule to at most ${MAX_SCOPE_ACCOUNTS} accounts, or leave it for all`,
    );
  if (new Set(rule.accountIds).size !== rule.accountIds.length)
    add("accountIds", "An account is listed twice");
  for (const [index, id] of rule.accountIds.entries())
    if (!chart.has(id)) add(`accountIds[${index}]`, "That account is not in the chart");
  const action = rule.action;
  const open = (id: string | undefined, path: string, role?: readonly string[]): void => {
    const account = id ? chart.get(id) : undefined;
    if (!id) add(path, "Choose an account");
    else if (!account) add(path, "That account is not in the chart");
    else if (account.closedOn !== null) add(path, `${account.code} ${account.name} is closed`);
    else {
      if (role && !role.includes(account.role))
        add(path, `${account.code} ${account.name} is not an ${role.join(" or ")} account`);
      if (rule.accountIds.includes(account.id))
        add(path, "A rule cannot book a line to the account the line is on");
    }
  };
  switch (action.kind) {
    case "categorize":
      open(action.accountId, "action.accountId");
      if (action.allocations !== undefined)
        add("action.allocations", "Only a split has allocations");
      break;
    case "transfer":
      open(action.accountId, "action.accountId", ["asset", "liability"]);
      if (action.allocations !== undefined)
        add("action.allocations", "Only a split has allocations");
      break;
    case "split": {
      const specs = action.allocations ?? [];
      for (const message of new Set(checkAllocations(specs))) add("action.allocations", message);
      for (const [index, spec] of specs.entries())
        open(spec.accountId, `action.allocations[${index}].accountId`);
      if (action.accountId !== undefined)
        add("action.accountId", "A split names its accounts in its allocations");
      break;
    }
    case "exclude":
      if (action.accountId !== undefined)
        add("action.accountId", "An excluded line has no account");
      if (action.allocations !== undefined)
        add("action.allocations", "Only a split has allocations");
      if (action.narration !== undefined)
        add("action.narration", "An excluded line has no journal, so no narration");
      break;
    default:
      add("action.kind", "Choose categorize, split, transfer or exclude");
  }
  if (action.narration !== undefined) {
    const message = narrationProblem(action.narration);
    if (message) add("action.narration", message);
  }
  if (action.reason !== undefined && action.kind !== "exclude")
    add("action.reason", "Only an exclusion records a reason");
  return out;
}

/** The problems a stored rule has today because the chart moved on (an account closed, a split
 * that no longer adds up), for the rules list. Same checks as writing, so a rule that could not be
 * saved now is flagged. */
export function ruleHealth(
  rule: RuleDefinition,
  chart: ReadonlyMap<string, ChartAccount>,
): RuleProblem[] {
  return validateRule(rule, chart);
}
