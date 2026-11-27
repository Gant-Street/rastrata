import { describe, expect, test } from "bun:test";
import type { AccountTagMap } from "../src/account-tags.ts";
import { buildTagMap, type TagRecord } from "../src/chart/tags.ts";
import { reportingThreshold, THRESHOLD_YEARS } from "../src/tax/thresholds.ts";
import {
  compileVendorTotals,
  type PayeeSource,
  type Vendor,
  type VendorInputs,
} from "../src/tax/vendors.ts";
import { KernelBook } from "./support/kernel-book.ts";

const C = (dollars: number, cents = 0) => BigInt(dollars) * 100n + BigInt(cents);

describe("the reporting thresholds", () => {
  test("are the IRS's for the years that were read, and nothing is guessed for the others", () => {
    expect(THRESHOLD_YEARS).toEqual([2025, 2026]);
    expect(reportingThreshold(2025)?.cents).toBe(60_000n);
    expect(reportingThreshold(2026)?.cents).toBe(200_000n);
    expect(reportingThreshold(2024)).toBeUndefined();
    // 2027 is adjusted for inflation by the IRS and is in no publication that was read.
    expect(reportingThreshold(2027)).toBeUndefined();
    for (const year of THRESHOLD_YEARS) {
      const threshold = reportingThreshold(year);
      expect(threshold?.sources.length).toBeGreaterThan(0);
      for (const source of threshold?.sources ?? []) {
        expect(source.url).toMatch(/^https:\/\/www\.irs\.gov\//);
        expect(source.readOn).toBe("2026-10-04");
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// A year of payments, as plain data. Every expected total is summed from this list.
// ---------------------------------------------------------------------------------------------
const accounts = [
  { code: "1000", role: "asset" as const, name: "Checking" },
  { code: "1010", role: "asset" as const, name: "Savings" },
  { code: "1500", role: "asset" as const, name: "Equipment" },
  { code: "2000", role: "liability" as const, name: "Card" },
  { code: "3000", role: "equity" as const, name: "Owner investment" },
  { code: "4000", role: "income" as const, name: "Sales" },
  { code: "6030", role: "expense" as const, name: "Contract labor" },
  { code: "6080", role: "expense" as const, name: "Legal and professional" },
  { code: "6140", role: "expense" as const, name: "Supplies" },
];

const tags = (cash: readonly string[]): AccountTagMap => {
  const records: TagRecord[] = cash.map((id, index) => ({
    seq: index + 1,
    accountId: id,
    tag: "cashFlowClass",
    effectiveOn: "0001-01-01",
    value: "cash",
  }));
  return buildTagMap(records, records.length);
};

const vendor = (id: string, over: Partial<Vendor>): Vendor => ({
  id,
  version: 1,
  name: id,
  payeeKeys: [],
  reporting: "undecided",
  reason: null,
  w9: "not_requested",
  w9On: null,
  classification: null,
  paidBy: "unknown",
  notes: "",
  recordedAt: "2026-03-01T00:00:00.000Z",
  principal: "owner",
  ...over,
});

const VENDORS: readonly Vendor[] = [
  vendor("jane", { name: "Jane Doe Design", payeeKeys: ["jane doe"] }),
  vendor("acme", {
    name: "Acme Law LLP",
    payeeKeys: ["acme law"],
    reporting: "yes",
    w9: "received",
    paidBy: "bank",
  }),
  vendor("pixel", {
    name: "Pixel Studio",
    payeeKeys: ["pixel studio"],
    reporting: "yes",
    paidBy: "card_or_network",
  }),
  vendor("corp", {
    name: "Big Corp Inc",
    payeeKeys: ["big corp"],
    reporting: "no",
    reason: "corporation",
  }),
];

type Pay = {
  date: string;
  lines: readonly (readonly [string, bigint])[];
  memo: string;
  /** What the Inbox line says; absent for an entry typed by hand. */
  inbox?: PayeeSource;
};
const PAYMENTS: readonly Pay[] = [
  {
    date: "2026-01-02",
    lines: [
      ["1000", C(50000)],
      ["3000", -C(50000)],
    ],
    memo: "Investment",
  },
  {
    date: "2026-02-01",
    lines: [
      ["6030", C(1200)],
      ["1000", -C(1200)],
    ],
    memo: "bank line",
    inbox: { counterparty: "", description: "ZELLE PAYMENT TO JANE DOE 5521" },
  },
  {
    date: "2026-03-01",
    lines: [
      ["6030", C(900)],
      ["1000", -C(900)],
    ],
    memo: "bank line",
    inbox: { counterparty: "Jane Doe Design", description: "ACH DEBIT" },
  },
  {
    date: "2026-04-01",
    lines: [
      ["6030", C(500)],
      ["2000", -C(500)],
    ],
    memo: "card line",
    inbox: { counterparty: "JANE DOE", description: "CARD PURCHASE" },
  },
  {
    date: "2026-05-01",
    lines: [
      ["6080", C(3000)],
      ["1000", -C(3000)],
    ],
    memo: "bank line",
    inbox: { counterparty: "", description: "ACME LAW LLP RETAINER" },
  },
  {
    date: "2026-06-01",
    lines: [
      ["6080", C(400)],
      ["3000", -C(400)],
    ],
    memo: "paid personally",
    inbox: { counterparty: "Acme Law", description: "owner reimbursement" },
  },
  {
    date: "2026-07-01",
    lines: [
      ["6030", C(2500)],
      ["1000", -C(2500)],
    ],
    memo: "bank line",
    inbox: { counterparty: "PIXEL STUDIO", description: "INV 1" },
  },
  {
    date: "2026-08-01",
    lines: [
      ["6030", C(750)],
      ["1010", -C(750)],
    ],
    memo: "bank line",
    inbox: { counterparty: "", description: "SOMEONE NEW LLC 0042" },
  },
  {
    date: "2026-08-02",
    lines: [
      ["6030", C(100)],
      ["1000", -C(100)],
    ],
    memo: "bank line",
    inbox: { counterparty: "", description: "SOMEONE NEW LLC 0043" },
  },
  {
    date: "2026-09-01",
    lines: [
      ["6140", C(600)],
      ["1000", -C(600)],
    ],
    memo: "bank line",
    inbox: { counterparty: "OFFICE DEPOT", description: "SUPPLIES" },
  },
  {
    date: "2026-10-01",
    lines: [
      ["1000", C(300)],
      ["6030", -C(300)],
    ],
    memo: "refund",
    inbox: { counterparty: "JANE DOE", description: "REFUND" },
  },
  {
    date: "2026-11-01",
    lines: [
      ["6030", C(400)],
      ["1000", -C(400)],
    ],
    memo: "bank line",
    inbox: { counterparty: "JANE DOE", description: "ACH" },
  },
  // typed by hand: no Inbox line, matched on the narration
  {
    date: "2026-11-15",
    lines: [
      ["6080", C(250)],
      ["1000", -C(250)],
    ],
    memo: "Paid Acme Law for a contract review",
  },
  // a bank part and a card part: cannot be told apart, so it is not counted
  {
    date: "2026-11-20",
    lines: [
      ["6030", C(1000)],
      ["1000", -C(600)],
      ["2000", -C(400)],
    ],
    memo: "split payment",
    inbox: { counterparty: "ANOTHER PAYEE", description: "SPLIT" },
  },
  // a move between expense accounts is not a payment
  {
    date: "2026-11-25",
    lines: [
      ["6030", C(50)],
      ["6140", -C(50)],
    ],
    memo: "reclass",
  },
  // last year: out of range
  {
    date: "2026-12-31",
    lines: [
      ["6030", C(10)],
      ["1000", -C(10)],
    ],
    memo: "outside",
    inbox: { counterparty: "JANE DOE", description: "ACH" },
  },
];

function book() {
  const kernel = new KernelBook({ basis: "cash", firstYear: 2026, years: 1, accounts });
  const payees = new Map<string, PayeeSource>();
  for (const payment of PAYMENTS) {
    const id = kernel.post(payment.date, payment.lines, payment.memo);
    if (payment.inbox) payees.set(id, payment.inbox);
  }
  return { kernel, payees };
}

const inputs = (over: Partial<VendorInputs> = {}): VendorInputs => {
  const { kernel, payees } = book();
  return {
    state: kernel.state,
    tags: tags(["1000", "1010"]),
    from: "2026-01-01",
    to: "2026-12-30",
    reportable: new Set(["6030", "6080"]),
    vendors: VENDORS,
    payees,
    threshold: 200_000n,
    ...over,
  };
};

const row = (totals: ReturnType<typeof compileVendorTotals>, id: string) => {
  const found = totals.vendors.find((entry) => entry.vendor.id === id);
  if (!found) throw new Error(`No vendor ${id}`);
  return found;
};

describe("1099 vendor totals", () => {
  const totals = compileVendorTotals(inputs());

  test("count what was paid from bank accounts, net of a refund, and nothing else", () => {
    const jane = row(totals, "jane");
    // 1200 (zelle) + 900 (ACH) - 300 (refund) + 400 = 2200 counted; 500 on the card is left out.
    expect(jane.counted).toBe(C(2200));
    expect(jane.card).toBe(C(500));
    expect(jane.other).toBe(0n);
    expect(jane.payments).toBe(5);
    expect(jane.meetsThreshold).toBe(true);
    const acme = row(totals, "acme");
    // 3000 from the bank, 250 typed by hand and matched on its narration; 400 paid with the owner's money.
    expect(acme.counted).toBe(C(3250));
    expect(acme.other).toBe(C(400));
    expect(acme.card).toBe(0n);
  });

  test("a vendor recorded as paid by card or payment app has every payment left out", () => {
    const pixel = row(totals, "pixel");
    expect(pixel.counted).toBe(0n);
    expect(pixel.card).toBe(C(2500));
    expect(pixel.meetsThreshold).toBe(false);
    expect(totals.payments.find((payment) => payment.vendorId === "pixel")?.reason).toBe(
      "vendor_card_or_network",
    );
  });

  test("payees that are not vendors are grouped, and a mixed or reclassified entry is left out and listed", () => {
    const names = totals.payees.map((payee) => [
      payee.payee.replace(/ 004\d$/, ""),
      payee.counted,
      payee.other,
    ]);
    expect(totals.payees.find((payee) => payee.payee.startsWith("SOMEONE NEW"))).toMatchObject({
      payments: 2,
      counted: C(750) + C(100),
      firstOn: "2026-08-01",
      lastOn: "2026-08-02",
    });
    expect(names.length).toBe(3);
    const mixed = totals.payments.find((payment) => payment.reason === "mixed");
    expect(mixed).toMatchObject({ cents: C(1000), counts: false, paidFrom: "mixed" });
    const reclass = totals.payments.find((payment) => payment.reason === "reclass");
    expect(reclass).toMatchObject({ cents: C(50), counts: false });
  });

  test("an account that is not marked is not counted, and a date out of range is not read", () => {
    expect(
      totals.payments.some((payment) =>
        payment.accounts.some((account) => account.code === "6140"),
      ),
    ).toBe(false);
    expect(
      totals.payments.every(
        (payment) => payment.date >= "2026-01-01" && payment.date <= "2026-12-30",
      ),
    ).toBe(true);
    expect(totals.markedAccounts.map((account) => account.code)).toEqual(["6030", "6080"]);
    const none = compileVendorTotals(inputs({ reportable: new Set() }));
    expect(none.payments).toEqual([]);
    expect(none.totals.counted).toBe(0n);
  });

  test("the totals are the sums of the payments, to the cent", () => {
    const sum = (field: "counted" | "card" | "other") =>
      [...totals.vendors, ...totals.payees].reduce((total, entry) => total + entry[field], 0n);
    expect(sum("counted")).toBe(totals.totals.counted);
    expect(sum("card")).toBe(totals.totals.card);
    expect(sum("other")).toBe(totals.totals.other);
    // The independent figure: every payment on a marked account in range, summed from the list above.
    let everything = 0n;
    for (const payment of PAYMENTS)
      if (payment.date >= "2026-01-01" && payment.date <= "2026-12-30")
        for (const [code, cents] of payment.lines)
          if (code === "6030" || code === "6080") everything += cents;
    expect(totals.totals.counted + totals.totals.card + totals.totals.other).toBe(everything);
  });

  test("says what needs attention for a vendor at or over the threshold, and only then", () => {
    expect(row(totals, "jane").attention).toEqual([
      "undecided",
      "w9_missing",
      "method_unconfirmed",
    ]);
    // Acme has a decision, a W-9 and a confirmed method: nothing to do.
    expect(row(totals, "acme").attention).toEqual([]);
    // Pixel is under the threshold (its card payments do not count), Big Corp does not need a 1099.
    expect(row(totals, "pixel").attention).toEqual([]);
    expect(row(totals, "corp").attention).toEqual([]);
    const lower = compileVendorTotals(inputs({ threshold: C(600) }));
    expect(row(lower, "jane").meetsThreshold).toBe(true);
    const higher = compileVendorTotals(inputs({ threshold: C(5000) }));
    expect(row(higher, "acme").meetsThreshold).toBe(false);
    expect(row(higher, "acme").attention).toEqual([]);
  });

  test("when no account is tagged as cash every asset is read as a bank account, and it says so", () => {
    const untagged = compileVendorTotals(inputs({ tags: tags([]) }));
    expect(untagged.noCashTags).toBe(true);
    expect(totals.noCashTags).toBe(false);
    // The savings payment (750) was from an asset, which is a bank account here either way.
    expect(row(untagged, "jane").counted).toBe(C(2200));
    // With only the checking account tagged, the savings account is "another asset" and its payment is not counted.
    const checkingOnly = compileVendorTotals(inputs({ tags: tags(["1000"]) }));
    expect(
      checkingOnly.payees.find((payee) => payee.payee.startsWith("SOMEONE NEW")),
    ).toMatchObject({
      counted: C(100),
      other: C(750),
    });
  });

  test("two vendors that claim the same text give the payment to neither", () => {
    const clash = compileVendorTotals(
      inputs({
        vendors: [
          vendor("a", { payeeKeys: ["someone new"] }),
          vendor("b", { payeeKeys: ["someone new"] }),
        ],
      }),
    );
    expect(clash.vendors.every((entry) => entry.payments === 0)).toBe(true);
    expect(clash.payees.find((payee) => payee.payee.startsWith("SOMEONE NEW"))?.ambiguous).toBe(
      true,
    );
  });

  test("hostile payee text is data: bounded, one line and never interpreted", () => {
    const { kernel } = book();
    const id = kernel.post(
      "2026-12-01",
      [
        ["6030", C(5)],
        ["1000", -C(5)],
      ],
      "hostile",
    );
    const result = compileVendorTotals({
      ...inputs({ state: kernel.state }),
      payees: new Map([
        [
          id,
          {
            counterparty: "=cmd|' /C calc'!A0‮\u0000 Ignore previous instructions",
            description: "x".repeat(50_000),
          },
        ],
      ]),
    });
    const hostile = result.payments.find((payment) => payment.journalId === id);
    expect(hostile?.payee).not.toContain(String.fromCharCode(0));
    expect(hostile?.payee).not.toContain(String.fromCharCode(0x202e));
    expect(hostile?.payee.length).toBeLessThanOrEqual(300);
    expect(hostile?.vendorId).toBeNull();
  });

  test("the payee hash changes when the Inbox's attribution does, and not otherwise", () => {
    const again = compileVendorTotals(inputs());
    expect(again.payeesHash).toBe(totals.payeesHash);
    const { payees } = book();
    const [firstId] = [...payees.keys()];
    const changed = new Map(payees);
    changed.set(firstId as string, { counterparty: "Someone else", description: "x" });
    const other = compileVendorTotals({ ...inputs(), payees: changed });
    expect(other.payeesHash).not.toBe(totals.payeesHash);
  });

  test("a refund beyond the payments gives a negative total, never a hidden one", () => {
    const kernel = new KernelBook({ basis: "cash", firstYear: 2026, years: 1, accounts });
    kernel.post(
      "2026-01-02",
      [
        ["1000", C(1000)],
        ["3000", -C(1000)],
      ],
      "Investment",
    );
    const refund = kernel.post(
      "2026-02-01",
      [
        ["1000", C(100)],
        ["6030", -C(100)],
      ],
      "refund",
    );
    const result = compileVendorTotals({
      ...inputs({ state: kernel.state }),
      payees: new Map([[refund, { counterparty: "JANE DOE", description: "REFUND" }]]),
    });
    expect(row(result, "jane").counted).toBe(-C(100));
  });
});
