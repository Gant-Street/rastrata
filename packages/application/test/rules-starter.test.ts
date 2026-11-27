import { afterEach, describe, expect, test } from "bun:test";
import { buildTemplate } from "../src/chart/templates.ts";
import type { IngestItem, ProposalContext } from "../src/ingest-types.ts";
import { sumMoney } from "../src/money.ts";
import {
  accountFor,
  KINDS,
  type StarterAccount,
  type StarterKind,
} from "../src/rules/starter/accounts.ts";
import { findMerchant, starterMerchants } from "../src/rules/starter/match.ts";
import {
  createStarterProposer,
  merchantHistory,
  STARTER_CONFIDENCE,
  STARTER_PROPOSER,
  starterReason,
} from "../src/rules/starter/proposer.ts";
import { starterWords } from "../src/rules/starter/text.ts";
import { registeredProposers } from "../src/slices/ingest/proposers.ts";
import { batchOf, closeFixtures, ingestFixture, type Json } from "./support/ingest-fixture.ts";

afterEach(() => closeFixtures());

// ---- Reading the bank's text -------------------------------------------------------------------------------

describe("bank text, as the starter list reads it", () => {
  test("an apostrophe or an ampersand between letters joins, so one merchant is one word however it is written", () => {
    expect(starterWords("MCDONALD'S #1234 DENVER CO")).toEqual([
      "mcdonalds",
      "1234",
      "denver",
      "co",
    ]);
    expect(starterWords("MCDONALDS F1234")).toEqual(["mcdonalds", "f", "1234"]);
    expect(starterWords("AT&T BILL PAYMENT")).toEqual(["att", "bill", "payment"]);
    expect(starterWords("ATT*BILL PAYMENT")).toEqual(["att", "bill", "payment"]);
    // An ampersand with spaces around it separates two names.
    expect(starterWords("BARNES & NOBLE")).toEqual(["barnes", "noble"]);
  });

  test("letters and digits are read apart, so a store, ticket or reference number never hides the name", () => {
    expect(starterWords("STARBUCKS#12345")).toEqual(["starbucks", "12345"]);
    expect(starterWords("AMERICAN AIR0012345678901")).toEqual(["american", "air", "0012345678901"]);
    expect(starterWords("SQ *BLUE BOTTLE 8F2K3")).toEqual([
      "sq",
      "blue",
      "bottle",
      "8",
      "f",
      "2",
      "k",
      "3",
    ]);
  });

  test("a text of any length is read, and an empty one is no words", () => {
    expect(starterWords("")).toEqual([]);
    expect(starterWords("x".repeat(100_000)).length).toBeGreaterThan(0);
  });
});

// ---- Which merchant a line names ---------------------------------------------------------------------------

const outcome = (...fields: (string | undefined)[]) => {
  const found = findMerchant(fields);
  return found.outcome === "found" ? found.kind : found.outcome;
};

describe("which merchant a line names", () => {
  test("the list is a few hundred merchants, each once, each of a kind the mapping knows", () => {
    const list = starterMerchants();
    expect(list.length).toBeGreaterThanOrEqual(400);
    expect(new Set(list.map((entry) => entry.id)).size).toBe(list.length);
    for (const entry of list) if (entry.kind !== null) expect(KINDS[entry.kind]).toBeDefined();
  });

  test("a merchant is found however the bank wraps it", () => {
    const cases: [string, StarterKind][] = [
      ["GOOGLE WORKSPACE", "software"],
      ["ACH DEBIT GOOGLE WORKSPACE", "software"],
      ["GOOGLE *WORKSPACE 650-253-0000 CA", "software"],
      ["POS DEBIT 1234 STAPLES 00123 DENVER CO", "officeSupplies"],
      ["USPS PO 1234", "postage"],
      ["FEDEX 123456789", "shipping"],
      ["XCEL ENERGY", "utilities"],
      ["STATE FARM INSURANCE", "insurance"],
      ["GUSTO PAYROLL", "payroll"],
      ["MONTHLY SERVICE FEE", "bankFees"],
      ["OVERDRAFT FEE", "bankFees"],
      ["STRIPE TRANSFER ST-X1", "stripePayout"],
      ["SQUARESPACE INC", "hosting"],
      ["ADOBE CREATIVE CLOUD", "software"],
      ["INTUIT *QBooks", "software"],
      ["AT&T BILL PAYMENT", "telecom"],
      ["VERIZON WIRELESS PAYMENTS", "telecom"],
      ["SHELL OIL 57442", "fuel"],
      ["STARBUCKS #12345", "meals"],
      ["AMERICAN AIR0012345678901", "travel"],
      ["RENT 1450 LARIMER", "rent"],
    ];
    for (const [text, kind] of cases) expect(outcome(text), text).toBe(kind);
  });

  test("a line whose counterparty names the merchant is found from that field alone", () => {
    expect(outcome("Adobe", "PAYMENT 8392")).toBe("software");
    expect(outcome(undefined, "GITHUB, INC. 8F2K3")).toBe("software");
  });

  test("the longer spelling wins over the shorter one it contains", () => {
    expect(outcome("UBER EATS")).toBe("meals");
    expect(outcome("UBER *TRIP HELP.UBER.COM")).toBe("travel");
    expect(outcome("GUSTO TAX")).toBe("payrollTaxes");
    expect(outcome("GUSTO PAYROLL")).toBe("payroll");
  });

  test("a line that says it is a place to eat is never read as anything else", () => {
    expect(outcome("ADOBE GRILL")).toBe("unclear");
    expect(outcome("CAFE ADOBE")).not.toBe("software");
  });

  test("what it is not sure of is left to the person: it says nothing", () => {
    // Known to sell many kinds of thing, or no merchant at all.
    for (const text of [
      "COSTCO WHOLESALE 0412",
      "AMAZON.COM*2K4LP",
      "AMZN MKTP US",
      "WALMART SUPERCENTER",
      "TRANSFER TO SAVINGS",
      "ZELLE PAYMENT TO JOHN",
      "CHECK 1042",
      "ATM WITHDRAWAL",
      "",
    ])
      expect(outcome(text), text).toBe("none");
  });

  test("a name is found as whole words only, never inside another word", () => {
    expect(outcome("PARENT TEACHER ASSOCIATION")).toBe("none");
    expect(outcome("CURRENT BILL")).toBe("none");
    expect(outcome("GUSTOSO FOODS")).toBe("none");
  });

  test("two merchants of different kinds in one line are unclear, and say nothing", () => {
    expect(outcome("GOOGLE WORKSPACE FEDEX 1234")).toBe("unclear");
  });

  test("the reason is one plain sentence with no figure in it", () => {
    const sentence = (text: string) => {
      const found = findMerchant([text]);
      if (found.outcome !== "found") throw new Error(`${text} is not found`);
      return starterReason(found.entry, found.kind);
    };
    expect(sentence("USPS PO 1234")).toBe("USPS is usually postage.");
    expect(sentence("GOOGLE WORKSPACE")).toBe("Google Workspace is usually software.");
    expect(sentence("MONTHLY SERVICE FEE")).toBe("A monthly service fee is a bank fee.");
    expect(sentence("STRIPE TRANSFER ST-X1")).toBe(
      "A Stripe transfer is usually a payout from Stripe.",
    );
    for (const entry of starterMerchants()) {
      if (entry.kind === null) continue;
      const reason = starterReason(entry, entry.kind);
      // (A name may have a digit in it, like 1Password; the sentence has no figure of its own.)
      expect(reason.replace(entry.name, ""), entry.id).not.toMatch(/\d|%|percent/i);
      expect(reason, entry.id).toMatch(/\.$/);
    }
  });
});

// ---- Which account of this book a kind goes to --------------------------------------------------------------

const templateChart = (id: string, addOns: string[] = ["online-business"]): StarterAccount[] =>
  buildTemplate(id, { basis: "cash", taxYear: 2026, addOns }).accounts.map((account) => ({
    id: account.code,
    name: account.name,
    role: account.role,
    taxLine: account.tags.taxLine,
    roleKey: account.tags.roleKey,
  }));

const nameOf = (chart: readonly StarterAccount[], kind: StarterKind): string | undefined => {
  const choice = accountFor(kind, chart);
  return choice ? chart.find((account) => account.id === choice.accountId)?.name : undefined;
};

describe("which account a kind goes to, on each chart template", () => {
  test("Schedule C: by tax line first, by name where the form has no line of its own", () => {
    const chart = templateChart("sole-proprietor");
    expect(nameOf(chart, "software")).toBe("Software and subscriptions");
    expect(nameOf(chart, "utilities")).toBe("Utilities");
    expect(nameOf(chart, "insurance")).toBe("Insurance (other than health)");
    expect(nameOf(chart, "payroll")).toBe("Wages");
    expect(nameOf(chart, "rent")).toBe("Rent or lease: Office space");
    expect(nameOf(chart, "meals")).toBe("Meals");
    expect(nameOf(chart, "fuel")).toBe("Car and truck expenses");
    expect(nameOf(chart, "bankFees")).toBe("Bank and card fees");
    expect(nameOf(chart, "postage")).toBe("Office expense");
    expect(accountFor("utilities", chart)?.basis).toBe("taxLine");
    expect(accountFor("bankFees", chart)?.basis).toBe("name");
  });

  test("an S corporation: wages are two lines (officers and everyone else), so a payroll debit is not guessed", () => {
    const chart = templateChart("s-corporation");
    expect(nameOf(chart, "payroll")).toBeUndefined();
    expect(nameOf(chart, "software")).toBe("Software and subscriptions");
    expect(nameOf(chart, "insurance")).toBe("Insurance");
    expect(nameOf(chart, "rent")).toBe("Rent");
    expect(nameOf(chart, "fuel")).toBe("Travel");
  });

  test("a partnership: guaranteed payments are not payroll, and wages to others are", () => {
    const chart = templateChart("partnership");
    expect(nameOf(chart, "payroll")).toBe("Salaries and wages (other than to partners)");
    expect(nameOf(chart, "advertising")).toBe("Advertising and marketing");
    expect(nameOf(chart, "rent")).toBe("Rent");
  });

  test("the generic chart has no tax lines, and its names carry every kind", () => {
    const chart = templateChart("generic");
    expect(chart.every((account) => account.taxLine === undefined)).toBe(true);
    for (const kind of [
      "software",
      "utilities",
      "insurance",
      "payroll",
      "meals",
      "travel",
      "bankFees",
    ] as const)
      expect(nameOf(chart, kind), kind).toBeDefined();
    expect(nameOf(chart, "payroll")).toBe("Wages");
    expect(nameOf(chart, "payrollTaxes")).toBe("Payroll taxes");
  });

  test("a payout from Stripe goes to the account that carries the role key, whatever it is called", () => {
    for (const id of ["sole-proprietor", "s-corporation", "partnership", "generic"])
      expect(nameOf(templateChart(id), "stripePayout"), id).toBe("Stripe payouts in transit");
    const renamed = templateChart("sole-proprietor").map((account) =>
      account.roleKey === "payouts.in-transit" ? { ...account, name: "Money on its way" } : account,
    );
    expect(nameOf(renamed, "stripePayout")).toBe("Money on its way");
    // A book that has no such account has nothing to suggest.
    expect(nameOf(templateChart("sole-proprietor", []), "stripePayout")).toBeUndefined();
  });

  test("every kind of a template's chart is either one account or none, never a guess between two", () => {
    for (const id of ["sole-proprietor", "s-corporation", "partnership", "generic"]) {
      const chart = templateChart(id);
      for (const kind of Object.keys(KINDS) as StarterKind[]) {
        const choice = accountFor(kind, chart);
        if (choice === null) continue;
        const account = chart.find((candidate) => candidate.id === choice.accountId);
        expect(account?.role, `${id} ${kind}`).toBe(KINDS[kind].role);
      }
    }
  });
});

describe("which account a kind goes to, on a chart the owner has edited", () => {
  const expense = (id: string, name: string, taxLine?: string): StarterAccount => ({
    id,
    name,
    role: "expense",
    taxLine,
  });

  test("a rename does not move the suggestion: the tax line the chart records is what is read", () => {
    const chart = [expense("a", "Power and light", "scheduleC.line25"), expense("b", "Meals out")];
    expect(accountFor("utilities", chart)).toEqual({ accountId: "a", basis: "taxLine" });
  });

  test("two accounts on one line are told apart by name, or not at all", () => {
    const split = [
      expense("a", "Electric", "scheduleC.line25"),
      expense("b", "Water and sewer", "scheduleC.line25"),
    ];
    expect(accountFor("utilities", split)).toBeNull();
    const named = [
      expense("a", "Utilities", "scheduleC.line25"),
      expense("b", "Water and sewer", "scheduleC.line25"),
    ];
    expect(accountFor("utilities", named)).toEqual({ accountId: "a", basis: "taxLine" });
  });

  test("two accounts that could both be meant give nothing", () => {
    const chart = [expense("a", "Software"), expense("b", "Software subscriptions")];
    expect(accountFor("software", chart)).toBeNull();
  });

  test("a word that says the account is something else rules it out", () => {
    expect(accountFor("insurance", [expense("a", "Health insurance")])).toBeNull();
    expect(accountFor("insurance", [expense("a", "Insurance")])).toEqual({
      accountId: "a",
      basis: "name",
    });
    expect(accountFor("rent", [expense("a", "Equipment rental")])).toBeNull();
    expect(accountFor("payrollTaxes", [expense("a", "Payroll taxes")])).toEqual({
      accountId: "a",
      basis: "name",
    });
  });

  test("an account of another role is never chosen, and a chart without the account has none", () => {
    const asset: StarterAccount = { id: "a", name: "Software", role: "asset" };
    expect(accountFor("software", [asset])).toBeNull();
    expect(accountFor("bankFees", [expense("a", "Meals")])).toBeNull();
    expect(accountFor("software", [])).toBeNull();
  });

  test("a code says nothing: the same code is a different account on another form", () => {
    expect(accountFor("software", [expense("6100", "Rent")])).toBeNull();
  });
});

// ---- What the proposer says -------------------------------------------------------------------------------

const BANK = "1000";
const tagsByCode = new Map(
  buildTemplate("sole-proprietor", {
    basis: "cash",
    taxYear: 2026,
    addOns: ["online-business"],
  }).accounts.map((account) => [account.code, account.tags] as const),
);
type Edits = Partial<Record<string, { closedOn?: string; openedOn?: string }>>;
const chartAccounts = (changes: Edits = {}): ProposalContext["accounts"][number][] => [
  { id: BANK, code: BANK, name: "Business checking", role: "asset", closedOn: null },
  ...buildTemplate("sole-proprietor", {
    basis: "cash",
    taxYear: 2026,
    addOns: ["online-business"],
  }).accounts.map((account) => {
    const opened = changes[account.code]?.openedOn;
    return {
      id: account.code,
      code: account.code,
      name: account.name,
      role: account.role,
      closedOn: changes[account.code]?.closedOn ?? null,
      ...(opened !== undefined ? { openedOn: opened } : {}),
    };
  }),
];
const contextOf = (changes?: Edits): ProposalContext => ({
  accounts: chartAccounts(changes),
  currency: "USD",
});
const lineOf = (description: string, amount: string, extra: Partial<IngestItem["line"]> = {}) =>
  ({
    kind: "bankLine",
    provider: "csv",
    accountKey: "csv:1000",
    rawIndex: 0,
    postedOn: "2026-03-04",
    amount,
    currency: "USD",
    description,
    ...extra,
  }) as IngestItem["line"];
const itemOf = (
  description: string,
  amount: string,
  partial: Partial<IngestItem> = {},
): IngestItem => ({
  id: "item-1",
  line: lineOf(description, amount),
  batchId: "batch-1",
  status: "new",
  ledgerAccountId: BANK,
  ...partial,
});
const starter = (options: Parameters<typeof createStarterProposer>[0] = {}) =>
  createStarterProposer({ tagsOf: (id) => tagsByCode.get(id) ?? {}, ...options });
const accountNamed = (name: string) =>
  chartAccounts().find((account) => account.name === name)?.id as string;

describe("the starter proposer", () => {
  test("a known merchant is suggested the account its kind goes to, with the reason in one sentence", () => {
    const proposals = starter().propose(itemOf("USPS PO 1234", "-42.80"), contextOf());
    expect(proposals).toHaveLength(1);
    const [proposal] = proposals;
    expect(proposal).toMatchObject({
      proposer: STARTER_PROPOSER,
      kind: "categorize",
      confidence: STARTER_CONFIDENCE,
      reasons: ["USPS is usually postage."],
    });
    expect(proposal?.legs).toEqual([
      { accountId: BANK, amount: "-42.80" },
      { accountId: accountNamed("Office expense"), amount: "42.80" },
    ]);
    expect(sumMoney((proposal?.legs ?? []).map((leg) => leg.amount))).toBe("0.00");
  });

  test("it is the weakest source: its name is starter, and its confidence is below anything learned", () => {
    expect(STARTER_PROPOSER).toBe("starter");
    expect(STARTER_CONFIDENCE).toBe(0.5);
  });

  test("money in is never an expense: a refund from a software merchant is left to the person", () => {
    expect(starter().propose(itemOf("ADOBE CREATIVE CLOUD", "20.00"), contextOf())).toEqual([]);
    expect(starter().propose(itemOf("GUSTO PAYROLL", "100.00"), contextOf())).toEqual([]);
    // And money out is never a payout.
    expect(starter().propose(itemOf("STRIPE TRANSFER ST-X1", "-100.00"), contextOf())).toEqual([]);
  });

  test("a deposit from Stripe goes to the account the payouts wait in, and to none where the Stripe lane pairs it", () => {
    const proposals = starter().propose(itemOf("STRIPE TRANSFER ST-X1", "1318.40"), contextOf());
    expect(proposals[0]?.legs).toEqual([
      { accountId: BANK, amount: "1318.40" },
      { accountId: accountNamed("Stripe payouts in transit"), amount: "-1318.40" },
    ]);
    expect(proposals[0]?.reasons).toEqual(["A Stripe transfer is usually a payout from Stripe."]);
    // Stripe has told the book about its payouts: the deposit is paired with its payout exactly.
    expect(
      starter({ roleAccount: () => null }).propose(
        itemOf("STRIPE TRANSFER ST-X1", "1318.40"),
        contextOf(),
      ),
    ).toEqual([]);
  });

  test("a line a rule decides gets nothing from the list, even when the rule can no longer be applied", () => {
    const decided = starter({ decidedByRule: () => true });
    expect(decided.propose(itemOf("USPS PO 1234", "-42.80"), contextOf())).toEqual([]);
  });

  test("where the book has booked the merchant to another account, the list says nothing; where to the same, it does", () => {
    const office = accountNamed("Office expense");
    const history = (accounts: string[]) =>
      starter({ bookedTo: () => new Set(accounts) }).propose(
        itemOf("USPS PO 1234", "-42.80"),
        contextOf(),
      );
    expect(history([accountNamed("Meals")])).toEqual([]);
    expect(history([office, accountNamed("Meals")])).toEqual([]);
    expect(history([office])).toHaveLength(1);
    expect(history([])).toHaveLength(1);
  });

  test("an account that is closed, or not yet open on the line's date, is not suggested", () => {
    const office = accountNamed("Office expense");
    const line = itemOf("USPS PO 1234", "-42.80");
    expect(starter().propose(line, contextOf({ [office]: { closedOn: "2026-01-01" } }))).toEqual(
      [],
    );
    expect(starter().propose(line, contextOf({ [office]: { openedOn: "2026-04-01" } }))).toEqual(
      [],
    );
    expect(
      starter().propose(line, contextOf({ [office]: { openedOn: "2026-03-04" } })),
    ).toHaveLength(1);
  });

  test("an account that takes no postings is left out as if it were not there", () => {
    const context: ProposalContext = {
      ...contextOf(),
      accounts: chartAccounts().map((account) =>
        account.name === "Office expense" ? { ...account, postingAllowed: false } : account,
      ),
    };
    expect(starter().propose(itemOf("USPS PO 1234", "-42.80"), context)).toEqual([]);
  });

  test("a line that has been decided, posted or set aside is not suggested for again", () => {
    for (const status of ["posted", "excluded", "drafted"] as const)
      expect(
        starter().propose(itemOf("USPS PO 1234", "-42.80", { status }), contextOf()),
        status,
      ).toEqual([]);
    expect(
      starter().propose(itemOf("USPS PO 1234", "-42.80", { status: "proposed" }), contextOf()),
    ).toHaveLength(1);
  });

  test("a line with no bank account, no amount or a text nobody knows gets nothing", () => {
    expect(
      starter().propose(itemOf("USPS PO 1234", "-42.80", { ledgerAccountId: null }), contextOf()),
    ).toEqual([]);
    expect(starter().propose(itemOf("USPS PO 1234", "0.00"), contextOf())).toEqual([]);
    expect(starter().propose(itemOf("USPS PO 1234", "not a number"), contextOf())).toEqual([]);
    expect(starter().propose(itemOf("COSTCO WHOLESALE 0412", "-212.66"), contextOf())).toEqual([]);
  });

  test("a line from another system (not a bank line) gets nothing", () => {
    const event = {
      id: "item-2",
      line: {
        kind: "event",
        provider: "stripe",
        accountKey: "stripe:acct_1:usd",
        rawIndex: 0,
        eventOn: "2026-03-04",
        summary: "USPS",
        currency: "USD",
        legs: [],
      },
      batchId: "batch-1",
      status: "new",
      ledgerAccountId: null,
    } as unknown as IngestItem;
    expect(starter().propose(event, contextOf())).toEqual([]);
  });

  test("how the book booked a merchant is read from its examples, by merchant and by side", () => {
    const booked = merchantHistory([
      { text: "USPS PO 1234", accountId: "6100", direction: "out" },
      { text: "USPS PO 5678", accountId: "6200", direction: "out" },
      { text: "USPS REFUND", accountId: "4000", direction: "in" },
      { text: "A TEXT NOBODY KNOWS", accountId: "6300", direction: "out" },
    ]);
    const usps = findMerchant(["USPS PO 1234"]);
    if (usps.outcome !== "found") throw new Error("USPS is not found");
    expect([...(booked(usps.entry.id, "out") ?? [])].sort()).toEqual(["6100", "6200"]);
    expect([...(booked(usps.entry.id, "in") ?? [])]).toEqual(["4000"]);
    expect(booked("software:Adobe", "out")).toBeUndefined();
  });
});

// ---- In the Inbox -----------------------------------------------------------------------------------------

/** The statement of the study of 2026-11-11: a new studio's first month at the bank, 15 lines. */
const STATEMENT = [
  { date: "2026-10-01", amount: "1318.40", description: "STRIPE TRANSFER ST-X1" },
  { date: "2026-10-02", amount: "-16.00", description: "SQUARESPACE INC" },
  { date: "2026-10-03", amount: "-42.80", description: "USPS PO 1234" },
  { date: "2026-10-05", amount: "-1840.00", description: "GUSTO PAYROLL" },
  { date: "2026-10-08", amount: "959.87", description: "STRIPE TRANSFER ST-X2" },
  { date: "2026-10-09", amount: "-14.40", description: "GOOGLE WORKSPACE" },
  { date: "2026-10-12", amount: "-212.66", description: "COSTCO WHOLESALE 0412" },
  { date: "2026-10-14", amount: "-96.12", description: "XCEL ENERGY" },
  { date: "2026-10-15", amount: "1204.15", description: "STRIPE TRANSFER ST-X3" },
  { date: "2026-10-16", amount: "-1500.00", description: "RENT 1450 LARIMER" },
  { date: "2026-10-19", amount: "-59.99", description: "ADOBE CREATIVE CLOUD" },
  { date: "2026-10-20", amount: "-15.00", description: "MONTHLY SERVICE FEE" },
  { date: "2026-10-22", amount: "884.30", description: "STRIPE TRANSFER ST-X4" },
  { date: "2026-10-26", amount: "-131.00", description: "STATE FARM INSURANCE" },
  { date: "2026-10-29", amount: "-27.35", description: "USPS PO 1234" },
];

/** A new book made from a template, with one bank account (what a first import makes). */
async function newBook(template: string, addOns: string[] = ["online-business"]) {
  const f = await ingestFixture({ setup: false });
  const built = buildTemplate(template, { basis: "cash", taxYear: 2026, addOns });
  const setup = await f.call(
    "book.setup",
    {
      name: "Larimer Studio",
      currency: "USD",
      fiscalYear: 2026,
      periodModel: "monthly",
      accounts: [
        { code: BANK, name: "Business checking", role: "asset" },
        ...built.accounts.map((account) => ({
          code: account.code,
          name: account.name,
          role: account.role,
          ...(account.parentCode ? { parentCode: account.parentCode } : {}),
          tags: account.tags,
        })),
      ],
    },
    crypto.randomUUID(),
  );
  expect(setup.body.ok, JSON.stringify(setup.body)).toBe(true);
  return f;
}

const inboxOf = async (f: Awaited<ReturnType<typeof newBook>>) => {
  const reply = await f.call("inbox.list", { pageSize: 200 });
  expect(reply.body.ok, JSON.stringify(reply.body)).toBe(true);
  return reply.body.data.items as Json[];
};

const submit = (
  f: Awaited<ReturnType<typeof newBook>>,
  lines: readonly { date: string; amount: string; description: string }[],
) => f.port.submit(batchOf(f.port, lines, { ledgerAccountId: BANK }));

describe("the starter list in the Inbox", () => {
  test("it is registered as a proposer of last resort, after the others by name and by turn", () => {
    const registered = registeredProposers();
    const names = registered.map((entry) => entry.name);
    expect(names).toContain("starter");
    expect(names).toEqual([...names].sort());
    expect(registered.find((entry) => entry.name === "starter")?.fallback).toBe(true);
    for (const entry of registered.filter((candidate) => candidate.name !== "starter"))
      expect(entry.fallback, entry.name).not.toBe(true);
  });

  test("a first import into a new book arrives with a suggestion for the lines whose merchant is common", async () => {
    const f = await newBook("sole-proprietor");
    submit(f, STATEMENT);
    const items = await inboxOf(f);
    expect(items).toHaveLength(15);
    const suggested = items.filter((item) => item.suggestion);
    // 14 of 15: only the Costco line is left to the person.
    expect(suggested).toHaveLength(14);
    expect(items.filter((item) => !item.suggestion).map((item) => item.line.description)).toEqual([
      "COSTCO WHOLESALE 0412",
    ]);
    // Every one of them says where it came from, so an agent can tell it from a learned one.
    expect(new Set(suggested.map((item) => item.suggestion.proposer))).toEqual(
      new Set(["starter"]),
    );
    const category = (description: string) => {
      const item = items.find((candidate) => candidate.line.description === description);
      const names = new Map(
        buildTemplate("sole-proprietor", {
          basis: "cash",
          taxYear: 2026,
          addOns: ["online-business"],
        }).accounts.map((account) => [account.code, account.name] as const),
      );
      const leg = item?.suggestion.legs.find((candidate: Json) => candidate.accountId !== BANK);
      return names.get(leg?.accountId);
    };
    expect(category("USPS PO 1234")).toBe("Office expense");
    expect(category("GOOGLE WORKSPACE")).toBe("Software and subscriptions");
    expect(category("SQUARESPACE INC")).toBe("Software and subscriptions");
    expect(category("XCEL ENERGY")).toBe("Utilities");
    expect(category("STATE FARM INSURANCE")).toBe("Insurance (other than health)");
    expect(category("GUSTO PAYROLL")).toBe("Wages");
    expect(category("MONTHLY SERVICE FEE")).toBe("Bank and card fees");
    expect(category("RENT 1450 LARIMER")).toBe("Rent or lease: Office space");
    expect(category("STRIPE TRANSFER ST-X1")).toBe("Stripe payouts in transit");
  });

  test("a book without Stripe's accounts is not offered Stripe's transfers, and nothing else changes", async () => {
    const f = await newBook("sole-proprietor", []);
    submit(f, STATEMENT);
    const items = await inboxOf(f);
    const left = items.filter((item) => !item.suggestion).map((item) => item.line.description);
    expect(left.sort()).toEqual([
      "COSTCO WHOLESALE 0412",
      "STRIPE TRANSFER ST-X1",
      "STRIPE TRANSFER ST-X2",
      "STRIPE TRANSFER ST-X3",
      "STRIPE TRANSFER ST-X4",
    ]);
  });

  test("on a generic chart and an S corporation's the same statement is suggested, and payroll only where it is one line", async () => {
    const generic = await newBook("generic");
    submit(generic, STATEMENT);
    const genericItems = await inboxOf(generic);
    expect(genericItems.filter((item) => item.suggestion)).toHaveLength(14);
    closeFixtures();
    const corporation = await newBook("s-corporation");
    submit(corporation, STATEMENT);
    const corporationItems = await inboxOf(corporation);
    const left = corporationItems
      .filter((item) => !item.suggestion)
      .map((item) => item.line.description);
    expect(left.sort()).toEqual(["COSTCO WHOLESALE 0412", "GUSTO PAYROLL"]);
  });

  test("the reason is the sentence the Inbox shows, with no figure in it", async () => {
    const f = await newBook("sole-proprietor");
    submit(f, [{ date: "2026-10-03", amount: "-42.80", description: "USPS PO 1234" }]);
    const [item] = await inboxOf(f);
    const detail = await f.call("inbox.get", { itemId: item?.id });
    expect(detail.body.ok, JSON.stringify(detail.body)).toBe(true);
    const proposals = detail.body.data.proposals as Json[];
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      proposer: "starter",
      reasons: ["USPS is usually postage."],
    });
  });

  test("a rule decides: the line gets the rule's suggestion and no second one from the list", async () => {
    const f = await newBook("sole-proprietor");
    const made = await f.call(
      "rules.create",
      {
        rule: {
          name: "Postage is supplies",
          conditions: [{ field: "description", operator: "contains", value: "usps" }],
          // Supplies, not the Office expense the list would suggest for postage.
          action: { kind: "categorize", accountId: "6140" },
        },
        madeBy: { kind: "person" },
      },
      crypto.randomUUID(),
    );
    expect(made.body.ok, JSON.stringify(made.body)).toBe(true);
    submit(f, [{ date: "2026-10-03", amount: "-42.80", description: "USPS PO 1234" }]);
    const [item] = await inboxOf(f);
    expect(item?.suggestion.proposer).toBe(`rule:${made.body.data.id}`);
    expect(item?.suggestion.legs.find((leg: Json) => leg.accountId !== BANK)?.accountId).toBe(
      "6140",
    );
    expect(item?.proposalCount).toBe(1);
  });

  test("what the book has learned is preferred: a learned line is not shown the list's guess beside it", async () => {
    const f = await newBook("sole-proprietor");
    const github = (day: number) => ({
      date: `2026-10-0${day}`,
      amount: "-4.00",
      description: "GITHUB, INC. SAN FRANCISCO CA",
    });
    submit(f, [github(2), github(3), github(4), github(5)]);
    const first = await inboxOf(f);
    // Before it has learned anything the list suggests the account its kind goes to.
    expect(first.map((item) => item.suggestion.proposer)).toEqual(Array(4).fill("starter"));
    const categorized = await f.call(
      "inbox.categorize",
      { itemIds: first.map((item) => item.id), accountId: "6200" },
      crypto.randomUUID(),
    );
    expect(categorized.body.ok, JSON.stringify(categorized.body)).toBe(true);
    expect(categorized.body.data.failed).toBe(0);
    submit(f, [github(9)]);
    const seen = new Set(first.map((item) => item.id));
    const next = (await inboxOf(f)).find((item) => !seen.has(item.id));
    expect(next).toBeDefined();
    const detail = await f.call("inbox.get", { itemId: next?.id });
    const proposals = detail.body.data.proposals as Json[];
    // The book's own history: one suggestion, the classifier's, and the list is not asked.
    expect(proposals.map((proposal) => proposal.proposer)).toEqual(["classifier"]);
  });
});
