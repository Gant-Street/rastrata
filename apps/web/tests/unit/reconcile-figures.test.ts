import { expect, test } from "bun:test";
import type { Reconciliation } from "@rastrata/application/client-contracts";
import { centsOf, columnTotals, figuresFor, totalOf } from "../../src/routes/reconcile/figures";
import { expectWithin } from "../support/budget.ts";

type Line = Reconciliation["lines"][number];
const line = (postingId: string, amount: string): Line => ({
  postingId,
  journalId: `j-${postingId}`,
  date: "2026-01-02",
  narration: postingId,
  amount,
  selected: false,
});

test("the difference on the screen is exact where a float is not", () => {
  const lines = [line("a", "0.10"), line("b", "0.20"), line("c", "-0.05")];
  const cents = centsOf(lines);
  const draft = { openingBalance: "0.00", statementBalance: "0.25" };
  // 0.1 + 0.2 - 0.05 is 0.25000000000000006 in floating point; in cents it is exactly 25.
  const figures = figuresFor(draft, cents, new Set(["a", "b", "c"]));
  expect(figures.difference).toBe("0.00");
  expect(figures.canComplete).toBe(true);
  expect(figuresFor(draft, cents, new Set(["a", "b"])).difference).toBe("-0.05");
  expect(figuresFor(draft, cents, new Set()).difference).toBe("0.25");
});

test("amounts beyond 2^53 and a single cent stay exact", () => {
  const lines = [line("big", "9007199254740993.01"), line("fee", "-0.10")];
  const cents = centsOf(lines);
  const figures = figuresFor(
    { openingBalance: "0.00", statementBalance: "9007199254740992.91" },
    cents,
    new Set(["big", "fee"]),
  );
  expect(figures.clearedBalance).toBe("9007199254740992.91");
  expect(figures.difference).toBe("0.00");
  expect(
    figuresFor(
      { openingBalance: "0.00", statementBalance: "9007199254740992.92" },
      cents,
      new Set(["big", "fee"]),
    ).difference,
  ).toBe("0.01");
});

test("an opening balance continues from the earlier statement", () => {
  const lines = [line("a", "100.00"), line("b", "-14.00")];
  const figures = figuresFor(
    { openingBalance: "1190.00", statementBalance: "1276.00" },
    centsOf(lines),
    new Set(["a", "b"]),
  );
  expect(figures.selectedTotal).toBe("86.00");
  expect(figures.clearedBalance).toBe("1276.00");
  expect(figures.difference).toBe("0.00");
});

test("a selection that names a line the draft does not have changes nothing", () => {
  const lines = [line("a", "5.00")];
  const figures = figuresFor(
    { openingBalance: "0.00", statementBalance: "5.00" },
    centsOf(lines),
    new Set(["a", "ghost"]),
  );
  expect(figures.selectedCount).toBe(1);
  expect(figures.difference).toBe("0.00");
});

test("column totals split money out from money in, in exact positive amounts", () => {
  const lines = [
    line("a", "1000.00"),
    line("b", "-40.10"),
    line("c", "-19.90"),
    line("d", "250.00"),
  ];
  const cents = centsOf(lines);
  expect(columnTotals(lines, cents, new Set(["a", "b", "c", "d"]))).toEqual({
    out: { count: 2, total: "60.00" },
    in: { count: 2, total: "1250.00" },
  });
  expect(columnTotals(lines, cents, new Set(["b"]))).toEqual({
    out: { count: 1, total: "40.10" },
    in: { count: 0, total: "0.00" },
  });
  expect(totalOf([line("x", "-0.01"), line("y", "-0.02")])).toBe("0.03");
});

test("five thousand lines are summed in well under a frame", () => {
  const lines = Array.from({ length: 5000 }, (_, index) =>
    line(
      `p${index}`,
      `${index % 2 ? "-" : ""}${(index % 977) + 1}.${String(index % 100).padStart(2, "0")}`,
    ),
  );
  const cents = centsOf(lines);
  const all = new Set(lines.map((entry) => entry.postingId));
  const started = performance.now();
  for (let round = 0; round < 20; round++)
    figuresFor({ openingBalance: "0.00", statementBalance: "0.00" }, cents, all);
  expectWithin("one round of figures for a large account", (performance.now() - started) / 20, 16);
});
