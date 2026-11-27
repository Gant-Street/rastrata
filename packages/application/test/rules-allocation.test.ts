import { expect, test } from "bun:test";
import {
  allocate,
  type AllocationSpec,
  checkAllocations,
  formatPercent,
  parsePercent,
} from "../src/rules/allocation.ts";
import { formatMoney, parseMoney } from "../src/money.ts";
import { random } from "./fixtures/rules-kit.ts";

const cents = (value: string) => parseMoney(value);
const sum = (parts: readonly { cents: bigint }[]) =>
  parts.reduce((all, part) => all + part.cents, 0n);

test("percentages are hundredths of a percent and nothing else", () => {
  expect(parsePercent("50")).toBe(5000n);
  expect(parsePercent("33.33")).toBe(3333n);
  expect(parsePercent("0.01")).toBe(1n);
  expect(parsePercent("100")).toBe(10000n);
  expect(parsePercent("100.00")).toBe(10000n);
  for (const bad of [
    "",
    "0",
    "0.00",
    "100.01",
    "101",
    "-5",
    "5.",
    ".5",
    "1e2",
    "33.333",
    "abc",
    " 5",
    "5 ",
    "1,5",
  ])
    expect(parsePercent(bad)).toBeNull();
  expect(formatPercent(3333n)).toBe("33.33");
  expect(formatPercent(5000n)).toBe("50.00");
  expect(formatPercent(1n)).toBe("0.01");
});

test("a three-way split of 100.00 adds up exactly, with the odd cent to the largest remainder", () => {
  const result = allocate(cents("100.00"), [
    { accountId: "a", percent: "33.33" },
    { accountId: "b", percent: "33.33" },
    { accountId: "c", percent: "33.34" },
  ]);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.parts.map((part) => formatMoney(part.cents))).toEqual(["33.33", "33.33", "33.34"]);
  expect(sum(result.parts)).toBe(10000n);
});

test("rounding cents go one each to the largest fractional remainders, earlier part first on ties", () => {
  // 10.01 split 60/40: exact 6.006 and 4.004. Floors 6.00 + 4.00 leave one cent for the larger remainder.
  const sixty = allocate(cents("10.01"), [
    { accountId: "a", percent: "60" },
    { accountId: "b", percent: "40" },
  ]);
  expect(sixty.ok && sixty.parts.map((part) => formatMoney(part.cents))).toEqual(["6.01", "4.00"]);
  // 0.01 split 50/50: one cent cannot be halved; the earlier part takes it.
  const half = allocate(cents("0.01"), [
    { accountId: "a", percent: "50" },
    { accountId: "b", percent: "50" },
  ]);
  expect(half.ok && half.parts).toEqual([{ accountId: "a", cents: 1n }]);
  // 0.02 split three ways: two cents, three parts; the first two parts get one each.
  const three = allocate(cents("0.02"), [
    { accountId: "a", percent: "33.33" },
    { accountId: "b", percent: "33.33" },
    { accountId: "c", percent: "33.34" },
  ]);
  expect(three.ok && sum(three.parts)).toBe(2n);
});

test("fixed amounts come first, the rest takes what is left", () => {
  const result = allocate(cents("250.00"), [
    { accountId: "a", amount: "100.00" },
    { accountId: "b", percent: "50" },
    { accountId: "c", rest: true },
  ]);
  expect(
    result.ok && result.parts.map((part) => [part.accountId, formatMoney(part.cents)]),
  ).toEqual([
    ["a", "100.00"],
    ["b", "75.00"],
    ["c", "75.00"],
  ]);
});

test("the part that takes the rest absorbs the cents rounding loses, visibly", () => {
  const result = allocate(cents("10.01"), [
    { accountId: "a", percent: "33.33" },
    { accountId: "b", percent: "33.33" },
    { accountId: "c", rest: true },
  ]);
  expect(result.ok && result.parts.map((part) => formatMoney(part.cents))).toEqual([
    "3.33",
    "3.33",
    "3.35",
  ]);
});

test("a split is refused rather than guessed", () => {
  const reason = (total: string, specs: AllocationSpec[]) => {
    const result = allocate(cents(total), specs);
    return result.ok ? null : result.reason;
  };
  expect(
    reason("10.00", [
      { accountId: "a", amount: "7.00" },
      { accountId: "b", amount: "7.00" },
    ]),
  ).toContain("more than the line");
  expect(
    reason("10.00", [
      { accountId: "a", amount: "4.00" },
      { accountId: "b", amount: "5.00" },
    ]),
  ).toContain("do not add up");
  expect(
    reason("10.00", [
      { accountId: "a", percent: "60" },
      { accountId: "b", percent: "30" },
    ]),
  ).toContain("90.00");
  expect(reason("10.00", [{ accountId: "a", percent: "60" }])).toContain("at least two");
  expect(
    reason("10.00", [
      { accountId: "a", percent: "50" },
      { accountId: "a", percent: "50" },
    ]),
  ).toContain("twice");
  expect(
    reason("10.00", [
      { accountId: "a", percent: "50", amount: "1.00" },
      { accountId: "b", rest: true },
    ]),
  ).toContain("exactly one");
  expect(
    reason("10.00", [
      { accountId: "a", rest: true },
      { accountId: "b", rest: true },
    ]),
  ).toContain("Only one");
  expect(
    reason("10.00", [
      { accountId: "a", percent: "100" },
      { accountId: "b", rest: true },
    ]),
  ).toContain("leave nothing");
  expect(
    reason("0.00", [
      { accountId: "a", percent: "50" },
      { accountId: "b", percent: "50" },
    ]),
  ).toContain("nothing to split");
  expect(
    checkAllocations([
      { accountId: "a", amount: "-1.00" },
      { accountId: "b", rest: true },
    ]),
  ).toContain("A fixed amount must be a positive amount with two decimals");
  expect(
    checkAllocations([
      { accountId: "a", amount: "1.5" },
      { accountId: "b", rest: true },
    ]),
  ).toHaveLength(1);
});

test("a split of any amount adds up to the exact cent (property)", () => {
  const next = random(2026);
  const accounts = ["a", "b", "c", "d", "e"];
  for (let run = 0; run < 3000; run++) {
    // Amounts from one cent to more than a trillion dollars; no float can hold the larger ones.
    const magnitude = Math.floor(next() * 15);
    const total =
      BigInt(1 + Math.floor(next() * 9)) * 10n ** BigInt(magnitude) +
      BigInt(Math.floor(next() * 100));
    const count = 2 + Math.floor(next() * 4);
    // Random percentages in hundredths summing to exactly 100.00.
    const cuts = Array.from({ length: count - 1 }, () => 1 + Math.floor(next() * 9998)).sort(
      (x, y) => x - y,
    );
    const points: number[] = [];
    let previous = 0;
    for (const cut of [...cuts, 10000]) {
      points.push(cut - previous);
      previous = cut;
    }
    if (points.some((value) => value < 1)) continue;
    const specs: AllocationSpec[] = points.map((value, index) => ({
      accountId: accounts[index] as string,
      percent: formatPercent(BigInt(value)),
    }));
    const result = allocate(total, specs);
    expect(result.ok).toBe(true);
    if (!result.ok) continue;
    expect(sum(result.parts)).toBe(total);
    // Every part is within one cent of its exact share.
    for (const [index, part] of result.parts.entries()) {
      const spec = specs.find((item) => item.accountId === part.accountId) as AllocationSpec;
      const exact = (total * (parsePercent(spec.percent as string) as bigint)) / 10000n;
      expect(part.cents >= exact && part.cents <= exact + 1n, `run ${run} part ${index}`).toBe(
        true,
      );
    }
  }
});

test("fixed, percentage and rest parts together always add up (property)", () => {
  const next = random(99);
  for (let run = 0; run < 2000; run++) {
    const total = BigInt(100 + Math.floor(next() * 1_000_000_000));
    const fixed = BigInt(1 + Math.floor((next() * Number(total)) / 3));
    const basis = 1 + Math.floor(next() * 9000);
    const result = allocate(total, [
      { accountId: "a", amount: formatMoney(fixed) },
      { accountId: "b", percent: formatPercent(BigInt(basis)) },
      { accountId: "c", rest: true },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(sum(result.parts)).toBe(total);
  }
});
