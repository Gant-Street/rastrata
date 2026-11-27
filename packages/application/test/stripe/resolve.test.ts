import { expect, test } from "bun:test";
import { ApplicationError } from "../../src/errors.ts";
import {
  type ChartAccount,
  type RoleResolution,
  type StripeSettings,
  accountOf,
  isReady,
  rejectUnusableChoices,
  resolveRoles,
  unresolvedRoles,
} from "../../src/slices/stripe/settings.ts";

/** Which account each Stripe role uses on a date: what the owner chose, else the one open account
 * the chart's role key names on that date, and nothing else. Pure, so every case is cheap. */

const chart: ChartAccount[] = [
  { id: "1100", code: "1100", role: "asset", closedOn: null },
  { id: "1110", code: "1110", role: "asset", closedOn: null },
  { id: "2500", code: "2500", role: "liability", closedOn: null },
  { id: "4000", code: "4000", role: "income", closedOn: null },
  { id: "4010", code: "4010", role: "income", closedOn: null },
  { id: "4100", code: "4100", role: "income", closedOn: null },
  { id: "6025", code: "6025", role: "expense", closedOn: null },
  { id: "6026", code: "6026", role: "expense", closedOn: null },
  { id: "6040", code: "6040", role: "expense", closedOn: null },
];

/** A tag history: from each date on, an account carries a role key. */
type History = Record<string, [from: string, key: string | null][]>;
const keys =
  (history: History) =>
  (accountId: string, asOf: string): string | undefined => {
    let current: string | undefined;
    for (const [from, key] of history[accountId] ?? [])
      if (from <= asOf) current = key ?? undefined;
    return current;
  };

const TEMPLATE: History = {
  "1100": [["0001-01-01", "stripe.balance"]],
  "1110": [["0001-01-01", "payouts.in-transit"]],
  "2500": [["0001-01-01", "tax.sales"]],
  "4000": [["0001-01-01", "revenue.sales"]],
  "4100": [["0001-01-01", "refunds"]],
  "6025": [["0001-01-01", "stripe.fees"]],
  "6026": [["0001-01-01", "chargebacks"]],
};

const settings = (
  mapping: StripeSettings["mapping"] = [],
  salesTax: StripeSettings["salesTax"] = "stripe",
): Pick<StripeSettings, "mapping" | "salesTax"> => ({ mapping, salesTax });
const of = (roles: RoleResolution[], role: string): RoleResolution => {
  const found = roles.find((r) => r.role === role);
  if (!found) throw new Error(`no ${role}`);
  return found;
};

test("with nothing chosen, each role takes the one open account that carries its key, and the optional one is merely missing", () => {
  const roles = resolveRoles(settings(), chart, keys(TEMPLATE), "2026-03-09");
  expect(roles).toHaveLength(8);
  for (const [role, account] of [
    ["stripe.balance", "1100"],
    ["payouts.in-transit", "1110"],
    ["tax.sales", "2500"],
    ["revenue.sales", "4000"],
    ["refunds", "4100"],
    ["stripe.fees", "6025"],
    ["chargebacks", "6026"],
  ] as const)
    expect(of(roles, role)).toMatchObject({
      state: "tagged",
      accountId: account,
      code: account,
      required: true,
      problem: null,
    });
  expect(of(roles, "stripe.adjustments")).toMatchObject({
    state: "missing",
    required: false,
    accountId: null,
  });
  expect(isReady(roles)).toBe(true);
  expect(unresolvedRoles(roles)).toEqual([]);
  expect(accountOf(roles, "stripe.fees")).toBe("6025");
  expect(accountOf(roles, "stripe.adjustments")).toBeNull();
});

test("an account the owner chose wins over the key, and is checked like any other", () => {
  const roles = resolveRoles(
    settings([{ role: "refunds", accountId: "6026" }]),
    chart,
    keys(TEMPLATE),
    "2026-03-09",
  );
  expect(of(roles, "refunds")).toMatchObject({ state: "chosen", accountId: "6026" });
  expect(of(roles, "chargebacks")).toMatchObject({ state: "tagged", accountId: "6026" });
  // Not in the chart, closed, or the wrong kind: said plainly, by code.
  const bad = resolveRoles(
    settings([
      { role: "stripe.fees", accountId: "9999" },
      { role: "refunds", accountId: "1100" },
      { role: "chargebacks", accountId: "4010" },
    ]),
    chart.map((a) => (a.id === "4010" ? { ...a, closedOn: "2026-03-01" } : a)),
    keys(TEMPLATE),
    "2026-03-09",
  );
  expect(of(bad, "stripe.fees")).toMatchObject({ state: "unusable", accountId: null });
  expect(of(bad, "stripe.fees").problem).toBe(
    "The account chosen for Stripe fees is no longer in the chart. Choose another account.",
  );
  expect(of(bad, "refunds").problem).toBe(
    "Refunds must be an income or expense account; 1100 is asset. Choose another account.",
  );
  expect(of(bad, "chargebacks").problem).toBe(
    "Account 4010, chosen for Chargebacks and disputes, is closed. Choose another account.",
  );
  expect(isReady(bad)).toBe(false);
  expect(unresolvedRoles(bad).map((r) => r.role)).toEqual([
    "stripe.fees",
    "refunds",
    "chargebacks",
  ]);
});

test("nothing is guessed from a name or a code: an account without the key is not used, and the missing role is named", () => {
  const roles = resolveRoles(
    settings(),
    chart,
    keys({ "1100": TEMPLATE["1100"] ?? [] }),
    "2026-03-09",
  );
  expect(of(roles, "stripe.balance").state).toBe("tagged");
  for (const role of ["stripe.fees", "payouts.in-transit", "refunds", "revenue.sales"]) {
    expect(of(roles, role)).toMatchObject({ state: "missing", accountId: null });
    expect(of(roles, role).problem).toContain(`role key ${role}`);
    expect(of(roles, role).problem).toContain("Choose one here");
  }
  expect(isReady(roles)).toBe(false);
  expect(unresolvedRoles(roles).map((r) => r.role)).toEqual([
    "stripe.fees",
    "payouts.in-transit",
    "refunds",
    "chargebacks",
    "tax.sales",
    "revenue.sales",
  ]);
});

test("two open accounts with one key are ambiguous, listed by code, and a closed one does not count", () => {
  const twice: History = { ...TEMPLATE, "4010": [["0001-01-01", "revenue.sales"]] };
  const ambiguous = resolveRoles(settings(), chart, keys(twice), "2026-03-09");
  expect(of(ambiguous, "revenue.sales")).toMatchObject({ state: "ambiguous", accountId: null });
  expect(of(ambiguous, "revenue.sales").problem).toBe(
    "Accounts 4000, 4010 all carry the role key revenue.sales, so Rastrata cannot tell which is Sales. Choose one here, or leave the key on one account.",
  );
  // Choosing settles it.
  const chosen = resolveRoles(
    settings([{ role: "revenue.sales", accountId: "4010" }]),
    chart,
    keys(twice),
    "2026-03-09",
  );
  expect(of(chosen, "revenue.sales")).toMatchObject({ state: "chosen", accountId: "4010" });
  // Or closing the other.
  const closed = resolveRoles(
    settings(),
    chart.map((a) => (a.id === "4000" ? { ...a, closedOn: "2026-02-01" } : a)),
    keys(twice),
    "2026-03-09",
  );
  expect(of(closed, "revenue.sales")).toMatchObject({ state: "tagged", accountId: "4010" });
});

test("the key is read on the date asked for: a move on the 10th gives the old account before and the new one from then", () => {
  const moved: History = {
    ...TEMPLATE,
    "4000": [
      ["0001-01-01", "revenue.sales"],
      ["2026-03-10", null],
    ],
    "4010": [["2026-03-10", "revenue.sales"]],
  };
  const on = (date: string) =>
    accountOf(resolveRoles(settings(), chart, keys(moved), date), "revenue.sales");
  expect(on("2026-03-09")).toBe("4000");
  expect(on("2026-03-10")).toBe("4010");
  expect(on("2026-12-31")).toBe("4010");
  // The day before the new key begins, neither carries it only if the move had a gap; here none.
  const gap: History = { ...moved, "4010": [["2026-04-01", "revenue.sales"]] };
  const mid = resolveRoles(settings(), chart, keys(gap), "2026-03-20");
  expect(of(mid, "revenue.sales")).toMatchObject({ state: "missing" });
});

test("an account closed on the day, or before it, is not open for an entry on that day", () => {
  const closedOn = (date: string | null) =>
    chart.map((a) => (a.id === "6025" ? { ...a, closedOn: date } : a));
  expect(
    of(
      resolveRoles(settings(), closedOn("2026-03-09"), keys(TEMPLATE), "2026-03-09"),
      "stripe.fees",
    ).state,
  ).toBe("missing");
  expect(
    of(
      resolveRoles(settings(), closedOn("2026-03-10"), keys(TEMPLATE), "2026-03-09"),
      "stripe.fees",
    ).state,
  ).toBe("tagged");
});

test("a key on the wrong kind of account is reported as unusable with the account's code and the way out", () => {
  const wrong: History = {
    ...TEMPLATE,
    "4000": [],
    "6025": [["0001-01-01", "revenue.sales"]],
    "4010": [["0001-01-01", "stripe.fees"]],
  };
  const roles = resolveRoles(settings(), chart, keys(wrong), "2026-03-09");
  expect(of(roles, "revenue.sales")).toMatchObject({ state: "unusable", code: "6025" });
  expect(of(roles, "revenue.sales").problem).toBe(
    "Sales must be an income account; 6025 is expense. It carries the role key revenue.sales: choose another account here, or move the key.",
  );
  expect(of(roles, "stripe.fees")).toMatchObject({ state: "unusable", code: "4010" });
});

test("the Stripe balance is its own account: no other role may use it, chosen or tagged", () => {
  const roles = resolveRoles(
    settings([{ role: "payouts.in-transit", accountId: "1100" }]),
    chart,
    keys(TEMPLATE),
    "2026-03-09",
  );
  expect(of(roles, "stripe.balance")).toMatchObject({ state: "tagged", accountId: "1100" });
  expect(of(roles, "payouts.in-transit")).toMatchObject({ state: "unusable", accountId: null });
  expect(of(roles, "payouts.in-transit").problem).toBe(
    "Payouts in transit cannot use account 1100: it is the Stripe balance. Choose another account here, or move the role key.",
  );
});

test("sales tax is needed only when it is split, and an unresolved optional role never blocks", () => {
  const noTax: History = { ...TEMPLATE, "2500": [] };
  const split = resolveRoles(settings([], "stripe"), chart, keys(noTax), "2026-03-09");
  expect(of(split, "tax.sales")).toMatchObject({ required: true, state: "missing" });
  expect(isReady(split)).toBe(false);
  const none = resolveRoles(settings([], "none"), chart, keys(noTax), "2026-03-09");
  expect(of(none, "tax.sales")).toMatchObject({ required: false, state: "missing" });
  expect(isReady(none)).toBe(true);
  expect(of(none, "stripe.adjustments").required).toBe(false);
});

test("a choice that cannot work is refused when it is made; what the chart gives is only reported", () => {
  const choice = settings([{ role: "refunds", accountId: "1100" }]);
  const roles = resolveRoles(choice, chart, keys(TEMPLATE), "2026-03-09");
  expect(() => rejectUnusableChoices(choice, roles)).toThrow(ApplicationError);
  try {
    rejectUnusableChoices(choice, roles);
  } catch (error) {
    expect((error as ApplicationError).code).toBe("stripe_settings_invalid");
    expect((error as ApplicationError).message).toContain("1100 is asset");
  }
  // The same trouble from the chart's key (an expense account tagged as sales) is not an error here.
  const tagged = resolveRoles(
    settings(),
    chart,
    keys({ ...TEMPLATE, "4000": [], "6025": [["0001-01-01", "revenue.sales"]] }),
    "2026-03-09",
  );
  expect(of(tagged, "revenue.sales").state).toBe("unusable");
  expect(() => rejectUnusableChoices(settings(), tagged)).not.toThrow();
});
