import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanUpTax, type Json, type TaxFixture, taxFixture } from "./tax-support.ts";

afterEach(cleanUpTax);

const uuid = () => crypto.randomUUID();

/** A sole proprietor's 2026 on the real template with a clock in February 2027, so the year has ended. */
async function book(): Promise<TaxFixture> {
  const f = await taxFixture({ today: "2027-02-10" });
  await f.setupFromTemplate({ templateId: "sole-proprietor", basis: "cash", taxYear: 2026 });
  await f.post(
    "2026-01-15",
    [
      ["1000", "20000.00", ""],
      ["3000", "", "20000.00"],
    ],
    "Owner investment",
  );
  await f.post(
    "2026-03-10",
    [
      ["1000", "300.00", ""],
      ["4000", "", "300.00"],
    ],
    "Design work",
  );
  return f;
}

/** The calendar lane's own account of the periods: the figures every expectation here is read from, so
 * the tie-in is checked against the source of the closes and not against this lane's reading of them. */
async function periods(f: TaxFixture): Promise<Json[]> {
  return (await act(f, "periods.list", {})).periods;
}

/** Close the whole fiscal year the way the Periods screen does: prepare the year-end, commit the plan. */
async function closeYear(f: TaxFixture): Promise<void> {
  const plan = await act(f, "periods.yearEnd", { fiscalYear: 2026, reason: "Reviewed" }, uuid());
  const done = await act(
    f,
    "periods.commitYearEnd",
    { planId: plan.planId, planHash: plan.planHash },
    uuid(),
  );
  expect(done.disposition, JSON.stringify(done)).toBe("committed");
}

/** Reopen one period; the closes of every later period are superseded and they stay locked. */
async function reopen(f: TaxFixture, periodId: string): Promise<void> {
  const planId = uuid();
  const plan = await act(
    f,
    "periods.prepare",
    { periodId, operation: "reopen", reason: "A correction" },
    planId,
  );
  const done = await act(f, "operations.commit", { planId, planHash: plan.planHash });
  expect(done.disposition, JSON.stringify(done)).toBe("committed");
}

const check = (data: Json, key: string) => data.checks.find((item: Json) => item.key === key);
const manifestOf = (pack: Json) =>
  JSON.parse(pack.files.find((file: Json) => file.path === "manifest.json").content);
const readmeOf = (pack: Json): string =>
  pack.files.find((file: Json) => file.path === "README.md").content;

describe("a year that is not closed", () => {
  test("is said plainly in the pack, its manifest and the checks", async () => {
    const f = await book();
    const pack = await act(f, "taxPack.build", { taxYear: 2026 });
    expect(pack.close).toMatchObject({
      state: "open",
      periods: 12,
      closed: 0,
      superseded: 0,
      open: 12,
      last: null,
    });
    expect(pack.close.statement).toContain("No period in this range is closed");
    expect(pack.close.statement).toContain(`book revision ${pack.bookRevision}`);
    expect(readmeOf(pack)).toContain("## How final it is");
    expect(readmeOf(pack)).toContain(pack.close.statement);
    expect(manifestOf(pack).close).toMatchObject({ state: "open", closed: 0, last: null });
    const checks = await act(f, "taxChecks.get", { taxYear: 2026 });
    expect(check(checks, "periods")).toMatchObject({ status: "attention", href: "/periods" });
    expect(check(checks, "periods").detail).toContain("12 of 12 periods that have ended");
  });
});

describe("a year that is closed", () => {
  test("ties the pack to the last current close: its revision and its report population hash", async () => {
    const f = await book();
    const before = await act(f, "taxPack.build", { taxYear: 2026 });
    await closeYear(f);
    const list = await periods(f);
    const december = list.at(-1) as Json;
    expect(
      list.every((period: Json) => period.status === "closed" && !period.closeSuperseded),
    ).toBe(true);
    // The calendar lane's own figures for the last close.
    expect(december.closingRevision).toMatch(/^[0-9]+$/);
    expect(december.reportPopulationHash).toMatch(/^[0-9a-f]{64}$/);

    const pack = await act(f, "taxPack.build", { taxYear: 2026 });
    expect(pack.close).toMatchObject({
      state: "closed",
      periods: 12,
      closed: 12,
      superseded: 0,
      open: 0,
      last: {
        periodId: december.id,
        startsOn: december.startsOn,
        endsOn: december.endsOn,
        closingRevision: december.closingRevision,
        reportPopulationHash: december.reportPopulationHash,
      },
    });
    expect(pack.close.statement).toContain(`book revision ${december.closingRevision}`);
    expect(pack.close.statement).toContain(december.reportPopulationHash);
    expect(pack.close.statement).toContain(
      "Every period in this range is closed with a current close",
    );
    // The pack was built after the close, from a later revision, and says so.
    expect(Number(pack.bookRevision)).toBeGreaterThanOrEqual(Number(december.closingRevision));
    // It is in the README and in the manifest, which is what an accountant or a verifier reads.
    expect(readmeOf(pack)).toContain(pack.close.statement);
    const manifest = manifestOf(pack);
    expect(manifest.close.state).toBe("closed");
    expect(manifest.close.last).toEqual({
      periodId: december.id,
      label: december.label,
      startsOn: december.startsOn,
      endsOn: december.endsOn,
      closingRevision: december.closingRevision,
      reportPopulationHash: december.reportPopulationHash,
    });
    // The readiness check says the same, with the revision.
    const checks = await act(f, "taxChecks.get", { taxYear: 2026 });
    expect(check(checks, "periods").status).toBe("ok");
    expect(check(checks, "periods").detail).toContain(
      `recorded at book revision ${december.closingRevision}`,
    );
    // The same book before the close is not the same pack, and a pinned revision rebuilds the earlier one.
    expect(pack.manifestSha256).not.toBe(before.manifestSha256);
    const pinned = await act(f, "taxPack.build", { taxYear: 2026, revision: before.bookRevision });
    expect(pinned.manifestSha256).toBe(before.manifestSha256);
    expect(pinned.close.state).toBe("open");
  });

  test("the accountant pack says the same, from the same close", async () => {
    const f = await book();
    await closeYear(f);
    const december = (await periods(f)).at(-1) as Json;
    const year = await act(f, "taxPack.build", { taxYear: 2026 });
    const accountant = await act(f, "taxAccountant.build", { taxYear: 2026 });
    expect(accountant.close).toEqual(year.close);
    expect(accountant.close.last.closingRevision).toBe(december.closingRevision);
    expect(readmeOf(accountant)).toContain("## How final it is");
    expect(readmeOf(accountant)).toContain(accountant.close.statement);
    expect(manifestOf(accountant).close.last.reportPopulationHash).toBe(
      december.reportPopulationHash,
    );
  });
});

describe("a year whose closes were superseded by a reopening", () => {
  test("says which periods are open and which are locked with a close that no longer describes the books", async () => {
    const f = await book();
    await closeYear(f);
    const list = await periods(f);
    const march = list[2] as Json;
    await reopen(f, march.id);
    const after = await periods(f);
    // The calendar lane's own account: March is open, the later periods are locked with a superseded
    // close, January and February keep their current closes.
    const superseded = after.filter((period: Json) => period.closeSuperseded);
    expect(after.filter((period: Json) => period.status === "open").map((p: Json) => p.id)).toEqual(
      [march.id],
    );
    expect(superseded).toHaveLength(9);

    const pack = await act(f, "taxPack.build", { taxYear: 2026 });
    expect(pack.close).toMatchObject({
      state: "partly_closed",
      periods: 12,
      closed: 2,
      superseded: 9,
      open: 1,
    });
    // The last current close is February's, not December's: December's no longer describes the books.
    expect(pack.close.last.periodId).toBe((after[1] as Json).id);
    expect(pack.close.last.closingRevision).toBe((after[1] as Json).closingRevision);
    expect(pack.close.statement).toContain("2 of 12 periods");
    expect(pack.close.statement).toContain("1 is open");
    expect(pack.close.statement).toContain("9 are locked but their closes were superseded");
    expect(pack.close.statement).toContain("closing again");
    expect(readmeOf(pack)).toContain(pack.close.statement);
    expect(manifestOf(pack).close).toMatchObject({
      state: "partly_closed",
      superseded: 9,
      open: 1,
    });

    const checks = await act(f, "taxChecks.get", { taxYear: 2026 });
    const periodsCheck = check(checks, "periods");
    expect(periodsCheck.status).toBe("attention");
    expect(periodsCheck.href).toBe("/periods");
    expect(periodsCheck.detail).toContain(
      "1 of 12 periods that have ended in this range is not closed",
    );
    expect(periodsCheck.detail).toContain("9 periods are locked but their closes were superseded");
  });

  test("an entry dated in a locked period is a warning whether or not its close is current, and not in an open one", async () => {
    const f = await book();
    await closeYear(f);
    const list = await periods(f);
    await reopen(f, (list[2] as Json).id);
    const line = (date: string, id: string) =>
      `${id},${date},A correction,6080,10.00,\r\n${id},${date},A correction,1000,,10.00`;
    const csv = [
      "Entry,Date,Narration,Account,Debit,Credit",
      line("2026-01-20", "IN-JAN"),
      line("2026-03-20", "IN-MAR"),
      line("2026-06-20", "IN-JUN"),
    ].join("\r\n");
    const preview = await act(f, "taxAdjustments.preview", { csv });
    const warned = (id: string) =>
      preview.entries
        .find((entry: Json) => entry.entry === id)
        .problems.map((problem: Json) => problem.code);
    // January keeps a current close and June's was superseded: both are locked, so both are said.
    expect(warned("IN-JAN")).toEqual(["date_in_closed_period"]);
    expect(warned("IN-JUN")).toEqual(["date_in_closed_period"]);
    // March was reopened: it takes postings again.
    expect(warned("IN-MAR")).toEqual([]);
    expect(preview.canImport).toBe(true);
  });
});
