import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeDurableBook } from "@rastrata/kernel";
import { LocalBookService } from "../src/local.ts";
import type { BookSetup } from "../src/contracts.ts";

const setup: BookSetup = {
  name: "Example Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Cash", role: "asset" },
    { code: "3000", name: "Owner capital", role: "equity" },
    { code: "4000", name: "Revenue", role: "income" },
    { code: "5000", name: "Expense", role: "expense" },
  ],
};

test("local book setup provisions a real authorized ledger and survives restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-local-book-"));
  const path = join(directory, "local.sqlite");
  let service: LocalBookService | undefined;
  try {
    service = await LocalBookService.open(path);
    expect(service.setupState()).toBeNull();
    const receipt = await service.setup(setup);
    expect(receipt.outcomeSequence).toBe("1");
    // The calendar's last year is recorded with the setup: the year the book was created in.
    expect(service.setupState()).toEqual({
      ...setup,
      basis: "accrual",
      fiscalYearStartMonth: 1,
      calendarThrough: expect.any(Number),
    });
    const page = await service.outcomePage();
    expect(page.outcomes.length).toBe(1);
    const decoded = decodeDurableBook(page.genesis);
    expect(decoded.disposition).toBe("decoded");
    if (decoded.disposition === "decoded") {
      expect(decoded.aggregate.state.admissionSnapshot.accounts).toHaveLength(4);
      expect(decoded.aggregate.state.periods).toHaveLength(12);
    }
    expect((await service.readAggregate()).aggregate.state.status).toBe("open");
    const empty = await service.reports("2026-01-31");
    expect(empty.trialBalance.debit).toBe("0.00");
    expect(empty.profitAndLoss.netIncome).toBe("0.00");
    expect(empty.balanceSheet.balanced).toBe(true);
    const draft = service.createDraft({
      date: "2026-01-15",
      reference: "OPEN-1",
      narration: "Owner contribution",
      lines: [
        { accountId: "1000", debit: "1000.00", credit: "" },
        { accountId: "3000", debit: "", credit: "1000.00" },
      ],
    });
    expect(draft.status).toBe("draft");
    expect((await service.readAggregate()).aggregate.state.journals).toHaveLength(0);
    const posting = await service.postDraft(draft.id);
    expect(posting.disposition).toBe("committed");
    expect(service.draft(draft.id)?.status).toBe("posted");
    expect((await service.readAggregate()).aggregate.state.journals).toHaveLength(1);
    expect((await service.postDraft(draft.id)).outcomeSequence).toBe(posting.outcomeSequence);
    let expenseId = "";
    for (const [reference, accountId, cashDebit, amount] of [
      ["REV-1", "4000", true, "200.00"],
      ["EXP-1", "5000", false, "50.00"],
    ] as const) {
      const journal = service.createDraft({
        date: "2026-01-16",
        reference,
        narration: reference,
        lines: cashDebit
          ? [
              { accountId: "1000", debit: amount, credit: "" },
              { accountId, debit: "", credit: amount },
            ]
          : [
              { accountId, debit: amount, credit: "" },
              { accountId: "1000", debit: "", credit: amount },
            ],
      });
      if (reference === "EXP-1") expenseId = journal.id;
      expect((await service.postDraft(journal.id)).disposition).toBe("committed");
    }
    const reports = await service.reports("2026-01-31");
    expect(reports.trialBalance.balanced).toBe(true);
    expect(reports.trialBalance.debit).toBe("1200.00");
    expect(reports.trialBalance.credit).toBe("1200.00");
    expect(reports.trialBalance.rows.find((row) => row.code === "1000")?.signedBalance).toBe(
      "1150.00",
    );
    expect(reports.profitAndLoss.netIncome).toBe("150.00");
    expect(reports.balanceSheet.assets).toBe("1150.00");
    expect(reports.balanceSheet.equity).toBe("1150.00");
    expect(reports.populationHash).toMatch(/^[a-f0-9]{64}$/);
    const reversal = await service.reverseJournal({
      actionId: "9c622b2c-fca5-4f10-857d-2333b79258f5",
      journalId: expenseId,
      accountingDate: "2026-01-17",
      reason: "Expense entered in error",
    });
    expect(reversal.disposition).toBe("committed");
    const corrected = await service.reports("2026-01-31");
    expect(corrected.trialBalance.rows.find((row) => row.code === "1000")?.signedBalance).toBe(
      "1200.00",
    );
    expect(corrected.profitAndLoss.netIncome).toBe("200.00");
    expect((await service.readAggregate()).aggregate.state.corrections).toHaveLength(1);
    const pinnedActivity = {
      accountId: "1000",
      asOf: "2026-01-31",
      revision: BigInt(corrected.bookRevision),
      populationHash: corrected.populationHash,
      from: "2026-01-01",
      to: "2026-01-31",
      page: 1,
    };
    const activity = await service.accountActivity(pinnedActivity);
    expect(activity.count).toBe(4);
    expect(activity.openingBalance).toBe("0.00");
    expect(activity.closingBalance).toBe("1200.00");
    expect(activity.rows.at(-1)?.runningBalance).toBe("1200.00");
    expect(
      (
        await service.journalEntry(expenseId, pinnedActivity.revision, {
          asOf: pinnedActivity.asOf,
          populationHash: pinnedActivity.populationHash,
        })
      ).lines,
    ).toHaveLength(2);
    await expect(
      service.journalEntry(expenseId, pinnedActivity.revision, {
        asOf: pinnedActivity.asOf,
        populationHash: "wrong",
      }),
    ).rejects.toThrow("Report population has changed");
    expect(
      (
        await service.reverseJournal({
          actionId: "9c622b2c-fca5-4f10-857d-2333b79258f5",
          journalId: expenseId,
          accountingDate: "2026-01-17",
          reason: "Expense entered in error",
        })
      ).outcomeSequence,
    ).toBe(reversal.outcomeSequence);
    const accountChange = await service.createAccount({
      actionId: "2e70d3be-886d-4b69-a39c-11f5128b69f9",
      code: "1100",
      name: "Savings",
      role: "asset",
      effectiveOn: "2026-01-18",
    });
    expect(accountChange.disposition).toBe("committed");
    expect((await service.accounts()).accounts).toHaveLength(5);
    expect((await service.reports("2026-01-17")).trialBalance.rows).toHaveLength(4);
    expect((await service.accountActivity(pinnedActivity)).populationHash).toBe(
      corrected.populationHash,
    );
    expect(
      (
        await service.createAccount({
          actionId: "2e70d3be-886d-4b69-a39c-11f5128b69f9",
          code: "1100",
          name: "Savings",
          role: "asset",
          effectiveOn: "2026-01-18",
        })
      ).outcomeSequence,
    ).toBe(accountChange.outcomeSequence);
    await expect(
      service.createAccount({
        actionId: "2e70d3be-886d-4b69-a39c-11f5128b69f9",
        code: "1100",
        name: "Different name",
        role: "asset",
        effectiveOn: "2026-01-18",
      }),
    ).rejects.toThrow("different input");
    const changedAccount = await service.changeAccount({
      actionId: "f3372337-2e0d-4119-abd6-f7372ed7d103",
      accountId: "1100",
      name: "Reserve cash",
      close: true,
      effectiveOn: "2026-01-19",
    });
    expect(changedAccount.disposition).toBe("committed");
    expect(
      (await service.accounts()).accounts.find((account) => account.id === "1100"),
    ).toMatchObject({
      name: "Reserve cash",
      closedOn: "2026-01-19",
    });
    const historical = await service.reports("2026-01-18");
    const historicalAccount = await service.accountActivity({
      accountId: "1100",
      asOf: "2026-01-18",
      revision: BigInt(historical.bookRevision),
      populationHash: historical.populationHash,
      from: "2026-01-01",
      to: "2026-01-18",
      page: 1,
    });
    expect(historicalAccount.account.name).toBe("Savings");
    const beforeClose = await service.reports("2026-01-31");
    const close = await service.changePeriod({
      actionId: "57708289-688d-405d-8f81-c73c5e408bee",
      periodId: "period-01",
      operation: "close",
      reason: "January reviewed",
    });
    expect(close.disposition).toBe("committed");
    expect((await service.periods()).periods[0]?.status).toBe("closed");
    expect(
      (await service.readAggregate()).aggregate.state.closePackages[0]?.reportPopulationHash.digest,
    ).toBe(beforeClose.populationHash);
    expect(
      (await service.reports("2026-01-31", BigInt(beforeClose.bookRevision))).populationHash,
    ).toBe(beforeClose.populationHash);
    const closedDraft = service.createDraft({
      date: "2026-01-20",
      reference: "LATE-1",
      narration: "Late receipt",
      lines: [
        { accountId: "1000", debit: "10.00", credit: "" },
        { accountId: "4000", debit: "", credit: "10.00" },
      ],
    });
    const closedPosting = await service.postDraft(closedDraft.id);
    expect(closedPosting.disposition).toBe("rejected");
    expect(closedPosting.diagnostics.join(" ")).toMatch(/period|closed/i);
    const reopen = await service.changePeriod({
      actionId: "a7dcc351-8d43-47ae-9d0e-ae7171ab3ad2",
      periodId: "period-01",
      operation: "reopen",
      reason: "Late receipt found",
    });
    expect(reopen.disposition).toBe("committed");
    expect((await service.periods()).periods[0]?.status).toBe("open");
    const originalPostingId = service.draft(closedDraft.id)?.postingOperationId;
    if (!originalPostingId) throw new Error("Missing rejected posting identity");
    const recovered = await service.recoverDraft(
      closedDraft.id,
      closedDraft.version,
      originalPostingId,
      crypto.randomUUID(),
    );
    expect(recovered.version).toBe(2);
    expect((await service.postDraft(recovered.id)).disposition).toBe("committed");
    expect(service.draft(recovered.id)?.postingOperationId).not.toBe(originalPostingId);
    const originalOutcome = await service.operation(originalPostingId);
    expect(originalOutcome.disposition).toBe("rejected");
    expect(
      (await service.commitAction(originalPostingId, originalOutcome.planHash ?? ""))
        .outcomeSequence,
    ).toBe(closedPosting.outcomeSequence);
    expect(service.draft(recovered.id)?.status).toBe("posted");
    const changedReportHash = (await service.reports("2026-01-31")).populationHash;
    service.close();
    service = await LocalBookService.open(path);
    // The calendar's last year is recorded with the setup: the year the book was created in.
    expect(service.setupState()).toEqual({
      ...setup,
      basis: "accrual",
      fiscalYearStartMonth: 1,
      calendarThrough: expect.any(Number),
    });
    expect((await service.outcomePage()).outcomes).toHaveLength(11);
    expect((await service.readAggregate()).aggregate.state.journals).toHaveLength(5);
    expect((await service.reports("2026-01-31")).populationHash).toBe(changedReportHash);
    expect((await service.setup(setup)).outcomeSequence).toBe("1");
    await expect(service.setup({ ...setup, name: "Different Co" })).rejects.toThrow(
      "already configured",
    );
  } finally {
    service?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a response lost after durable posting retries the same sealed command after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-local-retry-"));
  const path = join(directory, "local.sqlite");
  let service: LocalBookService | undefined;
  try {
    service = await LocalBookService.open(path);
    await service.setup(setup);
    const draft = service.createDraft({
      date: "2026-01-15",
      reference: "RETRY-1",
      narration: "Retained posting",
      lines: [
        { accountId: "1000", debit: "10.00", credit: "" },
        { accountId: "3000", debit: "", credit: "10.00" },
      ],
    });
    const first = await service.postDraft(draft.id);
    expect(first.disposition).toBe("committed");
    service.close();
    service = undefined;
    const db = new Database(path);
    db.query("UPDATE app_drafts SET status='posting', outcome_sequence=NULL WHERE id=?").run(
      draft.id,
    );
    db.close();
    service = await LocalBookService.open(path);
    expect(service.draft(draft.id)?.status).toBe("posting");
    const replay = await service.postDraft(draft.id);
    expect(replay.disposition).toBe("committed");
    expect(replay.outcomeSequence).toBe(first.outcomeSequence);
    expect(service.draft(draft.id)?.status).toBe("posted");
    expect((await service.readAggregate()).aggregate.state.journals).toHaveLength(1);
  } finally {
    service?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("setup preserves the selected quarterly fiscal periods", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-local-quarterly-"));
  const service = await LocalBookService.open(join(directory, "local.sqlite"));
  try {
    await service.setup({ ...setup, periodModel: "quarterly" });
    const periods = (await service.periods()).periods;
    expect(periods).toHaveLength(4);
    expect(periods[0]).toMatchObject({ label: "Q1", startsOn: "2026-01-01", endsOn: "2026-03-31" });
    expect(periods[3]).toMatchObject({ label: "Q4", startsOn: "2026-10-01", endsOn: "2026-12-31" });
    expect((await service.reports("2026-06-30")).trialBalance.balanced).toBe(true);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("competing account changes retain one revision or chronology rejection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-local-race-"));
  const service = await LocalBookService.open(join(directory, "local.sqlite"));
  try {
    await service.setup(setup);
    const originalRead = service.readAggregate.bind(service);
    let arrivals = 0;
    let release: () => void = () => {};
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    service.readAggregate = async (revision?: bigint) => {
      const snapshot = await originalRead(revision);
      arrivals++;
      if (arrivals === 2) release();
      await bothRead;
      return snapshot;
    };
    const results = await Promise.all([
      service.createAccount({
        actionId: "0b07959c-1534-4c89-bad1-ac37eef7e247",
        code: "1100",
        name: "Savings",
        role: "asset",
        effectiveOn: "2026-01-01",
      }),
      service.createAccount({
        actionId: "5105a74d-bcb1-4079-94f8-b6c38e5b2b7d",
        code: "1200",
        name: "Receivables",
        role: "asset",
        effectiveOn: "2026-01-01",
      }),
    ]);
    service.readAggregate = originalRead;
    expect(results.map((result) => result.disposition).sort()).toEqual(["committed", "rejected"]);
    expect(
      results
        .find((result) => result.disposition === "rejected")
        ?.problems.some((problem) =>
          ["stale_book_revision", "temporal_semantics_violation"].includes(problem.code),
        ),
    ).toBe(true);
    expect((await service.accounts()).accounts).toHaveLength(5);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an inadmissible account retains a rejected outcome and a date outside the calendar is refused before the kernel", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-local-invalid-"));
  const service = await LocalBookService.open(join(directory, "local.sqlite"));
  try {
    await service.setup(setup);
    const line = (account: string) => [
      { accountId: account, debit: "1.00", credit: "" },
      { accountId: "3000", debit: "", credit: "1.00" },
    ];
    const rejected = service.createDraft({
      date: "2026-01-15",
      reference: "INVALID-nonexistent",
      narration: "Rejected candidate",
      lines: line("nonexistent"),
    });
    const outcome = await service.postDraft(rejected.id);
    expect(outcome.disposition).toBe("rejected");
    expect(outcome.diagnostics.length).toBeGreaterThan(0);
    expect(service.draft(rejected.id)?.status).toBe("rejected");
    // A date before the calendar never reaches the kernel: the error names the date and the covered
    // range, and the draft stays editable.
    const outside = service.createDraft({
      date: "2025-01-15",
      reference: "INVALID-date",
      narration: "Outside the calendar",
      lines: line("1000"),
    });
    await expect(service.postDraft(outside.id)).rejects.toMatchObject({
      code: "calendar_not_configured",
      status: 409,
    });
    expect(service.draft(outside.id)?.status).toBe("draft");
    expect((await service.readAggregate()).aggregate.state.journals).toHaveLength(0);
    expect((await service.reports("2026-01-31")).balanceSheet.assets).toBe("0.00");
    // A date after the calendar's end grows the calendar and posts.
    const later = service.createDraft({
      date: "2027-01-15",
      reference: "LATER",
      narration: "After the calendar",
      lines: line("1000"),
    });
    expect((await service.postDraft(later.id)).disposition).toBe("committed");
    expect((await service.periods()).calendar.lastDate).toBe("2027-12-31");
    expect((await service.readAggregate()).aggregate.state.journals).toHaveLength(1);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("posted journals, reports and account activity span server result pages", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-local-pages-"));
  const service = await LocalBookService.open(join(directory, "local.sqlite"));
  try {
    await service.setup(setup);
    const malformed = service.createDraft({
      date: "2026-01-15",
      reference: "BAD-1",
      narration: "Bad precision",
      lines: [
        { accountId: "1000", debit: "1.0", credit: "" },
        { accountId: "3000", debit: "", credit: "1.00" },
      ],
    });
    await expect(service.postDraft(malformed.id)).rejects.toThrow("two-decimal");
    expect(service.draft(malformed.id)?.status).toBe("draft");
    const balanced = service.saveDraft(malformed.id, malformed.version, {
      ...malformed.data,
      lines: [
        { accountId: "1000", debit: "1.00", credit: "" },
        { accountId: "3000", debit: "", credit: "2.00" },
      ],
    });
    expect(() => service.saveDraft(malformed.id, malformed.version, balanced.data)).toThrow(
      "Draft changed",
    );
    await expect(service.postDraft(malformed.id)).rejects.toThrow("must balance");
    service.discardDraft(malformed.id, balanced.version);
    for (let index = 0; index < 26; index++) {
      const draft = service.createDraft({
        date: "2026-01-15",
        reference: `BATCH-${String(index).padStart(2, "0")}`,
        narration: "Owner contribution",
        lines: [
          { accountId: "1000", debit: "1.00", credit: "" },
          { accountId: "3000", debit: "", credit: "1.00" },
        ],
      });
      expect((await service.postDraft(draft.id)).disposition).toBe("committed");
    }
    const first = await service.journalBook();
    const second = await service.journalBook({
      page: 2,
      text: "",
      from: "",
      to: "",
      accountId: "",
      status: "",
    });
    expect(first.count).toBe(26);
    expect(first.entries).toHaveLength(25);
    expect(second.entries).toHaveLength(1);
    expect(new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size).toBe(26);
    const filtered = await service.journalBook({
      page: 1,
      text: "BATCH-25",
      from: "2026-01-01",
      to: "2026-01-31",
      accountId: "1000",
      status: "Posted",
    });
    expect(filtered.count).toBe(1);
    expect(filtered.entries[0]?.reference).toBe("BATCH-25");
    const report = await service.reports("2026-01-31");
    expect(report.trialBalance.debit).toBe("26.00");
    expect(report.trialBalance.credit).toBe("26.00");
    const scope = {
      accountId: "1000",
      asOf: "2026-01-31",
      revision: BigInt(report.bookRevision),
      populationHash: report.populationHash,
      from: "2026-01-01",
      to: "2026-01-31",
    };
    const activityFirst = await service.accountActivity({ ...scope, page: 1 });
    const activitySecond = await service.accountActivity({ ...scope, page: 2 });
    expect(activityFirst.count).toBe(26);
    expect(activityFirst.rows).toHaveLength(25);
    expect(activitySecond.rows).toHaveLength(1);
    expect(activitySecond.closingBalance).toBe("26.00");
    const addedLater = service.createDraft({
      date: "2026-01-15",
      reference: "BATCH-LATER",
      narration: "Later owner contribution",
      lines: [
        { accountId: "1000", debit: "1.00", credit: "" },
        { accountId: "3000", debit: "", credit: "1.00" },
      ],
    });
    expect((await service.postDraft(addedLater.id)).disposition).toBe("committed");
    const pinnedSecond = await service.journalBook({
      page: 2,
      text: "",
      from: "",
      to: "",
      accountId: "",
      status: "",
      revision: BigInt(first.scope.revision),
    });
    expect(pinnedSecond.count).toBe(26);
    expect(pinnedSecond.entries.map((entry) => entry.id)).toEqual(
      second.entries.map((entry) => entry.id),
    );
    expect((await service.journalBook()).count).toBe(27);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
