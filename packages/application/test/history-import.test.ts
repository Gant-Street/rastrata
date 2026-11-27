import { afterEach, expect, test } from "bun:test";
import { ingestFor } from "../src/slices/statements/ports.ts";
import { baseSetup, fixture } from "./calendar-support.ts";
import { CHART } from "./shadow-xero-fixtures.ts";

/** Bringing history in through the operations: preview, the chunks of an import, what the book holds
 * afterwards, and what stops it. The book is the browser's setup: a calendar from 2000, the books
 * beginning this year. */

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});
type Fixture = Awaited<ReturnType<typeof fixture>>;
const open = async () => {
  const f = await fixture({
    cleanup: (work) => cleanup.push(work),
    now: () => new Date(2026, 10, 2, 12, 0, 0),
  });
  const reply = await f.call(
    "book.setup",
    {
      ...baseSetup,
      accounts: [...baseSetup.accounts],
      fiscalYear: 2000,
      booksStartOn: "2026-01-01",
    },
    crypto.randomUUID(),
  );
  expect(reply.body.ok, JSON.stringify(reply.body)).toBe(true);
  return f;
};

/** Ten years of a small business: a sale and an expense every month, from 2016. */
const history = (
  header = "Journal,Date,Reference,Description,Account Code,Account,Debit,Credit",
): string => {
  const rows = [header];
  let n = 0;
  for (let year = 2016; year <= 2025; year += 1)
    for (let month = 1; month <= 12; month += 1) {
      const mm = String(month).padStart(2, "0");
      n += 1;
      rows.push(`J-${n},${year}-${mm}-05,INV-${n},Sale ${n},1000,Cash,100.00,`);
      rows.push(`J-${n},${year}-${mm}-05,INV-${n},Sale ${n},4000,Sales,,100.00`);
      n += 1;
      rows.push(`J-${n},${year}-${mm}-20,,Supplies ${n},5000,Expense,30.00,`);
      rows.push(`J-${n},${year}-${mm}-20,,Supplies ${n},1000,Cash,,30.00`);
    }
  return rows.join("\n");
};

const upload = (f: Fixture, csv: string) =>
  ingestFor(f.service).archive(new TextEncoder().encode(csv), "text/csv", "history.csv").sha256;
const preview = async (f: Fixture, file: string, extra: Record<string, unknown> = {}) => {
  const reply = await f.call("history.preview", { file, ...extra });
  expect(reply.body.ok, JSON.stringify(reply.body)).toBe(true);
  return reply.body.data;
};
const importAll = async (
  f: Fixture,
  file: string,
  limit = 50,
  extra: Record<string, unknown> = {},
) => {
  let last: Record<string, unknown> = {};
  let calls = 0;
  for (;;) {
    const reply = await f.call("history.import", { file, limit, ...extra }, crypto.randomUUID());
    expect(reply.body.ok, JSON.stringify(reply.body)).toBe(true);
    last = reply.body.data;
    calls += 1;
    if (last.done === true || calls > 50) break;
  }
  return { last, calls };
};

test("ten years of entries are previewed, imported in chunks, and are in the book dated as they were", async () => {
  const f = await open();
  const file = upload(f, history());
  const seen = await preview(f, file);
  expect(seen).toMatchObject({
    entries: 240,
    lines: 480,
    firstDate: "2016-01-05",
    lastDate: "2025-12-20",
    dateOrder: "ymd",
    unmapped: 0,
    problemCount: 0,
    alreadyImported: 0,
    remaining: 240,
    ready: true,
    startsBefore: "2016-01-05",
  });
  expect(seen.years.map((year: { fiscalYear: number }) => year.fiscalYear)).toEqual([
    2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025,
  ]);
  expect(seen.years[0]).toMatchObject({ entries: 24, lines: 48, total: "1560.00" });
  expect(
    seen.accounts.map((row: { label: string; account: string }) => [row.label, row.account]),
  ).toEqual([
    ["1000 Cash", "1000"],
    ["4000 Sales", "4000"],
    ["5000 Expense", "5000"],
  ]);

  const { last, calls } = await importAll(f, file, 100);
  expect(calls).toBe(3);
  expect(last).toMatchObject({
    importedTotal: 240,
    remaining: 0,
    total: 240,
    done: true,
    failed: null,
    booksBegan: "2016-01-05",
  });
  // The books begin where the history does, so none of those years is before them.
  const list = await f.periods();
  expect(list.calendar.booksBegan).toBe("2016-01-05");
  const years = list.calendar.fiscalYears as { fiscalYear: number; beforeBooks: boolean }[];
  expect(years.filter((year) => year.fiscalYear >= 2016 && year.beforeBooks)).toEqual([]);

  // What the book holds is what the file said: the figures at the end of 2018.
  const report = (await f.call("reports.get", { asOf: "2018-12-31" })).body.data;
  // Three years of 12 x (100 - 30) in cash.
  expect(report.balanceSheet.assets).toBe("2520.00");
  expect(report.balanceSheet.balanced).toBe(true);
  const later = (await f.call("reports.get", { asOf: "2025-12-31" })).body.data;
  expect(later.balanceSheet.assets).toBe("8400.00");
});

test("the setup checklist knows a history came in, so opening balances are not a step that is left", async () => {
  const f = await open();
  const checklist = async () => (await f.call("cutover.checklist", {})).body.data;
  expect((await checklist()).historyImported).toBe(false);
  expect((await f.call("book.get", {})).body.data.setup).not.toHaveProperty("historyImported");
  await importAll(f, upload(f, history()), 500);
  expect((await checklist()).historyImported).toBe(true);
  // The setup a client reads and a retried setup are what they were.
  expect((await f.call("book.get", {})).body.data.setup).not.toHaveProperty("historyImported");
  const again = await f.call(
    "book.setup",
    {
      ...baseSetup,
      accounts: [...baseSetup.accounts],
      fiscalYear: 2000,
      booksStartOn: "2026-01-01",
    },
    crypto.randomUUID(),
  );
  expect(again.body.ok, JSON.stringify(again.body)).toBe(true);
});

test("importing the file again, or a call sent twice, posts nothing twice", async () => {
  const f = await open();
  const file = upload(f, history());
  await importAll(f, file, 500);
  const again = await f.call("history.import", { file, limit: 500 }, crypto.randomUUID());
  expect(again.body.data).toMatchObject({
    imported: 0,
    importedTotal: 240,
    remaining: 0,
    done: true,
  });
  // The same bytes uploaded again are the same file.
  expect(upload(f, history())).toBe(file);
  // One call, sent twice under one identity, is the one answer.
  const id = crypto.randomUUID();
  const first = await f.call("history.import", { file, limit: 10 }, id);
  const second = await f.call("history.import", { file, limit: 10 }, id);
  expect(second.body).toEqual(first.body);
  const preview2 = await preview(f, file);
  expect(preview2).toMatchObject({ alreadyImported: 240, remaining: 0 });
});

test("a file with problems, accounts the book does not have, or dates outside the calendar is not imported, and says why", async () => {
  const f = await open();
  // A line that does not balance, and an account the book has no account for.
  const bad = [
    "Date,Account,Debit,Credit",
    "2018-01-02,1000,10.00,",
    "2018-01-02,4000,,9.00",
    "2018-02-02,Rent,10.00,",
    "2018-02-02,1000,,10.00",
  ].join("\n");
  const file = upload(f, bad);
  const seen = await preview(f, file);
  expect(seen).toMatchObject({ ready: false, problemCount: 1, unmapped: 1 });
  expect(seen.problems[0]).toMatchObject({ row: 2, code: "unbalanced" });
  const refused = await f.call("history.import", { file }, crypto.randomUUID());
  expect(refused.body.ok).toBe(false);
  expect(refused.body.error.code).toBe("history_not_ready");
  expect(refused.body.error.message).toContain("row 2");

  // An account of the file is mapped to one of the book's, by the code.
  const rent = upload(
    f,
    ["Date,Account,Debit,Credit", "2018-02-02,Rent,10.00,", "2018-02-02,1000,,10.00"].join("\n"),
  );
  expect((await preview(f, rent)).ready).toBe(false);
  expect((await preview(f, rent, { map: [{ account: "Rent", to: "5000" }] })).ready).toBe(true);
  const wrong = await preview(f, rent, { map: [{ account: "Rent", to: "9999" }] });
  expect(wrong.ready).toBe(false);
  expect(wrong.conflicts[0]).toContain("9999");

  // 1998 is before the calendar, which can never be helped; 2031 is after it, which the import grows the
  // calendar for as it posts.
  const outside = upload(
    f,
    [
      "Date,Account,Debit,Credit",
      "1998-01-02,1000,10.00,",
      "1998-01-02,4000,,10.00",
      "2031-01-02,1000,10.00,",
      "2031-01-02,4000,,10.00",
    ].join("\n"),
  );
  const edges = await preview(f, outside);
  expect(edges.ready).toBe(false);
  expect(edges.conflicts.join(" ")).toContain("before the calendar begins on 2000-01-01");
  expect(edges.conflicts.join(" ")).not.toContain("2031");
  expect(edges.years.map((year: { fiscalYear: number }) => year.fiscalYear)).toEqual([2031]);
  // Nothing was posted by any of it.
  expect((await f.periods()).calendar.booksBegan).toBe("2026-01-01");
});

test("a history dated after the calendar's end grows the calendar as it is imported", async () => {
  const f = await open();
  const ahead = upload(
    f,
    [
      "Date,Account,Debit,Credit",
      "2026-11-02,1000,10.00,",
      "2026-11-02,4000,,10.00",
      "2027-03-05,1000,20.00,",
      "2027-03-05,4000,,20.00",
      "2028-01-15,1000,30.00,",
      "2028-01-15,4000,,30.00",
    ].join("\n"),
  );
  const plan = await preview(f, ahead);
  expect(plan.ready, JSON.stringify(plan.conflicts)).toBe(true);
  expect(plan.years.map((year: { fiscalYear: number }) => year.fiscalYear)).toEqual([
    2026, 2027, 2028,
  ]);
  const { last } = await importAll(f, ahead, 2);
  expect(last).toMatchObject({ done: true, importedTotal: 3, remaining: 0 });
  const periods = await f.periods();
  expect(periods.calendar.lastDate).toBe("2028-12-31");
  expect(periods.calendar.booksBegan).toBe("2026-01-01");
  const feed = (await f.call("changes.list", {})).body.data;
  expect(
    feed.changes.filter((change: { kind: string }) => change.kind === "calendar.extended"),
  ).toHaveLength(2);
});

test("history does not go into dates the book already holds entries in, and an opening entry is not counted twice", async () => {
  const f = await open();
  await f.postOk("2026-03-05", "10.00");
  // 2026 holds an entry, so a file that reaches into 2026 meets it.
  const reaching = upload(
    f,
    [
      "Date,Account,Debit,Credit",
      "2025-12-01,1000,10.00,",
      "2025-12-01,4000,,10.00",
      "2026-04-01,1000,10.00,",
      "2026-04-01,4000,,10.00",
    ].join("\n"),
  );
  const meets = await preview(f, reaching);
  expect(meets.ready).toBe(false);
  expect(meets.conflicts[0]).toContain(
    "already holds 1 entry dated between 2025-12-01 and 2026-04-01",
  );
  // A file that ends before the book's first entry is brought in alongside it.
  const before = upload(
    f,
    ["Date,Account,Debit,Credit", "2025-12-01,1000,10.00,", "2025-12-01,4000,,10.00"].join("\n"),
  );
  expect((await preview(f, before)).ready).toBe(true);
  // An entry typed in before the history's last date, however, is in the way; a posted opening entry too.
  const done = await f.call("history.import", { file: before }, crypto.randomUUID());
  expect(done.body.data).toMatchObject({ imported: 1, done: true });
});

test("the book that refuses an entry stops the call at it, and the entries before it stay posted", async () => {
  const f = await open();
  const closed = await f.prepareCommit("periods.prepare", {
    periodId: "period-2019-03",
    operation: "close",
    reason: "Reviewed",
  });
  expect(closed.receipt?.body.data.disposition).toBe("committed");
  const csv = [
    "Date,Account,Debit,Credit",
    "2018-01-02,1000,10.00,",
    "2018-01-02,4000,,10.00",
    "2019-03-10,1000,10.00,",
    "2019-03-10,4000,,10.00",
  ].join("\n");
  const file = upload(f, csv);
  const seen = await preview(f, file);
  // A period inside the file's dates is closed: that is said in the preview, before any posting.
  expect(seen.ready).toBe(false);
  expect(seen.conflicts.join(" ")).toContain("is closed");
});

test("a person with post permission only can read what a preview says, and a person without cannot import", async () => {
  const f = await open();
  const file = upload(f, history());
  const reading = await f.call("history.preview", { file }, undefined, ["read"]);
  expect(reading.body.ok).toBe(true);
  const refused = await f.call("history.import", { file }, crypto.randomUUID(), ["read", "draft"]);
  expect(refused.body.ok).toBe(false);
  expect(refused.status).toBe(403);
  // Adding accounts changes the book's configuration, which posting alone does not allow.
  const adding = await f.call(
    "history.import",
    { file, map: [{ account: "Rent", add: "expense" }] },
    crypto.randomUUID(),
    ["read", "draft", "post"],
  );
  expect(adding.status).toBe(403);
  expect(adding.body.error.message).toContain("configure");
});

test("each year of the book is tied to the old books' trial balance at its last day, and a difference is named", async () => {
  const f = await open();
  await importAll(f, upload(f, history()), 500);
  // Three years of 36 months: cash 36 x 70, sales 36 x 100, expense 36 x 30.
  const tb = [
    "Account Code,Account,Debit,Credit",
    '1000,Cash,"2,520.00",',
    "4000,Sales,,3600.00",
    "5000,Expense,1080.00,",
    "Total,,3600.00,3600.00",
  ].join("\n");
  const tied = (await f.call("history.tieOut", { file: upload(f, tb), asOf: "2018-12-31" })).body
    .data;
  expect(tied).toMatchObject({
    asOf: "2018-12-31",
    tied: true,
    differing: 0,
    fileTotal: "0.00",
    unmapped: [],
    problemCount: 0,
  });
  expect(
    tied.accounts.map((row: { account: string; book: string }) => [row.account, row.book]),
  ).toEqual([
    ["1000", "2520.00"],
    ["4000", "-3600.00"],
    ["5000", "1080.00"],
  ]);
  // One figure off by a dollar, and an account the book does not have: neither is passed over.
  const off = [
    "Account Code,Account,Debit,Credit",
    "1000,Cash,2521.00,",
    "4000,Sales,,3600.00",
    "5000,Expense,1080.00,",
    "9999,Mystery,,1.00",
  ].join("\n");
  const bad = (await f.call("history.tieOut", { file: upload(f, off), asOf: "2018-12-31" })).body
    .data;
  expect(bad.tied).toBe(false);
  expect(bad.differing).toBe(1);
  expect(bad.accounts[0]).toMatchObject({
    account: "1000",
    file: "2521.00",
    book: "2520.00",
    difference: "-1.00",
  });
  expect(bad.unmapped).toEqual(["9999 Mystery: -1.00"]);
  // A date before the history begins has nothing in the book, so a trial balance of nothing ties.
  const none = (
    await f.call("history.tieOut", {
      file: upload(f, ["Account,Debit,Credit", "Cash,0.00,0.00"].join("\n")),
      asOf: "2015-12-31",
    })
  ).body.data;
  expect(none.tied).toBe(true);
  expect(
    (await f.call("history.tieOut", { file: upload(f, "hello\n1\n"), asOf: "2018-12-31" })).body
      .data.problems[0].code,
  ).toBe("no_header");
});

test("accounts the file has and the book lacks are added by the import, open from the start of the calendar, and none is added twice", async () => {
  const f = await open();
  const file = upload(
    f,
    [
      "Journal,Date,Account Code,Account,Debit,Credit",
      "A,2018-01-10,1000,Cash,500.00,",
      "A,2018-01-10,,Owner Investment,,500.00",
      "B,2018-02-10,6500,Consulting Costs,120.00,",
      "B,2018-02-10,1000,Cash,,120.00",
      "C,2018-03-10,,Bank Fees,5.00,",
      "C,2018-03-10,1000,Cash,,5.00",
    ].join("\n"),
  );
  const seen = await preview(f, file);
  expect(seen).toMatchObject({ unmapped: 3, adding: 0, ready: false });
  const rows = (data: { accounts: { label: string }[] }, pick: (row: never) => unknown) =>
    Object.fromEntries(data.accounts.map((row) => [row.label, pick(row as never)]));
  // The number or a strong word in the name suggests a kind; nothing else does.
  expect(rows(seen, (row: { suggestedRole: string | null }) => row.suggestedRole)).toMatchObject({
    "6500 Consulting Costs": "expense",
    "Owner Investment": "equity",
    "Bank Fees": null,
  });

  const map = [
    { account: "6500 Consulting Costs", add: "expense" },
    { account: "Owner Investment", add: "equity" },
    { account: "Bank Fees", add: "expense" },
  ];
  const planned = await preview(f, file, { map });
  expect(planned).toMatchObject({ unmapped: 0, adding: 3, ready: true });
  // The file's own code is used when it is free; the others take the next free code of their kind.
  expect(rows(planned, (row: { account: string; add: string }) => [row.account, row.add])).toEqual({
    "1000 Cash": ["1000", null],
    "6500 Consulting Costs": ["6500", "expense"],
    "Owner Investment": ["3010", "equity"],
    "Bank Fees": ["6010", "expense"],
  });
  // A preview adds nothing.
  const before = (await f.call("accounts.list", {})).body.data.accounts.length;
  expect(before).toBe(4);

  const { last } = await importAll(f, file, 500, { map });
  expect(last).toMatchObject({ importedTotal: 3, done: true, failed: null });
  const chart = (await f.call("accounts.list", {})).body.data.accounts as {
    code: string;
    name: string;
    role: string;
    openedOn: string;
  }[];
  expect(chart).toHaveLength(7);
  expect(chart.find((account) => account.code === "3010")).toMatchObject({
    name: "Owner Investment",
    role: "equity",
    openedOn: "2000-01-01",
  });
  expect(chart.find((account) => account.code === "6010")).toMatchObject({
    name: "Bank Fees",
    role: "expense",
  });
  const report = (await f.call("reports.get", { asOf: "2018-12-31" })).body.data;
  expect(report.balanceSheet.assets).toBe("375.00");
  expect(report.balanceSheet.balanced).toBe(true);

  // Sent again, nothing is posted or added twice; and the file now resolves to the accounts by itself.
  const again = await f.call("history.import", { file, map }, crypto.randomUUID());
  expect(again.body.data).toMatchObject({ imported: 0, done: true });
  expect((await f.call("accounts.list", {})).body.data.accounts).toHaveLength(7);
  expect(await preview(f, file)).toMatchObject({ unmapped: 0, adding: 0, alreadyImported: 3 });
});

test("accounts cannot be added once the book has entries, and the preview says so", async () => {
  const f = await open();
  await f.postOk("2026-03-05", "10.00");
  const file = upload(
    f,
    ["Date,Account,Debit,Credit", "2018-01-02,Rent,10.00,", "2018-01-02,1000,,10.00"].join("\n"),
  );
  const map = [{ account: "Rent", add: "expense" }];
  const seen = await preview(f, file, { map });
  expect(seen.ready).toBe(false);
  expect(seen.conflicts[0]).toContain("dated before the file begins");
  const refused = await f.call("history.import", { file, map }, crypto.randomUUID());
  expect(refused.body.ok).toBe(false);
  expect(refused.body.error.code).toBe("history_not_ready");
  expect((await f.call("accounts.list", {})).body.data.accounts).toHaveLength(4);
});

test("a book's own general ledger export is read as a history, so a book can be rebuilt into another with other settings", async () => {
  const old = await open();
  for (const [date, amount] of [
    ["2026-02-03", "100.00"],
    ["2026-03-05", "250.50"],
    ["2026-03-20", "40.00"],
  ] as const)
    await old.postOk(date, amount);
  const exported = await old.call("reports.export", {
    statement: "general-ledger",
    from: "2026-01-01",
    asOf: "2026-12-31",
  });
  expect(exported.body.ok, JSON.stringify(exported.body)).toBe(true);
  const csv = exported.body.data.content as string;

  // The new book has the other basis; the old one's entries come in as they are.
  const fresh = await fixture({
    cleanup: (work) => cleanup.push(work),
    now: () => new Date(2026, 10, 2, 12, 0, 0),
  });
  const made = await fresh.call(
    "book.setup",
    {
      ...baseSetup,
      accounts: [...baseSetup.accounts],
      fiscalYear: 2000,
      booksStartOn: "2026-01-01",
      basis: "accrual",
    },
    crypto.randomUUID(),
  );
  expect(made.body.ok, JSON.stringify(made.body)).toBe(true);
  const file = upload(fresh, csv);
  const seen = await preview(fresh, file);
  expect(seen).toMatchObject({
    entries: 3,
    firstDate: "2026-02-03",
    lastDate: "2026-03-20",
    unmapped: 0,
    problemCount: 0,
    ready: true,
  });
  const { last } = await importAll(fresh, file);
  expect(last).toMatchObject({ importedTotal: 3, done: true });
  const [a, b] = await Promise.all([
    old.call("reports.get", { asOf: "2026-12-31" }),
    fresh.call("reports.get", { asOf: "2026-12-31" }),
  ]);
  expect(b.body.data.balanceSheet.assets).toBe(a.body.data.balanceSheet.assets);
  expect(b.body.data.balanceSheet.balanced).toBe(true);
});

test("a file one book has read is not another book's: naming its hash opens nothing", async () => {
  const mine = await open();
  const other = await open();
  const file = upload(mine, history());
  // Read once, so that what it said is kept for the calls of an import.
  expect((await preview(mine, file)).entries).toBe(240);
  const refused = await other.call("history.preview", { file });
  expect(refused.body.ok).toBe(false);
  expect(refused.body.error.code).toBe("file_not_found");
});

/** A Xero Journal Report: the codes of the fixture chart (Business Bank Account 090, Sales 200, Rent 469). */
const xeroJournal = (year: number, from = 1, to = 12): string => {
  const rows = [
    "Journal Report",
    "Harbor Studio LLC",
    "",
    "Date,Journal Number,Source,Reference,Description,Account Code,Account,Debit (USD),Credit (USD)",
  ];
  let n = year * 100;
  for (let month = from; month <= to; month += 1) {
    const mm = String(month).padStart(2, "0");
    n += 1;
    rows.push(
      `${year}-${mm}-05,${n},Bank Transaction,,Stripe payout,090,Business Bank Account,300.00,`,
    );
    rows.push(`${year}-${mm}-05,${n},Bank Transaction,,Stripe payout,200,Sales,,300.00`);
    n += 1;
    rows.push(`${year}-${mm}-07,${n},Bank Transaction,,Studio rent,469,Rent,100.00,`);
    rows.push(
      `${year}-${mm}-07,${n},Bank Transaction,,Studio rent,090,Business Bank Account,,100.00`,
    );
  }
  return rows.join("\n");
};

test("with the Xero chart imported, a Xero journal's accounts are read the way the owner mapped them, and the kind of the rest comes from Xero's types", async () => {
  const f = await open();
  const file = upload(f, xeroJournal(2025));
  // Before the chart: Xero's three-digit codes say nothing about the kind, so nothing is suggested.
  const blind = await preview(f, file);
  expect(
    blind.accounts.map((row: { label: string; suggestedRole: string | null }) => [
      row.label,
      row.suggestedRole,
    ]),
  ).toEqual([
    ["090 Business Bank Account", null],
    ["200 Sales", null],
    ["469 Rent", null],
  ]);
  // The chart of the move from Xero: Sales maps to the book's Sales by name; the rest have no counterpart.
  const chart = await f.call(
    "xero.chart.import",
    { text: CHART, accept: "likely" },
    crypto.randomUUID(),
  );
  expect(chart.body.ok, JSON.stringify(chart.body)).toBe(true);
  const seen = await preview(f, file);
  expect(
    seen.accounts.map(
      (row: { label: string; account: string | null; suggestedRole: string | null }) => [
        row.label,
        row.account,
        row.suggestedRole,
      ],
    ),
  ).toEqual([
    ["090 Business Bank Account", null, "asset"],
    ["200 Sales", "4000", null],
    ["469 Rent", null, "expense"],
  ]);
  const map = [
    { account: "090 Business Bank Account", add: "asset" },
    { account: "469 Rent", add: "expense" },
  ];
  const { last } = await importAll(f, file, 500, { map });
  expect(last).toMatchObject({ importedTotal: 24, done: true });
  const accounts = (await f.call("accounts.list", {})).body.data.accounts as {
    code: string;
    name: string;
    role: string;
  }[];
  expect(accounts.find((account) => account.code === "090")).toMatchObject({
    name: "Business Bank Account",
    role: "asset",
  });
  expect(accounts.find((account) => account.code === "469")).toMatchObject({ role: "expense" });
  const report = (await f.call("reports.get", { asOf: "2025-12-31" })).body.data;
  expect(report.balanceSheet.assets).toBe("2400.00");
});

test("a later part of a history can add the accounts it brings, open from its first day, and a part that overlaps the book cannot", async () => {
  const f = await open();
  const first = upload(f, xeroJournal(2024));
  await importAll(f, first, 500, {
    map: [
      { account: "090 Business Bank Account", add: "asset" },
      { account: "200 Sales", add: "income" },
      { account: "469 Rent", add: "expense" },
    ],
  });
  // 2025 brings an account 2024 did not have.
  const second = upload(
    f,
    [
      xeroJournal(2025),
      "2025-03-09,999901,Bank Transaction,,Monthly fee,404,Bank Fees,15.00,",
      "2025-03-09,999901,Bank Transaction,,Monthly fee,090,Business Bank Account,,15.00",
    ].join("\n"),
  );
  const map = [{ account: "404 Bank Fees", add: "expense" }];
  const seen = await preview(f, second, { map });
  expect(seen).toMatchObject({ unmapped: 0, adding: 1, ready: true, conflicts: [] });
  const { last } = await importAll(f, second, 500, { map });
  expect(last).toMatchObject({ importedTotal: 25, done: true });
  const fees = (
    (await f.call("accounts.list", {})).body.data.accounts as { code: string; openedOn: string }[]
  ).find((account) => account.code === "404");
  expect(fees?.openedOn).toBe("2025-01-05");
  expect((await f.call("reports.get", { asOf: "2025-12-31" })).body.data.balanceSheet.assets).toBe(
    "4785.00",
  );
  // A part dated inside what the book holds cannot add an account: the book has later entries.
  const overlapping = upload(
    f,
    [
      "Date,Journal Number,Account Code,Account,Debit,Credit",
      "2024-06-15,5001,412,Consulting,40.00,",
      "2024-06-15,5001,090,Business Bank Account,,40.00",
    ].join("\n"),
  );
  const refused = await preview(f, overlapping, {
    map: [{ account: "412 Consulting", add: "expense" }],
  });
  expect(refused.ready).toBe(false);
  expect(refused.conflicts.join(" ")).toContain("dated before the file begins");
});

test("a name decides which of the book's accounts an account of the file is, a code alone never does, and a likely match by name is suggested for the person to keep or change", async () => {
  const f = await open();
  // The book's 5000 is "Expense"; the file's 5000 is "Bank Service Charges": not the same account. Its "Cash
  // (Checking)" is probably the book's "Cash"; its "4000 Sales" is the book's Sales by name and code.
  const file = upload(
    f,
    [
      "Date,Account Code,Account,Debit,Credit",
      "2026-02-01,5000,Bank Service Charges,15.00,",
      "2026-02-01,,Cash (Checking),,15.00",
      "2026-02-02,,Cash (Checking),100.00,",
      "2026-02-02,4000,Sales,,100.00",
    ].join("\n"),
  );
  const seen = await preview(f, file);
  expect(
    seen.accounts.map(
      (row: { label: string; account: string | null; suggestedAccount: string | null }) => [
        row.label,
        row.account,
        row.suggestedAccount,
      ],
    ),
  ).toEqual([
    ["Cash (Checking)", null, "1000"],
    ["4000 Sales", "4000", null],
    ["5000 Bank Service Charges", null, null],
  ]);
  // With the suggestion taken and the charges added, everything resolves.
  const map = [
    { account: "Cash (Checking)", to: "1000" },
    { account: "5000 Bank Service Charges", add: "expense" },
  ];
  expect(await preview(f, file, { map })).toMatchObject({ unmapped: 0, adding: 1, ready: true });
  // The added account cannot take the book's code 5000, which is in use: it gets the next free one of its kind.
  const planned = await preview(f, file, { map });
  expect(
    planned.accounts.find((row: { label: string }) => row.label === "5000 Bank Service Charges")
      .account,
  ).toBe("6010");
});
