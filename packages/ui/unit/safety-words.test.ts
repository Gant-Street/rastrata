import { describe, expect, test } from "bun:test";
import { words } from "../src/safety/words";

// The Backups screen does not know which kind of book a check is replaying, so what it says about how
// long a check takes has to be true of both: a book made with the chain-head state commitment (every book
// made since 2026-10-07) replays in about a second for every thousand entries, and a book made before it in
// a time that grows with the square of the book. The service's own estimate, which does know, says what is
// left. These pin the copy so that neither kind is promised the other's time.
describe("what the Backups screen says about the time a check takes", () => {
  test("the note on a running check names the usual time and the slower kind of book", () => {
    expect(words.jobReplayNote).toContain("a second for every thousand entries");
    expect(words.jobReplayNote).toContain("earlier version");
  });

  test("it promises no time that is only true of one kind of book, and no shape that is only true of one", () => {
    for (const text of [words.jobReplayNote, words.verifyHint, words.restoreAfter]) {
      expect(text).not.toMatch(/22 seconds|minutes at several thousand|at the end|square/i);
    }
  });

  test("the estimate of what is left is called an estimate", () => {
    expect(words.jobRemaining("12 s")).toBe("about 12 s left (an estimate)");
  });
});
