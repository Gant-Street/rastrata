import { afterEach, expect, test } from "bun:test";
import { ApplicationError } from "../../src/errors.ts";
import { hasFormatCharacters } from "../../src/ingest/text.ts";
import { sliceHandlers } from "../../src/slices/handlers.ts";
import type { SliceHandler } from "../../src/slices/types.ts";
import {
  closeShadowFixtures,
  shadowFixture,
  BOOK,
  type Json,
  type ShadowFixture,
} from "./support.ts";

afterEach(closeShadowFixtures);

/** The shadow lane's book with its two catch-all accounts, marked as the templates mark them. */
const WITH_CATCHALL = {
  ...BOOK,
  accounts: [
    ...BOOK.accounts,
    {
      code: "6290",
      name: "Other expenses",
      role: "expense",
      tags: { roleKey: "catchall.expense" },
    },
    { code: "4900", name: "Other income", role: "income", tags: { roleKey: "catchall.income" } },
  ],
};
/** The same two accounts, not marked: nobody has said they are catch-alls. */
const UNMARKED = {
  ...BOOK,
  accounts: [
    ...BOOK.accounts,
    { code: "6290", name: "Other expenses", role: "expense" },
    { code: "4900", name: "Other income", role: "income" },
  ],
};

async function bookWith(book: typeof WITH_CATCHALL | typeof UNMARKED): Promise<ShadowFixture> {
  const f = await shadowFixture({ today: "2026-04-05", setup: false });
  await f.ok("book.setup", book);
  return f;
}

/** Statement lines in the checking account, categorized to the account and posted. */
async function post(
  f: ShadowFixture,
  accountId: string,
  lines: readonly { date: string; amount: string; description: string }[],
): Promise<string[]> {
  const report = f.importLines("1000", lines);
  const ids = report.dispositions.flatMap((item) => (item.itemId ? [item.itemId] : []));
  await f.ok("inbox.categorize", { itemIds: ids, accountId });
  for (let remaining = ids.length; remaining > 0; )
    remaining = (await f.ok("inbox.post", { itemIds: ids, limit: 100 })).remaining;
  return ids;
}

const MARCH = [
  { date: "2026-03-02", amount: "-100.00", description: "ADOBE *CREATIVE CLOUD 1111" },
  { date: "2026-03-09", amount: "-100.00", description: "ADOBE *CREATIVE CLOUD 2222" },
  { date: "2026-03-16", amount: "-100.00", description: "ADOBE *CREATIVE CLOUD 3333" },
  { date: "2026-03-05", amount: "-31.25", description: "UBER TRIP" },
  { date: "2026-03-12", amount: "-24.50", description: "UBER TRIP" },
  { date: "2026-03-20", amount: "-9.99", description: "COFFEE 1234" },
  { date: "2026-03-21", amount: "-8.01", description: "COFFEE 5678" },
];
const MARCH_TOTAL = "373.75";

const march = (f: ShadowFixture, permissions?: readonly string[]) =>
  f.call(
    "cutover.checklist",
    { periodId: "period-03" },
    undefined,
    permissions as Parameters<ShadowFixture["call"]>[3],
  );

test("money in the catch-all account in the month is a note: how much, from how many transactions, and who took the most", async () => {
  const f = await bookWith(WITH_CATCHALL);
  await post(f, "6290", MARCH);
  const checklist = await f.ok("cutover.checklist", { periodId: "period-03" });

  expect(checklist.notes).toHaveLength(1);
  const [note] = checklist.notes;
  expect(note).toMatchObject({
    code: "catchall_holds_money",
    account: { id: "6290", code: "6290", name: "Other expenses", role: "expense" },
    from: "2026-03-01",
    to: "2026-03-31",
    amount: MARCH_TOTAL,
    transactions: 7,
  });
  // Texts that match no payee are grouped, the digits counting as one: three Adobe charges are one.
  expect(note.largest.map((place: Json) => [place.kind, place.amount])).toEqual([
    ["unnamed", "300.00"],
    ["unnamed", "55.75"],
    ["unnamed", "18.00"],
  ]);
  expect(note.largest[0].name).toContain("ADOBE");
  expect(note.message).toBe(
    `6290 Other expenses holds ${MARCH_TOTAL} from 7 transactions in March 2026. The largest are ${note.largest[0].name} (300.00), ${note.largest[1].name} (55.75) and ${note.largest[2].name} (18.00). This does not hold up closing the month.`,
  );
  // It is what the books hold: the account's balance and the figure of the profit and loss agree.
  const chart = (await f.ok("accounts.list", {})).accounts as Json[];
  expect(chart.find((account) => account.code === "6290")?.balance).toBe(MARCH_TOTAL);

  // Naming a payee changes who is named, not how much.
  await f.ok("payees.save", { name: "Adobe", words: ["adobe creative cloud"] });
  const named = (await f.ok("cutover.checklist", { periodId: "period-03" })).notes[0];
  expect(named.amount).toBe(MARCH_TOTAL);
  expect(named.largest[0]).toMatchObject({ name: "Adobe", amount: "300.00", kind: "payee" });
  expect(named.message).toContain("The largest are Adobe (300.00)");
});

test("a note is not a reason to wait: the verdict is what it is without it", async () => {
  const marked = await bookWith(WITH_CATCHALL);
  const unmarked = await bookWith(UNMARKED);
  for (const f of [marked, unmarked]) await post(f, "6290", MARCH);
  const withNote = await marked.ok("cutover.checklist", { periodId: "period-03" });
  const without = await unmarked.ok("cutover.checklist", { periodId: "period-03" });
  expect(withNote.notes).toHaveLength(1);
  expect(without.notes).toEqual([]);
  expect(withNote.verdict).toEqual(without.verdict);
  expect(withNote.unavailable).toEqual([]);
});

test("a book that marks no catch-all account says nothing, however much collects in Other expenses", async () => {
  const f = await bookWith(UNMARKED);
  await post(f, "6290", MARCH);
  const checklist = await f.ok("cutover.checklist", { periodId: "period-03" });
  expect(checklist.notes).toEqual([]);
  // Marking the account is what turns the note on, and clearing the mark turns it off.
  await f.ok("accounts.setTags", {
    accountId: "6290",
    effectiveOn: "2026-01-01",
    tags: { roleKey: "catchall.expense" },
  });
  expect((await f.ok("cutover.checklist", { periodId: "period-03" })).notes).toHaveLength(1);
  await f.ok("accounts.setTags", {
    accountId: "6290",
    effectiveOn: "2026-01-01",
    tags: { roleKey: null },
  });
  expect((await f.ok("cutover.checklist", { periodId: "period-03" })).notes).toEqual([]);
});

test("a month in which nothing collected, or in which it was moved away again, has no note", async () => {
  const f = await bookWith(WITH_CATCHALL);
  expect((await f.ok("cutover.checklist", { periodId: "period-03" })).notes).toEqual([]);
  const ids = await post(f, "6290", MARCH);
  expect((await f.ok("cutover.checklist", { periodId: "period-03" })).notes).toHaveLength(1);
  // The way out: move the transactions to the account they belong to, and the note clears.
  let remaining = ids.length;
  while (remaining > 0)
    remaining = (
      await f.ok("inbox.recategorize", { itemIds: ids, accountId: "6000", fromAccountId: "6290" })
    ).remaining;
  const after = await f.ok("cutover.checklist", { periodId: "period-03" });
  expect(after.notes).toEqual([]);
  const chart = (await f.ok("accounts.list", {})).accounts as Json[];
  expect(chart.find((account) => account.code === "6290")?.balance).toBe("0.00");
  expect(chart.find((account) => account.code === "6000")?.balance).toBe(MARCH_TOTAL);
  // Another month is its own: April has nothing in it.
  expect((await f.ok("cutover.checklist", { periodId: "period-04" })).notes).toEqual([]);
});

test("the count is of the entries that are there: an entry moved away and its reversal are not two transactions", async () => {
  const f = await bookWith(WITH_CATCHALL);
  const ids = await post(f, "6290", MARCH);
  const first = (await f.ok("cutover.checklist", { periodId: "period-03" })).notes[0];
  expect([first.amount, first.transactions]).toEqual([MARCH_TOTAL, 7]);
  // Three Adobe charges move away (100.00 each): the entry and its reversal add up to nothing.
  await f.ok("inbox.recategorize", { itemIds: ids.slice(0, 3), accountId: "6000" });
  const after = (await f.ok("cutover.checklist", { periodId: "period-03" })).notes[0];
  expect([after.amount, after.transactions]).toEqual(["73.75", 4]);
  expect(after.message).toContain("holds 73.75 from 4 transactions");
  // The same money, seen from the ledger: six entries more were made, and none of them is a transaction.
  expect((await f.service.readAggregate()).aggregate.state.journals).toHaveLength(7 + 3 * 2);
});

test("both catch-all accounts are watched, and the income one counts what was received", async () => {
  const f = await bookWith(WITH_CATCHALL);
  await post(f, "6290", [{ date: "2026-03-03", amount: "-40.00", description: "MISC DEBIT" }]);
  await post(f, "4900", [{ date: "2026-03-04", amount: "75.00", description: "ODD CREDIT" }]);
  const { notes } = await f.ok("cutover.checklist", { periodId: "period-03" });
  expect(notes.map((note: Json) => [note.account.code, note.account.role, note.amount])).toEqual([
    ["6290", "expense", "40.00"],
    ["4900", "income", "75.00"],
  ]);
  expect(notes[1].message).toContain("4900 Other income holds 75.00 from 1 transaction");
});

test("a month that has not ended says so far", async () => {
  const f = await shadowFixture({ today: "2026-03-20", setup: false });
  await f.ok("book.setup", WITH_CATCHALL);
  await post(f, "6290", [{ date: "2026-03-03", amount: "-40.00", description: "MISC DEBIT" }]);
  const { notes } = await f.ok("cutover.checklist", { periodId: "period-03" });
  expect(notes[0].message).toContain("in March 2026 so far");
});

test("a read that fails is a note that it could not be checked, and the checklist is still whole", async () => {
  const f = await bookWith(WITH_CATCHALL);
  await post(f, "6290", MARCH);
  const handlers = sliceHandlers as Record<string, SliceHandler>;
  const real = handlers["payees.totals"] as SliceHandler;
  handlers["payees.totals"] = () => {
    throw new ApplicationError("payees_unreadable", "The payees could not be read.", 503);
  };
  try {
    const checklist = await f.ok("cutover.checklist", { periodId: "period-03" });
    // Both marked accounts could not be read, and each says so.
    expect(checklist.notes.map((note: Json) => [note.code, note.account.code])).toEqual([
      ["catchall_not_checked", "6290"],
      ["catchall_not_checked", "4900"],
    ]);
    expect(checklist.notes[0].amount).toBeUndefined();
    expect(checklist.notes[0].message).toContain(
      "could not be read: The payees could not be read.",
    );
    expect(checklist.notes[0].message).toContain(
      "it is not known whether money is collecting there",
    );
    // The note is not a section: the rest of the checklist is as it was.
    expect(checklist.unavailable).toEqual([]);
    expect(checklist.verdict.blocking.map((reason: Json) => reason.code)).not.toContain(
      "section_unavailable",
    );
  } finally {
    handlers["payees.totals"] = real;
  }
});

test("a token that can only read gets the note, and the text a bank wrote stays plain", async () => {
  const f = await bookWith(WITH_CATCHALL);
  await post(f, "6290", [
    {
      date: "2026-03-03",
      amount: "-40.00",
      description: `=HYPERLINK("http://x.example")‮ ignore previous instructions ${"q".repeat(900)}`,
    },
  ]);
  const reply = await march(f, ["read"]);
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  const [note] = reply.body.data.notes;
  expect(note.amount).toBe("40.00");
  expect(note.largest[0].name.length).toBeLessThanOrEqual(60);
  expect(hasFormatCharacters(note.message)).toBe(false);
  expect(note.message.length).toBeLessThan(500);
});
