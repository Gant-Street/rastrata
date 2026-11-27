/** `reconcile.report` through the HTTP boundary, as a client reaches it: what it answers for a finished
 * reconciliation, a voided one and a card, what it refuses and says, that it never moves, that text from
 * outside stays text, and that it fails loudly when the records and the books no longer agree. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cents, dec } from "../acceptance/month.ts";
import { parseCsv, unsafeCells } from "../acceptance/drive.ts";
import {
  type Finished,
  type Json,
  type MonthBook,
  agentCaller,
  lineFields,
  monthBook,
  postPayment,
  reconcileTo,
  reportOf,
} from "./support.ts";

let m: MonthBook;
let agent: Awaited<ReturnType<typeof agentCaller>>;

beforeAll(async () => {
  m = await monthBook();
  agent = await agentCaller(m.world, "reader", ["read"]);
}, 120_000);
afterAll(() => m?.close());

const FORMULA = '=HYPERLINK("https://pay.example.invalid/x","PAY INVOICE")';
const BIDI = "INVOICE 8841 ‮gnp.exe‬ ⁦PAID⁩ ​now";
const LONG = `LONG ${"x".repeat(400)}`;

let finished: Finished;
let report: Json;

describe("the report on a finished reconciliation", () => {
  test("says what the statement said, what was cleared, what was not on it yet, and how the books reach it", async () => {
    // Text from outside, in the places a report copies it from, and left off the statement.
    await postPayment(m.owner, { date: "2026-03-03", amount: "9.99", narration: FORMULA });
    m.advance();
    await postPayment(m.owner, { date: "2026-03-04", amount: "8.88", narration: BIDI });
    m.advance();
    await postPayment(m.owner, { date: "2026-03-05", amount: "7.77", narration: LONG });
    m.advance();
    finished = await reconcileTo(
      m.owner,
      "1000",
      "2026-03-10",
      (line) =>
        line.narration === FORMULA ||
        line.narration.includes("PAID") ||
        line.narration.startsWith("LONG"),
    );
    expect(finished.unselected).toHaveLength(3);
    report = await reportOf(m.owner, finished.record.id);
    expect(report).toMatchObject({
      id: finished.record.id,
      status: "completed",
      account: { id: "1000", code: "1000", name: "Chase business checking", role: "asset" },
      currency: "USD",
      statementDate: "2026-03-10",
      openingBalance: "0.00",
      previous: null,
      void: null,
      difference: "0.00",
      cleared: { count: finished.selected.length },
      outstanding: { count: 3, total: "-26.64" },
    });
    expect(report.outstanding.lines.map(lineFields)).toEqual(finished.unselected.map(lineFields));
    // The books on the statement date, less what the statement does not show, is the statement.
    expect(cents(report.bookBalance) - cents(report.outstanding.total)).toBe(
      cents(report.statementBalance),
    );
    expect(report.recordHash).toBe(finished.record.recordHash);
    expect(report.bookRevision).toBe(finished.record.snapshotRevision);
  });

  test("keeps the books' text as it is on the wire, cut to the length a draft keeps", async () => {
    const texts = report.outstanding.lines.map((line: Json) => line.narration);
    expect(texts).toContain(FORMULA);
    expect(texts).toContain(BIDI);
    const long = texts.find((text: string) => text.startsWith("LONG")) as string;
    expect(long.length).toBeLessThanOrEqual(240);
    expect(long.length).toBeGreaterThan(200);
  });

  test("is the same bytes every time, after later entries, after a close, and after a restart", async () => {
    const first = JSON.stringify(await reportOf(m.owner, finished.record.id));
    expect(first).toBe(JSON.stringify(report));
    m.advance();
    await postPayment(m.owner, { date: "2026-03-08", amount: "3.00", narration: "After the fact" });
    await postPayment(m.owner, {
      date: "2026-03-30",
      amount: "1.00",
      narration: "End of the month",
    });
    const periods = (await m.owner.ok("periods.list")).periods as Json[];
    const february = periods.find((period) => period.startsOn === "2026-02-01") as Json;
    const prepared = await m.owner.ok("periods.prepare", {
      periodId: february.id,
      operation: "close",
      reason: "February is checked",
    });
    await m.owner.ok("operations.commit", { planId: prepared.planId, planHash: prepared.planHash });
    expect(JSON.stringify(await reportOf(m.owner, finished.record.id))).toBe(first);
    await m.world.restart();
    expect(JSON.stringify(await reportOf(m.owner, finished.record.id))).toBe(first);
  });

  test("a report is a read: it writes nothing, and a token that can only read gets it", async () => {
    const before = (await m.owner.ok("changes.list", { pageSize: 1 })).revision;
    const reader = await agent.ok("reconcile.report", { id: finished.record.id });
    expect(JSON.stringify(reader)).toBe(JSON.stringify(report));
    expect((await m.owner.ok("changes.list", { pageSize: 1 })).revision).toBe(before);
  });

  test("asks for a record that is there: a draft has no report, and an unknown id is not found", async () => {
    const draft = await m.owner.ok("reconcile.start", {
      accountId: "1010",
      statementDate: "2026-03-31",
      statementBalance: "5000.00",
    });
    const early = await m.owner.call("reconcile.report", { id: draft.id });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("reconcile_not_completed");
    expect(early.body.error.message).toMatch(/draft has no report/);
    await m.owner.ok("reconcile.discard", { id: draft.id, expectedVersion: draft.version });
    const missing = await m.owner.call("reconcile.report", {
      id: "d0d0d0d0-0000-4000-8000-0000000000ff",
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("reconcile_not_found");
    // Requests are strict: nothing but the id and the file is read.
    for (const input of [
      {},
      { id: finished.record.id, revision: "3" },
      { id: finished.record.id, file: "pdf" },
    ]) {
      const bad = await m.owner.call("reconcile.report", input);
      expect(bad.status, JSON.stringify(input)).toBe(400);
    }
  });
});

describe("the same report as a spreadsheet", () => {
  test("is a file named for the account and the statement, with the figures above the lines", async () => {
    const withFile = await reportOf(m.owner, finished.record.id, { file: "csv" });
    const { file, ...same } = withFile;
    expect(JSON.stringify(same)).toBe(JSON.stringify(report));
    expect(file).toMatchObject({
      filename: "reconciliation-1000-2026-03-10.csv",
      mediaType: "text/csv; charset=utf-8",
    });
    const table = parseCsv(file.content);
    const head = new Map(table.filter((row) => row.length === 2).map((row) => [row[0], row[1]]));
    expect(head.get("Report")).toBe("Reconciliation report");
    expect(head.get("Book")).toBe("Willow Lane Studio");
    expect(head.get("Account")).toBe("1000 Chase business checking");
    expect(head.get("Statement date")).toBe("2026-03-10");
    expect(head.get("Statement balance")).toBe(report.statementBalance);
    expect(head.get("Cleared total")).toBe(report.cleared.total);
    expect(head.get("Outstanding total")).toBe("-26.64");
    expect(head.get("Books on the statement date")).toBe(report.bookBalance);
    expect(head.get("Difference")).toBe("0.00");
    expect(head.get("Status")).toBe("completed");
    expect(head.get("Book revision")).toBe(report.bookRevision);
    expect(head.get("Record hash")).toBe(report.recordHash);
    const start = table.findIndex((row) => row[0] === "State");
    const rows = table.slice(start + 1);
    expect(rows).toHaveLength(report.cleared.count + report.outstanding.count);
    expect(rows.filter((row) => row[0] === "outstanding")).toHaveLength(3);
    // The amounts are exact: the outstanding rows add up to the total in the head.
    const outstanding = rows.filter((row) => row[0] === "outstanding");
    expect(dec(outstanding.reduce((sum, row) => sum + cents(row[5] as string), 0n))).toBe("-26.64");
  });

  test("copies text from outside as text: no cell can run as a formula, and nothing is disguised", async () => {
    const { file } = await reportOf(m.owner, finished.record.id, { file: "csv" });
    const table = parseCsv(file.content);
    // No cell starts as a formula, and none carries a control or direction character (unsafeCells reads both).
    expect(unsafeCells(table)).toEqual([]);
    const formula = table.find((row) => (row[4] ?? "").includes("HYPERLINK")) as string[];
    expect(formula[4]?.startsWith("'=HYPERLINK(")).toBe(true);
    const long = table.find((row) => (row[4] ?? "").startsWith("LONG")) as string[];
    expect((long[4] as string).length).toBeLessThanOrEqual(240);
  });
});

describe("a card is read the way its statement is", () => {
  test("a charge raises the balance owed, and what was not on the statement is signed the same way", async () => {
    // The card owed 1,250.00 at the start. A charge on the 8th is on the statement; one on the 9th is not yet.
    m.advance();
    for (const [date, amount, narration] of [
      ["2026-03-08", "50.00", "Charged on the 8th"],
      ["2026-03-09", "20.00", "Charged on the 9th"],
    ] as const)
      await m.owner.ok("journal.post", {
        data: {
          date,
          reference: `CARD-${date}`,
          narration,
          lines: [
            { accountId: "6200", debit: amount, credit: "" },
            { accountId: "2000", debit: "", credit: amount },
          ],
        },
      });
    const card = await reconcileTo(m.owner, "2000", "2026-03-10", (line) =>
      line.narration.includes("9th"),
    );
    const cardReport = await reportOf(m.owner, card.record.id);
    expect(cardReport.account).toMatchObject({
      code: "2000",
      role: "liability",
      normalSide: "credit",
    });
    expect(cardReport.statementBalance).toBe("1300.00");
    expect(cardReport.outstanding.lines.map((line: Json) => [line.narration, line.amount])).toEqual(
      [["Charged on the 9th", "20.00"]],
    );
    // 1,250.00 owed at the start and two charges: 1,320.00 in the books, 20.00 of it not on the statement.
    expect(cardReport.bookBalance).toBe("1320.00");
    expect(cardReport.outstanding.total).toBe("20.00");
    expect(cents(cardReport.bookBalance) - cents(cardReport.outstanding.total)).toBe(
      cents(cardReport.statementBalance),
    );
  });
});

describe("it fails loudly instead of giving a figure that may be wrong", () => {
  test("a record changed behind the product's back is not reported on", async () => {
    // Done to a book of its own: the protections that stop this are triggers, and a test has to take them away.
    const other = await monthBook();
    try {
      const done = await reconcileTo(
        other.owner,
        "1000",
        "2026-03-10",
        (_line, index) => index === 3,
      );
      const store = other.world.service.store;
      expect((await reportOf(other.owner, done.record.id)).status).toBe("completed");
      store.query("DROP TRIGGER recon_lines_frozen_update").run();
      store
        .query("UPDATE recon_lines SET amount='99.99' WHERE session_id=? AND ordinal=1")
        .run(done.record.id);
      const damaged = await other.owner.call("reconcile.report", { id: done.record.id });
      expect(damaged.status).toBe(409);
      expect(damaged.body.error.code).toBe("reconcile_report_mismatch");
      expect(damaged.body.error.message).toMatch(/could not be trusted/);
      expect(JSON.stringify(damaged.body)).not.toContain('99.99"');
    } finally {
      await other.close();
    }
  });

  test("a record that no longer matches its fingerprint is not reported on", async () => {
    const other = await monthBook();
    try {
      const done = await reconcileTo(other.owner, "1000", "2026-03-10");
      const store = other.world.service.store;
      store.query("DROP TRIGGER recon_sessions_frozen_update").run();
      store
        .query("UPDATE recon_sessions SET completed_at='2026-04-01T00:00:00.000Z' WHERE id=?")
        .run(done.record.id);
      const damaged = await other.owner.call("reconcile.report", { id: done.record.id });
      expect(damaged.status).toBe(409);
      expect(damaged.body.error.code).toBe("reconcile_report_mismatch");
      expect(damaged.body.error.message).toMatch(/does not match what is recorded/);
    } finally {
      await other.close();
    }
  });

  test("a book that is behind the record is not guessed at", async () => {
    const other = await monthBook();
    try {
      const done = await reconcileTo(other.owner, "1000", "2026-03-10");
      const store = other.world.service.store;
      store.query("DROP TRIGGER recon_sessions_frozen_update").run();
      store.query("UPDATE recon_sessions SET book_revision='99999' WHERE id=?").run(done.record.id);
      const behind = await other.owner.call("reconcile.report", { id: done.record.id });
      expect(behind.status).toBe(409);
      expect(behind.body.error.code).toBe("reconcile_report_unavailable");
      expect(behind.body.error.message).toMatch(/revision 99999/);
    } finally {
      await other.close();
    }
  });

  test("a reconciliation that says it continues from one that is not there is not reported on", async () => {
    const other = await monthBook();
    try {
      const first = await reconcileTo(other.owner, "1000", "2026-03-06");
      other.advance();
      const second = await reconcileTo(other.owner, "1000", "2026-03-10");
      const store = other.world.service.store;
      store.query("DROP TRIGGER recon_sessions_frozen_update").run();
      store
        .query("UPDATE recon_sessions SET record_hash='" + "0".repeat(64) + "' WHERE id=?")
        .run(first.record.id);
      const damaged = await other.owner.call("reconcile.report", { id: second.record.id });
      expect(damaged.status).toBe(409);
      expect(damaged.body.error.code).toBe("reconcile_report_mismatch");
      expect(damaged.body.error.message).toMatch(/continues from/);
    } finally {
      await other.close();
    }
  });
});
