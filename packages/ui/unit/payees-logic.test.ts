import { describe, expect, test } from "bun:test";
import {
  formErrors,
  hasErrors,
  keyLength,
  keyOf,
  nameFormValues,
  nameFromWords,
  parseWords,
  payeeFormValues,
  saveFields,
  testSentences,
  whoWrote,
  wouldRefuse,
} from "../src/payees/logic";
import type { PayeeTallyView, PayeeTestData, PayeeView } from "../src/payees/types";
import { words } from "../src/payees/words";

const nothing: PayeeTallyView = { received: "0.00", spent: "0.00", transactions: 0 };
const tally = (spent: string, transactions: number, received = "0.00"): PayeeTallyView => ({
  received,
  spent,
  transactions,
});
const test0: PayeeTestData = {
  keys: ["uber"],
  problems: [],
  matches: nothing,
  stays: nothing,
  fromUnnamed: nothing,
  fromAmbiguous: nothing,
  fromNowhere: nothing,
  taken: [],
  lost: nothing,
  tied: { ...nothing, payees: [] },
  beaten: [],
};

describe("the words a person types", () => {
  test("are split on rows and semicolons, trimmed, and kept once whatever the case", () => {
    expect(parseWords("Uber\n uber eats ;UBER\n\n;  ")).toEqual(["Uber", "uber eats"]);
    expect(parseWords("")).toEqual([]);
    expect(parseWords("  \n ; \n")).toEqual([]);
  });

  test("are reduced to a key the way the service reduces them: lower case, letters and digits, single spaces", () => {
    expect(keyOf("SQ *BLUE  BOTTLE-COFFEE #12")).toBe("sq blue bottle coffee 12");
    expect(keyOf("  Jane  Q. Doe ")).toBe("jane q doe");
    expect(keyOf("ÉCOLE d’art")).toBe("école d art");
    expect(keyOf("***")).toBe("");
    expect(keyLength("jane doe")).toBe(8);
    expect(keyLength("a b")).toBe(3);
    expect(keyLength("--")).toBe(0);
  });

  test("a name is made from the first set of words", () => {
    expect(nameFromWords("blue bottle coffee")).toBe("Blue Bottle Coffee");
    expect(nameFromWords("acme design\nacme")).toBe("Acme Design");
    expect(nameFromWords("")).toBe("");
    expect(nameFromWords("x".repeat(300)).length).toBe(120);
  });

  test("a form to name a payee from a text holds the name and words it offers and nothing else", () => {
    expect(nameFormValues("blue bottle coffee")).toEqual({
      name: "Blue Bottle Coffee",
      words: "blue bottle coffee",
      note: "",
      retired: false,
    });
    expect(nameFormValues("")).toEqual({ name: "", words: "", note: "", retired: false });
  });

  test("a form to change a payee holds it as it stands, one set of words to a row", () => {
    const payee: PayeeView = {
      id: "pay_1",
      version: 4,
      name: "Stripe",
      words: ["stripe", "stripe payments"],
      defaultAccountId: null,
      note: "Shop",
      retired: true,
      hasTaxDetails: false,
      recordedAt: "2026-03-01T00:00:00.000Z",
      principal: "owner",
    };
    expect(payeeFormValues(payee)).toEqual({
      name: "Stripe",
      words: "stripe\nstripe payments",
      note: "Shop",
      retired: true,
    });
  });
});

describe("what is wrong with a form before it is sent", () => {
  const form = (name: string, text: string) => ({ name, words: text, note: "", retired: false });

  test("naming a payee needs a name and words; changing one needs a name only", () => {
    expect(formErrors(form("", ""), true)).toEqual({
      name: words.nameRequired,
      words: words.wordsRequired,
    });
    expect(formErrors(form("Stripe", ""), true)).toEqual({ words: words.wordsRequired });
    expect(formErrors(form("Stripe", ""), false)).toEqual({});
    expect(formErrors(form("   ", "stripe"), false)).toEqual({ name: words.nameRequired });
    expect(hasErrors(formErrors(form("Stripe", "stripe"), true))).toBe(false);
  });

  test("words are held to the service's limits so the form can say so first", () => {
    expect(formErrors(form("Ab", "ab"), true).words).toBe(words.wordsShort);
    expect(formErrors(form("Ab", "uber\nab"), true).words).toBe(words.wordsShort);
    expect(formErrors(form("Ab", "***"), true).words).toBe(words.wordsShort);
    expect(formErrors(form("Ab", "a b"), true).words).toBeUndefined();
    expect(formErrors(form("Long", "x".repeat(121)), true).words).toBe(words.wordsLong);
    expect(
      formErrors(form("Many", Array.from({ length: 21 }, (_, i) => `words ${i}`).join("\n")), true)
        .words,
    ).toBe(words.wordsMany);
    expect(
      formErrors(
        form("Twenty", Array.from({ length: 20 }, (_, i) => `words ${i}`).join("\n")),
        true,
      ),
    ).toEqual({});
  });

  test("what is sent is cleaned the same way", () => {
    expect(
      saveFields({
        name: "  Stripe ",
        words: "Stripe\nstripe\n stripe payments ",
        note: " n ",
        retired: true,
      }),
    ).toEqual({
      name: "Stripe",
      words: ["Stripe", "stripe payments"],
      note: "n",
      retired: true,
    });
  });
});

describe("what some words would find, said in order of what a person needs to know", () => {
  test("words that find nothing say so; words with a problem say the problem and not that", () => {
    expect(testSentences(test0)).toEqual([{ tone: "attention", text: words.testNothing }]);
    expect(
      testSentences({
        ...test0,
        keys: [],
        problems: [
          { code: "invalid_input", message: "The words need at least 3 letters or digits." },
        ],
      }),
    ).toEqual([{ tone: "problem", text: "The words need at least 3 letters or digits." }]);
    expect(wouldRefuse(undefined)).toBe(false);
    expect(wouldRefuse(test0)).toBe(false);
    expect(wouldRefuse({ ...test0, problems: [{ code: "x", message: "No." }] })).toBe(true);
  });

  test("words that find transactions say how many and how much, then what moves and what is kept", () => {
    const found: PayeeTestData = {
      ...test0,
      matches: tally("41.20", 7),
      stays: tally("5.00", 1),
      fromUnnamed: tally("29.45", 5),
      fromAmbiguous: tally("3.00", 1),
      fromNowhere: tally("2.00", 1),
      taken: [{ payee: { id: "p2", name: "Blue Bottle Roasters" }, tally: tally("11.75", 2) }],
      lost: tally("8.00", 1),
      tied: {
        ...tally("52.19", 2),
        payees: [
          { id: "a", name: "Amazon" },
          { id: "b", name: "AWS" },
        ],
      },
      beaten: [
        { payee: { id: "p3", name: "Blue Bottle Coffee Roasters" }, tally: tally("9.00", 3) },
      ],
    };
    const said = testSentences(found);
    expect(said.map((sentence) => sentence.text)).toEqual([
      "These words find 7 transactions: 41.20 spent.",
      "1 transaction already belongs to this payee.",
      "5 transactions are not named yet.",
      "2 transactions belong to Blue Bottle Roasters now and would move to this payee.",
      "1 transaction matches more than one payee equally now. These words would settle it.",
      "1 transaction is an entry with no bank text to tell it apart by.",
      "1 transaction that belongs to this payee now would no longer, because the words changed.",
      "2 transactions match these words as well as Amazon and AWS. They would be given to none of them. Make one set of words longer.",
      "3 transactions contain these words but stay with Blue Bottle Coffee Roasters, whose words are longer.",
    ]);
    // What moves away from another payee, what is lost and what is tied are for a person to weigh.
    expect(said.filter((sentence) => sentence.tone === "attention").length).toBe(3);
  });

  test("money in is said as received, and a zero side is left out", () => {
    const said = testSentences({ ...test0, matches: tally("0.00", 2, "300.00") });
    expect(said[0]?.text).toBe("These words find 2 transactions: 300.00 received.");
    const both = testSentences({ ...test0, matches: tally("12.00", 3, "300.00") });
    expect(both[0]?.text).toBe("These words find 3 transactions: 12.00 spent and 300.00 received.");
  });
});

describe("who recorded a version", () => {
  test("is said in words a person knows", () => {
    expect(whoWrote("owner")).toBe("you");
    expect(whoWrote("agent:tok_1f3a")).toBe("an agent");
    expect(whoWrote("service:payees-migration")).toBe("Rastrata");
    expect(whoWrote("someone@example.com")).toBe("someone@example.com");
  });
});
