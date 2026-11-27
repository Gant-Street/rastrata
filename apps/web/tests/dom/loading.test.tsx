import { afterAll, beforeAll, expect, test } from "bun:test";
import { screen } from "@solidjs/testing-library";
import { openApp, pause } from "./support/app";
import { type Book, openBook } from "./support/book";

// A page that is reading draws nothing for a moment, then the outline of what is coming, and never a sentence.
let book: Book;
beforeAll(async () => {
  book = await openBook();
});
afterAll(async () => {
  await book.close();
});

const outline = () => document.querySelectorAll("main .rt-skeleton").length;

test("a new book opens on the setup, with no outline of Home before it", async () => {
  await openApp("/");
  expect(await screen.findByRole("heading", { name: "Set up your books" })).toBeTruthy();
  expect(screen.queryByText("Opening your book…", { selector: ":not(.rt-sr-only)" })).toBeNull();
});

test("a slow page draws nothing for the first moment, then its outline, then itself", async () => {
  await book.call("book.setup", {
    name: "Harbor Studio",
    currency: "USD",
    fiscalYear: 2026,
    periodModel: "monthly",
    accounts: [
      { code: "1000", name: "Operating cash", role: "asset" },
      { code: "3000", name: "Owner's investment", role: "equity" },
    ],
  });
  const stop = book.slow(700);
  await openApp("/journal");
  await pause(100);
  expect(outline()).toBe(0);
  await pause(250);
  expect(outline()).toBeGreaterThan(0);
  expect(document.body.textContent).not.toContain("Reading your transactions…Every");
  stop();
  expect(await screen.findByLabelText("Search transactions")).toBeTruthy();
  expect(outline()).toBe(0);
});
