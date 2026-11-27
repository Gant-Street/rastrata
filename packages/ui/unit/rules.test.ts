import { describe, expect, test } from "bun:test";
import {
  addCondition,
  addGroup,
  addPart,
  amountBoxes,
  blankCondition,
  blankDraft,
  conditionPath,
  defaultOp,
  fieldId,
  opsFor,
  removeCondition,
  removeGroup,
  removePart,
  setGroupMode,
  setPartKind,
  setScopeAccount,
  splitOp,
  updateCondition,
  updatePart,
  withActionKind,
  withField,
} from "../src/rules/draft";
import { formatCount, formatMoney } from "../src/format";
import { basisText, percentOfCounts, ratioText } from "../src/rules/format";
import { words } from "../src/rules/words";

describe("the rule draft", () => {
  test("a new draft has one blank condition and nothing else", () => {
    const draft = blankDraft();
    expect(draft.conditions).toHaveLength(1);
    expect(draft.groups).toEqual([]);
    expect(draft.scope).toBe("all");
    expect(draft.enabled).toBe(true);
    expect(draft.action.kind).toBe("categorize");
  });

  test("every step returns a new draft and leaves the old one alone", () => {
    const draft = blankDraft();
    const before = JSON.stringify(draft);
    const next = addCondition(draft, null);
    expect(JSON.stringify(draft)).toBe(before);
    expect(next.conditions).toHaveLength(2);
    const grouped = addGroup(draft);
    expect(draft.groups).toHaveLength(0);
    expect(grouped.groups).toHaveLength(1);
    expect(grouped.groups[0]?.conditions).toHaveLength(1);
    expect(JSON.stringify(draft)).toBe(before);
  });

  test("conditions are changed and removed where they are, top level or in a group", () => {
    let draft = addGroup(addCondition(blankDraft(), null));
    draft = updateCondition(draft, { group: null, index: 1 }, (condition) => ({
      ...condition,
      value: "github",
    }));
    draft = updateCondition(draft, { group: 0, index: 0 }, (condition) => ({
      ...condition,
      value: "stripe",
    }));
    expect(draft.conditions.map((condition) => condition.value)).toEqual(["", "github"]);
    expect(draft.groups[0]?.conditions[0]?.value).toBe("stripe");
    draft = removeCondition(draft, { group: null, index: 0 });
    expect(draft.conditions.map((condition) => condition.value)).toEqual(["github"]);
    draft = addCondition(draft, 0);
    expect(draft.groups[0]?.conditions).toHaveLength(2);
    draft = removeCondition(draft, { group: 0, index: 0 });
    expect(draft.groups[0]?.conditions.map((condition) => condition.value)).toEqual([""]);
    draft = setGroupMode(draft, 0, "all");
    expect(draft.groups[0]?.mode).toBe("all");
    draft = removeGroup(draft, 0);
    expect(draft.groups).toEqual([]);
  });

  test("each field offers only the operators that suit it, and starts on a sensible one", () => {
    expect(opsFor("description")).toContain("not:contains");
    expect(opsFor("description")).not.toContain("between");
    expect(opsFor("amount")).toContain("between");
    expect(opsFor("amount")).not.toContain("contains");
    expect(opsFor("direction")).toEqual(["is", "not:is"]);
    expect(defaultOp("counterparty")).toBe("contains");
    expect(defaultOp("amount")).toBe("between");
    expect(defaultOp("account")).toBe("is");
    for (const field of [
      "description",
      "counterparty",
      "reference",
      "amount",
      "direction",
    ] as const)
      expect(opsFor(field)).toContain(defaultOp(field));
  });

  test("a choice in the how list splits into an operator and a negation", () => {
    expect(splitOp("contains")).toEqual({ operator: "contains", negate: false });
    expect(splitOp("not:startsWith")).toEqual({ operator: "startsWith", negate: true });
    expect(splitOp("not:is")).toEqual({ operator: "is", negate: true });
  });

  test("changing what is tested starts the condition over but keeps its row", () => {
    const condition = { ...blankCondition("description"), value: "github", op: "not:contains" };
    const changed = withField(condition, "amount");
    expect(changed.key).toBe(condition.key);
    expect(changed.field).toBe("amount");
    expect(changed.op).toBe("between");
    expect(changed.value).toBe("");
    // The same field again changes nothing.
    expect(withField(condition, "description")).toBe(condition);
  });

  test("an amount test shows the boxes it needs", () => {
    expect(amountBoxes("between")).toEqual(["min", "max"]);
    expect(amountBoxes("not:between")).toEqual(["min", "max"]);
    expect(amountBoxes("atLeast")).toEqual(["min"]);
    expect(amountBoxes("not:atLeast")).toEqual(["min"]);
    expect(amountBoxes("atMost")).toEqual(["max"]);
    expect(amountBoxes("exactly")).toEqual(["value"]);
  });

  test("a different kind of action keeps what still applies and drops what does not", () => {
    const draft = blankDraft();
    const categorize = { ...draft.action, accountId: "acct-1", narration: "Software: {merchant}" };
    const transfer = withActionKind(categorize, "transfer");
    expect(transfer.accountId).toBe("acct-1");
    expect(transfer.narration).toBe("Software: {merchant}");
    const split = withActionKind(categorize, "split");
    expect(split.accountId).toBe("");
    expect(split.parts.map((part) => part.kind)).toEqual(["percent", "rest"]);
    const exclude = withActionKind({ ...split, reason: "" }, "exclude");
    expect(exclude.narration).toBe("");
    expect(exclude.parts).toEqual([]);
    // Coming back from exclude, the reason is gone.
    expect(withActionKind({ ...exclude, reason: "Personal" }, "categorize").reason).toBe("");
    // The same kind again changes nothing.
    expect(withActionKind(categorize, "categorize")).toBe(categorize);
  });

  test("only one part of a split can take the rest", () => {
    let draft = { ...blankDraft(), action: withActionKind(blankDraft().action, "split") };
    draft = addPart(draft);
    expect(draft.action.parts).toHaveLength(3);
    // Part 2 takes the rest at first; give it to part 1 and part 2 moves to a percentage.
    draft = setPartKind(draft, 0, "rest");
    expect(draft.action.parts.map((part) => part.kind)).toEqual(["rest", "percent", "percent"]);
    draft = updatePart(draft, 1, (part) => ({ ...part, value: "40" }));
    expect(draft.action.parts[1]?.value).toBe("40");
    // A part that takes the rest has no number of its own.
    draft = setPartKind(draft, 1, "rest");
    expect(draft.action.parts[1]?.value).toBe("");
    expect(draft.action.parts[0]?.kind).toBe("percent");
    draft = removePart(draft, 2);
    expect(draft.action.parts).toHaveLength(2);
  });

  test("accounts are added to and removed from the scope without duplicates", () => {
    let draft = blankDraft();
    draft = setScopeAccount(draft, "a", true);
    draft = setScopeAccount(draft, "b", true);
    draft = setScopeAccount(draft, "a", true);
    expect(draft.accountIds.sort()).toEqual(["a", "b"]);
    draft = setScopeAccount(draft, "a", false);
    expect(draft.accountIds).toEqual(["b"]);
  });

  test("a problem's path becomes a stable, valid element id", () => {
    expect(fieldId("name")).toBe("rule-name");
    expect(fieldId("conditions[0].value")).toBe("rule-conditions-0-value");
    expect(fieldId("groups[1].conditions[2].min")).toBe("rule-groups-1-conditions-2-min");
    expect(fieldId("action.allocations[0].accountId")).toBe("rule-action-allocations-0-accountId");
    expect(fieldId("conditions")).toBe("rule-conditions");
    // No two different paths in one rule share an id.
    const paths = [
      "conditions[0].value",
      "conditions[1].value",
      "groups[0].conditions[0].value",
      "groups[0].conditions[1].value",
    ];
    expect(new Set(paths.map(fieldId)).size).toBe(paths.length);
    expect(conditionPath({ group: null, index: 3 }, "field")).toBe("conditions[3].field");
    expect(conditionPath({ group: 1, index: 0 }, "max")).toBe("groups[1].conditions[0].max");
  });
});

describe("reading aids", () => {
  test("amounts are grouped as text and never rounded", () => {
    expect(formatMoney("1234567.80")).toBe("1,234,567.80");
    expect(formatMoney("-1234.50")).toBe("\u22121,234.50");
    expect(formatMoney("12.00")).toBe("12.00");
    expect(formatMoney("999.99")).toBe("999.99");
    expect(formatMoney("1000.00")).toBe("1,000.00");
    // A half-typed amount is shown as typed.
    expect(formatMoney("12.")).toBe("12.");
    expect(formatMoney("")).toBe("");
    expect(formatMoney("abc")).toBe("abc");
    expect(formatMoney("1e3")).toBe("1e3");
    // Exactness: 17 digits survive.
    expect(formatMoney("12345678901234567.89")).toBe("12,345,678,901,234,567.89");
  });

  test("percentages are whole numbers rounded down, or absent when there is nothing to divide", () => {
    expect(percentOfCounts(1, 3)).toBe(33);
    expect(percentOfCounts(2, 3)).toBe(66);
    expect(percentOfCounts(3, 3)).toBe(100);
    expect(percentOfCounts(0, 5)).toBe(0);
    expect(percentOfCounts(0, 0)).toBeNull();
  });

  test("a ratio in hundredths of a percent is shown to one decimal, rounded down", () => {
    expect(basisText(9231)).toBe("92.3%");
    expect(basisText(10000)).toBe("100.0%");
    expect(basisText(9999)).toBe("99.9%");
    expect(basisText(5)).toBe("0.0%");
    expect(basisText(0)).toBe("0.0%");
    expect(basisText(null)).toBe("—");
    expect(ratioText(12, 1200)).toBe("12 of 1,200");
    expect(formatCount(1234567)).toBe("1,234,567");
  });
});

describe("the words", () => {
  test("counts read as plain English, singular and plural", () => {
    expect(words.figureBody(1, 1, 90)).toContain("1 of 1 transaction ");
    expect(words.figureBody(1, 1, 90)).toContain(" is decided by a rule");
    expect(words.figureBody(12, 40, 90)).toContain("12 of 40 transactions");
    expect(words.figureBody(12, 40, 90)).toContain(" are decided by a rule");
    expect(words.previewShadowed(1)).toBe(
      "1 transaction matches but an earlier rule decides it first.",
    );
    expect(words.previewShadowed(3)).toBe(
      "3 transactions match but an earlier rule decides them first.",
    );
    expect(words.classifierLearned(1, 1)).toBe("Learned from 1 transaction across 1 account.");
    expect(words.classifierLearned(1200, 14)).toBe(
      "Learned from 1,200 transactions across 14 accounts.",
    );
  });

  test("nothing claims that a rule booked anything", () => {
    const sentences: string[] = [
      words.intro,
      words.pageLine,
      words.listEmptyBody,
      words.figureCaveat,
      words.previewChangesNothing,
      words.previewMatches(3, 10, 90),
      words.figureBody(3, 10, 90),
    ];
    for (const sentence of sentences)
      expect(sentence.toLowerCase()).not.toMatch(
        /\bhas booked\b|\bwere posted by\b|\bautomatically posts?\b/,
      );
    // The one thing said about booking is that a person still decides.
    expect(words.intro).toContain("nothing is recorded until you accept");
  });

  test("the moves are announced with the rule's name and its new place", () => {
    expect(words.moved("GitHub", 2, 9)).toBe("Moved GitHub to position 2 of 9.");
    expect(words.moveUp("GitHub")).toBe("Move GitHub up");
    expect(words.removeCondition("Condition 2")).toBe("Remove condition 2");
  });

  test("every operator offered has a label, and none is left as its code", () => {
    for (const field of ["description", "counterparty", "reference"] as const)
      for (const op of opsFor(field)) expect(words.textOps[op]).toBeDefined();
    for (const op of opsFor("amount")) expect(words.amountOps[op]).toBeDefined();
    for (const op of opsFor("direction")) expect(words.isOps[op]).toBeDefined();
    for (const field of Object.keys(words.fieldNames))
      expect(words.fieldNames[field as keyof typeof words.fieldNames]).toBeTruthy();
  });
});
