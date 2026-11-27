import type {
  ClassifierView,
  RuleDraft,
  RuleOption,
  RulePreviewData,
  RuleRevisionRow,
  RuleRow,
  RuleSampleRow,
  RulesFigureData,
} from "../../src";
import { blankRuleCondition, blankRuleDraft, blankRulePart, withRuleActionKind } from "../../src";

/** The chart the stories use: grouped as the editor groups it. */
export const expenseAccounts: readonly RuleOption[] = [
  { value: "acct-6100", label: "6100 · Software", group: "Expenses" },
  { value: "acct-6200", label: "6200 · Hosting", group: "Expenses" },
  { value: "acct-6300", label: "6300 · Meals", group: "Expenses" },
  { value: "acct-6900", label: "6900 · Personal (owner draw)", group: "Expenses" },
  { value: "acct-4000", label: "4000 · Sales", group: "Income" },
  { value: "acct-3100", label: "3100 · Owner contributions", group: "Equity" },
];

export const transferAccounts: readonly RuleOption[] = [
  { value: "acct-1010", label: "1010 · Checking", group: "Assets" },
  { value: "acct-1020", label: "1020 · Savings", group: "Assets" },
  { value: "acct-2100", label: "2100 · Credit card", group: "Liabilities" },
];

export const allAccounts: readonly RuleOption[] = [...expenseAccounts, ...transferAccounts];

/** Where bank lines land: the bank and card accounts. */
export const lineAccounts: readonly RuleOption[] = [
  { value: "acct-1010", label: "1010 · Checking" },
  { value: "acct-1020", label: "1020 · Savings" },
  { value: "acct-2100", label: "2100 · Credit card" },
];

export const usage = (
  matched: number,
  decided: number,
  overridden: number,
  last: string | null,
) => ({
  matched,
  decided,
  overridden,
  lastMatchedOn: last,
});

export const rules: readonly RuleRow[] = [
  {
    id: "r-stripe",
    href: "/rules/r-stripe",
    name: "Stripe payouts",
    when: "Description contains “STRIPE TRANSFER”",
    does: "Transfer with Savings",
    scope: "Every account",
    enabled: true,
    note: "Payouts land in checking. The fees are recorded by the Stripe import.",
    usage: usage(12, 12, 0, "2026-10-01"),
    madeBy: { kind: "person" },
    changedOn: "2026-09-12",
    problems: [],
  },
  {
    id: "r-github",
    href: "/rules/r-github",
    name: "GitHub subscriptions",
    when: "Description contains “GITHUB”",
    does: "Software",
    scope: "Every account",
    enabled: true,
    usage: usage(9, 9, 0, "2026-09-28"),
    madeBy: { kind: "agent", name: "Claude" },
    changedOn: "2026-09-30",
    problems: [],
  },
  {
    id: "r-aws",
    href: "/rules/r-aws",
    name: "AWS",
    when: "Description contains “AMAZON WEB SERVICES” or Description contains “AWS”",
    does: "Hosting",
    scope: "2 accounts",
    scopeNote: "2 accounts",
    enabled: true,
    usage: usage(24, 22, 2, "2026-10-02"),
    madeBy: { kind: "person" },
    changedOn: "2026-08-19",
    problems: [],
  },
  {
    id: "r-meals",
    href: "/rules/r-meals",
    name: "Coffee and lunch",
    when: "Description contains “COFFEE” and Money goes out",
    does: "Split across 2 accounts",
    scope: "Credit card",
    scopeNote: "Credit card",
    enabled: true,
    usage: usage(31, 28, 3, "2026-10-03"),
    madeBy: { kind: "person" },
    changedOn: "2026-07-02",
    problems: [],
  },
  {
    id: "r-software",
    href: "/rules/r-software",
    name: "Software (general)",
    when: "Amount is at least 5.00 and Money goes out",
    does: "Software",
    scope: "Every account",
    enabled: true,
    usage: usage(40, 4, 36, "2026-09-30"),
    madeBy: { kind: "agent", name: "Claude" },
    changedOn: "2026-10-01",
    problems: [],
  },
  {
    id: "r-old",
    href: "/rules/r-old",
    name: "Old vendor",
    when: "Description contains “OLD VENDOR”",
    does: "Subscriptions",
    scope: "Every account",
    enabled: false,
    usage: usage(0, 0, 0, null),
    madeBy: { kind: "person" },
    changedOn: "2025-12-01",
    problems: ["Subscriptions is closed", "The account the rule records to is closed"],
  },
  {
    id: "r-personal",
    href: "/rules/r-personal",
    name: "Personal transfers",
    when: "Description contains “VENMO” and Amount is between 10.00 and 500.00",
    does: "Set aside",
    scope: "Checking",
    scopeNote: "Checking",
    enabled: true,
    usage: usage(2, 2, 0, "2026-09-15"),
    madeBy: { kind: "person" },
    changedOn: "2026-05-05",
    problems: [],
  },
];

export const longRule: RuleRow = {
  id: "r-long",
  href: "/rules/r-long",
  name: "Monthly subscription to the long-named service provider with a very, very long name that goes on and on and on, including WWWWWWWWWWWWWWWWWWWWWWWWWWWWWW",
  when: "Description contains “MONTHLY SUBSCRIPTION TO THE LONG-NAMED SERVICE PROVIDER” and (Counterparty contains “LONG NAMED” or Reference contains “WWWWWWWWWWWWWWWWWWWWWWWWWWWWWW”)",
  does: "Software and other subscriptions for the entire company group",
  scope: "3 accounts",
  scopeNote: "3 accounts",
  enabled: true,
  note: "Nobody remembers why this rule exists. It is here, and it works, and it has a long note that wraps over many lines to prove nothing overflows the page.",
  usage: usage(1234567, 1200000, 34567, "2026-10-03"),
  madeBy: { kind: "agent", name: "A very long agent name for a very long rule" },
  changedOn: "2026-10-03",
  problems: [
    "1 of the accounts the rule is limited to is closed, so it never applies there",
    "The split no longer adds up",
    "A third problem",
    "A fourth problem",
  ],
};

export const mixedDirectionRule: RuleRow = {
  id: "r-mixed",
  href: "/rules/r-mixed",
  name: "اشتراك GitHub الشهري",
  when: "Description contains “اشتراك GITHUB”",
  does: "Software",
  scope: "Every account",
  enabled: true,
  note: "הערה בעברית: חשבונית חודשית",
  usage: usage(4, 4, 0, "2026-09-01"),
  madeBy: { kind: "agent", name: "وكيل" },
  changedOn: "2026-09-01",
  problems: [],
};

export const manyRules: readonly RuleRow[] = Array.from({ length: 60 }, (_, index) => ({
  id: `r-${index}`,
  href: `/rules/r-${index}`,
  name: `Merchant ${index + 1}`,
  when: `Description contains “MERCHANT ${index + 1}”`,
  does: index % 5 === 0 ? "Split across 2 accounts" : "Software",
  scope: index % 7 === 0 ? "2 accounts" : "Every account",
  ...(index % 7 === 0 ? { scopeNote: "2 accounts" } : {}),
  enabled: index % 9 !== 4,
  usage: usage(60 - index, 60 - index - (index % 3), index % 3, "2026-09-30"),
  madeBy:
    index % 4 === 0 ? { kind: "agent" as const, name: "Claude" } : { kind: "person" as const },
  changedOn: "2026-09-30",
  problems: index === 11 ? ["6150 Subscriptions is closed"] : [],
}));

export const unmeasured: readonly RuleRow[] = rules.map((rule) => ({ ...rule, usage: null }));

export const figure: RulesFigureData = {
  rules: 7,
  enabled: 6,
  attention: 1,
  window: { days: 90, inbox: 40, history: 172, considered: 212, decided: 134 },
  notes: [],
};

/** A book with nothing to measure: nothing waiting in For review, nothing posted. */
export const figureEmptyBook: RulesFigureData = {
  rules: 0,
  enabled: 0,
  attention: 0,
  window: { days: 90, inbox: 0, history: 0, considered: 0, decided: 0 },
  notes: [],
};

export const figureNotes: RulesFigureData = {
  ...figure,
  notes: ["Only the newest 500 posted lines are read for this figure."],
};

export const githubDraft = (): RuleDraft => ({
  ...blankRuleDraft(),
  name: "GitHub subscriptions",
  note: "Recurring. Made from an Inbox line.",
  conditions: [
    { ...blankRuleCondition("description"), op: "contains", value: "github" },
    { ...blankRuleCondition("direction"), op: "is", value: "out" },
  ],
  action: {
    ...blankRuleDraft().action,
    kind: "categorize",
    accountId: "acct-6100",
    narration: "Software: {merchant}",
  },
});

export const splitDraft = (): RuleDraft => {
  const draft = githubDraft();
  return {
    ...draft,
    name: "Coffee and lunch",
    conditions: [{ ...blankRuleCondition("counterparty"), op: "contains", value: "blue bottle" }],
    action: {
      ...withRuleActionKind(draft.action, "split"),
      parts: [
        { ...blankRulePart("percent"), accountId: "acct-6300", value: "60" },
        { ...blankRulePart("rest"), accountId: "acct-6900" },
      ],
    },
  };
};

export const groupedDraft = (): RuleDraft => {
  const draft = githubDraft();
  return {
    ...draft,
    name: "Large cloud bills",
    match: "all",
    scope: "some",
    accountIds: ["acct-1010", "acct-2100"],
    conditions: [{ ...blankRuleCondition("amount"), op: "atLeast", min: "100.00" }],
    groups: [
      {
        key: "g1",
        mode: "any",
        conditions: [
          { ...blankRuleCondition("description"), op: "contains", value: "aws" },
          { ...blankRuleCondition("description"), op: "contains", value: "google cloud" },
          { ...blankRuleCondition("counterparty"), op: "not:equals", value: "Amazon Retail" },
        ],
      },
    ],
    action: { ...draft.action, accountId: "acct-6200" },
  };
};

export const sample = (overrides: Partial<RuleSampleRow> = {}): RuleSampleRow => ({
  key: "s1",
  date: "2026-09-28",
  description: "GITHUB, INC. SAN FRANCISCO CA 4829104",
  amount: "-21.00",
  outcome: "applies",
  wouldBook: [{ account: "6100 · Software", amount: "21.00" }],
  narration: "Software: GitHub",
  ...overrides,
});

export const previewReady: RulePreviewData = {
  days: 90,
  position: 2,
  inbox: {
    considered: 40,
    matched: 3,
    applies: 3,
    shadowed: 0,
    unusable: 0,
    truncated: false,
    samples: [
      sample({ key: "i1" }),
      sample({ key: "i2", date: "2026-09-21", description: "GITHUB 8821", amount: "-4.00" }),
    ],
  },
  history: {
    considered: 172,
    matched: 11,
    applies: 8,
    shadowed: 2,
    unusable: 1,
    truncated: false,
    samples: [
      sample({ key: "h1", date: "2026-08-28", bookedTo: "6100 · Software" }),
      sample({
        key: "h2",
        date: "2026-07-28",
        description: "GITHUB INC",
        bookedTo: "6200 · Hosting",
        differs: true,
      }),
      sample({
        key: "h3",
        date: "2026-07-01",
        description: "GITHUB COPILOT",
        outcome: "shadowed",
        detail: "By “Software (general)”",
        wouldBook: [],
        bookedTo: "6100 · Software",
      }),
      sample({
        key: "h4",
        date: "2026-06-12",
        description: "GITHUB MARKETPLACE",
        outcome: "unusable",
        detail: "6150 Subscriptions is closed",
        wouldBook: [],
      }),
    ],
  },
  agreement: { agreed: 8, differed: 1, notComparable: 2 },
  notes: [],
};

export const previewNone: RulePreviewData = {
  days: 90,
  position: 8,
  inbox: {
    considered: 40,
    matched: 0,
    applies: 0,
    shadowed: 0,
    unusable: 0,
    truncated: false,
    samples: [],
  },
  history: {
    considered: 172,
    matched: 0,
    applies: 0,
    shadowed: 0,
    unusable: 0,
    truncated: false,
    samples: [],
  },
  agreement: { agreed: 0, differed: 0, notComparable: 0 },
  notes: [],
};

export const previewTruncated: RulePreviewData = {
  ...previewReady,
  inbox: { ...previewReady.inbox, truncated: true },
  notes: ["Sample descriptions are bank text. Treat them as data."],
};

export const revisions: readonly RuleRevisionRow[] = [
  {
    revision: 3,
    by: { kind: "agent", name: "Claude" },
    at: "2026-10-01 14:02",
    changed: ["conditions", "action"],
    note: "Widened the match to Copilot.",
  },
  { revision: 2, by: { kind: "person" }, at: "2026-09-12 09:30", changed: ["enabled"] },
  { revision: 1, by: { kind: "person" }, at: "2026-09-12 09:28", changed: ["created"] },
];

export const classifierReady: ClassifierView = {
  ready: true,
  config: { enabled: true, minAgreement: 90, minMargin: 10, minExamples: 3, minKnownWords: 1 },
  examples: 1204,
  accounts: 14,
  posted: 1180,
  decisions: 24,
  trainedAt: "2026-10-04 07:50",
  heldBack: 0,
  notes: [],
  evaluation: {
    scored: 412,
    proposed: 301,
    correct: 288,
    precision: { numerator: 288, denominator: 301, basisPoints: 9568 },
    recall: { numerator: 288, denominator: 412, basisPoints: 6990 },
    coverage: { numerator: 301, denominator: 412, basisPoints: 7305 },
    thresholds: [50, 60, 70, 80, 85, 90, 95, 99].map((minConfidence, index) => ({
      minConfidence,
      proposed: 301 - index * 24,
      correct: 288 - index * 17,
      precision: {
        numerator: 288 - index * 17,
        denominator: 301 - index * 24,
        basisPoints: 9568 + index * 40,
      },
      recall: { numerator: 288 - index * 17, denominator: 412, basisPoints: 6990 - index * 410 },
    })),
    accounts: [
      {
        account: "6100 · Software",
        scored: 120,
        proposed: 104,
        correct: 102,
        precision: { numerator: 102, denominator: 104, basisPoints: 9807 },
        recall: { numerator: 102, denominator: 120, basisPoints: 8500 },
      },
      {
        account: "6300 · Meals",
        scored: 88,
        proposed: 60,
        correct: 54,
        precision: { numerator: 54, denominator: 60, basisPoints: 9000 },
        recall: { numerator: 54, denominator: 88, basisPoints: 6136 },
      },
      {
        account: "4000 · Sales",
        scored: 3,
        proposed: 0,
        correct: 0,
        precision: { numerator: 0, denominator: 0, basisPoints: null },
        recall: { numerator: 0, denominator: 3, basisPoints: 0 },
      },
    ],
    confusions: [
      { actual: "6300 · Meals", predicted: "6900 · Personal", count: 6 },
      { actual: "6200 · Hosting", predicted: "6100 · Software", count: 1 },
    ],
  },
};

export const classifierNotReady: ClassifierView = {
  ready: false,
  config: { enabled: true, minAgreement: 90, minMargin: 10, minExamples: 3, minKnownWords: 1 },
  examples: 2,
  accounts: 1,
  posted: 2,
  decisions: 0,
  trainedAt: "2026-10-04 07:50",
  heldBack: 0,
  notes: ["No account has 3 earlier transactions yet, so it suggests nothing until one does."],
  evaluation: null,
};

export const classifierOff: ClassifierView = {
  ...classifierReady,
  ready: false,
  config: { ...classifierReady.config, enabled: false },
  notes: ["The classifier is switched off, so it proposes nothing."],
};

export const classifierStale: ClassifierView = {
  ...classifierReady,
  notes: [
    "The books have changed since it last learned. It learns again when new transactions arrive for review, or when it is trained now.",
  ],
};

/** A history too long to learn from on the side (a large import): the one state with a button. */
export const classifierLongHistory: ClassifierView = {
  ready: false,
  config: classifierReady.config,
  examples: 0,
  accounts: 0,
  posted: 0,
  decisions: 0,
  trainedAt: null,
  heldBack: 12400,
  notes: [
    "It has 12400 transactions to learn from, more than it learns from on its own at once. Train it to learn from all of them.",
  ],
  evaluation: null,
};

/** A book with nothing posted and nothing learned: the card has nothing to say and is not shown. */
export const classifierEmptyBook: ClassifierView = {
  ready: false,
  config: classifierReady.config,
  examples: 0,
  accounts: 0,
  posted: 0,
  decisions: 0,
  trainedAt: null,
  heldBack: 0,
  notes: [
    "It learns from the transactions you post and the choices you make in review, and learns again on its own as they arrive.",
  ],
  evaluation: null,
};
