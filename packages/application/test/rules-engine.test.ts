import { expect, test } from "bun:test";
import type { Proposal } from "../src/ingest-types.ts";
import { sumMoney } from "../src/money.ts";
import {
  buildProposal,
  compileEntry,
  compileRule,
  createRulesProposer,
  firstMatch,
  prepareLine,
} from "../src/rules/engine.ts";
import { narrationProblem, renderNarration } from "../src/rules/narration.ts";
import { suggestRule } from "../src/rules/suggest.ts";
import type { RuleCondition, RuleDefinition } from "../src/rules/types.ts";
import { validateRule } from "../src/rules/validate.ts";
import {
  bankLine,
  categorize,
  CARD,
  CHECKING,
  contains,
  context,
  DRAW,
  FEES,
  group,
  HOSTING,
  item,
  MEALS,
  OLD,
  random,
  REVENUE,
  rule,
  SAVINGS,
  SOFTWARE,
  TRAVEL,
} from "./fixtures/rules-kit.ts";
import {
  ARABIC_INDIC_THREE_DOT_ZERO_ZERO,
  NUL,
  RIGHT_TO_LEFT_OVERRIDE,
} from "./fixtures/hostile.ts";
import { expectWithin } from "./support/budget.ts";

const chart = new Map(context.accounts.map((account) => [account.id, account]));

/** Does this single condition match this line? */
function holds(condition: RuleCondition, partial = {}, account: string | null = CHECKING) {
  return compileRule(rule({ conditions: [condition] })).matches(
    prepareLine(bankLine(partial), account),
  );
}

test("text operators match on canonical text", () => {
  const line = { description: "UBER *TRIP 8F2K3 HELP.UBER.COM", counterparty: "Uber Technologies" };
  expect(holds({ field: "description", operator: "contains", value: "uber trip" }, line)).toBe(
    true,
  );
  expect(holds({ field: "description", operator: "contains", value: "UBER-TRIP" }, line)).toBe(
    true,
  );
  expect(holds({ field: "description", operator: "startsWith", value: "uber" }, line)).toBe(true);
  expect(holds({ field: "description", operator: "endsWith", value: "uber com" }, line)).toBe(true);
  expect(
    holds(
      { field: "description", operator: "equals", value: "uber trip 8f2k3 help uber com" },
      line,
    ),
  ).toBe(true);
  expect(holds({ field: "description", operator: "wholeWord", value: "trip" }, line)).toBe(true);
  expect(holds({ field: "description", operator: "wholeWord", value: "tri" }, line)).toBe(false);
  expect(
    holds({ field: "counterparty", operator: "equals", value: "UBER TECHNOLOGIES" }, line),
  ).toBe(true);
  expect(holds({ field: "counterparty", operator: "contains", value: "lyft" }, line)).toBe(false);
});

test("a negated condition is the exact complement of the positive one, for every operator", () => {
  const operators = ["contains", "equals", "startsWith", "endsWith", "wholeWord"] as const;
  const descriptions = ["GITHUB, INC.", "github", "My GitHub Bill", "githubby", "", "GitHub-Pages"];
  const needles = ["github", "GITHUB INC", "hub", "bill", "github pages"];
  for (const operator of operators)
    for (const description of descriptions)
      for (const value of needles)
        for (const account of [CHECKING, null]) {
          const positive = holds(
            { field: "description", operator, value },
            { description },
            account,
          );
          const negative = holds(
            { field: "description", operator, value, negate: true },
            { description },
            account,
          );
          expect(negative, `${operator} ${description} ${value}`).toBe(!positive);
        }
});

test("a line with no counterparty has empty text there", () => {
  expect(holds({ field: "counterparty", operator: "contains", value: "x" })).toBe(false);
  expect(holds({ field: "counterparty", operator: "contains", value: "x", negate: true })).toBe(
    true,
  );
  expect(holds({ field: "reference", operator: "contains", value: "x", negate: true })).toBe(true);
});

test("amount conditions are exact cents on the absolute amount", () => {
  const at = (amount: string) => ({ amount });
  expect(holds({ field: "amount", operator: "equals", value: "42.17" }, at("-42.17"))).toBe(true);
  expect(holds({ field: "amount", operator: "equals", value: "42.17" }, at("42.17"))).toBe(true);
  expect(holds({ field: "amount", operator: "equals", value: "42.17" }, at("42.18"))).toBe(false);
  expect(
    holds({ field: "amount", operator: "range", min: "10.00", max: "50.00" }, at("-10.00")),
  ).toBe(true);
  expect(
    holds({ field: "amount", operator: "range", min: "10.00", max: "50.00" }, at("50.00")),
  ).toBe(true);
  expect(
    holds({ field: "amount", operator: "range", min: "10.00", max: "50.00" }, at("9.99")),
  ).toBe(false);
  expect(
    holds({ field: "amount", operator: "range", min: "10.00", max: "50.00" }, at("50.01")),
  ).toBe(false);
  expect(holds({ field: "amount", operator: "range", min: "10.00" }, at("1000000.00"))).toBe(true);
  expect(holds({ field: "amount", operator: "range", max: "10.00" }, at("0.00"))).toBe(true);
  // Cents beyond double precision still compare exactly.
  expect(
    holds(
      { field: "amount", operator: "equals", value: "90071992547409.93" },
      at("-90071992547409.93"),
    ),
  ).toBe(true);
  expect(
    holds(
      { field: "amount", operator: "equals", value: "90071992547409.93" },
      at("-90071992547409.94"),
    ),
  ).toBe(false);
  expect(holds({ field: "amount", operator: "range", min: "0.10", max: "0.10" }, at("0.10"))).toBe(
    true,
  );
  expect(holds({ field: "amount", operator: "range", min: "0.10", max: "0.10" }, at("0.11"))).toBe(
    false,
  );
});

test("an amount the provider got wrong matches nothing and never throws", () => {
  for (const amount of [
    "",
    "12",
    "12.5",
    "1e3",
    "NaN",
    "--5.00",
    ARABIC_INDIC_THREE_DOT_ZERO_ZERO,
  ]) {
    const line = prepareLine(bankLine({ amount }), CHECKING);
    expect(line.cents).toBeNull();
    const rules = [
      rule({ conditions: [{ field: "amount", operator: "range", min: "0.00" }] }),
      rule({ conditions: [{ field: "direction", operator: "is", value: "out" }] }),
    ];
    for (const definition of rules) expect(compileRule(definition).matches(line)).toBe(false);
    const proposer = createRulesProposer([{ ...rule(), id: "r", priority: 1 }]);
    expect(proposer.propose(item(bankLine({ amount })), context)).toEqual([]);
  }
});

test("direction, account and provider conditions", () => {
  expect(holds({ field: "direction", operator: "is", value: "in" }, { amount: "10.00" })).toBe(
    true,
  );
  expect(holds({ field: "direction", operator: "is", value: "in" }, { amount: "-10.00" })).toBe(
    false,
  );
  expect(holds({ field: "direction", operator: "is", value: "out" }, { amount: "-10.00" })).toBe(
    true,
  );
  // A zero amount moves in neither direction.
  expect(holds({ field: "direction", operator: "is", value: "in" }, { amount: "0.00" })).toBe(
    false,
  );
  expect(holds({ field: "direction", operator: "is", value: "out" }, { amount: "0.00" })).toBe(
    false,
  );
  expect(holds({ field: "account", operator: "is", value: CHECKING })).toBe(true);
  expect(holds({ field: "account", operator: "is", value: SAVINGS })).toBe(false);
  expect(holds({ field: "account", operator: "is", value: CHECKING }, {}, null)).toBe(false);
  expect(holds({ field: "provider", operator: "is", value: "csv" })).toBe(true);
  expect(holds({ field: "provider", operator: "is", value: "CSV" })).toBe(true);
  expect(holds({ field: "provider", operator: "is", value: "stripe" })).toBe(false);
  expect(holds({ field: "provider", operator: "is", value: "stripe", negate: true })).toBe(true);
});

test("AND and OR groups combine as written", () => {
  const github = contains("github");
  const stripe = contains("stripe");
  const small = { field: "amount", operator: "range", max: "100.00" } as const;
  const lineWith = (description: string, amount: string) =>
    prepareLine(bankLine({ description, amount }), CHECKING);
  const matches = (definition: RuleDefinition, description: string, amount: string) =>
    compileRule(definition).matches(lineWith(description, amount));
  // (github OR stripe) AND small
  const either = rule({ conditions: [small], groups: [group("any", github, stripe)] });
  expect(matches(either, "GITHUB", "-10.00")).toBe(true);
  expect(matches(either, "STRIPE", "-10.00")).toBe(true);
  expect(matches(either, "OTHER", "-10.00")).toBe(false);
  expect(matches(either, "GITHUB", "-500.00")).toBe(false);
  // top-level any: github, or (stripe AND small)
  const loose = rule({ match: "any", conditions: [github], groups: [group("all", stripe, small)] });
  expect(matches(loose, "GITHUB", "-500.00")).toBe(true);
  expect(matches(loose, "STRIPE", "-10.00")).toBe(true);
  expect(matches(loose, "STRIPE", "-500.00")).toBe(false);
  // groups alone
  expect(
    matches(rule({ conditions: [], groups: [group("all", github, small)] }), "GITHUB", "-5.00"),
  ).toBe(true);
  // Nothing to test means nothing matches, not everything.
  expect(matches(rule({ conditions: [], groups: [] }), "GITHUB", "-5.00")).toBe(false);
  expect(matches(rule({ match: "any", conditions: [], groups: [] }), "GITHUB", "-5.00")).toBe(
    false,
  );
  expect(matches(rule({ conditions: [], groups: [group("any")] }), "GITHUB", "-5.00")).toBe(false);
});

test("a rule that cannot be understood never matches, even negated", () => {
  const broken: RuleCondition[] = [
    { field: "amount", operator: "range" },
    { field: "amount", operator: "range", min: "9.00", max: "1.00" },
    { field: "amount", operator: "equals", value: "x" },
    { field: "direction", operator: "is", value: "sideways" },
    { field: "description", operator: "range" as never, value: "x" },
    { field: "description", operator: "contains", value: "***" },
    { field: "description", operator: "contains" },
    { field: "account", operator: "is" },
    { field: "nonsense" as never, operator: "is", value: "x" },
  ];
  for (const condition of broken)
    for (const negate of [false, true])
      expect(holds({ ...condition, negate }), JSON.stringify(condition)).toBe(false);
});

test("the first enabled matching rule decides, in priority order", () => {
  const rules = [
    {
      ...rule({
        name: "Specific",
        conditions: [contains("github sponsors")],
        action: categorize(FEES),
      }),
      id: "a",
      priority: 1,
    },
    {
      ...rule({ name: "Disabled", enabled: false, conditions: [contains("github")] }),
      id: "b",
      priority: 2,
    },
    {
      ...rule({ name: "General", conditions: [contains("github")], action: categorize(SOFTWARE) }),
      id: "c",
      priority: 3,
    },
  ].map(compileEntry);
  const pick = (description: string) =>
    firstMatch(rules, prepareLine(bankLine({ description }), CHECKING))?.id;
  expect(pick("GITHUB SPONSORS")).toBe("a");
  expect(pick("GITHUB INC")).toBe("c");
  expect(pick("OTHER")).toBeUndefined();
});

test("a rule scoped to all accounts is evaluated, and priority is shared with scoped rules", () => {
  // Bigcapital fetched all-account rules and never evaluated them. Here they decide, and a
  // higher-priority all-accounts rule beats a lower-priority account-specific one.
  const proposer = createRulesProposer([
    {
      ...rule({
        name: "Everywhere",
        accountIds: [],
        conditions: [contains("github")],
        action: categorize(HOSTING),
      }),
      id: "all",
      priority: 1,
    },
    {
      ...rule({
        name: "Checking only",
        accountIds: [CHECKING],
        conditions: [contains("github")],
        action: categorize(SOFTWARE),
      }),
      id: "one",
      priority: 2,
    },
  ]);
  const on = (account: string) =>
    proposer.propose(item(bankLine(), { ledgerAccountId: account }), context)[0];
  expect(on(CHECKING)?.proposer).toBe("rule:all");
  expect(on(SAVINGS)?.proposer).toBe("rule:all");
  const reversed = createRulesProposer([
    {
      ...rule({
        name: "Checking only",
        accountIds: [CHECKING],
        conditions: [contains("github")],
        action: categorize(SOFTWARE),
      }),
      id: "one",
      priority: 1,
    },
    {
      ...rule({
        name: "Everywhere",
        accountIds: [],
        conditions: [contains("github")],
        action: categorize(HOSTING),
      }),
      id: "all",
      priority: 2,
    },
  ]);
  const under = (account: string) =>
    reversed.propose(item(bankLine(), { ledgerAccountId: account }), context)[0];
  expect(under(CHECKING)?.proposer).toBe("rule:one");
  expect(under(SAVINGS)?.proposer).toBe("rule:all");
});

function only(proposals: readonly Proposal[]): Proposal {
  expect(proposals).toHaveLength(1);
  return proposals[0] as Proposal;
}

test("categorize proposes a balanced entry with the bank leg, for money out and money in", () => {
  const proposer = createRulesProposer([{ ...rule(), id: "r1", name: "GitHub", priority: 1 }]);
  const out = only(proposer.propose(item(bankLine({ amount: "-42.17" })), context));
  expect(out.kind).toBe("categorize");
  expect(out.proposer).toBe("rule:r1");
  expect(out.confidence).toBe(1);
  expect(out.legs).toEqual([
    { accountId: CHECKING, amount: "-42.17" },
    { accountId: SOFTWARE, amount: "42.17" },
  ]);
  expect(sumMoney((out.legs ?? []).map((leg) => leg.amount))).toBe("0.00");
  const into = only(proposer.propose(item(bankLine({ amount: "10.00" })), context));
  expect(into.legs).toEqual([
    { accountId: CHECKING, amount: "10.00" },
    { accountId: SOFTWARE, amount: "-10.00" },
  ]);
  expect(out.reasons.length).toBeGreaterThan(0);
  expect(out.reasons.join(" ")).toContain("GitHub");
  expect(out.reasons.join(" ")).toContain("6100 Software");
});

test("a split books exact cents across accounts and the legs always sum to zero", () => {
  const split = rule({
    conditions: [contains("github")],
    action: {
      kind: "split",
      allocations: [
        { accountId: SOFTWARE, percent: "60" },
        { accountId: HOSTING, percent: "40" },
      ],
    },
  });
  const proposer = createRulesProposer([{ ...split, id: "s", priority: 1 }]);
  const proposal = only(proposer.propose(item(bankLine({ amount: "-10.01" })), context));
  expect(proposal.legs).toEqual([
    { accountId: CHECKING, amount: "-10.01" },
    { accountId: SOFTWARE, amount: "6.01" },
    { accountId: HOSTING, amount: "4.00" },
  ]);
  const next = random(5);
  for (let run = 0; run < 300; run++) {
    const cents = 1 + Math.floor(next() * 5_000_000);
    const amount = `${next() < 0.5 ? "-" : ""}${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
    const result = proposer.propose(item(bankLine({ amount })), context);
    const legs = only(result).legs ?? [];
    expect(sumMoney(legs.map((leg) => leg.amount))).toBe("0.00");
    expect(legs).toHaveLength(3);
  }
});

test("a split that cannot be carried out proposes nothing instead of a wrong entry", () => {
  const fixedOnly = rule({
    action: {
      kind: "split",
      allocations: [
        { accountId: SOFTWARE, amount: "30.00" },
        { accountId: HOSTING, amount: "30.00" },
      ],
    },
  });
  const built = (amount: string) =>
    buildProposal(
      compileEntry({ ...fixedOnly, id: "x", priority: 1 }),
      prepareLine(bankLine({ amount }), CHECKING),
      chart,
    );
  expect(built("-60.00").ok).toBe(true);
  const under = built("-59.99");
  expect(under.ok ? "" : under.reason).toContain("more than the line");
  const over = built("-60.01");
  expect(over.ok ? "" : over.reason).toContain("do not add up");
});

test("transfer and exclude proposals", () => {
  const transfer = rule({
    conditions: [contains("transfer to savings")],
    action: { kind: "transfer", accountId: SAVINGS, narration: "Move to savings" },
  });
  const exclude = rule({
    conditions: [contains("personal")],
    action: { kind: "exclude", reason: "Personal spending, not the business" },
  });
  const proposer = createRulesProposer([
    { ...transfer, id: "t", priority: 1 },
    { ...exclude, id: "e", priority: 2 },
  ]);
  const moved = only(
    proposer.propose(
      item(bankLine({ description: "Online Transfer to Savings 1234", amount: "-500.00" })),
      context,
    ),
  );
  expect(moved.kind).toBe("transfer");
  expect(moved.narration).toBe("Move to savings");
  expect(moved.legs).toEqual([
    { accountId: CHECKING, amount: "-500.00" },
    { accountId: SAVINGS, amount: "500.00" },
  ]);
  const left = only(
    proposer.propose(item(bankLine({ description: "PERSONAL PURCHASE" })), context),
  );
  expect(left.kind).toBe("exclude");
  expect(left.legs).toBeUndefined();
  expect(left.reasons.join(" ")).toContain("Personal spending");
});

test("a rule whose account closed, is missing, or is the bank itself proposes nothing", () => {
  const propose = (action: RuleDefinition["action"]) =>
    createRulesProposer([{ ...rule({ action }), id: "r", priority: 1 }]).propose(
      item(bankLine()),
      context,
    );
  expect(propose(categorize(OLD))).toEqual([]);
  expect(propose(categorize("nowhere"))).toEqual([]);
  expect(propose(categorize(CHECKING))).toEqual([]);
  expect(propose({ kind: "categorize" })).toEqual([]);
  expect(propose({ kind: "transfer", accountId: SOFTWARE })).toEqual([]);
  // The decisive rule failing does not let a lower rule decide in its place.
  const proposer = createRulesProposer([
    { ...rule({ action: categorize(OLD) }), id: "first", priority: 1 },
    { ...rule({ action: categorize(SOFTWARE) }), id: "second", priority: 2 },
  ]);
  expect(proposer.propose(item(bankLine()), context)).toEqual([]);
});

test("the proposer is silent for lines it cannot decide", () => {
  const proposer = createRulesProposer([{ ...rule(), id: "r", priority: 1 }]);
  expect(proposer.propose(item(bankLine(), { ledgerAccountId: null }), context)).toEqual([]);
  for (const status of ["drafted", "posted", "excluded"] as const)
    expect(proposer.propose(item(bankLine(), { status }), context)).toEqual([]);
  expect(proposer.propose(item(bankLine(), { status: "proposed" }), context)).toHaveLength(1);
  const event = {
    kind: "event",
    provider: "stripe",
    accountKey: "stripe:acct_1:usd",
    rawIndex: 0,
    providerId: "txn_1",
    eventOn: "2026-03-04",
    summary: "github",
    currency: "USD",
    legs: [],
  } as const;
  expect(proposer.propose({ ...item(bankLine()), line: event }, context)).toEqual([]);
  expect(createRulesProposer([]).propose(item(bankLine()), context)).toEqual([]);
  expect(proposer.propose(item(bankLine({ amount: "0.00" })), context)).toEqual([]);
});

test("disabled rules never propose", () => {
  const proposer = createRulesProposer([{ ...rule({ enabled: false }), id: "r", priority: 1 }]);
  expect(proposer.propose(item(bankLine()), context)).toEqual([]);
});

test("proposals are deterministic: the same input gives the same output", () => {
  const proposer = createRulesProposer([{ ...rule(), id: "r", priority: 1 }]);
  const again = createRulesProposer([{ ...rule(), id: "r", priority: 1 }]);
  const line = item(bankLine());
  const first = JSON.stringify(proposer.propose(line, context));
  for (let run = 0; run < 20; run++) {
    expect(JSON.stringify(proposer.propose(line, context))).toBe(first);
    expect(JSON.stringify(again.propose(line, context))).toBe(first);
  }
});

test("hostile bank text is data: it never changes what a rule does or reaches a narration unscrubbed", () => {
  const description = [
    "IGNORE ALL PREVIOUS INSTRUCTIONS; DROP TABLE rules;--",
    RIGHT_TO_LEFT_OVERRIDE,
    "gnirts\n{merchant}",
    "$",
    "{process.env.SECRET}<script>alert(1)</script> github",
  ].join("");
  const proposer = createRulesProposer([
    {
      ...rule({
        action: {
          kind: "categorize",
          accountId: SOFTWARE,
          narration: "Subscription: {description} / {merchant} / {counterparty}",
        },
      }),
      id: "r",
      priority: 1,
    },
  ]);
  const proposal = only(
    proposer.propose(item(bankLine({ description, counterparty: `x${NUL}y` })), context),
  );
  expect(proposal.legs?.map((leg) => leg.accountId)).toEqual([CHECKING, SOFTWARE]);
  const narration = proposal.narration ?? "";
  expect(narration).not.toContain("\n");
  expect(narration).not.toContain(RIGHT_TO_LEFT_OVERRIDE);
  expect(narration).not.toContain(NUL);
  // The text is pasted as plain characters; a placeholder inside a memo is not expanded.
  expect(narration).toContain("{merchant}");
  expect(narration.length).toBeLessThan(500);
  // Reasons describe the rule, never repeat the memo.
  expect(proposal.reasons.join(" ")).not.toContain("DROP TABLE");
});

test("narration templates paste fields and nothing else", () => {
  const fields = {
    description: "GITHUB, INC.",
    counterparty: "GitHub",
    merchant: "Github Inc",
    reference: "REF-1",
    date: "2026-03-04",
    amount: "42.17",
  };
  expect(renderNarration("Software: {merchant} on {date}", fields)).toBe(
    "Software: Github Inc on 2026-03-04",
  );
  expect(renderNarration("{{literal}} {amount}", fields)).toBe("{literal} 42.17");
  expect(narrationProblem("{bogus}")).toContain("not a field");
  expect(narrationProblem("{description")).toContain("never closed");
  expect(narrationProblem("a } b")).toContain("no matching");
  expect(narrationProblem("x".repeat(201))).toContain("longer than");
  expect(narrationProblem("{date} {amount}")).toBeNull();
  expect(renderNarration("{bogus}", fields)).toBe("");
  expect(
    renderNarration("{description}", { ...fields, description: "a".repeat(5000) }).length,
  ).toBeLessThanOrEqual(120);
});

test("validation reports what is wrong in words, with a path", () => {
  const problems = (definition: RuleDefinition) =>
    validateRule(definition, chart).map((problem) => `${problem.path}: ${problem.message}`);
  expect(problems(rule())).toEqual([]);
  expect(problems(rule({ name: "  " }))).toEqual(["name: Give the rule a name"]);
  expect(problems(rule({ conditions: [], groups: [] }))[0]).toContain("at least one condition");
  expect(
    problems(
      rule({ conditions: [{ field: "description", operator: "contains", value: "***" }] }),
    )[0],
  ).toContain("conditions[0].value");
  expect(problems(rule({ conditions: [{ field: "amount", operator: "range" }] }))[0]).toContain(
    "conditions[0].min",
  );
  expect(
    problems(
      rule({ conditions: [{ field: "amount", operator: "range", min: "9", max: "1.00" }] }),
    )[0],
  ).toContain("two decimals");
  expect(
    problems(
      rule({ conditions: [{ field: "amount", operator: "range", min: "9.00", max: "1.00" }] }),
    )[0],
  ).toContain("below the smallest");
  expect(
    problems(rule({ conditions: [{ field: "direction", operator: "is", value: "up" }] }))[0],
  ).toContain("Direction");
  expect(
    problems(rule({ conditions: [{ field: "account", operator: "is", value: "nowhere" }] }))[0],
  ).toContain("chart");
  expect(problems(rule({ groups: [{ mode: "any", conditions: [] }] }))[0]).toContain("groups[0]");
  expect(problems(rule({ action: categorize(OLD) }))[0]).toContain("closed");
  expect(problems(rule({ action: categorize("nowhere") }))[0]).toContain("not in the chart");
  expect(problems(rule({ action: { kind: "transfer", accountId: SOFTWARE } }))[0]).toContain(
    "asset or liability",
  );
  expect(problems(rule({ action: { kind: "transfer", accountId: CARD } }))).toEqual([]);
  expect(problems(rule({ action: { kind: "categorize" } }))[0]).toContain("Choose an account");
  expect(problems(rule({ accountIds: [CHECKING], action: categorize(CHECKING) }))[0]).toContain(
    "account the line is on",
  );
  expect(problems(rule({ action: { kind: "exclude", accountId: SOFTWARE } }))[0]).toContain(
    "no account",
  );
  expect(
    problems(
      rule({
        action: {
          kind: "split",
          allocations: [
            { accountId: SOFTWARE, percent: "60" },
            { accountId: HOSTING, percent: "30" },
          ],
        },
      }),
    )[0],
  ).toContain("90.00");
  expect(
    problems(rule({ action: { kind: "categorize", accountId: SOFTWARE, narration: "{nope}" } }))[0],
  ).toContain("not a field");
  expect(
    problems(rule({ action: { kind: "categorize", accountId: SOFTWARE, reason: "why" } }))[0],
  ).toContain("exclusion");
  expect(problems(rule({ accountIds: ["nowhere"] }))[0]).toContain("accountIds[0]");
  expect(
    problems(rule({ conditions: [{ field: "provider", operator: "is", value: "has space" }] }))[0],
  ).toContain("Name the source");
  expect(problems(rule({ action: categorize(DRAW) }))).toEqual([]);
});

test("a suggested rule always matches the line it was generalised from", () => {
  const lines: { description: string; counterparty?: string; amount: string }[] = [
    { description: "AMZN Mktp US*2K4AB5 AMZN.COM/BILL WA", amount: "-23.99" },
    { description: "POS DEBIT SQ *BLUE BOTTLE COFFEE 1234 OAKLAND CA", amount: "-6.50" },
    { description: "UBER *TRIP 8F2K3 HELP.UBER.COM", amount: "-18.20" },
    { description: "STRIPE TRANSFER ST-8F3K2L", counterparty: "Stripe", amount: "1250.00" },
    { description: "ATT*BILL PAYMENT", amount: "-80.00" },
    { description: "1234 STARBUCKS #99", amount: "-4.25" },
    { description: "GITHUB, INC. SAN FRANCISCO CA", amount: "-4.00" },
  ];
  for (const input of lines) {
    const suggestion = suggestRule(input);
    expect(suggestion.rule, input.description).not.toBeNull();
    const definition = suggestion.rule as RuleDefinition;
    const prepared = prepareLine(
      bankLine({
        description: input.description,
        amount: input.amount,
        ...(input.counterparty ? { counterparty: input.counterparty } : {}),
      }),
      CHECKING,
    );
    expect(compileRule(definition).matches(prepared), input.description).toBe(true);
    // And not the opposite direction: a refund from the same name is not caught.
    const opposite = prepareLine(
      bankLine({
        description: input.description,
        amount: input.amount.startsWith("-") ? "5.00" : "-5.00",
        ...(input.counterparty ? { counterparty: input.counterparty } : {}),
      }),
      CHECKING,
    );
    expect(compileRule(definition).matches(opposite)).toBe(false);
  }
  // A short single name must match as a whole word, or "att" would catch "seattle".
  const att = suggestRule({ description: "ATT 2K4AB5", amount: "-80.00" });
  expect(att.rule?.conditions[0]).toEqual({
    field: "description",
    operator: "wholeWord",
    value: "att",
  });
  expect(
    compileRule(att.rule as RuleDefinition).matches(
      prepareLine(bankLine({ description: "SEATTLE COFFEE", amount: "-3.00" }), CHECKING),
    ),
  ).toBe(false);
  expect(
    suggestRule({ description: "ATT*BILL PAYMENT", amount: "-80.00" }).rule?.conditions[0]?.value,
  ).toBe("att bill");
  expect(suggestRule({ description: "1234567890", amount: "-1.00" }).rule).toBeNull();
  expect(suggestRule({ description: "ACH WEB PAYMENT", amount: "-1.00" }).rule).toBeNull();
  const named = suggestRule({
    description: "x",
    counterparty: "Acme Corp NY",
    amount: "5.00",
    categoryAccountId: REVENUE,
  });
  expect(named.rule?.name).toBe("Acme Corp");
  expect(named.rule?.action).toEqual({ kind: "categorize", accountId: REVENUE });
  expect(named.basis?.field).toBe("counterparty");
});

test("many rules over many lines stay fast", () => {
  const rules = Array.from({ length: 300 }, (_, index) => ({
    ...rule({
      name: `Rule ${index}`,
      conditions: [
        contains(`merchant${index} shop`),
        { field: "amount", operator: "range", min: "1.00", max: "999.00" },
      ],
      action: categorize(index % 2 ? SOFTWARE : HOSTING),
    }),
    id: `r${index}`,
    priority: index + 1,
  }));
  const proposer = createRulesProposer(rules);
  const items = Array.from({ length: 5000 }, (_, index) =>
    item(
      bankLine({
        description: `MERCHANT${(index * 7) % 400} SHOP #${index} NEW YORK NY`,
        amount: `-${10 + (index % 90)}.${String(index % 100).padStart(2, "0")}`,
      }),
      { id: `i${index}` },
    ),
  );
  const started = performance.now();
  let proposed = 0;
  for (const entry of items) proposed += proposer.propose(entry, context).length;
  const elapsed = performance.now() - started;
  expect(proposed).toBeGreaterThan(3000);
  // 300 rules x 5,000 lines: the budget is generous; the measured time goes in the lane doc.
  expectWithin("300 rules over 5,000 lines", elapsed, 5000);
  console.log(`rules performance: 300 rules x 5,000 lines in ${elapsed.toFixed(0)} ms`);
});

test("travel and meals rules keep money in and out apart", () => {
  const proposer = createRulesProposer([
    {
      ...rule({
        name: "Refund",
        conditions: [contains("uber"), { field: "direction", operator: "is", value: "in" }],
        action: categorize(TRAVEL),
      }),
      id: "refund",
      priority: 1,
    },
    {
      ...rule({
        name: "Rides",
        conditions: [contains("uber trip"), { field: "direction", operator: "is", value: "out" }],
        action: categorize(TRAVEL),
      }),
      id: "rides",
      priority: 2,
    },
    {
      ...rule({ name: "Eats", conditions: [contains("uber eats")], action: categorize(MEALS) }),
      id: "eats",
      priority: 3,
    },
  ]);
  const by = (description: string, amount: string) =>
    proposer.propose(item(bankLine({ description, amount })), context)[0]?.proposer;
  expect(by("UBER *TRIP", "-10.00")).toBe("rule:rides");
  expect(by("UBER *TRIP", "10.00")).toBe("rule:refund");
  expect(by("UBER EATS", "-20.00")).toBe("rule:eats");
});
