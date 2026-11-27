import { afterEach, describe, expect, test } from "bun:test";
import { cleanUpTax, type Json, taxFixture, type TaxFixture } from "./tax-support.ts";

afterEach(cleanUpTax);

/** A sole proprietor's year on the real chart template, posted the way a person posts. */
async function year2025(
  extra: readonly (readonly [code: string, name: string, role: string])[] = [],
): Promise<TaxFixture> {
  const f = await taxFixture({ today: "2026-03-01" });
  await f.setupFromTemplate({ templateId: "sole-proprietor", basis: "cash", taxYear: 2025 });
  // Accounts added to the chart must take effect before the first entry, so they come first.
  for (const [code, name, role] of extra) await f.addAccount(code, name, role, "2025-01-01");
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
    "2025-03-10",
    [
      ["4100", "150.00", ""],
      ["1000", "", "150.00"],
    ],
    "Refund to a client",
  );
  await f.post(
    "2025-04-10",
    [
      ["6000", "400.00", ""],
      ["2000", "", "400.00"],
    ],
    "Ads on the card",
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
    "2025-06-10",
    [
      ["6200", "120.00", ""],
      ["2000", "", "120.00"],
    ],
    "Software",
  );
  await f.post(
    "2025-07-10",
    [
      ["6070", "25.00", ""],
      ["1000", "", "25.00"],
    ],
    "Loan interest",
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

const lineOf = (data: Json, key: string) => {
  for (const part of data.parts) for (const line of part.lines) if (line.key === key) return line;
  throw new Error(`No line ${key}`);
};

describe("taxWorksheet.get on a book set up from the Schedule C template", () => {
  test("totals the tagged accounts by line, applies the meals limit and reconciles", async () => {
    const f = await year2025();
    const result = await f.call("taxWorksheet.get", { taxYear: 2025 });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const data = result.body.data;
    expect(data.form.id).toBe("scheduleC");
    expect(data.form.status).toBe("final");
    expect(data.from).toBe("2025-01-01");
    expect(data.to).toBe("2025-12-31");
    expect(data.basis).toBe("cash");
    expect(lineOf(data, "scheduleC.line1").amount).toBe("4000.00");
    expect(lineOf(data, "scheduleC.line2").amount).toBe("150.00");
    expect(lineOf(data, "scheduleC.line8").amount).toBe("400.00");
    expect(lineOf(data, "scheduleC.line27b").amount).toBe("120.00");
    expect(lineOf(data, "scheduleC.line16b").amount).toBe("25.00");
    expect(lineOf(data, "scheduleC.line36").amount).toBe("900.00");
    // 50% of 85.50 is exactly 42.75.
    expect(lineOf(data, "scheduleC.line24b").booked).toBe("85.50");
    expect(lineOf(data, "scheduleC.line24b").amount).toBe("42.75");
    expect(lineOf(data, "scheduleC.line28").amount).toBe("587.75");
    // 4000 - 150 - 900 = 2950 gross income; less 587.75 = 2362.25.
    expect(lineOf(data, "scheduleC.line7").amount).toBe("2950.00");
    expect(lineOf(data, "scheduleC.line31").amount).toBe("2362.25");
    expect(data.unmapped).toEqual([]);
    // Net income per the profit and loss: 4000 - 150 - 900 - 400 - 85.50 - 120 - 25 = 2319.50.
    expect(data.reconciliation.netIncomeBooks).toBe("2319.50");
    expect(data.reconciliation.ties).toBe(true);
    expect(data.notes.map((note: Json) => note.key)).toContain("meals");
    expect(data.disclaimer).toContain("not tax advice");
  });

  test("an account with activity and no tax line is listed as not mapped, with its amount", async () => {
    const f = await year2025([["6999", "Odd expense", "expense"]]);
    await f.post(
      "2025-09-10",
      [
        ["6999", "33.00", ""],
        ["1000", "", "33.00"],
      ],
      "Something unclassified",
    );
    const result = await f.call("taxWorksheet.get", { taxYear: 2025 });
    const data = result.body.data;
    expect(data.unmapped).toEqual([
      expect.objectContaining({
        code: "6999",
        reason: "no_tax_line",
        amount: "33.00",
        taxLine: null,
      }),
    ]);
    expect(data.unmappedExpenses).toBe("33.00");
    expect(data.warnings.map((warning: Json) => warning.code)).toContain("unmapped_accounts");
    // Still ties: the net as booked, plus the unmapped expense taken out, is the profit and loss.
    expect(data.reconciliation.netIncomeBooks).toBe("2286.50");
    expect(data.reconciliation.ties).toBe(true);
    const rows = data.reconciliation.rows as { key: string; amount: string }[];
    expect(rows.map((row) => row.key)).toEqual([
      "netProfit",
      "meals",
      "unmappedIncome",
      "unmappedExpenses",
    ]);
    expect(rows.find((row) => row.key === "unmappedExpenses")?.amount).toBe("-33.00");
  });

  test("a tag changed from a date splits the account's postings at that date, and a pinned tags revision reproduces the old worksheet", async () => {
    const f = await year2025();
    const before = (await f.call("taxWorksheet.get", { taxYear: 2025 })).body.data;
    expect(lineOf(before, "scheduleC.line27b").amount).toBe("120.00");
    const change = await f.call(
      "accounts.setTags",
      { accountId: "6200", effectiveOn: "2025-07-01", tags: { taxLine: "scheduleC.line18" } },
      crypto.randomUUID(),
    );
    expect(change.status, JSON.stringify(change.body)).toBe(200);
    await f.post(
      "2025-09-20",
      [
        ["6200", "60.00", ""],
        ["2000", "", "60.00"],
      ],
      "More software",
    );
    const after = (await f.call("taxWorksheet.get", { taxYear: 2025 })).body.data;
    // The June posting was before the change; the September one is after it.
    expect(lineOf(after, "scheduleC.line27b").amount).toBe("120.00");
    expect(lineOf(after, "scheduleC.line18").amount).toBe("60.00");
    expect(after.populationHash).not.toBe(before.populationHash);
    expect(after.tagMapHash).not.toBe(before.tagMapHash);
    const pinned = (
      await f.call("taxWorksheet.get", { taxYear: 2025, tagsRevision: before.tagsRevision })
    ).body.data;
    // The tags as they were: the September posting is on line 27b again (and the book has moved on).
    expect(lineOf(pinned, "scheduleC.line27b").amount).toBe("180.00");
    expect(pinned.tagMapHash).toBe(before.tagMapHash);
    // The book as it was, with the tags as they were, is the first worksheet to the hash.
    const original = (
      await f.call("taxWorksheet.get", {
        taxYear: 2025,
        tagsRevision: before.tagsRevision,
        revision: before.bookRevision,
      })
    ).body.data;
    expect(original.populationHash).toBe(before.populationHash);
  });

  test("its population is the report population, so an amount drills through to the account activity", async () => {
    const f = await year2025();
    const data = (await f.call("taxWorksheet.get", { taxYear: 2025 })).body.data;
    const reports = (await f.call("reports.get", { asOf: "2025-12-31", from: "2025-01-01" })).body
      .data;
    expect(data.ledgerPopulationHash).toBe(reports.populationHash);
    const account = lineOf(data, "scheduleC.line8").accounts[0];
    const activity = await f.call("activity.get", {
      accountId: account.accountId,
      asOf: data.to,
      populationHash: data.ledgerPopulationHash,
      from: account.from,
      to: account.to,
      reportFrom: data.from,
    });
    expect(activity.status, JSON.stringify(activity.body)).toBe(200);
    expect(activity.body.data.netChange).toBe("400.00");
  });

  test("refuses an unverified tax year, a bad range and a missing permission, with a code that says why", async () => {
    const f = await year2025();
    const unsupported = await f.call("taxWorksheet.get", { taxYear: 2024 });
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.error.code).toBe("tax_year_unsupported");
    const backwards = await f.call("taxWorksheet.get", {
      taxYear: 2025,
      from: "2025-06-01",
      to: "2025-05-01",
    });
    expect(backwards.body.error.code).toBe("invalid_input");
    const notADate = await f.call("taxWorksheet.get", { taxYear: 2025, to: "2025-02-30" });
    expect(notADate.body.error.code).toBe("invalid_input");
    const denied = await f.call("taxWorksheet.get", { taxYear: 2025 }, undefined, []);
    expect(denied.status).toBe(403);
    // 2026 is a supported tax year but the book's calendar covers only 2025.
    const outside = await f.call("taxWorksheet.get", { taxYear: 2026 });
    expect(outside.status).toBe(409);
    expect(outside.body.error.code).toBe("calendar_not_configured");
    const percent = await f.call("taxWorksheet.get", { taxYear: 2025, mealsPercent: 101 });
    expect(percent.status).toBe(400);
  });
});

describe("taxWorksheet.export", () => {
  test("renders the three files, headed by what they were built from, with text neutralised", async () => {
    const f = await year2025([["6998", "=1+1 injected", "expense"]]);
    await f.post(
      "2025-10-10",
      [
        ["6998", "10.00", ""],
        ["1000", "", "10.00"],
      ],
      "@evil memo",
    );
    const worksheet = (await f.call("taxWorksheet.get", { taxYear: 2025 })).body.data;
    const sheet = (await f.call("taxWorksheet.export", { taxYear: 2025 })).body.data;
    expect(sheet.filename).toBe("schedule-c-worksheet-2025.csv");
    expect(sheet.mediaType).toBe("text/csv; charset=utf-8");
    expect(sheet.populationHash).toBe(worksheet.populationHash);
    expect(sheet.content).toContain(`Population hash,${worksheet.populationHash}`);
    expect(sheet.content).toContain("Fixture Studio");
    const accounts = (await f.call("taxWorksheet.export", { taxYear: 2025, file: "accounts" })).body
      .data;
    expect(accounts.filename).toBe("schedule-c-accounts-2025.csv");
    expect(accounts.content).toContain("'=1+1 injected");
    const postings = (await f.call("taxWorksheet.export", { taxYear: 2025, file: "postings" })).body
      .data;
    expect(postings.content).toContain("'@evil memo");
    expect(postings.content).not.toMatch(/\r\n[=+@]/);
  });
});
