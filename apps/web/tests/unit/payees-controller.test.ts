import { describe, expect, test } from "bun:test";
import { defaultPayeesState, parsePayeesState } from "@rastrata/ui/payees/url-state";
import {
  detailInput,
  entryHref,
  payeeHref,
  payeeInput,
  safeDownloadName,
  saveInput,
  saveWorkflow,
  subjectInput,
  testInput,
  totalsInput,
  vendorsHref,
} from "../../src/routes/payees/controller";

const dates = { asOf: "2026-03-31", from: "2026-03-01" };

describe("what the screen asks of the service", () => {
  test("the report asks for the dates, and for the side and the page only when they are not the usual", () => {
    expect(totalsInput(defaultPayeesState(), dates)).toEqual({
      asOf: "2026-03-31",
      from: "2026-03-01",
    });
    expect(totalsInput({ ...defaultPayeesState(), direction: "spent", page: 3 }, dates)).toEqual({
      asOf: "2026-03-31",
      from: "2026-03-01",
      direction: "spent",
      page: 3,
    });
    expect(totalsInput(defaultPayeesState(), { ...dates, revision: "412" })).toEqual({
      asOf: "2026-03-31",
      from: "2026-03-01",
      revision: "412",
    });
  });

  test("a row is read by exactly one thing, named the way the service names it", () => {
    expect(subjectInput({ kind: "payee", payeeId: "pay_1", label: "Stripe" })).toEqual({
      payeeId: "pay_1",
    });
    expect(
      subjectInput({
        kind: "unnamed",
        key: "chipotle #",
        label: "CHIPOTLE 2188",
        suggestedWords: "",
      }),
    ).toEqual({ unnamed: "chipotle #" });
    expect(subjectInput({ kind: "ambiguous", key: "amazon", label: "AMAZON", payees: [] })).toEqual(
      { ambiguous: "amazon" },
    );
    expect(subjectInput({ kind: "no_payee", why: "by_hand", label: "Entered by hand" })).toEqual({
      noPayee: "by_hand",
    });
    for (const subject of [
      { kind: "payee", payeeId: "p", label: "P" },
      { kind: "unnamed", key: "k", label: "K", suggestedWords: "" },
      { kind: "ambiguous", key: "k", label: "K", payees: [] },
      { kind: "no_payee", why: "no_bank_text", label: "N" },
    ] as const)
      expect(Object.keys(subjectInput(subject)).length).toBe(1);
  });

  test("the transactions of a row are asked for the same dates, a page at a time", () => {
    const subject = { kind: "payee", payeeId: "pay_1", label: "Stripe" } as const;
    expect(detailInput(subject, dates, 1)).toEqual({
      payeeId: "pay_1",
      asOf: "2026-03-31",
      from: "2026-03-01",
    });
    expect(detailInput(subject, dates, 4)).toEqual({
      payeeId: "pay_1",
      asOf: "2026-03-31",
      from: "2026-03-01",
      page: 4,
    });
    expect(payeeInput("pay_1", { ...dates, revision: "9" })).toEqual({
      payeeId: "pay_1",
      asOf: "2026-03-31",
      from: "2026-03-01",
      revision: "9",
      pageSize: 1,
    });
  });

  test("words are tried in the dates on screen, and for a payee being changed, as its own", () => {
    expect(testInput(["blue bottle coffee"], dates)).toEqual({
      words: ["blue bottle coffee"],
      asOf: "2026-03-31",
      from: "2026-03-01",
    });
    expect(testInput(["uber", "uber eats"], dates, "pay_9")).toEqual({
      words: ["uber", "uber eats"],
      asOf: "2026-03-31",
      from: "2026-03-01",
      payeeId: "pay_9",
    });
  });

  test("naming sends no version and changing names the one it changes", () => {
    const fields = { name: "Stripe", words: ["stripe"], note: "", retired: false };
    expect(saveInput(fields, null)).toEqual({ name: "Stripe", words: ["stripe"], note: "" });
    expect(saveInput({ ...fields, retired: true }, { id: "pay_1", version: 3 })).toEqual({
      name: "Stripe",
      words: ["stripe"],
      note: "",
      payeeId: "pay_1",
      expectedVersion: 3,
      retired: true,
    });
    // The words are copied, so a later change to the form cannot change a request that is retained.
    const typed = ["stripe"];
    const request = saveInput({ ...fields, words: typed }, null);
    typed.push("other");
    expect(request.words).toEqual(["stripe"]);
  });

  test("a save has one retained request for each payee and one for a payee being named", () => {
    expect(saveWorkflow(null)).toBe("payees:save:new");
    expect(saveWorkflow({ id: "pay_1" })).toBe("payees:save:pay_1");
  });
});

describe("where things are", () => {
  test("an entry's address escapes what it is given", () => {
    expect(entryHref("jnl_1")).toBe("/journal/jnl_1");
    expect(entryHref("a/b?c#d")).toBe("/journal/a%2Fb%3Fc%23d");
  });

  test("the 1099 vendors of a year", () => {
    expect(vendorsHref(2026)).toBe("/tax?tab=vendors&year=2026");
    expect(vendorsHref(undefined)).toBe("/tax?tab=vendors");
  });

  test("a payee opened from elsewhere is opened by this screen's own address, with the dates, and comes back the same", () => {
    const href = payeeHref("pay_0a1b", "2026-01-01", "2026-12-31");
    expect(href).toBe("/reports/payees?from=2026-01-01&to=2026-12-31&payee=pay_0a1b");
    const parsed = parsePayeesState(href.split("?")[1] ?? "", {
      years: [{ year: 2026, startsOn: "2026-01-01", endsOn: "2026-12-31" }],
      today: "2026-10-17",
    });
    expect(parsed.state.payee).toBe("pay_0a1b");
    expect(parsed.state.range).toMatchObject({ from: "2026-01-01", to: "2026-12-31" });
    expect(parsed.notice).toBeUndefined();
  });

  test("a file name for a download is plain whatever the service said", () => {
    expect(safeDownloadName("money-by-payee-2026-03-31.csv")).toBe("money-by-payee-2026-03-31.csv");
    expect(safeDownloadName("../../etc/passwd")).toBe("etc-passwd");
    expect(safeDownloadName("a b‮.csv")).toBe("a-b-.csv");
    expect(safeDownloadName("...")).toBe("download");
    expect(safeDownloadName("x".repeat(300)).length).toBe(120);
  });
});
