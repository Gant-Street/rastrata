import {
  array,
  date,
  id,
  nullable,
  object,
  operation,
  ref,
  signedMoney,
  text,
  type Schema,
  money,
  version,
} from "../../schema-kit.ts";
import type { SliceSchema } from "../types.ts";

/** The rules lane's contract: deterministic rules and a local classifier. Rules and the classifier
 * only ever *propose*; they never post. Nothing here changes the ledger, so no operation is a
 * prepared (kernel) action and `preparedPermissions` is empty.
 *
 * Shapes avoid unions and recursion on purpose: the Go bindings only support nullable unions and
 * the MCP adapter inlines every `$ref`. Conditions are therefore flat objects with optional
 * fields, and groups nest exactly one level (a rule holds conditions and groups; a group holds
 * conditions). */

const count: Schema = { type: "integer", minimum: 0, maximum: 2147483647 };
const percentPoints: Schema = { type: "integer", minimum: 0, maximum: 100 };
const instant = text(40);
const name120: Schema = { ...text(120), minLength: 1 };
const reasonText = text(500);

const conditionField: Schema = {
  type: "string",
  enum: ["description", "counterparty", "reference", "amount", "direction", "account", "provider"],
};
const conditionOperator: Schema = {
  type: "string",
  enum: ["contains", "equals", "startsWith", "endsWith", "wholeWord", "range", "is"],
};
const matchMode: Schema = { type: "string", enum: ["all", "any"] };
const authorKind: Schema = { type: "string", enum: ["person", "agent"] };
const ruleStatus: Schema = { type: "string", enum: ["active", "deleted"] };

/** Percent of what remains after fixed amounts: 0.01 to 100.00, at most two decimals. */
const percent: Schema = {
  type: "string",
  maxLength: 6,
  pattern: "^(100(\\.00?)?|[0-9]{1,2}(\\.[0-9]{1,2})?)$",
};

const ruleDefinitions: Readonly<Record<string, Schema>> = {
  RuleCondition: object(
    {
      field: conditionField,
      operator: conditionOperator,
      value: text(200),
      min: money,
      max: money,
      negate: { type: "boolean" },
    },
    ["field", "operator"],
  ),
  RuleConditionGroup: object({
    mode: matchMode,
    conditions: { ...array(ref("RuleCondition"), 20), minItems: 1 },
  }),
  RuleAllocation: object({ accountId: id, percent, amount: money, rest: { type: "boolean" } }, [
    "accountId",
  ]),
  RuleAction: object(
    {
      kind: { type: "string", enum: ["categorize", "split", "transfer", "exclude"] },
      accountId: id,
      allocations: array(ref("RuleAllocation"), 20),
      narration: text(200),
      reason: text(200),
    },
    ["kind"],
  ),
  /** What a person or agent writes. Omitted fields default to: enabled true, every account, match
   * "all", no conditions, no groups. A rule needs at least one condition or group. */
  RuleInput: object(
    {
      name: name120,
      enabled: { type: "boolean" },
      accountIds: array(id, 50),
      match: matchMode,
      conditions: array(ref("RuleCondition"), 20),
      groups: array(ref("RuleConditionGroup"), 10),
      action: ref("RuleAction"),
      note: text(500),
    },
    ["name", "action"],
  ),
  RuleAuthor: object({ kind: authorKind, name: text(80) }, ["kind"]),
  RuleProblem: object({ path: text(200), message: text(400) }),
  /** How a rule behaved over the window of `rules.list`: the lines waiting in the Inbox and the
   * posted lines of the last days. A rule that matches nothing is dead; one that matches lines but
   * decides none is hidden behind an earlier rule. */
  RuleUsage: object({
    /** Lines its scope and conditions match, whatever else matches them. */
    matched: count,
    /** Lines it decides: it is the first enabled rule to match. */
    decided: count,
    /** Lines it matches that an earlier enabled rule decides instead. */
    shadowed: count,
    /** The newest date among its matches. */
    lastMatchedOn: nullable(date),
  }),
  RuleRecord: object(
    {
      id,
      status: ruleStatus,
      /** Position among the active rules, 1 first; 0 once deleted. */
      priority: count,
      revision: version,
      name: name120,
      enabled: { type: "boolean" },
      accountIds: array(id, 50),
      match: matchMode,
      conditions: array(ref("RuleCondition"), 20),
      groups: array(ref("RuleConditionGroup"), 10),
      action: ref("RuleAction"),
      note: text(500),
      createdBy: ref("RuleAuthor"),
      createdAt: instant,
      updatedBy: ref("RuleAuthor"),
      updatedAt: instant,
      /** What is wrong with the rule today (an account since closed, say). Empty means usable. */
      problems: array(ref("RuleProblem"), 100),
      /** Present when `rules.list` was asked for usage. */
      usage: ref("RuleUsage"),
    },
    [
      "id",
      "status",
      "priority",
      "revision",
      "name",
      "enabled",
      "accountIds",
      "match",
      "conditions",
      "groups",
      "action",
      "createdBy",
      "createdAt",
      "updatedBy",
      "updatedAt",
      "problems",
    ],
  ),
  RuleListInput: object(
    {
      status: ruleStatus,
      /** Measure each active rule over the last `days` (90 by default): lines matched, decided and
       * taken by an earlier rule. Costs a pass over the Inbox and the recent posted history. */
      usage: { type: "boolean" },
      days: { type: "integer", minimum: 1, maximum: 365 },
    },
    [],
  ),
  RuleWindow: object({
    from: date,
    to: date,
    days: { type: "integer", minimum: 1, maximum: 365 },
    /** Lines waiting in the Inbox (new or proposed). */
    inbox: count,
    /** Posted lines dated inside the window. */
    history: count,
    /** inbox + history. */
    considered: count,
    /** Lines at least one enabled rule decides. */
    decided: count,
    notes: array(text(300), 5),
  }),
  RuleList: object({
    /** Changes whenever any rule is created, changed, deleted or reordered. Pass it back when
     * reordering so a stale view cannot overwrite someone else's order. */
    rulesRevision: count,
    count,
    enabled: count,
    /** Who last set the priority order, and when; null while it has only ever been creation order. */
    orderedBy: nullable(ref("RuleAuthor")),
    orderedAt: nullable(instant),
    /** What usage was measured over; null when usage was not asked for. */
    window: nullable(ref("RuleWindow")),
    rules: array(ref("RuleRecord"), 500),
  }),
  RuleGetInput: object({ ruleId: id }),
  RuleRevision: object(
    {
      revision: version,
      madeBy: ref("RuleAuthor"),
      madeAt: instant,
      /** Which parts changed: "created", "name", "conditions", "action", "enabled", "deleted"... */
      changed: array(text(40), 20),
      note: text(500),
    },
    ["revision", "madeBy", "madeAt", "changed"],
  ),
  RuleDetail: object({ rule: ref("RuleRecord"), history: array(ref("RuleRevision"), 1000) }),
  /** Who is making the change is decided by the runtime, not the request. A scoped agent token is
   * always recorded as that agent (its label and public id) and `madeBy` is ignored. The owner's
   * own access (the web, the CLI) is a person unless `madeBy` says it is an agent, and that
   * statement is a note for a reviewer: with the owner's own access there is nothing to check it
   * against. Omit `madeBy` to be recorded as what the runtime knows you to be. */
  RuleCreateInput: object(
    {
      rule: ref("RuleInput"),
      madeBy: ref("RuleAuthor"),
      /** 1-based place among the active rules; the end when omitted. */
      position: { type: "integer", minimum: 1, maximum: 500 },
    },
    ["rule"],
  ),
  RuleUpdateInput: object(
    {
      ruleId: id,
      expectedRevision: version,
      rule: ref("RuleInput"),
      madeBy: ref("RuleAuthor"),
    },
    ["ruleId", "expectedRevision", "rule"],
  ),
  RuleDeleteInput: object(
    { ruleId: id, expectedRevision: version, madeBy: ref("RuleAuthor"), reason: reasonText },
    ["ruleId", "expectedRevision"],
  ),
  RuleReorderInput: object(
    {
      expectedRulesRevision: count,
      /** Every active rule exactly once, highest priority first. */
      orderedRuleIds: array(id, 500),
      madeBy: ref("RuleAuthor"),
    },
    ["expectedRulesRevision", "orderedRuleIds"],
  ),
  /** A line typed or pasted in to try a rule on, for example the memo from an email or a statement
   * that is not in the Inbox. Hostile text is data: it is compared, never executed. */
  RuleTestLineInput: object(
    {
      description: { ...text(1000), minLength: 1 },
      counterparty: text(300),
      reference: text(300),
      /** Signed, negative is money out. */
      amount: signedMoney,
      /** The chart account the line is on. Defaults to the rule's own account scope, or the first open asset account. */
      accountId: id,
      /** The source kind, for a rule that tests the provider ("csv" by default). */
      provider: text(32),
    },
    ["description", "amount"],
  ),
  RuleTestInput: object(
    {
      ruleId: id,
      rule: ref("RuleInput"),
      /** Where an unsaved rule would sit; the end when omitted. Ignored with `ruleId`. */
      position: { type: "integer", minimum: 1, maximum: 500 },
      /** History window ending on `asOf`. */
      days: { type: "integer", minimum: 1, maximum: 3650 },
      asOf: date,
      samples: { type: "integer", minimum: 0, maximum: 50 },
      /** Lines to try the rule on directly, in addition to the Inbox and history. */
      lines: array(ref("RuleTestLineInput"), 10),
    },
    [],
  ),
  RuleLeg: object({ accountId: id, amount: signedMoney }),
  RuleTestSample: object(
    {
      itemId: id,
      date,
      description: text(300),
      counterparty: text(300),
      amount: signedMoney,
      accountId: id,
      outcome: { type: "string", enum: ["applies", "shadowed", "unusable"] },
      /** For "shadowed": the earlier rule that decides instead. */
      shadowedBy: text(120),
      /** For "unusable": why the rule's action cannot be applied to this line. */
      reason: text(300),
      /** History only: the account the line was in fact booked to, as a label. */
      bookedTo: text(200),
      /** History only, when the line was booked to one account: its id. */
      bookedAccountId: id,
      /** History only: the rule would book the line to the account it was booked to. Absent when
       * the rule or the booking is not comparable (a split, a transfer, an exclusion). */
      agrees: { type: "boolean" },
      /** For "applies": the entry the rule would propose, bank side included, signed from the book's view. */
      legs: array(ref("RuleLeg"), 21),
      /** For "applies": the narration the rule would give it. */
      narration: text(500),
    },
    ["date", "description", "amount", "outcome"],
  ),
  RuleTestLineResult: object(
    {
      /** Position in the lines supplied, from zero. */
      index: count,
      /** The account the line was treated as being on. */
      accountId: id,
      outcome: { type: "string", enum: ["applies", "shadowed", "unusable", "no_match"] },
      /** For "unusable": why the action cannot be applied. */
      reason: text(500),
      /** The conditions that held, in words. */
      held: array(text(300), 20),
      /** For "no_match": the conditions that did not hold, in words. */
      missed: array(text(300), 20),
      shadowedBy: text(120),
      kind: { type: "string", enum: ["categorize", "transfer", "exclude"] },
      legs: array(ref("RuleLeg"), 21),
      narration: text(500),
    },
    ["index", "accountId", "outcome", "held", "missed"],
  ),
  RuleTestSection: object({
    /** Lines looked at. */
    considered: count,
    /** Lines the rule's scope and conditions match. */
    matched: count,
    /** Matched and decided by this rule: nothing earlier takes it. */
    applies: count,
    /** Matched, but an earlier rule decides instead. */
    shadowed: count,
    /** Applies, but the action cannot be carried out (an account closed, a split that does not add up). */
    unusable: count,
    /** True when there were more lines than the test reads. */
    truncated: { type: "boolean" },
    samples: array(ref("RuleTestSample"), 50),
  }),
  RuleHistoryAgreement: object({
    /** Matched past lines already booked where this rule would book them. */
    agreed: count,
    /** Matched past lines booked somewhere else. */
    differed: count,
    /** Matched past lines whose booking this cannot be compared with (splits, transfers, exclusions). */
    notComparable: count,
  }),
  RuleTestResult: object({
    from: date,
    to: date,
    days: { type: "integer", minimum: 1 },
    /** Present when the definition is not valid; no counts are given then. */
    problems: array(ref("RuleProblem"), 100),
    /** Where the rule sits among the active rules for this test. */
    position: { type: "integer", minimum: 1 },
    inbox: ref("RuleTestSection"),
    history: ref("RuleTestSection"),
    agreement: ref("RuleHistoryAgreement"),
    /** One result per line supplied in `lines`, in order. */
    lines: array(ref("RuleTestLineResult"), 10),
    /** What could not be examined and why, for example when no inbox exists yet. */
    notes: array(text(300), 20),
  }),
  RuleSuggestInput: object(
    {
      description: text(1000),
      counterparty: text(300),
      amount: signedMoney,
      /** The account the line is on; kept for context, the suggestion applies to every account. */
      accountId: id,
      /** The account the line is or should be booked to; the history is consulted when omitted. */
      categoryAccountId: id,
    },
    ["description", "amount"],
  ),
  RuleSuggestionBasis: object({
    field: { type: "string", enum: ["description", "counterparty"] },
    phrase: text(200),
    /** The words that were left out of the phrase. */
    dropped: array(text(60), 50),
  }),
  RuleSuggestion: object({
    /** A candidate to review and create; null when nothing in the line identifies a merchant. */
    rule: nullable(ref("RuleInput")),
    basis: nullable(ref("RuleSuggestionBasis")),
    notes: array(text(400), 20),
  }),
  ClassifierConfig: object({
    enabled: { type: "boolean" },
    /** Of the earlier lines containing the line's most reliable word, at least this share (whole
     * percent) must have gone to the suggested account. */
    minAgreement: { type: "integer", minimum: 50, maximum: 100 },
    /** The suggested account's score must lead the runner-up by at least this many points. */
    minMargin: { type: "integer", minimum: 0, maximum: 99 },
    /** That word must have been booked to the suggested account on at least this many earlier lines. */
    minExamples: { type: "integer", minimum: 1, maximum: 100 },
    /** The line must contain at least this many words the classifier has seen. */
    minKnownWords: { type: "integer", minimum: 1, maximum: 5 },
  }),
  ClassifierConfigInput: object(
    {
      enabled: { type: "boolean" },
      minAgreement: { type: "integer", minimum: 50, maximum: 100 },
      minMargin: { type: "integer", minimum: 0, maximum: 99 },
      minExamples: { type: "integer", minimum: 1, maximum: 100 },
      minKnownWords: { type: "integer", minimum: 1, maximum: 5 },
    },
    [],
  ),
  ClassifierRatio: object({
    numerator: count,
    denominator: count,
    /** Hundredths of a percent, rounded down (9350 is 93.50%); null when the denominator is zero. */
    basisPoints: nullable({ type: "integer", minimum: 0, maximum: 10000 }),
  }),
  /** The same counts had only suggestions at or above a displayed confidence been trusted, the way
   * a bulk accept in the Inbox would choose them. */
  ClassifierThresholdRow: object({
    minConfidence: percentPoints,
    proposed: count,
    correct: count,
    precision: ref("ClassifierRatio"),
    recall: ref("ClassifierRatio"),
  }),
  /** One account's own report. `scored` is the lines that truly belong to it, `proposed` the
   * suggestions made for it, `correct` the suggestions for it that were right: precision is
   * correct over proposed, recall is correct over scored. */
  ClassifierAccountRow: object({
    accountId: id,
    scored: count,
    proposed: count,
    correct: count,
    precision: ref("ClassifierRatio"),
    recall: ref("ClassifierRatio"),
  }),
  ClassifierConfusion: object({ actual: id, predicted: id, count }),
  ClassifierEvaluation: object({
    /** The classifier's configuration the headline numbers were computed with. */
    config: ref("ClassifierConfig"),
    examples: count,
    warmup: count,
    scored: count,
    proposed: count,
    correct: count,
    /** Of the suggestions made, the share that was right. */
    precision: ref("ClassifierRatio"),
    /** Of all lines scored, the share that received a right suggestion. */
    recall: ref("ClassifierRatio"),
    /** Of all lines scored, the share that received any suggestion. */
    coverage: ref("ClassifierRatio"),
    thresholds: array(ref("ClassifierThresholdRow"), 20),
    accounts: array(ref("ClassifierAccountRow"), 500),
    confusions: array(ref("ClassifierConfusion"), 10),
    /** How the numbers were produced, in plain words. */
    method: text(500),
    computedAt: instant,
  }),
  ClassifierAccountExamples: object({ accountId: id, examples: count }),
  ClassifierSources: object({ posted: count, decisions: count }),
  ClassifierStatus: object({
    config: ref("ClassifierConfig"),
    /** True when there is enough history for it to suggest anything. */
    ready: { type: "boolean" },
    examples: count,
    accounts: count,
    vocabulary: count,
    /** Examples per account, the most used first. */
    topAccounts: array(ref("ClassifierAccountExamples"), 20),
    /** Where the examples came from: posted journals, and inbox decisions when the inbox exists. */
    sources: ref("ClassifierSources"),
    /** Changes whenever training changes what the classifier knows. */
    modelVersion: count,
    trainedAt: nullable(instant),
    /** The book revision the training read, so staleness can be told from the current head. */
    trainedThroughRevision: nullable(text(30)),
    evaluation: nullable(ref("ClassifierEvaluation")),
    /** Example rows it has to learn from but will not on its own, because the learning is too large
     * to run on the side of a read; zero when nothing is held back. `classifier.train` learns from
     * them all. */
    heldBack: count,
    notes: array(text(400), 20),
  }),
  ClassifierEvaluateInput: object({ config: ref("ClassifierConfigInput") }, []),
};

export const rulesSchema: SliceSchema = {
  name: "rules",
  definitions: ruleDefinitions,
  operations: [
    operation(
      "rules.list",
      "List the rules in priority order with what is wrong with each today. The first enabled rule that matches a line decides what is proposed for it; rules only propose and never post.",
      "read",
      "RuleListInput",
      false,
      "RuleList",
    ),
    operation(
      "rules.get",
      "Read one rule with its full revision history: who made or changed it, when, and what changed.",
      "read",
      "RuleGetInput",
      false,
      "RuleDetail",
    ),
    operation(
      "rules.create",
      "Create a rule. Conditions test the description, counterparty, reference, amount, direction, account or provider; the action categorises, splits (exact to the cent), marks a transfer or excludes. Text is compared without regard to case, accents or punctuation. Records who made it: an agent token is always recorded as that agent; the owner as a person unless it says otherwise. The rule only proposes; nothing is booked.",
      "draft",
      "RuleCreateInput",
      true,
      "RuleRecord",
    ),
    operation(
      "rules.update",
      "Replace a rule's definition. Supply the revision you read (expectedRevision); a stale revision is refused so two writers cannot overwrite each other. History keeps every earlier revision.",
      "draft",
      "RuleUpdateInput",
      true,
      "RuleRecord",
    ),
    operation(
      "rules.delete",
      "Retire a rule. It stops proposing at once but stays in the history, readable with rules.get and rules.list status deleted. Needs the revision you read.",
      "draft",
      "RuleDeleteInput",
      true,
      "RuleRecord",
    ),
    operation(
      "rules.reorder",
      "Set the priority order of the active rules by listing every one of them, highest priority first, with the rulesRevision you read.",
      "draft",
      "RuleReorderInput",
      true,
      "RuleList",
    ),
    operation(
      "rules.test",
      "Dry-run a stored or draft rule against the inbox and the posted history: how many lines it matches, how many an earlier rule would take instead, whether past bookings agree, with samples. Changes nothing.",
      "read",
      "RuleTestInput",
      false,
      "RuleTestResult",
    ),
    operation(
      "rules.suggest",
      "Generalise one bank line into a candidate rule: numbers, dates, reference ids and payment-rail words are dropped so it keeps matching next month. Returns a draft to review with rules.test and create; nothing is saved.",
      "read",
      "RuleSuggestInput",
      false,
      "RuleSuggestion",
    ),
    operation(
      "classifier.status",
      "Read the local classifier: its thresholds, how much history it learned from, whether it is ready, and its last evaluation. The classifier proposes categories from the book's own posted history; it never posts and calls no model.",
      "read",
      "Empty",
      false,
      "ClassifierStatus",
    ),
    operation(
      "classifier.configure",
      "Change the classifier's thresholds (confidence, margin, examples per account, known words) or switch it off. Only the fields supplied change.",
      "configure",
      "ClassifierConfigInput",
      true,
      "ClassifierStatus",
    ),
    operation(
      "classifier.train",
      "Learn from the book's posted history and the Inbox's decisions again and re-measure it. The classifier does this by itself whenever For review is read after a line was decided there or the books changed; this does it at once, and is the way to learn from a long history it holds back from on its own. Safe to repeat: the same history gives the same classifier.",
      "draft",
      "Empty",
      true,
      "ClassifierStatus",
    ),
    operation(
      "classifier.evaluate",
      "Measure how often the classifier would have been right on this book's own history, replayed in time order, optionally with different thresholds. Reports exact counts for precision and recall. Changes nothing.",
      "read",
      "ClassifierEvaluateInput",
      false,
      "ClassifierEvaluation",
    ),
  ],
};
