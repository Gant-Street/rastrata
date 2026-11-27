import { expect, test } from "bun:test";
import { ApplicationRequestError } from "../../src/application-client";
import { hrefFor, lookStateOf, pinOf } from "../../src/routes/changes/controller";

// What the Changes page decides without a browser: where a change leads, and what a failed attempt to
// say "I have looked at these" is.

test("an entry, an account and a reconciliation lead to their own page; the rest to the page that lists them", () => {
  expect(hrefFor({ kind: "journal", id: "journal-24" })).toBe("/journal/journal-24");
  expect(hrefFor({ kind: "account", id: "acct_1" })).toBe("/ledger?accountId=acct_1");
  expect(hrefFor({ kind: "reconciliation", id: "rec_9" })).toBe("/reconcile/rec_9");
  expect(hrefFor({ kind: "rule", id: "rule_41" })).toBe("/rules");
  expect(hrefFor({ kind: "period", id: "period_2026_03" })).toBe("/periods");
  expect(hrefFor({ kind: "calendar", id: "2027" })).toBe("/periods");
  expect(hrefFor({ kind: "token", id: "tok_7f3a91c2" })).toBe("/settings/agent");
  expect(hrefFor({ kind: "member", id: "user_3" })).toBe("/settings/members");
  // The day the books were opened has no page of its own.
  expect(hrefFor({ kind: "book", id: "book" })).toBeUndefined();
});

test("an identifier from outside cannot change the address it leads to", () => {
  expect(hrefFor({ kind: "journal", id: "../../settings?x=1#y" })).toBe(
    "/journal/..%2F..%2Fsettings%3Fx%3D1%23y",
  );
  expect(hrefFor({ kind: "account", id: "a&b=c" })).toBe("/ledger?accountId=a%26b%3Dc");
});

test("a failed look is what the service said, and a lost reply is not known either way", () => {
  const refusal = (code: string, uncertain = false) =>
    new ApplicationRequestError("Words from the service.", code, uncertain);
  expect(lookStateOf(refusal("review_out_of_date"))).toEqual({ kind: "stale" });
  expect(lookStateOf(refusal("review_incomplete"))).toEqual({ kind: "incomplete" });
  expect(lookStateOf(refusal("review_needs_a_person"))).toEqual({ kind: "denied" });
  // The client calls a refusal for permission "uncertain" and keeps the request; it is still a refusal.
  expect(lookStateOf(refusal("permission_denied", true))).toEqual({ kind: "denied" });
  // The reply never arrived.
  expect(lookStateOf(refusal("operation_unresolved", true))).toEqual({ kind: "uncertain" });
  // The service answered with a failure that records nothing.
  expect(lookStateOf(refusal("invalid_input"))).toEqual({ kind: "failed" });
  expect(lookStateOf(new Error("boom"))).toEqual({ kind: "failed" });
  expect(lookStateOf(undefined)).toEqual({ kind: "failed" });
});

test("a list is pinned by the revision and the instant it was read at", () => {
  expect(pinOf({ revision: "46", asOf: "2026-04-02T15:25:00.000Z" })).toEqual({
    revision: "46",
    asOf: "2026-04-02T15:25:00.000Z",
  });
});
