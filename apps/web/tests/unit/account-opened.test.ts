import { expect, test } from "bun:test";
import { openedForDisplay } from "../../src/routes/account-opened";

test("an account opened before the books began is shown as open from the day they began", () => {
  expect(openedForDisplay("2000-01-01", "2026-01-01")).toBe("2026-01-01");
  // One that opened after, or in a book that names no day, shows its own day.
  expect(openedForDisplay("2026-03-01", "2026-01-01")).toBe("2026-03-01");
  expect(openedForDisplay("2026-01-01", "2026-01-01")).toBe("2026-01-01");
  expect(openedForDisplay("2026-01-01", null)).toBe("2026-01-01");
  expect(openedForDisplay("2026-01-01", undefined)).toBe("2026-01-01");
});
