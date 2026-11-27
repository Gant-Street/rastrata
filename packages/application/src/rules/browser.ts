/** What the browser may use of the rules lane: the same pure functions the service runs, so the
 * editor can say at once what the service would say (a split that does not add up, a narration
 * with a field that does not exist, a condition with nothing to compare) and show the exact cents
 * of a split. The service still validates every write; this is the same code, not a second opinion.
 *
 * Only portable modules are exported here: no database, no ledger, no clock, no I/O. The web app's
 * dependency boundary names exactly these files. */
export {
  type AllocationPart,
  type AllocationResult,
  type AllocationSpec,
  allocate,
  checkAllocations,
  formatPercent,
  parsePercent,
} from "./allocation.ts";
export {
  NARRATION_PLACEHOLDERS,
  NARRATION_TEMPLATE_LIMIT,
  type NarrationFields,
  type NarrationPlaceholder,
  narrationProblem,
  renderNarration,
} from "./narration.ts";
export { canonicalText } from "./text.ts";
export {
  type ActionKind,
  ACTION_KINDS,
  type ChartAccount,
  CONDITION_FIELDS,
  type ConditionField,
  type ConditionOperator,
  MAX_CONDITIONS,
  MAX_GROUPS,
  MAX_NOTE,
  MAX_RULE_NAME,
  MAX_SCOPE_ACCOUNTS,
  MAX_VALUE,
  type RuleAction,
  type RuleCondition,
  type RuleConditionGroup,
  type RuleDefinition,
  type RuleProblem,
  TEXT_FIELDS,
  TEXT_OPERATORS,
} from "./types.ts";
export { validateRule } from "./validate.ts";
