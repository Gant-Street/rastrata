/** The report by payee on the acceptance month's book, through the operations a screen and an agent
 * use: the unnamed list and naming from it, the tie-out to the profit and loss, the rows opened, words
 * tried before they are saved, a line undone, and the file. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { allItems } from "./acceptance/drive.ts";
import { cents, dec } from "./acceptance/month.ts";
import type { World } from "./acceptance/world.ts";
import { type Driver, type MonthBook, bookTheMonth, enterByHand } from "./payees-support.ts";
import type { Json } from "./acceptance/world.ts";

let month: MonthBook & { world: World };
let d: Driver;
beforeAll(async () => {
  month = await bookTheMonth();
  d = month.d;
});
afterAll(async () => {
  await month?.world.close();
});

const MARCH = { from: "2026-03-01", asOf: "2026-03-31" };

/** The places of a report added up, from its wire. */
function placesAdd(report: Json): { income: bigint; expenses: bigint } {
  let income = 0n;
  let expenses = 0n;
  const take = (place: Json) => {
    income += cents(place.received);
    expenses += cents(place.spent);
  };
  for (const row of [...report.rows, ...report.unnamed, ...report.ambiguous]) take(row);
  take(report.unnamedRest);
  take(report.ambiguousRest);
  take(report.noPayee.byHand);
  take(report.noPayee.noBankText);
  return { income, expenses };
}

describe("the report", () => {
  test("with nobody named it lists the unnamed texts, grouped, and adds up to the profit and loss", async () => {
    const report = await d.ok("payees.totals", MARCH);
    expect(report).toMatchObject({
      from: "2026-03-01",
      to: "2026-03-31",
      currency: "USD",
      basis: "cash",
      direction: "both",
      rowCount: 0,
      inboxRead: true,
      warnings: [],
    });
    expect(report.tieOut).toMatchObject({
      profitLossIncome: "4553.05",
      profitLossExpenses: "5891.16",
      income: "4553.05",
      expenses: "5891.16",
      matches: true,
    });
    expect(placesAdd(report)).toEqual({ income: cents("4553.05"), expenses: cents("5891.16") });
    // The proof carries the four places it is made of, for the whole range: nobody is named, so none
    // of it is in the payees.
    const { places } = report.tieOut;
    expect(places.payees).toEqual({ received: "0.00", spent: "0.00", transactions: 0 });
    const put = (side: "received" | "spent") =>
      [places.payees, places.unnamed, places.ambiguous, places.noPayee].reduce(
        (sum, place) => sum + cents(place[side]),
        0n,
      );
    expect(put("received")).toBe(cents(report.tieOut.profitLossIncome));
    expect(put("spent")).toBe(cents(report.tieOut.profitLossExpenses));
    expect(
      places.payees.transactions +
        places.unnamed.transactions +
        places.ambiguous.transactions +
        places.noPayee.transactions,
    ).toBe(report.totals.transactions);
    // The statements say the same: the report is tied to the profit and loss of the same range.
    const core = await d.ok("reports.get", MARCH);
    expect(core.profitAndLoss.revenue).toBe(report.tieOut.profitLossIncome);
    expect(core.profitAndLoss.expenses).toBe(report.tieOut.profitLossExpenses);
    expect(report.ledgerPopulationHash).toBe(core.populationHash);
    // Largest first, and a group is the digits made one.
    const sizes = report.unnamed.map(
      (g: Json) => Math.abs(Number(g.received)) + Math.abs(Number(g.spent)),
    );
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
    expect(report.unnamed.find((g: Json) => g.key.startsWith("chipotle"))).toMatchObject({
      transactions: 4,
      spent: "76.00",
      suggestedWords: "chipotle",
    });
    // A journal a provider made takes the provider's name; its words are offered.
    expect(report.unnamed.find((g: Json) => g.key === "stripe")).toMatchObject({
      text: "Stripe",
      suggestedWords: "stripe",
      transactions: 6,
    });
    // The words offered are the leading name, without the channel the money came through.
    expect(
      report.unnamed.find((g: Json) => g.text.startsWith("ZELLE PAYMENT FROM ACME")).suggestedWords,
    ).toBe("acme design");
    expect(
      report.unnamed.find((g: Json) => g.text.startsWith("SQ *BLUE BOTTLE")).suggestedWords,
    ).toBe("blue bottle coffee");
    // A text that names nobody offers nothing.
    expect(report.unnamed.find((g: Json) => g.text === "CHECK 1041").suggestedWords).toBe("");
  });

  test("naming a payee moves its transactions from the unnamed list into the rows, and the whole still adds up", async () => {
    const before = await d.ok("payees.totals", MARCH);
    const chipotle = before.unnamed.find((g: Json) => g.key.startsWith("chipotle"));
    const tried = await d.ok("payees.test", { words: [chipotle.suggestedWords], ...MARCH });
    expect(tried.matches).toEqual({ received: "0.00", spent: "76.00", transactions: 4 });
    expect(tried.fromUnnamed).toEqual(tried.matches);
    expect(tried.taken).toEqual([]);
    expect(tried.problems).toEqual([]);
    const saved = await d.ok("payees.save", { name: "Chipotle", words: [chipotle.suggestedWords] });
    const after = await d.ok("payees.totals", MARCH);
    expect(after.rows).toEqual([
      expect.objectContaining({
        payeeId: saved.payee.id,
        name: "Chipotle",
        received: "0.00",
        spent: "76.00",
        net: "-76.00",
        transactions: 4,
        firstOn: "2026-03-06",
        lastOn: "2026-03-23",
      }),
    ]);
    expect(after.unnamedCount).toBe(before.unnamedCount - 1);
    // The proof is the same; only where its parts are held moved: 76.00 spent in 4 transactions went
    // from the unnamed texts to the payees.
    const { places: movedFrom, ...tieBefore } = before.tieOut;
    const { places: movedTo, ...tieAfter } = after.tieOut;
    expect(tieAfter).toEqual(tieBefore);
    expect(movedTo.payees).toEqual({ received: "0.00", spent: "76.00", transactions: 4 });
    expect(movedTo.unnamed).toEqual({
      received: movedFrom.unnamed.received,
      spent: dec(cents(movedFrom.unnamed.spent) - cents("76.00")),
      transactions: movedFrom.unnamed.transactions - 4,
    });
    expect(movedTo.ambiguous).toEqual(movedFrom.ambiguous);
    expect(movedTo.noPayee).toEqual(movedFrom.noPayee);
    expect(placesAdd(after)).toEqual(placesAdd(before));
    // What the report was read from changed, so its identity did; the ledger's did not.
    expect(after.populationHash).not.toBe(before.populationHash);
    expect(after.ledgerPopulationHash).toBe(before.ledgerPopulationHash);
    expect(after.payeesRevision).toBe(saved.payeesRevision);
    // A report pinned to the payees as they were is the report as it was.
    const pinned = await d.ok("payees.totals", { ...MARCH, payeesRevision: before.payeesRevision });
    expect(pinned.populationHash).toBe(before.populationHash);
    expect(pinned.rows).toEqual([]);
    // Naming posts nothing: the books did not move.
    expect(after.bookRevision).toBe(before.bookRevision);
  });

  test("the year adds up too, and a range inside the month does", async () => {
    for (const range of [
      { from: "2026-01-01", asOf: "2026-12-31" },
      { from: "2026-03-10", asOf: "2026-03-20" },
      { asOf: "2026-03-31" },
    ]) {
      const report = await d.ok("payees.totals", range);
      const core = await d.ok("reports.get", range);
      expect(report.tieOut.profitLossIncome).toBe(core.profitAndLoss.revenue);
      expect(report.tieOut.profitLossExpenses).toBe(core.profitAndLoss.expenses);
      expect(placesAdd(report)).toEqual({
        income: cents(core.profitAndLoss.revenue),
        expenses: cents(core.profitAndLoss.expenses),
      });
    }
  });

  test("limited to some accounts it adds up to the profit and loss of those accounts, and the file says which", async () => {
    // Meals and Travel: the largest payees of two expense accounts.
    const report = await d.ok("payees.totals", { ...MARCH, accountIds: ["6170", "6160"] });
    const core = await d.ok("reports.get", MARCH);
    const row = (code: string) => core.profitAndLoss.rows.find((r: Json) => r.code === code);
    expect(report.accountIds).toEqual(["6160", "6170"]);
    expect(report.tieOut).toMatchObject({
      profitLossIncome: "0.00",
      profitLossExpenses: dec(cents(row("6170").amount) + cents(row("6160").amount)),
      matches: true,
    });
    expect(placesAdd(report)).toEqual({ income: 0n, expenses: cents(report.tieOut.expenses) });
    expect(report.unnamed.every((g: Json) => g.received === "0.00")).toBe(true);
    // The population names the accounts, so it is not the whole book's.
    const whole = await d.ok("payees.totals", MARCH);
    expect(report.populationHash).not.toBe(whole.populationHash);
    expect(report.ledgerPopulationHash).toBe(whole.ledgerPopulationHash);
    const file = await d.ok("payees.export", { ...MARCH, accountIds: ["6170"] });
    expect(file.content).toContain("Accounts,6170 Meals");
    const detail = await d.ok("payees.get", {
      unnamed: report.unnamed[0].key,
      ...MARCH,
      accountIds: ["6170", "6160"],
    });
    expect(detail.accountIds).toEqual(["6160", "6170"]);
    // Only income and expense accounts have money by payee.
    const bank = await d.call("payees.totals", { ...MARCH, accountIds: ["1000"] });
    expect(bank.status).toBe(400);
    expect(bank.body.error.code).toBe("invalid_input");
    expect((await d.call("payees.totals", { ...MARCH, accountIds: ["9999"] })).status).toBe(404);
  });

  test("direction lists the side asked for, ordered by it, and the tie-out still covers both", async () => {
    const spent = await d.ok("payees.totals", { ...MARCH, direction: "spent" });
    expect(spent.direction).toBe("spent");
    expect(spent.unnamed.every((g: Json) => g.spent !== "0.00")).toBe(true);
    expect(spent.unnamed[0].spent).toBe("750.00");
    const received = await d.ok("payees.totals", { ...MARCH, direction: "received" });
    expect(received.unnamed.every((g: Json) => g.received !== "0.00")).toBe(true);
    expect(received.unnamed[0].received).toBe("2550.00");
    expect(received.tieOut).toEqual(spent.tieOut);
    expect(spent.unnamedCount + received.unnamedCount).toBeGreaterThan(spent.unnamedCount);
  });

  test("a long list is bounded, what it leaves out is added up, and rows are paged", async () => {
    const report = await d.ok("payees.totals", MARCH);
    // All of the month's groups fit; ask for the rows in pages of one.
    const savedNames: Json[] = [];
    for (const [name, word] of [
      ["Uber", "uber"],
      ["Starbucks", "starbucks"],
    ] as const)
      savedNames.push(await d.ok("payees.save", { name, words: [word] }));
    const first = await d.ok("payees.totals", { ...MARCH, pageSize: 1 });
    const second = await d.ok("payees.totals", { ...MARCH, pageSize: 1, page: 2 });
    expect(first.rowCount).toBeGreaterThanOrEqual(3);
    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(1);
    expect(first.rows[0].payeeId).not.toBe(second.rows[0].payeeId);
    expect(report.unnamedRest.groups).toBe(0);
  });

  test("by month, every payee and every month adds up to that month's profit and loss", async () => {
    const report = await d.ok("payees.totals", {
      from: "2026-01-01",
      asOf: "2026-05-31",
      byMonth: true,
    });
    expect(report.months.map((m: Json) => m.month)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
    ]);
    const march = await d.ok("reports.get", MARCH);
    expect(report.months[2]).toMatchObject({
      profitLossIncome: march.profitAndLoss.revenue,
      profitLossExpenses: march.profitAndLoss.expenses,
    });
    const chipotle = report.rows.find((r: Json) => r.name === "Chipotle");
    expect(chipotle.months.map((m: Json) => m.transactions)).toEqual([0, 0, 4, 0, 0]);
    expect(chipotle.months[2].spent).toBe("76.00");
  });
});

describe("a row opened", () => {
  test("a payee's transactions, newest first, with the text that was matched and the words that matched", async () => {
    const list = await d.ok("payees.list", {});
    const chipotle = list.payees.find((p: Json) => p.name === "Chipotle");
    const detail = await d.ok("payees.get", { payeeId: chipotle.id, ...MARCH });
    expect(detail.subject).toEqual({ kind: "payee", payeeId: chipotle.id });
    expect(detail.count).toBe(4);
    expect(detail.totals).toEqual({ received: "0.00", spent: "76.00", transactions: 4 });
    expect(detail.transactions.map((t: Json) => [t.date, t.spent])).toEqual([
      ["2026-03-23", "19.60"],
      ["2026-03-20", "21.10"],
      ["2026-03-16", "16.85"],
      ["2026-03-06", "18.45"],
    ]);
    expect(detail.transactions[0]).toMatchObject({
      text: "CHIPOTLE 1234 AUSTIN TX",
      textFrom: "description",
      accounts: "6170 Meals",
      payee: { id: chipotle.id, name: "Chipotle" },
      key: "chipotle",
      reverses: null,
    });
    const paged = await d.ok("payees.get", {
      payeeId: chipotle.id,
      ...MARCH,
      pageSize: 3,
      page: 2,
    });
    expect(paged.transactions).toHaveLength(1);
    expect(paged.count).toBe(4);
    const missing = await d.call("payees.get", { payeeId: "pay_nope", ...MARCH });
    expect(missing.status).toBe(404);
    const none = await d.call("payees.get", MARCH);
    expect(none.body.error.code).toBe("invalid_input");
    const two = await d.call("payees.get", { payeeId: chipotle.id, unnamed: "x", ...MARCH });
    expect(two.body.error.code).toBe("invalid_input");
  });

  test("a group of unnamed texts, the entries with no payee, and a tie", async () => {
    const report = await d.ok("payees.totals", MARCH);
    const group = report.unnamed.find((g: Json) => g.key.startsWith("ach credit northwind"));
    const detail = await d.ok("payees.get", { unnamed: group.key, ...MARCH });
    expect(detail.subject).toMatchObject({ kind: "unnamed", key: group.key });
    expect(detail.payee).toBeNull();
    expect(detail.transactions.map((t: Json) => [t.date, t.received])).toEqual([
      ["2026-03-25", "1350.00"],
      ["2026-03-05", "1200.00"],
    ]);
    expect(detail.transactions[0].payee).toBeNull();
    // Two payees whose words are the same length and both in "ADOBE *CREATIVE CLOUD".
    await d.ok("payees.save", { name: "Adobe", words: ["adobe creative"] });
    await d.ok("payees.save", { name: "Creative Cloud", words: ["creative cloud"] });
    const tied = await d.ok("payees.totals", MARCH);
    expect(tied.ambiguousCount).toBe(1);
    expect(tied.ambiguous[0]).toMatchObject({
      transactions: 4,
      spent: "219.96",
      payees: [
        expect.objectContaining({ name: "Adobe" }),
        expect.objectContaining({ name: "Creative Cloud" }),
      ],
    });
    expect(tied.tieOut.matches).toBe(true);
    const tie = await d.ok("payees.get", { ambiguous: tied.ambiguous[0].key, ...MARCH });
    expect(tie.subject.payees.map((p: Json) => p.name)).toEqual(["Adobe", "Creative Cloud"]);
    expect(tie.count).toBe(4);
    // A hand-written entry whose narration names nobody is "entered by hand", not a payee to name.
    const entry = await enterByHand(d, {
      date: "2026-03-31",
      reference: "DEPR",
      narration: "Depreciation, office laptop",
      lines: [
        { accountId: "6140", debit: "100.00", credit: "" },
        { accountId: "1000", debit: "", credit: "100.00" },
      ],
    });
    const hand = await d.ok("payees.totals", MARCH);
    expect(hand.noPayee.byHand).toEqual({ received: "0.00", spent: "100.00", transactions: 1 });
    expect(hand.unnamed.some((g: Json) => g.text.includes("Depreciation"))).toBe(false);
    const handDetail = await d.ok("payees.get", { noPayee: "by_hand", ...MARCH });
    expect(handDetail.transactions.map((t: Json) => [t.journalId, t.textFrom])).toEqual([
      [entry, "narration"],
    ]);
    expect(hand.tieOut.matches).toBe(true);
    // Its own words can name a payee, and then it is that payee's.
    await d.ok("payees.save", { name: "Office laptop", words: ["office laptop"] });
    const named = await d.ok("payees.totals", MARCH);
    expect(named.noPayee.byHand.transactions).toBe(0);
    expect(named.rows.find((r: Json) => r.name === "Office laptop")).toMatchObject({
      spent: "100.00",
    });
  });
});

describe("trying words before they are saved", () => {
  test("says what would move, what would be tied, what a longer payee keeps and what would be lost", async () => {
    const list = await d.ok("payees.list", {});
    const byName = (name: string) => list.payees.find((p: Json) => p.name === name);
    // "uber" is a payee now (six transactions). Words that find the same texts take them from it.
    const uber = byName("Uber");
    const take = await d.ok("payees.test", { words: ["uber trip"], ...MARCH });
    expect(take.matches.transactions).toBe(5);
    expect(take.taken).toEqual([{ payee: { id: uber.id, name: "Uber" }, tally: take.matches }]);
    // A payee whose words are longer keeps the texts both find: "com" is in the Uber texts and Uber's
    // word is longer. It finds other texts of its own.
    const beaten = await d.ok("payees.test", { words: ["com"], ...MARCH });
    expect(beaten.beaten).toEqual([
      {
        payee: { id: uber.id, name: "Uber" },
        tally: { received: "0.00", spent: "123.65", transactions: 5 },
      },
    ]);
    expect(beaten.matches.transactions).toBeGreaterThan(0);
    // The same length as another payee's word and in the same texts: tied, so given to neither.
    const tie = await d.ok("payees.test", { words: ["help"], ...MARCH });
    expect(tie.matches.transactions).toBe(0);
    expect(tie.tied.payees.map((p: Json) => p.name)).toEqual(["Uber"]);
    expect(tie.tied.transactions).toBe(5);
    const other = await d.ok("payees.test", {
      words: ["creative cloud"],
      payeeId: byName("Adobe").id,
      ...MARCH,
    });
    // Changing Adobe to "creative cloud" is a tie with the payee that already has those words.
    expect(other.problems.map((p: Json) => p.code)).toEqual(["payee_key_in_use"]);
    expect(other.tied.payees.map((p: Json) => p.name)).toEqual(["Creative Cloud"]);
    expect(other.tied.transactions).toBe(4);
    // Changing a payee's words says what it would lose.
    const lose = await d.ok("payees.test", {
      words: ["chipotle grill"],
      payeeId: byName("Chipotle").id,
      ...MARCH,
    });
    expect(lose.lost.transactions).toBe(4);
    expect(lose.matches.transactions).toBe(0);
    // Words too short are named, and what can be tried is.
    const short = await d.ok("payees.test", { words: ["ab", "wework"], ...MARCH });
    expect(short.problems.map((p: Json) => p.code)).toEqual(["invalid_input"]);
    expect(short.keys).toEqual(["wework"]);
    expect((await d.call("payees.test", { words: [], ...MARCH })).status).toBe(400);
    expect(
      (await d.call("payees.test", { words: ["uber"], payeeId: "pay_nope", ...MARCH })).status,
    ).toBe(404);
    // Nothing was saved by trying.
    expect((await d.ok("payees.list", {})).count).toBe(list.count);
  });
});

describe("a line undone", () => {
  test("its reversal nets where the line was, and the report still adds up", async () => {
    const coffee = month.rows.find(({ row }) => row.memo.startsWith("STARBUCKS"));
    expect(coffee).toBeDefined();
    const before = await d.ok("payees.totals", MARCH);
    const row = before.rows.find((r: Json) => r.name === "Starbucks");
    expect(row).toMatchObject({ transactions: 2, spent: "9.70" });
    const undone = await d.ok("inbox.undo", { itemIds: [(coffee as { item: Json }).item.id] });
    expect(undone.applied).toBe(1);
    const after = await d.ok("payees.totals", MARCH);
    // The original and its reversal are both Starbucks'; the line is back in review, not in the books.
    expect(after.rows.find((r: Json) => r.name === "Starbucks")).toMatchObject({
      transactions: 3,
      spent: "4.85",
    });
    expect(after.tieOut.matches).toBe(true);
    expect(after.tieOut.profitLossExpenses).toBe(
      dec(cents(before.tieOut.profitLossExpenses) - cents("4.85")),
    );
    const detail = await d.ok("payees.get", { payeeId: row.payeeId, ...MARCH });
    const reversal = detail.transactions.find((t: Json) => t.reverses !== null);
    expect(reversal).toMatchObject({ spent: "-4.85", payee: { name: "Starbucks" } });
    // Posting the line again puts it back where it was.
    const items = await allItems(month.world, { status: ["new", "proposed"], text: "STARBUCKS" });
    expect(items).toHaveLength(1);
    await d.ok("inbox.categorize", { itemIds: [items[0]?.id], accountId: "6170" });
    await d.ok("inbox.post", { filter: { status: ["drafted"] } });
    const again = await d.ok("payees.totals", MARCH);
    expect(again.rows.find((r: Json) => r.name === "Starbucks")).toMatchObject({
      transactions: 4,
      spent: "9.70",
    });
  });
});

describe("the file", () => {
  test("is headed by what it was made from and adds up to the profit and loss", async () => {
    const file = await d.ok("payees.export", MARCH);
    const report = await d.ok("payees.totals", MARCH);
    expect(file.filename).toBe("money-by-payee-2026-03-01-to-2026-03-31.csv");
    expect(file.mediaType).toBe("text/csv; charset=utf-8");
    expect(file.populationHash).toBe(report.populationHash);
    expect(file.content).toContain(`Population hash,${report.populationHash}`);
    expect(file.content).toContain(`Ledger population hash,${report.ledgerPopulationHash}`);
    expect(file.content).toContain("Report,Money by payee");
    expect(file.content).toContain(
      `profit and loss,Total income and total expenses of the same range,,${report.tieOut.profitLossIncome},${report.tieOut.profitLossExpenses},`,
    );
    expect(file.content).toMatch(/\r\npayee,Chipotle,chipotle,0\.00,76\.00,-76\.00,4,/);
  });

  test("never carries a cell a spreadsheet could run, whatever a bank wrote", async () => {
    for (const name of ["summary", "transactions"] as const) {
      const file = await d.ok("payees.export", { ...MARCH, file: name });
      for (const line of file.content.split("\r\n").slice(13)) {
        // Cells are plain or quoted; none begins with a formula character unless it is money.
        const cells = line.match(/"(?:[^"]|"")*"|[^,]*/g) ?? [];
        for (const cell of cells) {
          const bare = cell.startsWith('"') ? cell.slice(1) : cell;
          if (/^[=+@\t\r]/.test(bare)) throw new Error(`a cell could run: ${cell.slice(0, 60)}`);
          if (/^-/.test(bare) && !/^-\d+\.\d{2}$/.test(bare))
            throw new Error(`a cell could run: ${cell.slice(0, 60)}`);
        }
      }
      expect(file.content).not.toContain("‮");
    }
    const file = await d.ok("payees.export", { ...MARCH, file: "transactions" });
    // The hostile memos of the month are text.
    expect(file.content).toContain("'=HYPERLINK(");
    expect(file.content).toContain("'@SUM(1+1)");
  });

  test("one payee's transactions, and nobody else's", async () => {
    const list = await d.ok("payees.list", {});
    const chipotle = list.payees.find((p: Json) => p.name === "Chipotle");
    const file = await d.ok("payees.export", {
      ...MARCH,
      file: "transactions",
      payeeId: chipotle.id,
    });
    expect(file.filename).toBe("payee-transactions-2026-03-01-to-2026-03-31.csv");
    const lines = file.content.split("\r\n").filter((l: string) => l.includes("CHIPOTLE"));
    expect(lines).toHaveLength(4);
    expect(file.content).not.toContain("STARBUCKS");
    expect(
      (await d.call("payees.export", { ...MARCH, file: "transactions", payeeId: "pay_nope" }))
        .status,
    ).toBe(404);
  });
});
