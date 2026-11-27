import { afterEach, expect, test } from "bun:test";
import {
  listAccountLabel,
  setShowsAccountNumbers,
  showsAccountNumbers,
} from "../src/entries/display";

afterEach(() => setShowsAccountNumbers(false));

test("a list shows the name alone until the owner asks for numbers, and then the number first", () => {
  expect(showsAccountNumbers()).toBe(false);
  expect(listAccountLabel("Business checking", "1000")).toBe("Business checking");
  setShowsAccountNumbers(true);
  expect(showsAccountNumbers()).toBe(true);
  expect(listAccountLabel("Business checking", "1000")).toBe("1000 · Business checking");
});

test("an account without a number is just its name, whatever was asked", () => {
  setShowsAccountNumbers(true);
  expect(listAccountLabel("Business checking")).toBe("Business checking");
  expect(listAccountLabel("Business checking", "")).toBe("Business checking");
});
