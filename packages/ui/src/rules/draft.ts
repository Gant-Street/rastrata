import type {
  RuleConditionAt,
  RuleActionDraft,
  RuleActionKind,
  RuleConditionDraft,
  RuleDraft,
  RuleFieldName,
  RuleGroupDraft,
  RulePartDraft,
} from "./types";

/** The editor's draft and the small pure steps that change it. Every step returns a new draft and
 * leaves the old one alone, so the form can hand them to a signal and a test can replay them.
 *
 * What a person chooses in the "how" list is `op`: an operator, optionally prefixed "not:" (for
 * "does not contain"). The request splits that into an operator and a `negate` flag; that happens
 * where the draft becomes a request, not here. */

let counter = 0;
/** A fresh identity for a row of the form. */
export function draftKey(): string {
  counter += 1;
  return `k${counter}`;
}

export const RULE_FIELDS: readonly RuleFieldName[] = [
  "description",
  "counterparty",
  "reference",
  "amount",
  "direction",
  "account",
  "provider",
];

const TEXT_FIELDS: readonly RuleFieldName[] = ["description", "counterparty", "reference"];
const TEXT_OPS = [
  "contains",
  "not:contains",
  "equals",
  "not:equals",
  "startsWith",
  "not:startsWith",
  "endsWith",
  "not:endsWith",
  "wholeWord",
  "not:wholeWord",
] as const;
const AMOUNT_OPS = [
  "between",
  "not:between",
  "atLeast",
  "not:atLeast",
  "atMost",
  "not:atMost",
  "exactly",
  "not:exactly",
] as const;
const IS_OPS = ["is", "not:is"] as const;

export const PROVIDERS: readonly string[] = ["csv", "ofx", "qfx", "simplefin", "bank", "stripe"];

export const isTextField = (field: RuleFieldName): boolean => TEXT_FIELDS.includes(field);

/** The operators that suit a field, in the order the list shows them. */
export function opsFor(field: RuleFieldName): readonly string[] {
  if (isTextField(field)) return TEXT_OPS;
  return field === "amount" ? AMOUNT_OPS : IS_OPS;
}

export const defaultOp = (field: RuleFieldName): string =>
  isTextField(field) ? "contains" : field === "amount" ? "between" : "is";

/** "not:contains" is the operator "contains", negated. */
export const splitOp = (op: string): { operator: string; negate: boolean } =>
  op.startsWith("not:")
    ? { operator: op.slice("not:".length), negate: true }
    : { operator: op, negate: false };

/** Which boxes an amount test shows: an exact amount, a smallest, a largest, or both. */
export function amountBoxes(op: string): readonly ("value" | "min" | "max")[] {
  switch (splitOp(op).operator) {
    case "exactly":
      return ["value"];
    case "atLeast":
      return ["min"];
    case "atMost":
      return ["max"];
    default:
      return ["min", "max"];
  }
}

export function blankCondition(field: RuleFieldName = "description"): RuleConditionDraft {
  return { key: draftKey(), field, op: defaultOp(field), value: "", min: "", max: "" };
}

/** Changing what is tested starts the condition over: the old operator and values mean nothing
 * for a different field. */
export function withField(condition: RuleConditionDraft, field: RuleFieldName): RuleConditionDraft {
  return condition.field === field ? condition : { ...blankCondition(field), key: condition.key };
}

/** Changing how a text or amount is compared keeps what was typed where it still applies. */
export function withOp(condition: RuleConditionDraft, op: string): RuleConditionDraft {
  return { ...condition, op };
}

export const blankGroup = (): RuleGroupDraft => ({
  key: draftKey(),
  mode: "any",
  conditions: [blankCondition()],
});

export function blankPart(kind: RulePartDraft["kind"] = "percent"): RulePartDraft {
  return { key: draftKey(), accountId: "", kind, value: "" };
}

export function blankAction(kind: RuleActionKind = "categorize"): RuleActionDraft {
  return {
    kind,
    accountId: "",
    parts: kind === "split" ? [blankPart("percent"), blankPart("rest")] : [],
    narration: "",
    reason: "",
  };
}

export function blankDraft(): RuleDraft {
  return {
    name: "",
    note: "",
    enabled: true,
    scope: "all",
    accountIds: [],
    match: "all",
    conditions: [blankCondition()],
    groups: [],
    action: blankAction(),
  };
}

/** Choosing a different kind of action keeps what still applies (the narration, an account for a
 * book or a transfer) and drops what does not. */
export function withActionKind(action: RuleActionDraft, kind: RuleActionKind): RuleActionDraft {
  if (action.kind === kind) return action;
  const keepsAccount = kind === "categorize" || kind === "transfer";
  return {
    kind,
    accountId: keepsAccount ? action.accountId : "",
    parts:
      kind === "split"
        ? action.parts.length >= 2
          ? action.parts
          : [blankPart("percent"), blankPart("rest")]
        : [],
    narration: kind === "exclude" ? "" : action.narration,
    reason: kind === "exclude" ? action.reason : "",
  };
}

function replaceAt<T>(items: readonly T[], index: number, next: (item: T) => T): T[] {
  return items.map((item, at) => (at === index ? next(item) : item));
}

const without = <T>(items: readonly T[], index: number): T[] =>
  items.filter((_, at) => at !== index);

export function updateCondition(
  draft: RuleDraft,
  at: RuleConditionAt,
  next: (condition: RuleConditionDraft) => RuleConditionDraft,
): RuleDraft {
  if (at.group === null)
    return { ...draft, conditions: replaceAt(draft.conditions, at.index, next) };
  return {
    ...draft,
    groups: replaceAt(draft.groups, at.group, (group) => ({
      ...group,
      conditions: replaceAt(group.conditions, at.index, next),
    })),
  };
}

export function addCondition(draft: RuleDraft, group: number | null): RuleDraft {
  if (group === null) return { ...draft, conditions: [...draft.conditions, blankCondition()] };
  return {
    ...draft,
    groups: replaceAt(draft.groups, group, (item) => ({
      ...item,
      conditions: [...item.conditions, blankCondition()],
    })),
  };
}

export function removeCondition(draft: RuleDraft, at: RuleConditionAt): RuleDraft {
  if (at.group === null) return { ...draft, conditions: without(draft.conditions, at.index) };
  return {
    ...draft,
    groups: replaceAt(draft.groups, at.group, (group) => ({
      ...group,
      conditions: without(group.conditions, at.index),
    })),
  };
}

export const addGroup = (draft: RuleDraft): RuleDraft => ({
  ...draft,
  groups: [...draft.groups, blankGroup()],
});

export const removeGroup = (draft: RuleDraft, index: number): RuleDraft => ({
  ...draft,
  groups: without(draft.groups, index),
});

export const setGroupMode = (draft: RuleDraft, index: number, mode: "all" | "any"): RuleDraft => ({
  ...draft,
  groups: replaceAt(draft.groups, index, (group) => ({ ...group, mode })),
});

export const updatePart = (
  draft: RuleDraft,
  index: number,
  next: (part: RulePartDraft) => RulePartDraft,
): RuleDraft => ({
  ...draft,
  action: { ...draft.action, parts: replaceAt(draft.action.parts, index, next) },
});

/** Only one part of a split can take the rest, so choosing it for one part moves any other part
 * that had it to a percentage. */
export function setPartKind(
  draft: RuleDraft,
  index: number,
  kind: RulePartDraft["kind"],
): RuleDraft {
  const parts = draft.action.parts.map((part, at) => {
    if (at === index) return { ...part, kind, value: kind === "rest" ? "" : part.value };
    return kind === "rest" && part.kind === "rest" ? { ...part, kind: "percent" as const } : part;
  });
  return { ...draft, action: { ...draft.action, parts } };
}

export const addPart = (draft: RuleDraft): RuleDraft => ({
  ...draft,
  action: { ...draft.action, parts: [...draft.action.parts, blankPart("percent")] },
});

export const removePart = (draft: RuleDraft, index: number): RuleDraft => ({
  ...draft,
  action: { ...draft.action, parts: without(draft.action.parts, index) },
});

export function setScopeAccount(draft: RuleDraft, accountId: string, on: boolean): RuleDraft {
  const others = draft.accountIds.filter((id) => id !== accountId);
  return { ...draft, accountIds: on ? [...others, accountId] : others };
}

/** The id of the control a problem is about, so an error summary can move focus to it. `path` is
 * where the problem sits in the rule: "conditions[0].value", "action.accountId". */
export function fieldId(path: string): string {
  let out = "rule-";
  let dash = false;
  for (const char of path) {
    const word =
      (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || (char >= "0" && char <= "9");
    if (word) {
      out += char;
      dash = false;
    } else if (!dash) {
      out += "-";
      dash = true;
    }
  }
  return out.endsWith("-") ? out.slice(0, -1) : out;
}

/** The path of a condition's part: "conditions[1].value" or "groups[0].conditions[2].min". */
export const conditionPath = (at: RuleConditionAt, part: string): string =>
  at.group === null
    ? `conditions[${at.index}].${part}`
    : `groups[${at.group}].conditions[${at.index}].${part}`;
