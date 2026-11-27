import { expect, test } from "bun:test";
import { formatBytes, formatMoney } from "../src/format";
import { safeText, shownName } from "../src/statements/format";
import {
  emptyMapping,
  indexOf,
  isComplete,
  joinValues,
  missingParts,
  refFor,
  splitValues,
  withAmountKind,
  withOptional,
} from "../src/statements/mapping-model";
import type { ColumnInfo, ImportMapping } from "../src/statements/types";

const columns: ColumnInfo[] = [
  { index: 1, header: "Posting Date", samples: ["01/02/2026"] },
  { index: 2, header: "  Description ", samples: ["STAPLES"] },
  { index: 3, header: "Amount", samples: ["-12.34"] },
  { index: 4, header: "", samples: ["x"] },
];

test("a column is named by header when the file has one, and always by position", () => {
  expect(refFor(columns, 1, 1)).toEqual({ header: "Posting Date", index: 1 });
  expect(refFor(columns, 2, 1)).toEqual({ header: "Description", index: 2 });
  expect(refFor(columns, 4, 1)).toEqual({ index: 4 });
  expect(refFor(columns, 1, 0)).toEqual({ index: 1 });
  expect(refFor(columns, 9, 1)).toEqual({ index: 9 });
});

test("a reference finds its column by name first, then by position, then not at all", () => {
  expect(indexOf(columns, { header: "posting  date", index: 7 })).toBe(1);
  expect(indexOf(columns, { header: "Gone", index: 3 })).toBe(3);
  expect(indexOf(columns, { index: 9 })).toBe(0);
  expect(indexOf(columns, undefined)).toBe(0);
  expect(indexOf(columns, {})).toBe(0);
});

test("a mapping is complete only when every part the service needs is named", () => {
  const base = emptyMapping(1);
  expect(isComplete(base)).toBe(false);
  expect(missingParts(base)).toEqual([
    "the date column",
    "the amount column",
    "the description column",
  ]);
  const signed: ImportMapping = {
    ...base,
    date: { index: 1 },
    amount: { kind: "signed", amount: { index: 3 } },
    description: [{ index: 2 }],
  };
  expect(isComplete(signed)).toBe(true);
  expect(missingParts(signed)).toEqual([]);
  const split: ImportMapping = { ...signed, amount: { kind: "debitCredit", debit: { index: 3 } } };
  expect(isComplete(split)).toBe(false);
  expect(missingParts(split)).toEqual(["the money in column"]);
  const direction: ImportMapping = {
    ...signed,
    amount: {
      kind: "direction",
      amount: { index: 3 },
      direction: { index: 4 },
      outValues: [],
      inValues: ["C"],
    },
  };
  expect(isComplete(direction)).toBe(false);
  expect(missingParts(direction)).toEqual(["the values that mean money out and money in"]);
});

test("changing how amounts are written keeps what still applies, and a flipped sign survives", () => {
  const signed = { kind: "signed" as const, amount: { index: 3 }, invert: true };
  const split = withAmountKind(signed, "debitCredit");
  expect(split).toEqual({ kind: "debitCredit", invert: true });
  expect(withAmountKind({ ...split, debit: { index: 5 } }, "signed")).toEqual({
    kind: "signed",
    invert: true,
  });
  const direction = withAmountKind(signed, "direction");
  expect(direction).toMatchObject({
    kind: "direction",
    amount: { index: 3 },
    outValues: ["Debit"],
    inValues: ["Credit"],
    invert: true,
  });
});

test("optional columns are set and cleared without disturbing the rest", () => {
  const mapping = { ...emptyMapping(1), balance: { index: 5 } };
  expect(withOptional(mapping, "balance", undefined).balance).toBeUndefined();
  expect(withOptional(mapping, "reference", { index: 6 }).reference).toEqual({ index: 6 });
  expect(withOptional(mapping, "reference", { index: 6 }).balance).toEqual({ index: 5 });
});

test("comma-separated values are trimmed, de-duplicated and bounded", () => {
  expect(splitValues(" Debit , DR,, Debit ,CR")).toEqual(["Debit", "DR", "CR"]);
  expect(splitValues("")).toEqual([]);
  expect(splitValues(Array.from({ length: 40 }, (_, index) => `v${index}`).join(","))).toHaveLength(
    20,
  );
  expect(joinValues(["Debit", "DR"])).toBe("Debit, DR");
  expect(joinValues(undefined)).toBe("");
});

test("money is grouped by moving characters, never by arithmetic", () => {
  expect(formatMoney("1234567.50")).toBe("1,234,567.50");
  expect(formatMoney("-1234567.50")).toBe("\u22121,234,567.50");
  expect(formatMoney("0.05")).toBe("0.05");
  expect(formatMoney("999.99")).toBe("999.99");
  expect(formatMoney("123456789012345678.90")).toBe("123,456,789,012,345,678.90");
  expect(formatMoney("not money")).toBe("not money");
});

test("file sizes and names read the way a person expects, and a name cannot disguise itself", () => {
  expect(formatBytes(1)).toBe("1 byte");
  expect(formatBytes(820)).toBe("820 bytes");
  expect(formatBytes(14540)).toBe("14.2 KiB");
  expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MiB");
  expect(shownName("a‮exe.csv")).toBe("a exe.csv");
  expect(shownName("  spaced   out \n name.csv ")).toBe("spaced out name.csv");
});

test("text from a bank file is shown with its control and direction characters made visible", () => {
  expect(safeText("STARBUCKS #1234")).toBe("STARBUCKS #1234");
  expect(safeText("日本語 — café — شركة النور")).toBe("日本語 — café — شركة النور");
  expect(safeText("pay\u202etxt.exe")).toBe("pay\\u202etxt.exe");
  expect(safeText("a\u001b[31mred\u0007")).toBe("a\\u001b[31mred\\u0007");
  expect(safeText("zero\u200bwidth\ufeff")).toBe("zero\\u200bwidth\\ufeff");
  expect(safeText("line one\nline two")).toBe("line one\u21b5 line two");
  expect(safeText("\u{1F600} ok")).toBe("\u{1F600} ok");
});
