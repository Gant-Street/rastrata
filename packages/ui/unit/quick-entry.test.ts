import { describe, expect, test } from "bun:test";
import {
  quickChoices,
  cleanEntryText,
  quickDraft,
  emptyQuickValues,
  quickBankSide,
  parseEntryAmount,
  quickPresetAccount,
  quickPostedSentence,
  quickPreview,
  quickPreviewSentence,
  quickProblems,
  quickSwitchKind,
  QUICK_KINDS,
  type QuickAccount,
  type QuickValues,
} from "../src/entries/quick-entry";

const chart: readonly QuickAccount[] = [
  { id: "1000", code: "1000", name: "Business checking", role: "asset", bank: true },
  { id: "1100", code: "1100", name: "Business savings", role: "asset", bank: true },
  { id: "1200", code: "1200", name: "Prepaid insurance", role: "asset" },
  { id: "2000", code: "2000", name: "Business credit card", role: "liability", bank: true },
  { id: "2100", code: "2100", name: "Sales tax payable", role: "liability" },
  { id: "3000", code: "3000", name: "Owner's investment", role: "equity" },
  { id: "3100", code: "3100", name: "Owner's draw", role: "equity" },
  { id: "4000", code: "4000", name: "Sales", role: "income" },
  { id: "5000", code: "5000", name: "Software and subscriptions", role: "expense" },
  { id: "5100", code: "5100", name: "Meals", role: "expense" },
  { id: "5200", code: "5200", name: "Operating expenses", role: "expense", group: true },
  { id: "5900", code: "5900", name: "Old account", role: "expense", closed: true },
];

// Hidden characters are built, never typed, so this file stays plain text a reviewer can read.
const NUL = String.fromCodePoint(0);
const OVERRIDE = String.fromCodePoint(0x202e);
const ZERO_WIDTH = String.fromCodePoint(0x200b);

const values = (change: Partial<QuickValues> = {}): QuickValues => ({
  ...emptyQuickValues("2026-03-20"),
  ...change,
});

describe("an amount as a person types it", () => {
  test.each([
    ["25", "25.00"],
    ["25.5", "25.50"],
    ["25.50", "25.50"],
    ["1,250.5", "1250.50"],
    ["$7", "7.00"],
    ["$ 7.1", "7.10"],
    [".5", "0.50"],
    ["0.5", "0.50"],
    ["007.10", "7.10"],
    [" 12 ", "12.00"],
    ["12.", "12.00"],
    ["9999999999999999", "9999999999999999.00"],
  ])("%s is %s", (typed, wire) => {
    expect(parseEntryAmount(typed)).toEqual({ ok: true, value: wire });
  });

  test.each([
    ["", /Enter an amount/],
    ["   ", /Enter an amount/],
    ["abc", /dollars and cents/],
    ["-5", /without a minus sign/],
    ["1e3", /dollars and cents/],
    [".", /dollars and cents/],
    ["1.234", /at most two decimal/],
    ["0", /more than 0.00/],
    ["0.00", /more than 0.00/],
    ["00.0", /more than 0.00/],
    ["99999999999999999", /too large/],
  ])("%s is refused: %s", (typed, message) => {
    const result = parseEntryAmount(typed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(message);
  });

  test("a figure past what a number holds exactly stays exact", () => {
    expect(parseEntryAmount("9007199254740993.01")).toEqual({
      ok: true,
      value: "9007199254740993.01",
    });
  });
});

describe("which accounts a picker offers", () => {
  const ids = (kind: "spend" | "receive" | "transfer", side: "from" | "to", other?: string) =>
    quickChoices(kind, side, chart, other).map((choice) => [choice.group, choice.id]);

  test("money is paid from a bank, card or cash account first, then the other assets and liabilities", () => {
    expect(quickBankSide("spend", "from")).toBe(true);
    expect(quickBankSide("spend", "to")).toBe(false);
    expect(ids("spend", "from")).toEqual([
      ["Bank, card and cash accounts", "1000"],
      ["Bank, card and cash accounts", "2000"],
      ["Bank, card and cash accounts", "1100"],
      ["Other assets and liabilities", "1200"],
      ["Other assets and liabilities", "2100"],
    ]);
  });

  test("a category leaves out the bank accounts and lists the usual answer first", () => {
    expect(ids("spend", "to")).toEqual([
      ["Expenses", "5100"],
      ["Expenses", "5000"],
      ["Other accounts", "3100"],
      ["Other accounts", "3000"],
      ["Other accounts", "1200"],
      ["Other accounts", "4000"],
      ["Other accounts", "2100"],
    ]);
    expect(ids("receive", "from")[0]).toEqual(["Income", "4000"]);
    expect(ids("receive", "to").map(([, id]) => id)).toEqual([
      "1000",
      "2000",
      "1100",
      "1200",
      "2100",
    ]);
  });

  test("a group account, a closed account and the account on the other side are never offered", () => {
    const all = [
      ...ids("spend", "from"),
      ...ids("spend", "to"),
      ...ids("receive", "from"),
      ...ids("transfer", "to"),
    ].map(([, id]) => id);
    expect(all).not.toContain("5200");
    expect(all).not.toContain("5900");
    expect(ids("transfer", "to", "1000").map(([, id]) => id)).not.toContain("1000");
    expect(ids("transfer", "from", "1100").map(([, id]) => id)).not.toContain("1100");
    // A transfer is between two accounts that hold money, never a category.
    expect(ids("transfer", "to").map(([, id]) => id)).not.toContain("5000");
  });

  test("before any account is marked as a bank, every asset and liability is one", () => {
    const unmarked = chart.map(({ bank: _bank, ...account }) => account);
    const offered = quickChoices("spend", "from", unmarked).map((choice) => [
      choice.group,
      choice.id,
    ]);
    expect(offered.every(([group]) => group === "Bank, card and cash accounts")).toBe(true);
    expect(offered.map(([, id]) => id).sort()).toEqual(["1000", "1100", "1200", "2000", "2100"]);
  });

  test("an account that is not a bank is still offered as a category when it holds a balance", () => {
    expect(ids("spend", "to").map(([, id]) => id)).toContain("1200");
    expect(ids("spend", "to").map(([, id]) => id)).not.toContain("1000");
  });
});

describe("changing the kind of a transaction keeps what still fits", () => {
  const typed = values({
    from: "1000",
    to: "5000",
    party: "Linear",
    amount: "25.00",
    description: "Subscription",
  });

  test("the form offers money out, money in, then between accounts", () => {
    expect(QUICK_KINDS).toEqual(["spend", "receive", "transfer"]);
  });

  test("from Spend money to Receive money the bank moves to Deposit to and the category is asked again", () => {
    expect(quickSwitchKind(typed, "spend", "receive", chart)).toEqual(
      values({
        from: "",
        to: "1000",
        party: "Linear",
        amount: "25.00",
        description: "Subscription",
      }),
    );
  });

  test("to a Transfer the bank stays as From, the other side is asked, and nobody is named", () => {
    expect(quickSwitchKind(typed, "spend", "transfer", chart)).toEqual(
      values({ from: "1000", to: "", party: "", amount: "25.00", description: "Subscription" }),
    );
    // And back from a transfer: its From is where the money was paid from.
    const transfer = values({ from: "1100", to: "1000", amount: "300.00" });
    expect(quickSwitchKind(transfer, "transfer", "spend", chart)).toEqual(
      values({ from: "1100", to: "", amount: "300.00" }),
    );
    expect(quickSwitchKind(transfer, "transfer", "receive", chart)).toEqual(
      values({ from: "", to: "1100", amount: "300.00" }),
    );
  });

  test("an account the new kind does not offer on that side is not carried over", () => {
    // A closed account can be held by nothing; an account that is gone from the chart is asked again.
    const gone = values({ from: "9999", to: "5000", amount: "5.00" });
    expect(quickSwitchKind(gone, "spend", "receive", chart).to).toBe("");
  });

  test("the same kind changes nothing", () => {
    expect(quickSwitchKind(typed, "spend", "spend", chart)).toBe(typed);
  });
});

describe("the owner presets", () => {
  test("point at the equity account named for what happened, by the lowest code", () => {
    expect(quickPresetAccount("owner-out", chart)).toBe("3100");
    expect(quickPresetAccount("owner-in", chart)).toBe("3000");
    const generic: QuickAccount[] = [
      { id: "a", code: "3100", name: "Owner's draws and distributions", role: "equity" },
      { id: "b", code: "3000", name: "Owner's equity", role: "equity" },
      { id: "c", code: "3200", name: "Partners' capital contributions", role: "equity" },
      { id: "d", code: "3300", name: "Partners' distributions", role: "equity" },
    ];
    expect(quickPresetAccount("owner-out", generic)).toBe("a");
    expect(quickPresetAccount("owner-in", generic)).toBe("b");
    expect(quickPresetAccount("owner-out", [...generic].reverse())).toBe("a");
  });

  test("none when the chart has no such account, a closed or group account, or one that is not equity", () => {
    expect(quickPresetAccount("owner-out", [])).toBeUndefined();
    expect(
      quickPresetAccount("owner-out", [
        { id: "x", code: "3100", name: "Owner's draw", role: "equity", closed: true },
        { id: "y", code: "3101", name: "Owner's draw group", role: "equity", group: true },
        { id: "z", code: "6100", name: "Draw expense", role: "expense" },
      ]),
    ).toBeUndefined();
    expect(
      quickPresetAccount("owner-in", [
        { id: "e", code: "3100", name: "Owner's draw", role: "equity" },
      ]),
    ).toBeUndefined();
  });
});

describe("what is wrong with the form", () => {
  test("an empty form says what to fill in, in the order a person does", () => {
    const empty = quickProblems("spend", values({ date: "" }));
    expect(empty.map((problem) => problem.field)).toEqual(["date", "from", "to", "amount"]);
    expect(empty[1]?.message).toBe("Choose the account you paid from.");
    expect(empty[2]?.message).toBe("Choose a category.");
    // Each kind names its own fields: money received comes from a category into a deposit account.
    expect(quickProblems("receive", values()).map((problem) => problem.message)).toEqual([
      "Choose a category.",
      "Choose the account to deposit to.",
      "Enter an amount.",
    ]);
    expect(quickProblems("transfer", values())[1]?.message).toBe(
      "Choose the account to move money to.",
    );
  });

  test("two accounts must differ, and an amount must be an amount", () => {
    expect(
      quickProblems("transfer", values({ from: "1000", to: "1000", amount: "5" })).map(
        (p) => p.message,
      ),
    ).toEqual(["Choose two different accounts."]);
    expect(
      quickProblems("spend", values({ from: "1000", to: "5000", amount: "1.234" })).map(
        (p) => p.field,
      ),
    ).toEqual(["amount"]);
    expect(quickProblems("spend", values({ from: "1000", to: "5000", amount: "25" }))).toEqual([]);
  });
});

describe("what the entry will do", () => {
  // The kind names the case being read; the preview itself follows the accounts and the amount.
  const preview = (_kind: "spend" | "receive" | "transfer", change: Partial<QuickValues>) => {
    const lines = quickPreview(values(change), chart);
    return lines ? quickPreviewSentence(lines) : null;
  };

  test("an expense goes up and the bank goes down", () => {
    expect(preview("spend", { from: "1000", to: "5000", amount: "25" })).toBe(
      "This will record Software and subscriptions +25.00 and Business checking −25.00",
    );
  });

  test("income and the bank both go up when money is received", () => {
    expect(preview("receive", { from: "4000", to: "1000", amount: "1,250.5" })).toBe(
      "This will record Business checking +1,250.50 and Sales +1,250.50",
    );
  });

  test("a transfer takes from one account and adds to the other", () => {
    expect(preview("transfer", { from: "1000", to: "1100", amount: "500" })).toBe(
      "This will record Business savings +500.00 and Business checking −500.00",
    );
  });

  test("paying from a card makes the card balance go up, and an owner's draw lowers equity", () => {
    expect(preview("spend", { from: "2000", to: "5100", amount: "12.40" })).toBe(
      "This will record Meals +12.40 and Business credit card +12.40",
    );
    expect(preview("spend", { from: "1000", to: "3100", amount: "100" })).toBe(
      "This will record Owner's draw −100.00 and Business checking −100.00",
    );
  });

  test("a card payment from the bank lowers both balances", () => {
    expect(preview("transfer", { from: "1000", to: "2000", amount: "300" })).toBe(
      "This will record Business credit card −300.00 and Business checking −300.00",
    );
  });

  test("it says nothing until there is an amount and an account, and names what it can", () => {
    expect(preview("spend", { from: "1000", to: "5000" })).toBeNull();
    expect(preview("spend", { amount: "25" })).toBeNull();
    expect(preview("spend", { from: "1000", amount: "25" })).toBe(
      "This will record Business checking −25.00",
    );
    expect(preview("spend", { to: "5000", amount: "0.00" })).toBeNull();
  });

  test("each line carries the change as a wire amount too, exactly", () => {
    const lines = quickPreview(
      values({ from: "1000", to: "5000", amount: "9007199254740993.01" }),
      chart,
    );
    expect(lines?.map((line) => line.change)).toEqual([
      "9007199254740993.01",
      "-9007199254740993.01",
    ]);
  });
});

describe("the draft an entry is saved as", () => {
  test("two lines: the account money goes to is debited and the one it comes from is credited", () => {
    const draft = quickDraft(
      "spend",
      values({
        from: "1000",
        to: "5000",
        amount: "25",
        party: "Notion Labs",
        description: "Team plan",
      }),
      chart,
    );
    expect(draft).toEqual({
      date: "2026-03-20",
      reference: "Notion Labs",
      narration: "Team plan",
      lines: [
        { accountId: "5000", debit: "25.00", credit: "" },
        { accountId: "1000", debit: "", credit: "25.00" },
      ],
    });
    const received = quickDraft(
      "receive",
      values({ from: "4000", to: "1000", amount: "100" }),
      chart,
    );
    expect(received.lines).toEqual([
      { accountId: "1000", debit: "100.00", credit: "" },
      { accountId: "4000", debit: "", credit: "100.00" },
    ]);
  });

  test("what the Transactions list reads is the person's words first, then a plain sentence", () => {
    expect(
      quickDraft(
        "spend",
        values({ from: "1000", to: "5000", amount: "5", party: "Notion Labs" }),
        chart,
      ),
    ).toMatchObject({
      reference: "Notion Labs",
      narration: "Paid Notion Labs",
    });
    expect(
      quickDraft("spend", values({ from: "1000", to: "5000", amount: "5" }), chart),
    ).toMatchObject({
      reference: "Spend money",
      narration: "Spend money",
    });
    expect(
      quickDraft(
        "receive",
        values({ from: "4000", to: "1000", amount: "5", party: "Northwind LLC" }),
        chart,
      ),
    ).toMatchObject({ reference: "Northwind LLC", narration: "Received from Northwind LLC" });
    expect(
      quickDraft("transfer", values({ from: "1000", to: "1100", amount: "5" }), chart),
    ).toMatchObject({
      reference: "Transfer",
      narration: "Transfer from Business checking to Business savings",
    });
    expect(
      quickDraft(
        "transfer",
        values({ from: "1000", to: "1100", amount: "5", description: "Tax set-aside" }),
        chart,
      ),
    ).toMatchObject({ reference: "Tax set-aside", narration: "Tax set-aside" });
  });

  test("text the person typed is made safe and kept within the books' limits", () => {
    const draft = quickDraft(
      "spend",
      values({
        from: "1000",
        to: "5000",
        amount: "5",
        party: `  Evil${OVERRIDE} Co${NUL}  \n ${"x".repeat(200)}`,
        description: "a".repeat(2000),
      }),
      chart,
    );
    for (const hidden of [OVERRIDE, NUL, "\n"])
      expect(draft.reference.includes(hidden)).toBe(false);
    expect(draft.reference.length).toBeLessThanOrEqual(80);
    expect(draft.reference.startsWith("Evil Co xxx")).toBe(true);
    expect(draft.narration).toHaveLength(1000);
  });

  test("an amount the form would refuse is refused here too, never guessed at", () => {
    expect(() =>
      quickDraft("spend", values({ from: "1000", to: "5000", amount: "-5" }), chart),
    ).toThrow(/minus sign/);
  });
});

describe("what the toast says after a post", () => {
  test("the amount as a screen shows it, and the accounts it moved between", () => {
    expect(
      quickPostedSentence("spend", values({ from: "1000", to: "5000", amount: "25" }), chart),
    ).toBe("Posted: 25.00 spent on Software and subscriptions.");
    expect(
      quickPostedSentence(
        "receive",
        values({ from: "4000", to: "1000", amount: "1,250.5" }),
        chart,
      ),
    ).toBe("Posted: 1,250.50 received into Business checking.");
    expect(
      quickPostedSentence("transfer", values({ from: "1000", to: "1100", amount: "500" }), chart),
    ).toBe("Posted: 500.00 moved from Business checking to Business savings.");
  });

  test("an account that is not in the chart is said as it is, never as a blank", () => {
    expect(
      quickPostedSentence("spend", values({ from: "1000", to: "9999", amount: "5" }), chart),
    ).toBe("Posted: 5.00 spent on 9999.");
  });
});

describe("text made safe to keep", () => {
  test("control, invisible and direction-changing characters go, space collapses, length is capped", () => {
    expect(
      cleanEntryText(`  a\tb\n\nc ${ZERO_WIDTH}${OVERRIDE}d${String.fromCodePoint(7)}  `, 80),
    ).toBe("a b c d");
    expect(cleanEntryText("x".repeat(100), 10)).toBe("xxxxxxxxxx");
    expect(cleanEntryText("word ".repeat(30), 12)).toBe("word word wo");
    expect(cleanEntryText("", 5)).toBe("");
  });
});
