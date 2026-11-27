// The check that a service makes behind its answers (`ApplicationService.verifyLedger`) shares the process's one thread with the requests, so it gives way: after each turn it
// looks at how late the event loop came back, which is how much other work was done meanwhile, and waits a few times as long. In a quiet process it goes straight on, and a write
// that is waiting for the check hurries it.
import { expect, test } from "bun:test";
import { checkPause } from "../src/service.ts";

test("a turn of the event loop that comes back on time is a quiet process: the check goes straight on", () => {
  expect(checkPause(0, false)).toBe(0);
  expect(checkPause(1, false)).toBe(0);
  expect(checkPause(2, false)).toBe(0);
});

test("a turn that comes back late means requests were answered meanwhile: the check waits a few times as long, and never more than a tenth of a second", () => {
  expect(checkPause(5, false)).toBe(20);
  expect(checkPause(10, false)).toBe(40);
  expect(checkPause(24, false)).toBe(96);
  expect(checkPause(25, false)).toBe(100);
  expect(checkPause(400, false)).toBe(100);
});

test("a write that waits for the check does not give way to anything", () => {
  expect(checkPause(0, true)).toBe(0);
  expect(checkPause(10, true)).toBe(0);
  expect(checkPause(400, true)).toBe(0);
});
