import { expect, test } from "bun:test";
import { failedFiles } from "./gate-retry.ts";

test("the files whose tests failed, from the runner's output", () => {
  const output = [
    "bun test v1.4.4 (5d9cc0f4f)",
    "",
    "packages/application/test/rules-text.test.ts:",
    "canonicalising fifty thousand separators: 2 ms; budget 500 ms not asserted, the machine is busy (load 19.3)",
    "",
    "apps/api/test/telemetry.test.ts:",
    "(fail) the browser beacon > records what a signed-in page sends, and nothing else [30.80ms]",
    "",
    "tests/dom/inbox.test.ts:",
    "272 |   let pause = 10;",
    'error: expected .rt-toast to contain text Posted 12 transactions., has ""; ',
    "(fail) a first import is worked through from the keyboard: suggestions, Accept all, posted [48148.93ms]",
    "(fail) a second one in the same file [1.00ms]",
    "",
    " 70 pass",
    " 3 fail",
  ].join("\n");
  expect(failedFiles(output)).toEqual([
    "apps/api/test/telemetry.test.ts",
    "tests/dom/inbox.test.ts",
  ]);
  expect(failedFiles(" 5 pass\n 0 fail\n")).toEqual([]);
});
