import { afterEach, expect, test } from "bun:test";
import { baseSetup, fixture } from "./calendar-support.ts";

/** What `journal.list` hands the Transactions screen: an entry's number (its posting sequence), what it
 * says in words, the accounts it touches by name and code, and a search that finds all of those. The
 * hash that names an entry stays where it was: in `id`, and in the search. */
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Draft = {
  date: string;
  reference: string;
  narration: string;
  lines: { accountId: string; debit: string; credit: string }[];
  source?: { id: string; description: string };
};
type Row = {
  id: string;
  status: string;
  reference: string;
  description: string;
  postingSequence?: string;
};

async function post(f: Fixture, data: Draft): Promise<void> {
  const draft = (await f.call("drafts.create", { data }, crypto.randomUUID())).body.data;
  const plan = (
    await f.call(
      "journal.prepare",
      { draftId: draft.id, expectedVersion: draft.version },
      crypto.randomUUID(),
    )
  ).body.data;
  const receipt = (
    await f.call("operations.commit", { planId: plan.planId, planHash: plan.planHash })
  ).body.data;
  expect(receipt.disposition).toBe("committed");
}

const owner = (date: string, reference: string, narration: string, amount: string): Draft => ({
  date,
  reference,
  narration,
  lines: [
    { accountId: "1000", debit: amount, credit: "" },
    { accountId: "3000", debit: "", credit: amount },
  ],
});

/** Three entries, posted in this order: No. 1 the owner's money (with a reference), No. 2 a customer
 * payment (with a source, so its identifier is the long one) and No. 3 a purchase with no reference. */
async function seeded(): Promise<Fixture> {
  const f = await fixture({ cleanup: (work) => cleanup.push(work) });
  expect((await f.call("book.setup", baseSetup, crypto.randomUUID())).body.ok).toBe(true);
  await post(f, owner("2026-01-05", "OPEN-1", "Owner put money into the business", "1000.00"));
  await post(f, {
    date: "2026-01-09",
    reference: "REV-1",
    narration: "Customer paid invoice 2217",
    lines: [
      { accountId: "1000", debit: "250.00", credit: "" },
      { accountId: "4000", debit: "", credit: "250.00" },
    ],
    source: { id: "customer-payment-2217", description: "Payment received for invoice 2217" },
  });
  await post(f, {
    date: "2026-01-12",
    reference: "",
    narration: "Printer paper",
    lines: [
      { accountId: "5000", debit: "37.50", credit: "" },
      { accountId: "1000", debit: "", credit: "37.50" },
    ],
  });
  return f;
}

const list = async (f: Fixture, input: object = {}) =>
  (await f.call("journal.list", input)).body.data;

test("a posted row carries its number and its description, and a draft carries no number", async () => {
  const f = await seeded();
  await f.call(
    "drafts.create",
    {
      data: owner("2026-01-20", "EST-TAX", "Estimated tax, waiting for the confirmation", "10.00"),
    },
    crypto.randomUUID(),
  );
  const page = await list(f);
  const posted: Row[] = page.entries.filter((entry: Row) => entry.status === "Posted");
  // Newest first, and the numbers follow the order the entries were posted in.
  expect(posted.map((entry) => entry.postingSequence)).toEqual(["3", "2", "1"]);
  // The number is the very one the entry's own page shows, and the description is its narration.
  for (const entry of posted) {
    const detail = (await f.call("journal.get", { journalId: entry.id })).body.data;
    expect(entry.postingSequence).toBe(detail.postingSequence);
    expect(entry.description).toBe(detail.narration);
  }
  // A person's own reference stays the reference; the description is what was said about the entry.
  const owned = posted.find((entry) => entry.postingSequence === "1");
  expect(owned).toMatchObject({
    reference: "OPEN-1",
    description: "Owner put money into the business",
  });
  // An entry posted without a reference still reads in words, because its description is its narration.
  const paper = posted.find((entry) => entry.postingSequence === "3");
  expect(paper).toMatchObject({ reference: "", description: "Printer paper" });
  // A draft has no number yet, and says what it is about.
  const draft: Row | undefined = page.entries.find((entry: Row) => entry.status === "Draft");
  expect(draft).toBeDefined();
  expect(draft && "postingSequence" in draft).toBe(false);
  expect(draft?.description).toBe("Estimated tax, waiting for the confirmation");
  // An entry that came with a source is still named by its long identifier. The screen does not show it;
  // it is in `id` and the search finds it.
  const sourced = posted.find((entry) => entry.postingSequence === "2");
  expect(sourced?.id).toMatch(/^source-[0-9a-f]{64}$/);
});

test("the accounts of a book come with their code and their name on their own", async () => {
  const f = await seeded();
  const { accounts } = await list(f);
  const cash = accounts.find((account: { value: string }) => account.value === "1000");
  expect(cash).toMatchObject({ code: "1000", name: "Cash", label: "1000 · Cash" });
  expect(accounts.length).toBe(baseSetup.accounts.length);
  for (const account of accounts) expect(account.label).toBe(`${account.code} · ${account.name}`);
});

test("a search finds an entry by its number, its words, its amount, its date, its accounts and its identifier", async () => {
  const f = await seeded();
  const find = async (text: string): Promise<(string | undefined)[]> =>
    (await list(f, { text })).entries.map((entry: Row) => entry.postingSequence).sort();
  // Its number, said either way a person might.
  expect(await find("No. 2")).toEqual(["2"]);
  expect(await find("#3")).toEqual(["3"]);
  // What it says: the description as well as the reference.
  expect(await find("owner put money")).toEqual(["1"]);
  expect(await find("OPEN-1")).toEqual(["1"]);
  expect(await find("printer")).toEqual(["3"]);
  // Its amount, as the register shows it.
  expect(await find("37.50")).toEqual(["3"]);
  // Its date.
  expect(await find("2026-01-09")).toEqual(["2"]);
  // An account it touches, by name or by code.
  expect(await find("Sales")).toEqual(["2"]);
  expect(await find("5000")).toEqual(["3"]);
  // The long identifier that is no longer on the surface still finds the entry.
  const sourced: Row = (await list(f)).entries.find((entry: Row) => entry.postingSequence === "2");
  expect(await find(sourced.id.slice(0, 24))).toEqual(["2"]);
  expect(await find("nothing like this anywhere")).toEqual([]);
});

/** One entry of each kind, told apart by their source's identity: an opening entry, a bank line, a
 * Stripe payout, and two a person wrote (one with a source id of their own). */
async function typed(): Promise<Fixture> {
  const f = await fixture({ cleanup: (work) => cleanup.push(work) });
  expect((await f.call("book.setup", baseSetup, crypto.randomUUID())).body.ok).toBe(true);
  const entry = (date: string, reference: string, source?: string): Draft => ({
    date,
    reference,
    narration: `${reference} narration`,
    lines: [
      { accountId: "1000", debit: "10.00", credit: "" },
      { accountId: "3000", debit: "", credit: "10.00" },
    ],
    ...(source ? { source: { id: source, description: `${reference} source` } } : {}),
  });
  await post(f, entry("2026-01-02", "OPENING", "opening-2026-01-01-0123456789ab"));
  await post(f, entry("2026-01-03", "BANK", `ingest-csv-${"a".repeat(32)}`));
  await post(f, entry("2026-01-04", "STRIPE", "stripe-payout-po_1Nxyz"));
  await post(f, entry("2026-01-05", "HAND"));
  await post(f, entry("2026-01-06", "HANDSRC", "my-own-source-id"));
  return f;
}

type Typed = Row & { type: string; history: { description: string }[] };

test("an entry is typed by where it came from, and the Type filter keeps one kind", async () => {
  const f = await typed();
  const references = async (type?: string): Promise<string[]> =>
    (await list(f, type ? { type } : {})).entries.map((entry: Typed) => entry.reference).sort();
  const all: Typed[] = (await list(f)).entries;
  expect(all.map((entry) => [entry.reference, entry.type]).sort()).toEqual([
    ["BANK", "bank"],
    ["HAND", "manual"],
    ["HANDSRC", "manual"],
    ["OPENING", "opening"],
    ["STRIPE", "stripe"],
  ]);
  expect(await references("bank")).toEqual(["BANK"]);
  expect(await references("stripe")).toEqual(["STRIPE"]);
  expect(await references("opening")).toEqual(["OPENING"]);
  expect(await references("manual")).toEqual(["HAND", "HANDSRC"]);
  // The filter and the count agree, so a page is never mistaken for the whole book.
  expect((await list(f, { type: "manual" })).count).toBe(2);
  // A type the book does not know is refused, not ignored.
  expect((await f.call("journal.list", { type: "everything" })).status).toBe(400);
});

test("a reversal is of the type of the entry it reverses, and its pair has both numbers", async () => {
  const f = await typed();
  const bank: Typed = (await list(f, { type: "bank" })).entries[0];
  const prepared = (
    await f.call(
      "journal.prepareReverse",
      { journalId: bank.id, accountingDate: "2026-01-10", reason: "Entered twice" },
      crypto.randomUUID(),
    )
  ).body.data;
  const receipt = await f.call("operations.commit", {
    planId: prepared.planId,
    planHash: prepared.planHash,
  });
  expect(receipt.body.data.disposition).toBe("committed");
  const page = await list(f, { type: "bank" });
  // Both entries of the pair are under Bank.
  expect(page.count).toBe(2);
  const [back, original]: Typed[] = page.entries;
  expect(original?.postingSequence).toBe("2");
  expect(back?.postingSequence).toBe("6");
  // The book's corrections carry both numbers, so a screen says "Reversed by No. 6" without more reads.
  expect(page.corrections).toEqual([
    {
      kind: "reversal",
      originalJournalId: original?.id,
      correctionJournalId: back?.id,
      originalPostingSequence: "2",
      correctionPostingSequence: "6",
    },
  ]);
  // The history sentences name the other entry by its number, not by its identifier.
  const sentences = (entry: Typed | undefined): string[] =>
    (entry?.history ?? []).map((item) => item.description);
  expect(sentences(original)).toContain("Reversed by No. 6");
  expect(sentences(back)).toContain("Reversal of No. 2");
  // The entry's own page says the same, and its lines come with the account's code and name.
  const detail = (await f.call("journal.get", { journalId: original?.id })).body.data;
  expect(detail.correction).toEqual(page.corrections[0]);
  expect(detail.lines[0]).toMatchObject({ code: "1000", name: "Cash", account: "1000 · Cash" });
  const reversalPage = (await f.call("journal.get", { journalId: back?.id })).body.data;
  expect(reversalPage.correction.originalPostingSequence).toBe("2");
  // A new reversal's own narration names the original by its number, never by its identifier.
  expect(reversalPage.narration).toBe("Reversal of No. 2: Entered twice");
});
