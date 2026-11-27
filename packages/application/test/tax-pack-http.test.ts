import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ingestPort } from "../src/slices/ingest/port.ts";
import { batchOf } from "./support/ingest-fixture.ts";
import { cleanUpTax, type Json, taxFixture, type TaxFixture } from "./tax-support.ts";

afterEach(cleanUpTax);

/** A sole proprietor's 2025 on the real template: a few entries, posted the way a person posts. */
async function year2025(): Promise<TaxFixture> {
  const f = await taxFixture({ today: "2026-03-01" });
  await f.setupFromTemplate({ templateId: "sole-proprietor", basis: "cash", taxYear: 2025 });
  await f.post(
    "2025-01-10",
    [
      ["1000", "20000.00", ""],
      ["3000", "", "20000.00"],
    ],
    "Owner investment",
  );
  await f.post(
    "2025-02-10",
    [
      ["1000", "4000.00", ""],
      ["4000", "", "4000.00"],
    ],
    "Design work",
  );
  await f.post(
    "2025-05-10",
    [
      ["6170", "85.50", ""],
      ["1000", "", "85.50"],
    ],
    "Lunch with a client",
  );
  await f.post(
    "2025-08-10",
    [
      ["5000", "900.00", ""],
      ["1000", "", "900.00"],
    ],
    "Stock bought",
  );
  return f;
}

const check = (data: Json, key: string) => {
  const found = data.checks.find((item: Json) => item.key === key);
  if (!found) throw new Error(`No check ${key}`);
  return found;
};

describe("taxChecks.get", () => {
  test("says what is worth a look, in words, and where to fix it", async () => {
    const f = await year2025();
    const result = await f.call("taxChecks.get", { taxYear: 2025 });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const data = result.body.data;
    // 2025 is over and none of its months is closed.
    expect(check(data, "periods")).toMatchObject({ status: "attention", href: "/periods" });
    expect(check(data, "periods").detail).toContain("12 of 12 periods that have ended");
    expect(check(data, "periods").count).toBe(12);
    expect(check(data, "inbox").status).toBe("ok");
    // The template tags the bank accounts as cash, and none has been reconciled.
    expect(check(data, "reconcile")).toMatchObject({ status: "attention", href: "/reconcile" });
    expect(check(data, "reconcile").detail).toContain("never");
    expect(check(data, "unmapped").status).toBe("ok");
    // The periods, the reconciliations, the 1099 list (no account is marked yet) and sales tax (no
    // account is tagged tax.sales): the last two could not be checked, which is never "ok".
    expect(check(data, "vendors").status).toBe("unknown");
    expect(check(data, "sales")).toMatchObject({ status: "unknown", href: "/accounts" });
    expect(data.attention).toBe(4);
    expect(data.checks.map((item: Json) => item.key)).not.toContain("draft");
  });

  test("a closed year is ok, and an IRS draft form is said to be one", async () => {
    const f = await taxFixture({ today: "2027-02-01" });
    await f.setupFromTemplate({ templateId: "sole-proprietor", basis: "cash", taxYear: 2026 });
    await f.post(
      "2026-02-10",
      [
        ["1000", "4000.00", ""],
        ["4000", "", "4000.00"],
      ],
      "Design work",
    );
    const id = crypto.randomUUID();
    const plan = await f.call("periods.yearEnd", { fiscalYear: 2026, reason: "Reviewed" }, id);
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    const closed = await f.call(
      "periods.commitYearEnd",
      {
        planId: plan.body.data.planId,
        planHash: plan.body.data.planHash,
      },
      crypto.randomUUID(),
    );
    expect(closed.body.data.disposition, JSON.stringify(closed.body)).toBe("committed");
    const data = (await f.call("taxChecks.get", { taxYear: 2026 })).body.data;
    expect(check(data, "periods").status).toBe("ok");
    expect(check(data, "draft")).toMatchObject({ status: "attention" });
    expect(check(data, "draft").detail).toContain("IRS early-release draft");
  });

  test("lines dated in the range and still in the Inbox are counted, and a year in progress is said to be", async () => {
    const f = await taxFixture({ today: "2026-10-04" });
    await f.setupFromTemplate({ templateId: "sole-proprietor", basis: "cash", taxYear: 2026 });
    const port = ingestPort(f.service);
    port.submit(
      batchOf(
        port,
        [
          { date: "2026-03-05", amount: "-40.00", description: "Coffee", providerId: "t1" },
          { date: "2026-03-06", amount: "-60.00", description: "Paper", providerId: "t2" },
          { date: "2025-12-30", amount: "-10.00", description: "Last year", providerId: "t3" },
        ],
        { ledgerAccountId: "1000" },
      ),
    );
    const data = (await f.call("taxChecks.get", { taxYear: 2026 })).body.data;
    expect(check(data, "inbox")).toMatchObject({ status: "attention", href: "/inbox" });
    expect(check(data, "inbox").detail).toContain(
      "2 lines dated in this range are still in the Inbox",
    );
    // The number is data as well as words, so a screen can say it in its own words.
    expect(check(data, "inbox").count).toBe(2);
    expect(check(data, "year_not_ended").status).toBe("attention");
    // The 2025 line is outside the 2026 range, so it is not counted.
    expect(check(data, "inbox").detail).not.toContain("3 lines");
  });

  test("refuses an unverified year and a caller without permission", async () => {
    const f = await year2025();
    expect((await f.call("taxChecks.get", { taxYear: 2019 })).body.error.code).toBe(
      "tax_year_unsupported",
    );
    expect((await f.call("taxChecks.get", { taxYear: 2025 }, undefined, [])).status).toBe(403);
  });
});

describe("taxSummary.get", () => {
  test("is the checks for a year the person did not have to choose, with the years that were verified", async () => {
    const f = await year2025();
    const summary = (await f.call("taxSummary.get", {})).body.data;
    // The clock is in 2026 but the book's calendar is 2025: the year read is the one the book covers,
    // and the verified years are listed.
    expect(summary.years).toEqual([2025, 2026]);
    expect(summary.taxYear).toBe(2025);
    expect(summary.from).toBe("2025-01-01");
    expect(summary.to).toBe("2025-12-31");
    expect(summary.form).toMatchObject({ id: "scheduleC", status: "final" });
    expect(summary.disclaimer).toContain("does not give tax advice");
    expect(summary.attention).toBe(
      summary.checks.filter((item: Json) => item.status !== "ok").length,
    );
    // The same checks as asking for the year by name, to the word.
    const checks = (await f.call("taxChecks.get", { taxYear: 2025 })).body.data;
    expect(summary.checks).toEqual(checks.checks);
    expect(summary.attention).toBe(checks.attention);
    expect(summary.bookRevision).toBe(checks.bookRevision);
    expect((await f.call("taxSummary.get", { taxYear: 2025 })).body.data).toEqual(summary);
  });

  test("keeps the default year inside the years that were verified and the calendar the book has", async () => {
    // The clock before the verified years: the first one the calendar covers.
    const early = await taxFixture({ today: "2024-06-01" });
    await early.setupFromTemplate({ templateId: "sole-proprietor", basis: "cash", taxYear: 2025 });
    expect((await early.call("taxSummary.get", {})).body.data.taxYear).toBe(2025);
    // The clock after them: the last one the calendar covers.
    const late = await taxFixture({ today: "2028-02-01" });
    await late.setupFromTemplate({ templateId: "sole-proprietor", basis: "cash", taxYear: 2026 });
    expect((await late.call("taxSummary.get", {})).body.data.taxYear).toBe(2026);
    // A calendar that covers no verified year is said, with what to do, not read as another year.
    const uncovered = await taxFixture({ today: "2026-02-01" });
    await uncovered.setupFromTemplate({
      templateId: "sole-proprietor",
      basis: "cash",
      taxYear: 2025,
      fiscalYear: 2024,
    });
    const gap = await uncovered.call("taxSummary.get", {});
    expect(gap.status).toBe(409);
    expect(gap.body.error.code).toBe("calendar_not_configured");
  });

  test("refuses a year that was not verified, and needs only read permission", async () => {
    const f = await year2025();
    const refused = await f.call("taxSummary.get", { taxYear: 2024 });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe("tax_year_unsupported");
    expect((await f.call("taxSummary.get", {}, undefined, [])).status).toBe(403);
    expect((await f.call("taxSummary.get", {}, undefined, ["read"])).status).toBe(200);
  });
});

describe("taxPack.build", () => {
  test("returns the files, the manifest and the checks, tied to the same populations as the reports", async () => {
    const f = await year2025();
    const result = await f.call("taxPack.build", { taxYear: 2025 });
    expect(result.status, JSON.stringify(result.body).slice(0, 400)).toBe(200);
    const pack = result.body.data;
    expect(pack.format).toBe("rastrata-year-end-pack-v1");
    expect(pack.folder).toBe("rastrata-year-end-2025");
    const paths = pack.files.map((file: Json) => file.path);
    expect(paths).toEqual([
      "README.md",
      "statements/profit-and-loss.csv",
      "statements/balance-sheet.csv",
      "statements/cash-flow.csv",
      "statements/trial-balance.csv",
      "statements/general-ledger.csv",
      "tax/schedule-c-worksheet.csv",
      "tax/schedule-c-accounts.csv",
      "tax/schedule-c-postings.csv",
      "tax/1099-vendors.csv",
      "tax/1099-payments.csv",
      "manifest.json",
    ]);
    const reports = (await f.call("reports.get", { asOf: "2025-12-31", from: "2025-01-01" })).body
      .data;
    expect(pack.ledgerPopulationHash).toBe(reports.populationHash);
    const worksheet = (await f.call("taxWorksheet.get", { taxYear: 2025 })).body.data;
    expect(pack.worksheetPopulationHash).toBe(worksheet.populationHash);
    expect(pack.tagMapHash).toBe(worksheet.tagMapHash);
    for (const file of pack.files as { path: string; sha256: string; content: string }[])
      expect(file.sha256, file.path).toBe(createHash("sha256").update(file.content).digest("hex"));
    expect(pack.manifestSha256).toBe(pack.files.at(-1).sha256);
    // The README carries what the checks said.
    const readme = pack.files[0].content;
    expect(readme).toContain("Periods closed");
    expect(readme).toContain("12 of 12 periods");
    expect(pack.checks.map((item: Json) => item.key)).toEqual([
      "periods",
      "inbox",
      "reconcile",
      "unmapped",
      "vendors",
      "sales",
    ]);
    expect(pack.disclaimer).toContain("does not give tax advice");
  });

  test("builds the same bytes again from the same book, and different ones after the book changes", async () => {
    const f = await year2025();
    const first = (await f.call("taxPack.build", { taxYear: 2025 })).body.data;
    const again = (await f.call("taxPack.build", { taxYear: 2025 })).body.data;
    expect(again.files.map((file: Json) => file.sha256)).toEqual(
      first.files.map((file: Json) => file.sha256),
    );
    await f.post(
      "2025-09-10",
      [
        ["6000", "50.00", ""],
        ["1000", "", "50.00"],
      ],
      "Ads",
    );
    const changed = (await f.call("taxPack.build", { taxYear: 2025 })).body.data;
    expect(changed.manifestSha256).not.toBe(first.manifestSha256);
    // A pinned revision rebuilds the first pack exactly.
    const pinned = (await f.call("taxPack.build", { taxYear: 2025, revision: first.bookRevision }))
      .body.data;
    expect(pinned.manifestSha256).toBe(first.manifestSha256);
  });

  test("refuses a year the book's calendar does not cover, and a missing permission", async () => {
    const f = await year2025();
    const outside = await f.call("taxPack.build", { taxYear: 2026 });
    expect(outside.status).toBe(409);
    expect(outside.body.error.code).toBe("calendar_not_configured");
    expect((await f.call("taxPack.build", { taxYear: 2025 }, undefined, [])).status).toBe(403);
  });
});
