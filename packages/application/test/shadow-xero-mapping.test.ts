import { expect, test } from "bun:test";
import { parseXeroChart, type XeroAccount } from "../src/shadow/xero/chart.ts";
import {
  type BookAccount,
  type Choice,
  compatible,
  matchChart,
  similarity,
  suggest,
} from "../src/shadow/xero/mapping.ts";
import { csv } from "./shadow-xero-fixtures.ts";

const book = (
  id: string,
  code: string,
  name: string,
  role: BookAccount["role"],
  extra: Partial<BookAccount> = {},
): BookAccount => ({ id, code, name, role, closedOn: null, roleKey: null, ...extra });

const BOOK: BookAccount[] = [
  book("a1000", "1000", "Business checking", "asset"),
  book("a1500", "1500", "Equipment", "asset"),
  book("a2000", "2000", "Business credit card", "liability"),
  book("a2500", "2500", "Sales tax payable", "liability", { roleKey: "tax.sales" }),
  book("a3900", "3900", "Opening balance equity", "equity"),
  book("a4000", "4000", "Sales", "income", { roleKey: "revenue.sales" }),
  book("a6000", "6000", "Software and subscriptions", "expense"),
  book("a6025", "6025", "Stripe fees", "expense", { roleKey: "stripe.fees" }),
];

const xero = (text: string): XeroAccount[] => [...parseXeroChart(text).accounts];
const chart = (...rows: string[][]) =>
  xero(csv([["*Code", "*Name", "*Type", "*Tax Code"], ...rows.map((row) => [...row, "x"])]));

const match = (
  accounts: XeroAccount[],
  extra: {
    saved?: Map<string, Choice>;
    overrides?: Map<string, Choice>;
    book?: BookAccount[];
  } = {},
) =>
  matchChart({
    xero: accounts,
    book: extra.book ?? BOOK,
    saved: extra.saved ?? new Map(),
    overrides: extra.overrides ?? new Map(),
  });

test("names say more than codes: the same name is a match, the same code alone is only a hint", () => {
  const proposals = match(
    chart(
      ["090", "Business checking", "Bank"],
      ["200", "Sales", "Revenue"],
      ["4000", "Sales", "Revenue"],
      ["1000", "Petty cash drawer", "Bank"],
    ),
  );
  const [checking, sales200, sales4000, petty] = proposals;
  // Same name, other code: likely.
  expect(checking).toMatchObject({ accountId: "a1000", basis: "name", confidence: "likely" });
  // Two Xero accounts named Sales: the one with the same code is certain and takes it.
  expect(sales4000).toMatchObject({ accountId: "a4000", confidence: "certain" });
  expect(sales200?.accountId).toBeNull();
  expect(sales200?.problems).toContain("target_taken");
  expect(sales200?.candidates).toContain("a4000");
  // The same code with a different name is not applied: the owner is shown it and decides.
  expect(petty?.accountId).toBeNull();
  expect(petty?.candidates[0]).toBe("a1000");
});

test("an account is only matched to the same kind of account", () => {
  expect(compatible("expense", "income")).toBe(false);
  expect(compatible("income", "gain")).toBe(true);
  expect(compatible(null, "asset")).toBe(true);
  const proposals = match(chart(["300", "Sales", "Expense"]));
  expect(proposals[0]?.accountId).toBeNull();
});

test("similar names are candidates to check and are not applied", () => {
  expect(similarity("Sales Tax", "Sales tax payable")).toBeGreaterThanOrEqual(0.8);
  expect(similarity("Rent", "Software")).toBe(0);
  expect(similarity("Business Checking", "business  checking")).toBe(1);
  const proposals = match(
    chart(["820", "Sales Tax", "Sales Tax"], ["710", "Computer Equipment", "Fixed Asset"]),
  );
  expect(proposals[0]).toMatchObject({ accountId: null, confidence: "none" });
  expect(proposals[0]?.candidates).toContain("a2500");
  expect(proposals[1]?.candidates).toContain("a1500");
});

test("a person's decision is never displaced, and says when its target is gone or closed or a different kind", () => {
  const accounts = chart(
    ["090", "Business checking", "Bank"],
    ["400", "Advertising", "Expense"],
    ["410", "Gone", "Expense"],
    ["420", "Closed", "Expense"],
  );
  const saved = new Map<string, Choice>([
    ["400", { accountId: "a6000", skip: false }],
    ["410", { accountId: "a9999", skip: false }],
    ["420", { accountId: "a1000", skip: false }],
  ]);
  const withClosed = BOOK.map((item) =>
    item.id === "a1000" ? { ...item, closedOn: "2026-01-01" } : item,
  );
  const proposals = match(accounts, { saved, book: withClosed });
  expect(proposals[1]).toMatchObject({ accountId: "a6000", basis: "saved", confidence: "certain" });
  expect(proposals[2]?.problems).toEqual(["target_missing"]);
  expect(proposals[3]?.problems).toEqual(expect.arrayContaining(["target_closed", "role_differs"]));
  // The saved choice on 1000 is taken, so the automatic match for the checking account gives way.
  expect(proposals[0]?.accountId).toBeNull();
  // An override beats a saved choice, and a skip is a decision too.
  const overridden = match(accounts, {
    saved,
    overrides: new Map<string, Choice>([
      ["400", { accountId: "a6025", skip: false }],
      ["410", { accountId: null, skip: true }],
    ]),
  });
  expect(overridden[1]).toMatchObject({ accountId: "a6025", basis: "override" });
  expect(overridden[2]).toMatchObject({ skip: true, accountId: null, confidence: "certain" });
});

test("several Xero accounts may be mapped to one account on purpose", () => {
  const accounts = chart(["400", "Advertising", "Expense"], ["401", "Marketing", "Expense"]);
  const saved = new Map<string, Choice>([
    ["400", { accountId: "a6000", skip: false }],
    ["401", { accountId: "a6000", skip: false }],
  ]);
  expect(match(accounts, { saved }).map((item) => item.accountId)).toEqual(["a6000", "a6000"]);
});

test("an account with no counterpart gets a suggestion from its Xero type and the templates", () => {
  const proposals = match(
    chart(
      ["830", "Stripe Fees", "Expense"],
      ["715", "Studio Furniture", "Fixed Asset"],
      ["990", "Mystery", "Spaceship"],
    ),
    { book: BOOK.filter((item) => item.id !== "a6025") },
  );
  const [fees, furniture, mystery] = proposals;
  // The template's Stripe fees account carries the role key the Stripe lane finds it by.
  expect(fees?.suggestion).toMatchObject({
    role: "expense",
    roleKey: "stripe.fees",
    like: "Stripe fees",
  });
  expect(furniture?.suggestion).toMatchObject({
    role: "asset",
    cashFlowClass: "investing",
    roleKey: null,
  });
  expect(mystery?.problems).toContain("unknown_role");
  expect(mystery?.suggestion).toBeNull();
  expect(suggest(furniture?.xero as XeroAccount, null)?.like).toBeNull();
});
