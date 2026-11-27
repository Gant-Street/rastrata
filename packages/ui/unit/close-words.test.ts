import { expect, test } from "bun:test";
import { closeWords } from "../src/accounting/close-words";

test("the line under the title says what closing is only until something is closed", () => {
  expect(closeWords.nothingClosed).toBe("Nothing is closed yet.");
  expect(closeWords.explanation()).toBe(
    "Closing a month stops new entries dated in it. You can reopen it.",
  );
  expect(closeWords.explanation("quarter")).toBe(
    "Closing a quarter stops new entries dated in it. You can reopen it.",
  );
  expect(closeWords.closedThrough("Oct 31, 2026")).toBe("Books are closed through Oct 31, 2026.");
  // The years the book keeps before the books began are its own business: no word names them, and the
  // page does not say where the books start.
  expect("earlier" in closeWords).toBe(false);
  expect("startsOn" in closeWords).toBe(false);
});

test("the card and its button name the month the books are closed through", () => {
  expect(closeWords.through("October 2026")).toBe("Through October 2026");
  expect(closeWords.closeThrough("October 2026")).toBe("Close through October 2026");
  expect(closeWords.closing.done("October 2026")).toBe("October 2026 is closed.");
  expect(closeWords.closing.doneRun("January to October 2026")).toBe(
    "January to October 2026 are closed.",
  );
});
