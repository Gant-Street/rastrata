import { describe, expect, test } from "bun:test";
import {
  accountFlow,
  accountName,
  correctionNote,
  plainNarration,
  sideText,
} from "../src/accounting-logic";
import type { AccountChoice, JournalLine, RegisterCorrection } from "../src/accounting-types";

const choice = (value: string, name: string, withName = true): AccountChoice => ({
  value,
  label: `${value} · ${name}`,
  path: "asset",
  group: "asset",
  ...(withName ? { code: value, name } : {}),
});
const accounts = [
  choice("1000", "Business checking"),
  choice("4000", "Sales"),
  choice("6200", "Software and subscriptions"),
  choice("6090", "Office expense"),
  choice("2000", "Business credit card"),
  choice("7000", "Legacy account", false),
];
const line = (accountId: string, debit: string | null, credit: string | null): JournalLine => ({
  id: accountId,
  accountId,
  debit,
  credit,
});

describe("an account is named by its name", () => {
  test("its own name when the application gives one", () => {
    expect(accountName(accounts, "1000")).toBe("Business checking");
  });
  test("what a picker calls it when there is no name, and its identifier when it is unknown", () => {
    expect(accountName(accounts, "7000")).toBe("7000 · Legacy account");
    expect(accountName(accounts, "nope")).toBe("nope");
  });
});

describe("the accounts of an entry read as money moving", () => {
  test("a payment goes from the account credited to the account debited", () => {
    const flow = accountFlow(
      { lines: [line("6200", "19.00", null), line("1000", null, "19.00")] },
      accounts,
    );
    expect(flow).toEqual({
      from: ["Business checking"],
      to: ["Software and subscriptions"],
      open: [],
    });
  });

  test("money received goes from Sales into the bank", () => {
    const flow = accountFlow(
      { lines: [line("1000", "498.75", null), line("4000", null, "498.75")] },
      accounts,
    );
    expect(flow.from).toEqual(["Sales"]);
    expect(flow.to).toEqual(["Business checking"]);
  });

  test("a split lists each account once, in the order the entry names them", () => {
    const flow = accountFlow(
      {
        lines: [
          line("6090", "118.40", null),
          line("6200", "200.00", null),
          line("6090", "10.00", null),
          line("1000", null, "328.40"),
        ],
      },
      accounts,
    );
    expect(flow.to).toEqual(["Office expense", "Software and subscriptions"]);
    expect(flow.from).toEqual(["Business checking"]);
  });

  test("a line with an amount on neither side is an account still being filled in", () => {
    const flow = accountFlow(
      { lines: [line("1000", "5.00", null), line("4000", "", null), line("6200", null, null)] },
      accounts,
    );
    expect(flow.to).toEqual(["Business checking"]);
    expect(flow.open).toEqual(["Sales", "Software and subscriptions"]);
  });

  test("an entry with no lines names no accounts", () => {
    expect(accountFlow({ lines: [] }, accounts)).toEqual({ from: [], to: [], open: [] });
  });
});

describe("a reversal and the entry it cancels", () => {
  const original = "0f1c9a0e-5d3b-4c8f-9e2a-1b6d4c7e8f90";
  const reversal = "7b2d6e41-93a8-4f10-8c55-2e0a6d9b3c17";
  const links: RegisterCorrection[] = [
    {
      kind: "reversal",
      originalJournalId: original,
      correctionJournalId: reversal,
      originalPostingSequence: "18",
      correctionPostingSequence: "24",
    },
  ];
  const number = (sequence: string) => `No. ${sequence}`;

  test("each says which entry it is paired with, by number", () => {
    expect(correctionNote(original, links)).toEqual({
      kind: "reversedBy",
      journalId: reversal,
      number: "24",
    });
    expect(correctionNote(reversal, links)).toEqual({
      kind: "reverses",
      journalId: original,
      number: "18",
    });
  });

  test("an entry no reversal links has no note", () => {
    expect(correctionNote("something-else", links)).toBeUndefined();
    expect(correctionNote(original, undefined)).toBeUndefined();
  });

  test("a reversal's narration names the entry it cancels by its number, not its identifier", () => {
    const narration = `Reversal of ${original}: Entered twice by mistake`;
    expect(plainNarration(narration, reversal, links, number)).toBe(
      "Reversal of No. 18: Entered twice by mistake",
    );
  });

  test("any other narration is left as it is", () => {
    expect(plainNarration("Coworking, March", reversal, links, number)).toBe("Coworking, March");
    // The original is not a reversal: its narration is its own.
    expect(plainNarration(`Reversal of ${original}: x`, original, links, number)).toBe(
      `Reversal of ${original}: x`,
    );
    // Without the other entry's number there is nothing better to say.
    const bare: RegisterCorrection[] = [
      { originalJournalId: original, correctionJournalId: reversal },
    ];
    expect(plainNarration(`Reversal of ${original}: x`, reversal, bare, number)).toBe(
      `Reversal of ${original}: x`,
    );
  });
});

describe("a side of an entry is a short list", () => {
  const more = (count: number) => `${count} more`;
  test("names up to the limit and says how many more", () => {
    expect(sideText(["A", "B", "C"], 3, more)).toBe("A, B, C");
    expect(sideText(["A", "B", "C", "D", "E"], 3, more)).toBe("A, B, C, 2 more");
    expect(sideText([], 3, more)).toBe("");
  });
});
