import { describe, expect, test } from "bun:test";
import { introParts } from "../src/intro";

describe("folding an introduction into a page header", () => {
  test("the first sentence is the line and the rest is the explanation", () => {
    expect(
      introParts(
        "Check an account against the statement your bank sent. When every line you tick adds up, the difference is 0.00.",
      ),
    ).toEqual({
      line: "Check an account against the statement your bank sent.",
      rest: "When every line you tick adds up, the difference is 0.00.",
    });
  });

  test("a single sentence is all line, with nothing to explain", () => {
    expect(introParts("Find an entry. ")).toEqual({ line: "Find an entry.", rest: undefined });
    expect(introParts("Find an entry")).toEqual({ line: "Find an entry", rest: undefined });
  });

  test("spaces and line breaks in the copy are one space", () => {
    expect(introParts("One thing\n  and another.   Then a second sentence.")).toEqual({
      line: "One thing and another.",
      rest: "Then a second sentence.",
    });
  });

  test("a question and an exclamation end a sentence too", () => {
    expect(introParts("Is it done? Yes. Really!")).toEqual({
      line: "Is it done?",
      rest: "Yes. Really!",
    });
  });

  test("nothing is nothing", () => {
    expect(introParts("")).toEqual({ line: "", rest: undefined });
  });
});
