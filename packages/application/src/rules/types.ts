import type { AllocationSpec } from "./allocation.ts";
import type { TextOperator } from "./text.ts";

/** The vocabulary of a rule. Plain data, JSON-safe, no dates as objects, no floats: this is the
 * shape stored in product state and carried over the wire (see slices/rules/schema.ts). */

export const TEXT_FIELDS = ["description", "counterparty", "reference"] as const;
export type TextField = (typeof TEXT_FIELDS)[number];
export const CONDITION_FIELDS = [
  ...TEXT_FIELDS,
  "amount",
  "direction",
  "account",
  "provider",
] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];

export const TEXT_OPERATORS = [
  "contains",
  "equals",
  "startsWith",
  "endsWith",
  "wholeWord",
] as const satisfies readonly TextOperator[];
export const CONDITION_OPERATORS = [...TEXT_OPERATORS, "range", "is"] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** One test on one field of a bank line.
 *
 * - Text fields (description, counterparty, reference): contains, equals, startsWith, endsWith or
 *   wholeWord, with `value`. Compared in canonical form (see text.ts), so case, accents,
 *   punctuation and spacing never matter, for every operator alike.
 * - amount: `equals` with `value` ("12.00"), or `range` with `min` and/or `max`, both inclusive.
 *   The amount compared is the absolute amount in exact cents; use a direction condition for the
 *   sign. Never rounded, never a tolerance.
 * - direction: `is` with `value` "in" (money into the account) or "out".
 * - account: `is` with `value` the chart account id the line belongs to.
 * - provider: `is` with `value` the source kind ("csv", "ofx", "qfx", "simplefin", "bank", "stripe").
 *
 * `negate` makes the condition true exactly when it would otherwise be false. A line without a
 * counterparty or reference has empty text there, so "counterparty does not contain X" holds. */
export interface RuleCondition {
  readonly field: ConditionField;
  readonly operator: ConditionOperator;
  readonly value?: string;
  readonly min?: string;
  readonly max?: string;
  readonly negate?: boolean;
}

/** A nested set of conditions: every one ("all") or at least one ("any") must hold. */
export interface RuleConditionGroup {
  readonly mode: "all" | "any";
  readonly conditions: readonly RuleCondition[];
}

export const ACTION_KINDS = ["categorize", "split", "transfer", "exclude"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** What a matching rule proposes. It only ever suggests; nothing posts without a person (or an
 * agent with the right grant) turning it into a draft and going through prepare and commit.
 *
 * - categorize: book the line against `accountId`.
 * - split: book it across `allocations`, exact to the cent (see allocation.ts).
 * - transfer: the line moves money to or from `accountId`, one of your own asset or liability
 *   accounts (a credit card payment, a transfer to savings).
 * - exclude: not a business transaction; leave it out of the books, with `reason` recorded.
 *
 * `narration` is an optional template for the journal narration (see narration.ts). */
export interface RuleAction {
  readonly kind: ActionKind;
  readonly accountId?: string;
  readonly allocations?: readonly AllocationSpec[];
  readonly narration?: string;
  readonly reason?: string;
}

/** The part of a rule a person or an agent writes. `conditions` and `groups` are joined by `match`:
 * with "all" every condition and every group must hold, with "any" at least one of them must. A
 * rule applies to the chart accounts in `accountIds`, or to every account when that is empty. */
export interface RuleDefinition {
  readonly name: string;
  readonly enabled: boolean;
  readonly accountIds: readonly string[];
  readonly match: "all" | "any";
  readonly conditions: readonly RuleCondition[];
  readonly groups: readonly RuleConditionGroup[];
  readonly action: RuleAction;
  readonly note?: string;
}

/** Who made a rule: a person at the keyboard, or an agent. Self-declared by the caller until
 * scoped tokens identify agents; the record is provenance for a reviewer, not an access control. */
export interface RuleAuthor {
  readonly kind: "person" | "agent";
  readonly name?: string;
}

/** A stored rule. `priority` is its position among the active rules, 1 first; the first enabled
 * rule that matches a line decides. */
export interface Rule extends RuleDefinition {
  readonly id: string;
  readonly priority: number;
  readonly revision: number;
  readonly createdBy: RuleAuthor;
  readonly createdAt: string;
  readonly updatedBy: RuleAuthor;
  readonly updatedAt: string;
}

export interface RuleProblem {
  /** Where, as a path into the definition: "conditions[0].value", "action.accountId". */
  readonly path: string;
  readonly message: string;
}

/** The chart as rules see it. */
export interface ChartAccount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly role: string;
  readonly closedOn: string | null;
}

export const MAX_CONDITIONS = 20;
export const MAX_GROUPS = 10;
export const MAX_SCOPE_ACCOUNTS = 50;
export const MAX_RULE_NAME = 120;
export const MAX_NOTE = 500;
export const MAX_VALUE = 200;
