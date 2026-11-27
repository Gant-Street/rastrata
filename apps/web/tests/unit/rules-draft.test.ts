import { describe, expect, test } from "bun:test";
import { shown } from "../support/shown";
import type {
  AccountRow,
  ClassifierStatus,
  RuleInput,
  RuleRecord,
  RuleTestResult,
} from "@rastrata/application/client-contracts";
import { blankDraft, type RuleDraft, withActionKind } from "@rastrata/ui/rules-logic";
import { chartView } from "../../src/routes/rules/chart";
import {
  classifierOf,
  describeAction,
  describeWhen,
  draftOf,
  errorsOf,
  firstNarration,
  inputFromRecord,
  inputOf,
  isStructural,
  previewOf,
  problemsOf,
  revisionsOf,
  rowOf,
  splitPreview,
  stamp,
  summaryOf,
  tryOf,
} from "../../src/routes/rules/draft";

const account = (
  id: string,
  code: string,
  name: string,
  role: AccountRow["role"],
  closedOn: string | null = null,
): AccountRow => ({
  id,
  code,
  name,
  role,
  parentId: null,
  openedOn: "2026-01-01",
  closedOn,
  balance: "0.00",
});

const chart = chartView([
  account("a-1010", "1010", "Checking", "asset"),
  account("a-1020", "1020", "Savings", "asset"),
  account("a-2100", "2100", "Credit card", "liability"),
  account("a-3100", "3100", "Owner contributions", "equity"),
  account("a-4000", "4000", "Sales", "income"),
  account("a-6100", "6100", "Software", "expense"),
  account("a-6150", "6150", "Subscriptions", "expense", "2026-06-30"),
  account("a-6300", "6300", "Meals", "expense"),
  account("a-6900", "6900", "Personal", "expense"),
]);

function github(): RuleDraft {
  const draft = blankDraft();
  const [first] = draft.conditions;
  if (!first) throw new Error("a new draft has a condition");
  return {
    ...draft,
    name: "  GitHub subscriptions ",
    conditions: [{ ...first, field: "description", op: "contains", value: "github" }],
    action: { ...draft.action, kind: "categorize", accountId: "a-6100" },
  };
}

const record = (input: RuleInput, over: Partial<RuleRecord> = {}): RuleRecord => ({
  id: "r-1",
  status: "active",
  priority: 1,
  revision: 3,
  name: input.name,
  enabled: input.enabled ?? true,
  accountIds: input.accountIds ?? [],
  match: input.match ?? "all",
  conditions: input.conditions ?? [],
  groups: input.groups ?? [],
  action: input.action,
  ...(input.note !== undefined ? { note: input.note } : {}),
  createdBy: { kind: "agent", name: "Claude" },
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedBy: { kind: "person" },
  updatedAt: "2026-10-03T08:15:00.000Z",
  problems: [],
  ...over,
});

describe("a draft becomes a rule", () => {
  test("a text condition keeps what was typed and the name is trimmed", () => {
    const input = inputOf(github());
    expect(input.name).toBe("GitHub subscriptions");
    expect(input.conditions).toEqual([
      { field: "description", operator: "contains", value: "github" },
    ]);
    expect(input.action).toEqual({ kind: "categorize", accountId: "a-6100" });
    expect(input.accountIds).toEqual([]);
    expect(input.note).toBeUndefined();
  });

  test("a negated operator becomes the operator and a negate flag", () => {
    const draft = github();
    const [first] = draft.conditions;
    if (!first) throw new Error("no condition");
    const input = inputOf({ ...draft, conditions: [{ ...first, op: "not:startsWith" }] });
    expect(input.conditions?.[0]).toEqual({
      field: "description",
      operator: "startsWith",
      value: "github",
      negate: true,
    });
  });

  test("each amount test becomes the right range or exact amount", () => {
    const base = github();
    const [first] = base.conditions;
    if (!first) throw new Error("no condition");
    const amount = (op: string, boxes: { value?: string; min?: string; max?: string }) =>
      inputOf({
        ...base,
        conditions: [{ ...first, field: "amount", op, value: "", min: "", max: "", ...boxes }],
      }).conditions?.[0];
    expect(amount("between", { min: " 10.00 ", max: "99.99" })).toEqual({
      field: "amount",
      operator: "range",
      min: "10.00",
      max: "99.99",
    });
    expect(amount("atLeast", { min: "100.00" })).toEqual({
      field: "amount",
      operator: "range",
      min: "100.00",
    });
    expect(amount("atMost", { max: "5.00" })).toEqual({
      field: "amount",
      operator: "range",
      max: "5.00",
    });
    expect(amount("not:atLeast", { min: "100.00" })).toEqual({
      field: "amount",
      operator: "range",
      min: "100.00",
      negate: true,
    });
    expect(amount("exactly", { value: "12.00" })).toEqual({
      field: "amount",
      operator: "equals",
      value: "12.00",
    });
    expect(amount("not:exactly", { value: "12.00" })).toEqual({
      field: "amount",
      operator: "equals",
      value: "12.00",
      negate: true,
    });
  });

  test("an empty box is sent empty, so the check names the box, not a different test", () => {
    const base = github();
    const [first] = base.conditions;
    if (!first) throw new Error("no condition");
    const draft = {
      ...base,
      conditions: [{ ...first, field: "amount" as const, op: "between", min: "10.00", max: "" }],
    };
    const problems = problemsOf(draft, chart);
    expect(problems.map((problem) => problem.path)).toContain("conditions[0].max");
  });

  test("a split sends its parts, and the part that takes the rest has no number", () => {
    const draft: RuleDraft = {
      ...github(),
      action: {
        ...withActionKind(github().action, "split"),
        parts: [
          { key: "p1", accountId: "a-6300", kind: "percent", value: " 60 " },
          { key: "p2", accountId: "a-6900", kind: "rest", value: "" },
        ],
        narration: "Lunch: {merchant}",
      },
    };
    expect(inputOf(draft).action).toEqual({
      kind: "split",
      allocations: [
        { accountId: "a-6300", percent: "60" },
        { accountId: "a-6900", rest: true },
      ],
      narration: "Lunch: {merchant}",
    });
    expect(problemsOf(draft, chart)).toEqual([]);
  });

  test("exclude carries only its reason, and a rule limited to accounts lists them", () => {
    const draft: RuleDraft = {
      ...github(),
      scope: "some",
      accountIds: ["a-1010"],
      note: " Personal ",
      action: { ...github().action, kind: "exclude", accountId: "", reason: " Not business " },
    };
    const input = inputOf(draft);
    expect(input.action).toEqual({ kind: "exclude", reason: "Not business" });
    expect(input.accountIds).toEqual(["a-1010"]);
    expect(input.note).toBe("Personal");
  });

  test("scope 'all' sends no accounts even if some were ticked before", () => {
    expect(inputOf({ ...github(), scope: "all", accountIds: ["a-1010"] }).accountIds).toEqual([]);
  });

  test("a rule being checked before it is named is checked under a placeholder name", () => {
    expect(inputOf({ ...github(), name: "" }, "Untitled rule").name).toBe("Untitled rule");
  });
});

describe("a rule becomes a draft, and back", () => {
  const cases: Record<string, RuleInput> = {
    "a plain categorize": {
      name: "GitHub",
      conditions: [{ field: "description", operator: "contains", value: "github" }],
      action: { kind: "categorize", accountId: "a-6100", narration: "Software: {merchant}" },
    },
    "a negated text test": {
      name: "Not Amazon",
      conditions: [
        { field: "counterparty", operator: "equals", value: "Amazon Retail", negate: true },
      ],
      action: { kind: "categorize", accountId: "a-6100" },
    },
    "every kind of amount test": {
      name: "Amounts",
      match: "any",
      conditions: [
        { field: "amount", operator: "range", min: "10.00", max: "20.00" },
        { field: "amount", operator: "range", min: "100.00" },
        { field: "amount", operator: "range", max: "5.00", negate: true },
        { field: "amount", operator: "equals", value: "12.00" },
      ],
      action: { kind: "categorize", accountId: "a-6100" },
    },
    "direction, account and source": {
      name: "Where it came from",
      conditions: [
        { field: "direction", operator: "is", value: "out" },
        { field: "account", operator: "is", value: "a-1010" },
        { field: "provider", operator: "is", value: "stripe", negate: true },
      ],
      action: { kind: "transfer", accountId: "a-1020" },
    },
    "groups and scope": {
      name: "Cloud",
      enabled: false,
      accountIds: ["a-1010", "a-2100"],
      note: "Large bills",
      conditions: [{ field: "amount", operator: "range", min: "100.00" }],
      groups: [
        {
          mode: "any",
          conditions: [
            { field: "description", operator: "contains", value: "aws" },
            { field: "description", operator: "wholeWord", value: "gcp" },
          ],
        },
      ],
      action: { kind: "categorize", accountId: "a-6100" },
    },
    "a split with three kinds of part": {
      name: "Split",
      conditions: [{ field: "description", operator: "contains", value: "market" }],
      action: {
        kind: "split",
        allocations: [
          { accountId: "a-6300", percent: "50.50" },
          { accountId: "a-6900", amount: "10.00" },
          { accountId: "a-6100", rest: true },
        ],
      },
    },
    "an exclusion": {
      name: "Personal",
      conditions: [{ field: "description", operator: "contains", value: "venmo" }],
      action: { kind: "exclude", reason: "Personal" },
    },
  };
  for (const [name, input] of Object.entries(cases))
    test(`${name} survives the round trip exactly`, () => {
      const again = inputOf(draftOf(input));
      // Defaults are filled in, nothing else changes.
      expect(again).toEqual({
        enabled: true,
        accountIds: [],
        match: "all",
        groups: [],
        ...input,
        conditions: input.conditions ?? [],
      });
    });

  test("a stored rule is switched off without touching anything else", () => {
    const stored = record(cases["groups and scope"] as RuleInput, { enabled: true });
    const off = inputFromRecord(stored, { enabled: false });
    expect(off.enabled).toBe(false);
    expect({ ...off, enabled: true }).toEqual({ ...inputFromRecord(stored), enabled: true });
    expect(off.conditions).toBe(stored.conditions);
    expect(off.groups).toBe(stored.groups);
    expect(off.action).toBe(stored.action);
    // Not asked to change anything, so nothing changes.
    expect(inputFromRecord(stored).enabled).toBe(true);
  });
});

describe("problems", () => {
  test("a good rule has none", () => {
    expect(problemsOf(github(), chart)).toEqual([]);
  });

  test("an empty draft says what is missing, where", () => {
    const problems = problemsOf(blankDraft(), chart);
    const paths = problems.map((problem) => problem.path);
    expect(paths).toContain("name");
    expect(paths).toContain("conditions[0].value");
    expect(paths).toContain("action.accountId");
  });

  test("a closed account is named as a problem and not offered", () => {
    const draft = { ...github(), action: { ...github().action, accountId: "a-6150" } };
    expect(problemsOf(draft, chart).map((problem) => problem.message)).toEqual([
      "6150 Subscriptions is closed",
    ]);
    expect(chart.bookable.some((option) => option.value === "a-6150")).toBe(false);
    // It is still shown when a stored rule names it.
    const offered = chart.withCurrent(chart.bookable, ["a-6150"]);
    expect(offered.find((option) => option.value === "a-6150")?.label).toBe(
      "6150 · Subscriptions (closed)",
    );
  });

  test("a split that does not add up says so on the split", () => {
    const draft: RuleDraft = {
      ...github(),
      action: {
        ...withActionKind(github().action, "split"),
        parts: [
          { key: "p1", accountId: "a-6300", kind: "percent", value: "60" },
          { key: "p2", accountId: "a-6900", kind: "percent", value: "30" },
        ],
      },
    };
    const errors = errorsOf(problemsOf(draft, chart));
    expect(errors["action.allocations"]).toContain("add up to 90.00");
  });

  test("problems with the same place are joined, and the summary links to a control that exists", () => {
    const problems = [
      { path: "accountIds[0]", message: "That account is not in the chart" },
      { path: "accountIds[1]", message: "That account is not in the chart" },
      { path: "groups", message: "Use at most 10 groups" },
      { path: "conditions[0].value", message: "Enter some text" },
    ];
    expect(errorsOf(problems)).toEqual({
      accountIds: "That account is not in the chart; That account is not in the chart",
      conditions: "Use at most 10 groups",
      "conditions[0].value": "Enter some text",
    });
    expect(summaryOf(problems).map((entry) => entry.id)).toEqual([
      "rule-accountIds",
      "rule-accountIds",
      "rule-conditions",
      "rule-conditions-0-value",
    ]);
  });

  test("only problems with what the rule matches stop the live check", () => {
    expect(isStructural({ path: "conditions[0].value", message: "" })).toBe(true);
    expect(isStructural({ path: "groups[1]", message: "" })).toBe(true);
    expect(isStructural({ path: "accountIds[0]", message: "" })).toBe(true);
    expect(isStructural({ path: "conditions", message: "" })).toBe(true);
    expect(isStructural({ path: "name", message: "" })).toBe(false);
    expect(isStructural({ path: "action.accountId", message: "" })).toBe(false);
    expect(isStructural({ path: "action.allocations", message: "" })).toBe(false);
  });
});

describe("splits, to the cent", () => {
  const split = (parts: RuleDraft["action"]["parts"]): RuleDraft => ({
    ...github(),
    action: { ...withActionKind(github().action, "split"), parts },
  });

  test("percentages divide exactly, and the part that takes the rest gets the cents", () => {
    const preview = splitPreview(
      split([
        { key: "1", accountId: "a-6300", kind: "percent", value: "33.33" },
        { key: "2", accountId: "a-6900", kind: "percent", value: "33.33" },
        { key: "3", accountId: "a-6100", kind: "rest", value: "" },
      ]),
      "100.01",
      chart,
    );
    expect(preview).toEqual({
      total: "100.01",
      parts: [
        { account: "Meals", amount: "33.33" },
        { account: "Personal", amount: "33.33" },
        { account: "Software", amount: "33.35" },
      ],
    });
  });

  test("without a rest part the rounding goes by the largest remainder and the total is exact", () => {
    const preview = splitPreview(
      split([
        { key: "1", accountId: "a-6300", kind: "percent", value: "33.33" },
        { key: "2", accountId: "a-6900", kind: "percent", value: "33.33" },
        { key: "3", accountId: "a-6100", kind: "percent", value: "33.34" },
      ]),
      "0.10",
      chart,
    );
    if (!preview || "problem" in preview) throw new Error("expected a split");
    const cents = preview.parts.map((part) => Number(part.amount.replace(".", "")));
    expect(cents.reduce((sum, value) => sum + value, 0)).toBe(10);
  });

  test("fixed amounts come first", () => {
    const preview = splitPreview(
      split([
        { key: "1", accountId: "a-6300", kind: "amount", value: "10.00" },
        { key: "2", accountId: "a-6900", kind: "rest", value: "" },
      ]),
      "120.00",
      chart,
    );
    expect(preview).toEqual({
      total: "120.00",
      parts: [
        { account: "Meals", amount: "10.00" },
        { account: "Personal", amount: "110.00" },
      ],
    });
  });

  test("parts without an account yet are told apart, and a bad example says why", () => {
    const blank = split([
      { key: "1", accountId: "", kind: "percent", value: "40" },
      { key: "2", accountId: "", kind: "rest", value: "" },
    ]);
    expect(splitPreview(blank, "50.00", chart)).toEqual({
      total: "50.00",
      parts: [
        { account: "Part 1", amount: "20.00" },
        { account: "Part 2", amount: "30.00" },
      ],
    });
    expect(splitPreview(blank, "abc", chart)).toEqual({
      problem: "Enter a positive amount with two decimals, for example 120.00.",
    });
    expect(splitPreview(blank, "0.00", chart)).toHaveProperty("problem");
    expect(splitPreview(github(), "50.00", chart)).toBeNull();
  });

  test("a split that cannot be made says why instead of guessing", () => {
    const preview = splitPreview(
      split([
        { key: "1", accountId: "a-6300", kind: "amount", value: "200.00" },
        { key: "2", accountId: "a-6900", kind: "rest", value: "" },
      ]),
      "120.00",
      chart,
    );
    expect(preview).toHaveProperty("problem");
  });
});

describe("what the lists and checks show", () => {
  test("a rule's row says what it does, where, and what it has matched", () => {
    const stored = record(
      {
        name: "AWS",
        accountIds: ["a-1010", "a-2100"],
        conditions: [{ field: "description", operator: "contains", value: "aws" }],
        action: { kind: "categorize", accountId: "a-6100" },
      },
      { problems: [{ path: "action.accountId", message: "6150 Subscriptions is closed" }] },
    );
    const row = rowOf(stored, chart, {
      matched: 24,
      decided: 22,
      shadowed: 2,
      lastMatchedOn: "2026-10-02",
    });
    expect(row).toMatchObject({
      id: "r-1",
      href: "/rules/r-1",
      name: "AWS",
      when: "Description contains “aws”",
      does: "Software",
      scope: "2 accounts",
      scopeNote: "2 accounts",
      enabled: true,
      usage: { matched: 24, decided: 22, overridden: 2, lastMatchedOn: "2026-10-02" },
      madeBy: { kind: "agent", name: "Claude" },
      changedOn: shown.date("2026-10-03T08:15:00.000Z"),
      problems: ["6150 Subscriptions is closed"],
    });
    expect(rowOf(stored, chart).usage).toBeNull();
  });

  test("the action is described in words", () => {
    expect(describeAction({ kind: "transfer", accountId: "a-1020" }, chart)).toBe(
      "Transfer with Savings",
    );
    expect(describeAction({ kind: "exclude" }, chart)).toBe("Set aside");
    expect(
      describeAction(
        {
          kind: "split",
          allocations: [
            { accountId: "a-6300", rest: true },
            { accountId: "a-6900", rest: true },
          ],
        },
        chart,
      ),
    ).toBe("Split across 2 accounts");
    expect(describeAction({ kind: "categorize", accountId: "" }, chart)).toBe("Not complete yet");
    expect(describeAction({ kind: "categorize", accountId: "gone" }, chart)).toBe(
      "An account that is not in the chart",
    );
  });

  test("when a rule applies is said in words, with groups in brackets and nothing as every transaction", () => {
    const when = (input: RuleInput) => describeWhen(record(input), chart);
    const action = { kind: "categorize", accountId: "a-6100" } as const;
    expect(
      when({
        name: "GitHub",
        conditions: [{ field: "description", operator: "contains", value: "GITHUB" }],
        action,
      }),
    ).toBe("Description contains “GITHUB”");
    // Both must hold, then either; an amount test reads as a sentence, and a direction as itself.
    expect(
      when({
        name: "Cloud",
        match: "all",
        conditions: [
          { field: "amount", operator: "range", min: "10.00", max: "50.50" },
          { field: "direction", operator: "is", value: "out" },
        ],
        groups: [
          {
            mode: "any",
            conditions: [
              { field: "description", operator: "wholeWord", value: "aws" },
              { field: "counterparty", operator: "startsWith", value: "google", negate: true },
            ],
          },
        ],
        action,
      }),
    ).toBe(
      "Amount is between 10.00 and 50.50 and Money goes out and (Description contains the word “aws” or Counterparty does not start with “google”)",
    );
    // A bank account and a source are named as a person names them.
    expect(
      when({
        name: "Card",
        match: "any",
        conditions: [
          { field: "account", operator: "is", value: "a-2100" },
          { field: "provider", operator: "is", value: "stripe" },
          { field: "amount", operator: "equals", value: "12.40" },
        ],
        action,
      }),
    ).toBe("Account is Credit card or Source is Stripe or Amount is exactly 12.40");
    expect(when({ name: "Everything", action })).toBe("Every transaction");
  });

  test("the history reads newest first, in UTC", () => {
    const rows = revisionsOf([
      {
        revision: 1,
        madeBy: { kind: "person" },
        madeAt: "2026-09-12T09:28:11.000Z",
        changed: ["created"],
      },
      {
        revision: 3,
        madeBy: { kind: "agent", name: "Claude" },
        madeAt: "2026-10-01T14:02:00.000Z",
        changed: ["conditions"],
        note: "Widened",
      },
    ]);
    expect(rows.map((row) => row.revision)).toEqual([3, 1]);
    expect(rows[0]).toMatchObject({
      at: shown.instant("2026-10-01T14:02:00.000Z"),
      by: { kind: "agent", name: "Claude" },
    });
    expect(stamp("2026-10-04T07:50:12.345Z")).toBe(shown.instant("2026-10-04T07:50:12.345Z"));
  });

  const result: RuleTestResult = {
    from: "2026-07-07",
    to: "2026-10-04",
    days: 90,
    problems: [],
    position: 2,
    inbox: {
      considered: 40,
      matched: 1,
      applies: 1,
      shadowed: 0,
      unusable: 0,
      truncated: false,
      samples: [
        {
          itemId: "i-1",
          date: "2026-09-28",
          description: "GITHUB, INC. 4829104",
          amount: "-21.00",
          accountId: "a-1010",
          outcome: "applies",
          legs: [
            { accountId: "a-1010", amount: "-21.00" },
            { accountId: "a-6100", amount: "21.00" },
          ],
          narration: "Software: GitHub",
        },
      ],
    },
    history: {
      considered: 172,
      matched: 3,
      applies: 1,
      shadowed: 1,
      unusable: 1,
      truncated: true,
      samples: [
        {
          date: "2026-08-28",
          description: "GITHUB",
          amount: "-21.00",
          accountId: "a-1010",
          outcome: "applies",
          bookedTo: "6300 Meals",
          bookedAccountId: "a-6300",
          agrees: false,
          legs: [
            { accountId: "a-1010", amount: "-21.00" },
            { accountId: "a-6100", amount: "21.00" },
          ],
        },
        {
          date: "2026-07-28",
          description: "GITHUB COPILOT",
          amount: "-10.00",
          accountId: "a-1010",
          outcome: "shadowed",
          shadowedBy: "Software (general)",
          bookedTo: "6100 Software",
          bookedAccountId: "a-6100",
        },
        {
          date: "2026-07-01",
          description: "GITHUB MARKETPLACE",
          amount: "-5.00",
          accountId: "a-1010",
          outcome: "unusable",
          reason: "6150 Subscriptions is closed",
        },
      ],
    },
    agreement: { agreed: 0, differed: 1, notComparable: 0 },
    lines: [],
    notes: ["A note"],
  };

  test("a check shows the entry a rule would suggest without the bank's own side", () => {
    const preview = previewOf(result, chart);
    expect(preview.inbox.samples[0]).toMatchObject({
      key: "i-1",
      outcome: "applies",
      wouldBook: [{ account: "Software", amount: "21.00" }],
      narration: "Software: GitHub",
    });
    expect(preview.history.truncated).toBe(true);
    expect(preview.notes).toEqual(["A note"]);
    expect(firstNarration(preview)).toBe("Software: GitHub");
    expect(firstNarration(null)).toBeUndefined();
  });

  test("a past booking somewhere else is flagged, an earlier rule is named, and a reason is given", () => {
    const [applies, shadowed, unusable] = previewOf(result, chart).history.samples;
    expect(applies).toMatchObject({ bookedTo: "Meals", differs: true });
    expect(shadowed).toMatchObject({
      outcome: "shadowed",
      detail: "By “Software (general)”",
      bookedTo: "Software",
      differs: false,
    });
    expect(unusable).toMatchObject({
      outcome: "unusable",
      detail: "6150 Subscriptions is closed",
      differs: false,
    });
  });

  test("a line that was tried shows what held, what did not, and what it would become", () => {
    const tried = tryOf(
      {
        index: 0,
        accountId: "a-1010",
        outcome: "applies",
        held: ["description contains “github”"],
        missed: [],
        kind: "categorize",
        legs: [
          { accountId: "a-1010", amount: "-12.40" },
          { accountId: "a-6100", amount: "12.40" },
        ],
        narration: "Software: GitHub",
      },
      chart,
    );
    expect(tried).toMatchObject({
      outcome: "applies",
      held: ["description contains “github”"],
      wouldBook: [{ account: "Software", amount: "12.40" }],
      kind: "booking it to an account",
      narration: "Software: GitHub",
    });
    expect(
      tryOf(
        {
          index: 0,
          accountId: "a-1010",
          outcome: "shadowed",
          shadowedBy: "AWS",
          held: [],
          missed: [],
        },
        chart,
      ).detail,
    ).toBe("AWS");
  });
});

describe("the classifier", () => {
  test("its figures keep their exact counts, and accounts are named", () => {
    const status: ClassifierStatus = {
      config: { enabled: true, minAgreement: 90, minMargin: 10, minExamples: 3, minKnownWords: 1 },
      ready: true,
      examples: 120,
      accounts: 4,
      vocabulary: 300,
      topAccounts: [],
      sources: { posted: 118, decisions: 2 },
      modelVersion: 2,
      trainedAt: "2026-10-04T07:50:12.000Z",
      trainedThroughRevision: "abc",
      evaluation: {
        config: {
          enabled: true,
          minAgreement: 90,
          minMargin: 10,
          minExamples: 3,
          minKnownWords: 1,
        },
        examples: 120,
        warmup: 5,
        scored: 100,
        proposed: 80,
        correct: 76,
        precision: { numerator: 76, denominator: 80, basisPoints: 9500 },
        recall: { numerator: 76, denominator: 100, basisPoints: 7600 },
        coverage: { numerator: 80, denominator: 100, basisPoints: 8000 },
        thresholds: [
          {
            minConfidence: 90,
            proposed: 50,
            correct: 49,
            precision: { numerator: 49, denominator: 50, basisPoints: 9800 },
            recall: { numerator: 49, denominator: 100, basisPoints: 4900 },
          },
        ],
        accounts: [
          {
            accountId: "a-6100",
            scored: 60,
            proposed: 50,
            correct: 48,
            precision: { numerator: 48, denominator: 50, basisPoints: 9600 },
            recall: { numerator: 48, denominator: 60, basisPoints: 8000 },
          },
        ],
        confusions: [{ actual: "a-6300", predicted: "a-6900", count: 3 }],
        method: "Replays",
        computedAt: "2026-10-04T07:50:12.000Z",
      },
      heldBack: 0,
      notes: ["a note"],
    };
    const view = classifierOf(status, chart);
    expect(view).toMatchObject({
      ready: true,
      examples: 120,
      posted: 118,
      decisions: 2,
      trainedAt: shown.instant("2026-10-04T07:50:12.000Z"),
      heldBack: 0,
      notes: ["a note"],
    });
    expect(view.evaluation?.precision).toEqual({
      numerator: 76,
      denominator: 80,
      basisPoints: 9500,
    });
    expect(view.evaluation?.accounts[0]?.account).toBe("Software");
    expect(view.evaluation?.confusions[0]).toEqual({
      actual: "Meals",
      predicted: "Personal",
      count: 3,
    });
    expect(
      classifierOf({ ...status, evaluation: null, trainedAt: null, heldBack: 7000 }, chart),
    ).toMatchObject({
      evaluation: null,
      trainedAt: null,
      heldBack: 7000,
    });
  });
});

describe("the chart", () => {
  test("accounts are offered grouped, expenses first, open ones only", () => {
    const groups = [...new Set(chart.bookable.map((option) => option.group))];
    expect(groups).toEqual(["Expenses", "Income", "Assets", "Liabilities", "Equity"]);
    expect(
      chart.bookable.filter((option) => option.group === "Expenses").map((o) => o.label),
    ).toEqual(["6100 · Software", "6300 · Meals", "6900 · Personal"]);
  });

  test("your own accounts are the assets and liabilities, in code order", () => {
    expect(chart.own.map((option) => option.label)).toEqual([
      "1010 · Checking",
      "1020 · Savings",
      "2100 · Credit card",
    ]);
  });

  test("an account that is not in the chart is named as such", () => {
    expect(chart.label("nope")).toBe("An account that is not in the chart");
    expect(chart.label("a-4000")).toBe("Sales");
    expect(chart.withCurrent(chart.own, ["gone"]).at(-1)).toMatchObject({
      value: "gone",
      label: "An account that is not in the chart",
    });
    // Nothing to add when everything is offered.
    expect(chart.withCurrent(chart.own, ["a-1010"])).toBe(chart.own);
  });
});
