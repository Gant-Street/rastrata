import { expect, test } from "bun:test";
import type { BankTransaction } from "../../src/agent/bank-wire.ts";
import { PROVIDER, accountKeyOf, normaliseTransactions } from "../../src/banks/normalise.ts";

const KEY = "bank:fca_1ABC";
const at = (day: number, hour = 8): number => Date.UTC(2026, 9, day, hour) / 1000;

const tx = (overrides: Partial<BankTransaction> = {}): BankTransaction => ({
  id: "fctxn_1",
  amount: -1000,
  currency: "usd",
  description: "Rocket Rides",
  status: "posted",
  transactedAt: at(3),
  postedAt: at(4),
  updated: at(5),
  ...overrides,
});

const run = (transactions: BankTransaction[], kind: "checking" | "credit_card" = "checking") =>
  normaliseTransactions({ kind }, transactions, { accountKey: KEY });

test("the account key is the provider and Stripe's identifier, and nothing else can be a key", () => {
  expect(accountKeyOf("fca_1ABC")).toBe(KEY);
  expect(PROVIDER).toBe("bank");
  for (const bad of ["", "ab", "has space", "semi;colon", "x".repeat(65), "fca_é"])
    expect(accountKeyOf(bad)).toBeNull();
});

test("a posted transaction becomes a bank line in exact two-place money, dated by the day the bank posted it", () => {
  const { lines, counts, held } = run([tx()]);
  expect(held).toEqual([]);
  expect(counts).toEqual({ received: 1, imported: 1, pending: 0, repeated: 0, held: 0 });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({
    kind: "bankLine",
    provider: "bank",
    accountKey: KEY,
    providerId: "fctxn_1",
    rawIndex: 0,
    postedOn: "2026-10-04",
    amount: "-10.00",
    currency: "USD",
    description: "Rocket Rides",
  });
  expect(JSON.parse(lines[0]?.excerpt ?? "{}")).toMatchObject({ id: "fctxn_1", amount: -1000 });
});

test("the sign is Stripe's: money out is negative and money in is positive, and cents are never rounded", () => {
  const { lines } = run([
    tx({ id: "a", amount: 5 }),
    tx({ id: "b", amount: -5 }),
    tx({ id: "c", amount: 123456789 }),
    tx({ id: "d", amount: 0 }),
    tx({ id: "e", amount: -100 }),
  ]);
  expect(lines.map((line) => line.amount)).toEqual([
    "0.05",
    "-0.05",
    "1234567.89",
    "0.00",
    "-1.00",
  ]);
});

test("a transaction with no posted time is dated by when it happened, and one with neither a usable time is held", () => {
  const { lines, held, counts } = run([
    tx({ id: "a", postedAt: null, transactedAt: at(7) }),
    tx({ id: "b", postedAt: null, transactedAt: 0 }),
  ]);
  expect(lines.map((line) => line.postedOn)).toEqual(["2026-10-07"]);
  expect(held).toEqual([
    expect.objectContaining({ key: "id:b", id: "b", reason: expect.stringContaining("date") }),
  ]);
  expect(counts.held).toBe(1);
});

test("pending and voided transactions are left until the bank has posted them, and are counted", () => {
  const { lines, counts } = run([
    tx({ id: "a", status: "pending", postedAt: null }),
    tx({ id: "b", status: "void", postedAt: null }),
    tx({ id: "c" }),
  ]);
  expect(lines.map((line) => line.providerId)).toEqual(["c"]);
  expect(counts).toMatchObject({ received: 3, imported: 1, pending: 2 });
});

test("an amount that is not a whole number of cents is held with its reason, and never stops the rest", () => {
  const { lines, held, counts } = run([
    tx({ id: "a", amount: 10.5 }),
    tx({ id: "b", amount: Number.NaN }),
    tx({ id: "c", amount: 2 ** 60 }),
    tx({ id: "d" }),
  ]);
  expect(lines.map((line) => line.providerId)).toEqual(["d"]);
  expect(held.map((item) => item.id)).toEqual(["a", "b", "c"]);
  expect(held[0]?.reason).toContain("whole number of cents");
  expect(counts).toMatchObject({ received: 4, imported: 1, held: 3 });
});

test("an identifier the pipeline cannot take, or a currency that is not a code, is held", () => {
  const { lines, held } = run([
    tx({ id: "" }),
    tx({ id: " padded " }),
    tx({ id: "with\u0007bell" }),
    tx({ id: "ok", currency: "dollars" }),
    tx({ id: "fine", currency: "eur" }),
  ]);
  expect(lines.map((line) => [line.providerId, line.currency])).toEqual([["fine", "EUR"]]);
  expect(held).toHaveLength(4);
  expect(held.filter((item) => item.id === null)).toHaveLength(3);
  // A held transaction's own text is never in the reason.
  for (const item of held) expect(item.reason).not.toContain("bell");
});

test("the same transaction twice in one call is one line; a repeat that disagrees is kept, for the pipeline to flag", () => {
  const { lines, counts } = run([
    tx({ id: "a" }),
    tx({ id: "a" }),
    tx({ id: "b" }),
    tx({ id: "b", amount: -2000 }),
  ]);
  expect(lines.map((line) => [line.providerId, line.amount])).toEqual([
    ["a", "-10.00"],
    ["b", "-10.00"],
    ["b", "-20.00"],
  ]);
  expect(counts.repeated).toBe(1);
});

test("a description is kept as received and long ones are not cut here (the pipeline bounds and flags them)", () => {
  const text = "  PAYMENT\u202e TO ACME  ";
  const { lines } = run([tx({ description: text })]);
  expect(lines[0]?.description).toBe(text);
});
