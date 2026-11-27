import type { BankLine, IngestItem, ProposalContext } from "../../src/ingest-types.ts";
import type {
  RuleAction,
  RuleCondition,
  RuleDefinition,
  RuleConditionGroup,
} from "../../src/rules/types.ts";

/** Small builders and a fixed chart for the rules tests. Nothing here is a real merchant's data. */

/** A deterministic pseudo-random generator (mulberry32): the same seed always gives the same run. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const CHECKING = "checking";
export const SAVINGS = "savings";
export const CARD = "card";
export const REVENUE = "revenue";
export const SOFTWARE = "software";
export const HOSTING = "hosting";
export const MEALS = "meals";
export const TRAVEL = "travel";
export const FEES = "fees";
export const DRAW = "draw";
export const OLD = "old";

export const context: ProposalContext = {
  accounts: [
    { id: CHECKING, code: "1010", name: "Checking", role: "asset", closedOn: null },
    { id: SAVINGS, code: "1020", name: "Savings", role: "asset", closedOn: null },
    { id: CARD, code: "2100", name: "Credit card", role: "liability", closedOn: null },
    { id: DRAW, code: "3100", name: "Owner draw", role: "equity", closedOn: null },
    { id: REVENUE, code: "4000", name: "Revenue", role: "income", closedOn: null },
    { id: SOFTWARE, code: "6100", name: "Software", role: "expense", closedOn: null },
    { id: HOSTING, code: "6200", name: "Hosting", role: "expense", closedOn: null },
    { id: MEALS, code: "6300", name: "Meals", role: "expense", closedOn: null },
    { id: TRAVEL, code: "6400", name: "Travel", role: "expense", closedOn: null },
    { id: FEES, code: "6600", name: "Bank fees", role: "expense", closedOn: null },
    { id: OLD, code: "6900", name: "Old software", role: "expense", closedOn: "2026-01-01" },
  ],
};

export function bankLine(partial: Partial<BankLine> = {}): BankLine {
  return {
    kind: "bankLine",
    provider: "csv",
    accountKey: "csv:checking",
    rawIndex: 0,
    postedOn: "2026-03-04",
    amount: "-42.17",
    currency: "USD",
    description: "GITHUB, INC. SAN FRANCISCO CA",
    ...partial,
  };
}

export function item(line: BankLine, partial: Partial<IngestItem> = {}): IngestItem {
  return {
    id: "item-1",
    line,
    batchId: "batch-1",
    status: "new",
    ledgerAccountId: CHECKING,
    ...partial,
  };
}

export const rule = (partial: Partial<RuleDefinition> = {}): RuleDefinition => ({
  name: "Rule",
  enabled: true,
  accountIds: [],
  match: "all",
  conditions: [{ field: "description", operator: "contains", value: "github" }],
  groups: [],
  action: { kind: "categorize", accountId: SOFTWARE },
  ...partial,
});

export const contains = (value: string, field: RuleCondition["field"] = "description") =>
  ({ field, operator: "contains", value }) satisfies RuleCondition;

export const group = (
  mode: RuleConditionGroup["mode"],
  ...conditions: RuleCondition[]
): RuleConditionGroup => ({ mode, conditions });

export const categorize = (accountId: string): RuleAction => ({ kind: "categorize", accountId });
