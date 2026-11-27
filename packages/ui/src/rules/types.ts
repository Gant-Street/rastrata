/** Display contracts for the rules components. Amounts and percentages are exact decimal strings
 * supplied by the application and typed by a person; the components show them and never calculate
 * with them. Rule names, notes, bank descriptions, counterparties and account names are untrusted
 * text: they are shown as text only, never as markup. */

export type RuleFieldName =
  | "description"
  | "counterparty"
  | "reference"
  | "amount"
  | "direction"
  | "account"
  | "provider";

/** One test on one field, as a person edits it. `op` is the choice in the "how" list: an operator,
 * optionally prefixed "not:" (see draft.ts for the lists). Which of `value`, `min` and `max` are
 * used depends on the field and the operator. */
export type RuleConditionDraft = {
  /** Identifies the row while editing. Never sent. */
  key: string;
  field: RuleFieldName;
  op: string;
  value: string;
  min: string;
  max: string;
};

export type RuleGroupDraft = {
  key: string;
  mode: "all" | "any";
  conditions: RuleConditionDraft[];
};

/** One part of a split: an account, and what it takes. */
export type RulePartDraft = {
  key: string;
  accountId: string;
  kind: "percent" | "amount" | "rest";
  /** The percentage ("60") or the amount ("12.00"); empty for the part that takes the rest. */
  value: string;
};

export type RuleActionKind = "categorize" | "split" | "transfer" | "exclude";

export type RuleActionDraft = {
  kind: RuleActionKind;
  /** The account to book to (categorize) or the other account of a transfer. */
  accountId: string;
  parts: RulePartDraft[];
  narration: string;
  /** Why a line is left out of the books (exclude). */
  reason: string;
};

/** A rule as the editor holds it, before it is turned into the request. */
export type RuleDraft = {
  name: string;
  note: string;
  enabled: boolean;
  scope: "all" | "some";
  accountIds: string[];
  match: "all" | "any";
  conditions: RuleConditionDraft[];
  groups: RuleGroupDraft[];
  action: RuleActionDraft;
};

/** A problem for the error summary: the id of the control it is about, and what is wrong. */
export type RuleFormError = { id: string; message: string };

/** Where a condition sits: at the top of the rule (`group` is null) or inside a group. */
export type RuleConditionAt = { group: number | null; index: number };

export type RuleOption = {
  value: string;
  label: string;
  disabled?: boolean;
  /** Options with the same group are listed together under its name. */
  group?: string;
};

/** What a split would do to an amount typed as an example: the exact parts, or why it cannot. */
export type RuleSplitPreview =
  | { problem: string }
  | { total: string; parts: readonly { account: string; amount: string }[] };

/** What the rule list shows about one rule. `does` and `scope` are already in words. */
export type RuleRow = {
  id: string;
  href: string;
  name: string;
  /** When the rule applies, in words: `Description contains “GITHUB”`. */
  when: string;
  /** What the rule suggests, for example "Software". */
  does: string;
  /** "Every account" or "2 accounts". */
  scope: string;
  /** Where the rule is limited to some accounts: "Checking" or "2 accounts". Left out for every account. */
  scopeNote?: string | undefined;
  enabled: boolean;
  note?: string | undefined;
  /** Null until measured, or when the measure failed. */
  usage: {
    matched: number;
    decided: number;
    overridden: number;
    lastMatchedOn: string | null;
  } | null;
  madeBy: { kind: "person" | "agent"; name?: string | undefined };
  /** YYYY-MM-DD. */
  changedOn: string;
  /** What is wrong with the rule today, in words. Empty means it can be applied. */
  problems: readonly string[];
};

export type RulesFigureData = {
  rules: number;
  enabled: number;
  attention: number;
  /** Null when the lines could not be measured. */
  window: null | {
    days: number;
    inbox: number;
    history: number;
    considered: number;
    decided: number;
  };
  notes: readonly string[];
};

/** Whether a read is under way, failed, or done. */
export type RulesLoadState = "ready" | "loading" | "error";

/** What one matching line would become under a rule. */
export type RuleSampleLeg = { account: string; amount: string };

export type RuleSampleRow = {
  key: string;
  /** YYYY-MM-DD. */
  date: string;
  description: string;
  counterparty?: string | undefined;
  /** Signed, as on the statement. */
  amount: string;
  outcome: "applies" | "shadowed" | "unusable" | "no_match";
  /** Which earlier rule decides it, or why the rule cannot be applied. */
  detail?: string | undefined;
  /** The entry the rule would suggest: the accounts other than the bank's. */
  wouldBook: readonly RuleSampleLeg[];
  /** For a posted line: where it was actually booked. */
  bookedTo?: string | undefined;
  /** For a posted line: it was booked somewhere the rule would not put it. */
  differs?: boolean | undefined;
  narration?: string | undefined;
};

export type RuleSection = {
  considered: number;
  matched: number;
  applies: number;
  shadowed: number;
  unusable: number;
  truncated: boolean;
  samples: readonly RuleSampleRow[];
};

export type RulePreviewData = {
  days: number;
  position: number;
  inbox: RuleSection;
  history: RuleSection;
  agreement: { agreed: number; differed: number; notComparable: number };
  notes: readonly string[];
};

/** Where the live check of a draft stands. */
export type RulePreviewState = "idle" | "incomplete" | "loading" | "ready" | "error";

export type RuleTryValues = {
  description: string;
  counterparty: string;
  amount: string;
  accountId: string;
};

export type RuleTryResult = {
  outcome: "applies" | "shadowed" | "unusable" | "no_match";
  /** The earlier rule that decides it, or why the rule cannot be applied. */
  detail?: string | undefined;
  held: readonly string[];
  missed: readonly string[];
  wouldBook: readonly RuleSampleLeg[];
  narration?: string | undefined;
  /** What the line would be, in words: "Book it", "Leave it out of the books". */
  kind?: string | undefined;
};

export type RuleRevisionRow = {
  revision: number;
  by: { kind: "person" | "agent"; name?: string | undefined };
  /** An instant as the viewer reads it: "Oct 4, 2026, 7:50 AM". */
  at: string;
  changed: readonly string[];
  note?: string | undefined;
};

export type ClassifierRatioView = {
  numerator: number;
  denominator: number;
  /** Hundredths of a percent, or null when there is nothing to divide. */
  basisPoints: number | null;
};

export type ClassifierConfigView = {
  enabled: boolean;
  minAgreement: number;
  minMargin: number;
  minExamples: number;
  minKnownWords: number;
};

export type ClassifierEvaluationView = {
  scored: number;
  proposed: number;
  correct: number;
  precision: ClassifierRatioView;
  recall: ClassifierRatioView;
  coverage: ClassifierRatioView;
  thresholds: readonly {
    minConfidence: number;
    proposed: number;
    correct: number;
    precision: ClassifierRatioView;
    recall: ClassifierRatioView;
  }[];
  accounts: readonly {
    account: string;
    scored: number;
    proposed: number;
    correct: number;
    precision: ClassifierRatioView;
    recall: ClassifierRatioView;
  }[];
  confusions: readonly { actual: string; predicted: string; count: number }[];
};

export type ClassifierView = {
  ready: boolean;
  config: ClassifierConfigView;
  examples: number;
  accounts: number;
  posted: number;
  decisions: number;
  /** An instant as the viewer reads it, or null when it has never been trained. */
  trainedAt: string | null;
  evaluation: ClassifierEvaluationView | null;
  /** Transactions it has to learn from but will not on its own, the learning being too large to
   * run on the side: the one state in which the card offers to train it. Zero otherwise. */
  heldBack: number;
  notes: readonly string[];
};
