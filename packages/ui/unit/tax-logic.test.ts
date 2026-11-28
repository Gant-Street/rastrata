import { describe, expect, test } from "bun:test";
import {
  attentionCount,
  describeCheck,
  emptyVendorValues,
  groupChecks,
  hasVendorErrors,
  PAYEE_MAX,
  PAYEE_MIN,
  parsePayees,
  salesPeriodLabel,
  severityOf,
  vendorErrors,
  vendorFields,
  vendorValues,
} from "../src/tax/logic";
import type { TaxCheckStatus, TaxCheckView, TaxVendorView } from "../src/tax/types";
import { words as taxWords } from "../src/tax/words";

const vendor: TaxVendorView = {
  id: "v1",
  version: 3,
  name: "Jane Doe Design",
  payeeKeys: ["jane doe", "jane d"],
  reporting: "no",
  reason: "corporation",
  w9: "received",
  w9On: "2026-02-10",
  classification: "c_corporation",
  paidBy: "bank",
  notes: "Invoices monthly",
  recordedAt: "2026-02-11T10:00:00Z",
  principal: "owner",
};

describe("payee texts", () => {
  test("are one per line or separated by semicolons, trimmed, with blanks and repeats dropped", () => {
    expect(parsePayees("jane doe\n  Jane Doe ; acme corp;;\n\n  ")).toEqual([
      "jane doe",
      "acme corp",
    ]);
    expect(parsePayees("")).toEqual([]);
    expect(parsePayees(" ;\n; ")).toEqual([]);
  });

  test("keep the first spelling typed and the order typed", () => {
    expect(parsePayees("Zed Co\nalpha llc\nZED CO")).toEqual(["Zed Co", "alpha llc"]);
  });

  test("are text and nothing else: formulas, markup and long strings come back as typed", () => {
    const hostile = [
      '=HYPERLINK("http://example.invalid")',
      "<script>alert(1)</script>",
      "x".repeat(5000),
    ];
    expect(parsePayees(hostile.join("\n"))).toEqual(hostile);
  });

  test("never throw, never return a blank piece or the same text twice, whatever is typed", () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed;
    };
    const alphabet = ["a", "B", " ", "\n", ";", "\t", "é", "=", "0", "‮"];
    for (let round = 0; round < 500; round++) {
      let text = "";
      for (let index = 0; index < next() % 40; index++) text += alphabet[next() % alphabet.length];
      const pieces = parsePayees(text);
      expect(pieces.every((piece) => piece !== "" && piece === piece.trim())).toBe(true);
      expect(new Set(pieces.map((piece) => piece.toLowerCase())).size).toBe(pieces.length);
    }
  });
});

describe("the vendor form", () => {
  test("an empty form is a vendor not yet decided, with a name only when it starts from a payee", () => {
    const empty = emptyVendorValues();
    expect(empty).toMatchObject({
      name: "",
      payees: "",
      reporting: "undecided",
      w9: "not_requested",
    });
    expect(emptyVendorValues("ZELLE TO JANE DOE")).toMatchObject({
      name: "ZELLE TO JANE DOE",
      payees: "ZELLE TO JANE DOE",
    });
    expect(emptyVendorValues("y".repeat(300)).name).toHaveLength(120);
  });

  test("says what is wrong next to the field, and nothing when the form can be sent", () => {
    expect(hasVendorErrors(vendorErrors(vendorValues(vendor)))).toBe(false);
    const bad = vendorErrors({
      ...emptyVendorValues(),
      name: "   ",
      payees: "ab",
      reporting: "no",
      reason: "",
      w9On: "10/02/2026",
    });
    expect(bad).toEqual({
      name: taxWords.formNameRequired,
      payees: taxWords.formPayeeShort,
      reason: taxWords.formReasonRequired,
      w9On: taxWords.formW9OnBad,
    });
    expect(hasVendorErrors(bad)).toBe(true);
  });

  test("a payee text is at least three and at most a hundred and twenty characters", () => {
    const text = (length: number) => ({
      ...emptyVendorValues(),
      name: "A",
      payees: "x".repeat(length),
    });
    expect(vendorErrors(text(PAYEE_MIN - 1)).payees).toBeDefined();
    expect(vendorErrors(text(PAYEE_MIN)).payees).toBeUndefined();
    expect(vendorErrors(text(PAYEE_MAX)).payees).toBeUndefined();
    expect(vendorErrors(text(PAYEE_MAX + 1)).payees).toBeDefined();
  });

  test("a W-9 date is a real date written year-month-day, or empty", () => {
    const withDate = (w9On: string) => ({ ...emptyVendorValues(), name: "A", w9On });
    for (const good of ["", "  ", "2026-02-10", " 2026-12-31 "])
      expect(vendorErrors(withDate(good)).w9On, good).toBeUndefined();
    for (const bad of ["2026-02-30", "2026-13-01", "02/10/2026", "yesterday", "2026-2-1"])
      expect(vendorErrors(withDate(bad)).w9On, bad).toBe(taxWords.formW9OnBad);
  });

  test("the fields sent are the form, trimmed, with empty optional fields cleared and a reason only for no", () => {
    expect(vendorFields(vendorValues(vendor))).toEqual({
      name: "Jane Doe Design",
      payeeKeys: ["jane doe", "jane d"],
      reporting: "no",
      reason: "corporation",
      w9: "received",
      w9On: "2026-02-10",
      classification: "c_corporation",
      paidBy: "bank",
      notes: "Invoices monthly",
    });
    const yes = vendorFields({
      ...vendorValues(vendor),
      reporting: "yes",
      reason: "corporation",
      w9On: " ",
      classification: "",
      notes: "  ",
    });
    expect(yes).toMatchObject({ reason: null, w9On: null, classification: null, notes: "" });
  });

  test("a vendor read from the service and sent back unchanged says the same things", () => {
    const fields = vendorFields(vendorValues(vendor));
    expect(fields.payeeKeys).toEqual([...vendor.payeeKeys]);
    expect(fields.name).toBe(vendor.name);
    expect(fields.paidBy).toBe(vendor.paidBy);
  });

  test("optional Act 2 filing details validate, round-trip, and clear cleanly without collecting TIN values", () => {
    const bad = vendorErrors({ ...emptyVendorValues(), name: "Contractor", email: "not-an-email" });
    expect(bad.email).toBe(taxWords.formEmailBad);

    const rich = vendorFields({
      ...emptyVendorValues(),
      name: "Jane Design",
      legalName: "Jane Doe LLC",
      email: "jane@example.com",
      tinStatus: "on_file",
      addressLine1: "100 Main St",
      addressCity: "Austin",
      addressState: "tx",
      addressPostalCode: "78701",
    });
    expect(rich).toMatchObject({
      legalName: "Jane Doe LLC",
      email: "jane@example.com",
      tinStatus: "on_file",
      address: { line1: "100 Main St", city: "Austin", state: "TX", postalCode: "78701" },
    });

    const cleared = vendorFields(
      {
        ...vendorValues({
          ...vendor,
          legalName: "Jane Doe LLC",
          email: "jane@example.com",
          tinStatus: "verified",
          address: { line1: "100 Main St", city: "Austin", state: "TX", postalCode: "78701" },
        }),
        legalName: "",
        email: "",
        tinStatus: "not_collected",
        addressLine1: "",
        addressCity: "",
        addressState: "",
        addressPostalCode: "",
      },
      {
        ...vendor,
        legalName: "Jane Doe LLC",
        email: "jane@example.com",
        tinStatus: "verified",
        address: { line1: "100 Main St", city: "Austin", state: "TX", postalCode: "78701" },
      },
    );
    expect(cleared).toMatchObject({
      legalName: null,
      email: null,
      tinStatus: "not_collected",
      address: null,
    });
  });
});

describe("the checks are sorted by what they ask of the person", () => {
  const check = (
    key: string,
    status: TaxCheckStatus,
    extra: Partial<TaxCheckView> = {},
  ): TaxCheckView => ({
    key,
    status,
    title: `service title of ${key}`,
    detail: `service detail of ${key}`,
    ...extra,
  });

  test("orange is only for what would change the figures when it is acted on", () => {
    // Transactions still waiting and an account with no tax line move a figure; a real difference with
    // Stripe does too.
    expect(severityOf(check("inbox", "attention"))).toBe("attention");
    expect(severityOf(check("unmapped", "attention"))).toBe("attention");
    expect(severityOf(check("sales", "attention"))).toBe("attention");
    // Closing months, reconciling and deciding on 1099 vendors are good practice: they change no figure.
    for (const key of ["periods", "reconcile", "vendors"])
      expect(severityOf(check(key, "attention")), key).toBe("calm");
    // A check that passed or could not be made is never orange, however it is called.
    for (const key of ["inbox", "unmapped", "sales", "periods", "reconcile", "vendors"])
      for (const status of ["ok", "unknown"] as const)
        expect(severityOf(check(key, status)), `${key} ${status}`).toBe("calm");
  });

  test("the facts about the figures are notes, whatever the service called them", () => {
    for (const key of ["draft", "books_start", "year_not_ended"])
      for (const status of ["attention", "ok", "unknown"] as const)
        expect(severityOf(check(key, status)), `${key} ${status}`).toBe("note");
  });

  test("a check the screen has not heard of keeps what the service said", () => {
    expect(severityOf(check("something_new", "attention"))).toBe("attention");
    expect(severityOf(check("something_new", "ok"))).toBe("calm");
    expect(severityOf(check("something_new", "unknown"))).toBe("calm");
  });

  test("an ordinary book in the middle of its first year has nothing orange: the six warnings are calm or notes", () => {
    const normal = [
      check("periods", "attention", { href: "/periods", count: 9 }),
      check("inbox", "ok"),
      check("reconcile", "attention", { href: "/reconcile" }),
      check("unmapped", "ok"),
      check("vendors", "unknown", { href: "/tax?tab=vendors" }),
      check("sales", "unknown", { href: "/accounts" }),
      check("draft", "attention"),
      check("books_start", "attention"),
      check("year_not_ended", "attention"),
    ];
    const groups = groupChecks(normal, 2026);
    expect(groups.attention).toEqual([]);
    expect(attentionCount(normal)).toBe(0);
    expect(groups.notes.map((item) => item.key)).toEqual([
      "draft",
      "books_start",
      "year_not_ended",
    ]);
    expect(groups.calm.map((item) => item.key).sort()).toEqual([
      "inbox",
      "periods",
      "reconcile",
      "sales",
      "unmapped",
      "vendors",
    ]);
    // Two of the six are done: the transactions and the tax lines.
    expect(groups.done).toBe(2);
  });

  test("a book with transactions waiting is orange for that and for nothing else", () => {
    const waiting = [
      check("periods", "attention", { href: "/periods", count: 2 }),
      check("inbox", "attention", { href: "/inbox", count: 4 }),
      check("draft", "attention"),
    ];
    const groups = groupChecks(waiting, 2026);
    expect(groups.attention.map((item) => item.key)).toEqual(["inbox"]);
    expect(attentionCount(waiting)).toBe(1);
  });

  test("good practice lists what is left before what is done, and says how much is done", () => {
    const groups = groupChecks(
      [
        check("reconcile", "ok"),
        check("periods", "attention", { href: "/periods", count: 3 }),
        check("vendors", "unknown", { href: "/tax?tab=vendors" }),
      ],
      2026,
    );
    expect(groups.calm.map((item) => item.key)).toEqual(["periods", "vendors", "reconcile"]);
    expect(groups.done).toBe(1);
  });

  test("a link names what it fixes, never 'fix it', and a check that passed has none", () => {
    const year = 2026;
    const fix = (item: TaxCheckView) => describeCheck(item, year).fix;
    expect(fix(check("periods", "attention", { href: "/periods" }))).toBe("Close the books");
    expect(fix(check("inbox", "attention", { href: "/inbox", count: 4 }))).toBe(
      "Review 4 transactions",
    );
    expect(fix(check("inbox", "attention", { href: "/inbox", count: 1 }))).toBe(
      "Review 1 transaction",
    );
    expect(fix(check("inbox", "attention", { href: "/inbox" }))).toBe("Review the transactions");
    expect(fix(check("reconcile", "attention", { href: "/reconcile", count: 2 }))).toBe(
      "Reconcile 2 accounts",
    );
    expect(fix(check("unmapped", "attention", { href: "/accounts", count: 3 }))).toBe(
      "Add the missing tax lines to 3 accounts",
    );
    expect(fix(check("vendors", "unknown", { href: "/tax?tab=vendors" }))).toBe(
      "Mark the accounts that hold contractor payments",
    );
    expect(fix(check("vendors", "attention", { href: "/tax?tab=vendors" }))).toBe(
      "Decide on the 1099 vendors",
    );
    expect(fix(check("sales", "unknown", { href: "/accounts" }))).toBe("Tag the sales tax account");
    expect(fix(check("sales", "attention", { href: "/tax?tab=sales" }))).toBe(
      "Look at the sales tax figures",
    );
    expect(fix(check("something_new", "attention", { href: "/somewhere" }))).toBe(
      "Open service title of something_new",
    );
    // Every link is different, and none of them is the old one.
    const labels = ["periods", "inbox", "reconcile", "unmapped", "vendors", "sales"].map((key) =>
      fix(check(key, "attention", { href: "/x" })),
    );
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.some((label) => /fix it/i.test(label ?? ""))).toBe(false);
    // Nothing to fix, no link.
    const done = describeCheck(check("periods", "ok", { href: "/periods" }), year);
    expect(done.href).toBeUndefined();
    expect(done.fix).toBeUndefined();
    const note = describeCheck(check("draft", "attention"), year);
    expect(note.href).toBeUndefined();
  });

  test("the sales tax check says its finding and stops: what Rastrata does not know is not on the screen", () => {
    const said = describeCheck(
      check("sales", "attention", {
        detail:
          "The sales tax account collected 8.00 and paid or returned 5.00 in this range and holds 3.00 at the end. Look at this: the account shows more tax paid or returned than collected. Rastrata does not know your rates or filing dates.",
      }),
      2026,
    ).detail;
    expect(said.endsWith("more tax paid or returned than collected.")).toBe(true);
    expect(said).not.toContain("does not know");
  });

  test("the transactions waiting for review are said in the app's words, from the count", () => {
    const year = 2026;
    const waiting = (count: number | undefined) =>
      describeCheck(check("inbox", "attention", { href: "/inbox", count }), year).detail;
    expect(waiting(4)).toBe(
      "4 transactions dated in 2026 are waiting for review, so they are not in these figures.",
    );
    expect(waiting(1)).toBe(
      "1 transaction dated in 2026 is waiting for review, so it is not in these figures.",
    );
    // Without the number the service's own sentence is shown as it wrote it.
    expect(waiting(undefined)).toBe("service detail of inbox");
    expect(describeCheck(check("inbox", "ok"), year).detail).toBe(
      "Nothing dated in 2026 is waiting for review.",
    );
    expect(describeCheck(check("inbox", "unknown"), year).detail).toBe(
      "The transactions waiting for review could not be read, so it is not known whether any dated in 2026 are still waiting.",
    );
    // The words of the app, none of the service's.
    for (const text of [waiting(4), waiting(1)]) {
      expect(text).not.toMatch(/\bInbox\b/);
      expect(text).not.toMatch(/\blines?\b/);
    }
    expect(describeCheck(check("inbox", "ok"), year).title).toBe("Transactions waiting for review");
  });

  test("the other checks keep the service's sentence, with its figures shown the way every figure is", () => {
    const item = describeCheck(
      check("unmapped", "attention", {
        href: "/accounts",
        detail: "2 accounts have activity and no line (income 400.00, expenses 1150.00).",
      }),
      2026,
    );
    expect(item.detail).toBe(
      "2 accounts have activity and no line (income 400.00, expenses 1,150.00).",
    );
    expect(item.title).toBe("Accounts with no tax line");
  });
});

describe("sales tax periods", () => {
  const month = (date: string) => `month of ${date}`;
  const day = (date: string) => `day ${date}`;
  test("a month is named, a quarter is year and quarter, the whole range is its dates", () => {
    expect(
      salesPeriodLabel({ key: "2026-02", from: "2026-02-01", to: "2026-02-28" }, month, day),
    ).toBe("month of 2026-02-01");
    expect(
      salesPeriodLabel({ key: "2026-Q3", from: "2026-07-01", to: "2026-09-30" }, month, day),
    ).toBe("2026 Q3");
    expect(
      salesPeriodLabel({ key: "range", from: "2026-01-01", to: "2026-12-31" }, month, day),
    ).toBe("day 2026-01-01 to day 2026-12-31");
  });
});
