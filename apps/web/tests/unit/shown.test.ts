import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatDate,
  formatDateRange,
  formatInstant,
  formatMoney,
  formatMoneyAbsolute,
} from "@rastrata/ui/format";
import { shown } from "../support/shown";

// Tests read a displayed date or amount through `shown`, so a change to how the app writes a date is
// one change in the formatter and no edit in any assertion. `shown` is only worth anything if it calls
// the functions the screens call, and if the copy for the component tests is the copy for these.

test("shown reads a value through the functions the screens call", () => {
  expect(shown.date("2026-03-20")).toBe(formatDate("2026-03-20"));
  expect(shown.date("2026-03-20T12:00:00.000Z")).toBe(formatDate("2026-03-20T12:00:00.000Z"));
  expect(shown.instant("2026-03-20T12:00:00.000Z")).toBe(formatInstant("2026-03-20T12:00:00.000Z"));
  expect(shown.money("-1234.50")).toBe(formatMoney("-1234.50"));
  expect(shown.moneyAbsolute("-1234.50")).toBe(formatMoneyAbsolute("-1234.50"));
  expect(shown.range("2026-03-01", "2026-03-31")).toBe(formatDateRange("2026-03-01", "2026-03-31"));
});

test("the copy of shown for the component tests is the copy for the web application's", () => {
  const web = readFileSync(join(import.meta.dir, "..", "support", "shown.ts"), "utf8");
  const ui = readFileSync(
    join(import.meta.dir, "..", "..", "..", "..", "packages", "ui", "tests", "support", "shown.ts"),
    "utf8",
  );
  const formatter = (text: string) =>
    text
      .replace('"@rastrata/ui/format"', '"<formatter>"')
      .replace('"../../src/format"', '"<formatter>"');
  expect(formatter(web)).toContain('"<formatter>"');
  expect(formatter(ui)).toContain('"<formatter>"');
  expect(formatter(ui)).toBe(formatter(web));
});
