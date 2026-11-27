import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationHttp } from "../src/http.ts";
import { createLegacyBookHandler } from "../src/legacy-http.ts";
import { LocalBookService } from "../src/local.ts";
import {
  APPLICATION_API_VERSION,
  BUSINESS_PERMISSIONS,
  type BusinessPermission,
} from "../src/schema.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

const book = {
  name: "October Cash Co",
  currency: "USD",
  fiscalYear: 2025,
  fiscalYearStartMonth: 10,
  basis: "cash",
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Operating cash", role: "asset", tags: { cashFlowClass: "cash" } },
    { code: "1100", name: "Equipment", role: "asset", tags: { cashFlowClass: "investing" } },
    { code: "2000", name: "Card balance", role: "liability", tags: { cashFlowClass: "operating" } },
    { code: "3000", name: "Owner capital", role: "equity", tags: { cashFlowClass: "financing" } },
    { code: "4000", name: "Sales", role: "income" },
    { code: "5000", name: "Supplies", role: "expense" },
  ],
};

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-reports-http-"));
  const service = await LocalBookService.open(join(directory, "book.sqlite"));
  const http = new ApplicationHttp(service, {
    bookId: service.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  cleanup.push(() => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const call = async (
    name: string,
    input: unknown = {},
    operationId?: string,
    permissions?: readonly BusinessPermission[],
  ) => {
    const target = permissions
      ? new ApplicationHttp(service, { bookId: service.bookId, permissions })
      : http;
    const response = await target.fetch(
      new Request(`http://127.0.0.1:4010/v1/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: "local-book",
          input,
          ...(operationId ? { operationId } : {}),
        }),
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  const post = async (
    date: string,
    lines: readonly (readonly [string, string, string])[],
    narration: string,
  ) => {
    const draft = await call(
      "drafts.create",
      {
        data: {
          date,
          reference: narration.slice(0, 40),
          narration,
          lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit, credit })),
        },
      },
      crypto.randomUUID(),
    );
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);
    const planId = crypto.randomUUID();
    const prepared = await call(
      "journal.prepare",
      { draftId: draft.body.data.id, expectedVersion: draft.body.data.version },
      planId,
    );
    const committed = await call("operations.commit", {
      planId,
      planHash: prepared.body.data.planHash,
    });
    expect(committed.body.data.disposition, JSON.stringify(committed.body)).toBe("committed");
  };
  return { call, post, service };
}

/** A year of an October cash book: contribution, sales, supplies, an equipment purchase, a card balance. */
async function seeded() {
  const f = await fixture();
  // One fiscal year, the calendar these tests describe, however late the clock is.
  const setup = { ...book, calendarThrough: book.fiscalYear };
  expect((await f.call("book.setup", setup, crypto.randomUUID())).body.ok).toBe(true);
  await f.post(
    "2025-10-05",
    [
      ["1000", "5000.00", ""],
      ["3000", "", "5000.00"],
    ],
    "Owner contribution",
  );
  await f.post(
    "2025-11-10",
    [
      ["1000", "1200.00", ""],
      ["4000", "", "1200.00"],
    ],
    "November sales",
  );
  await f.post(
    "2025-12-12",
    [
      ["5000", "300.00", ""],
      ["1000", "", "300.00"],
    ],
    "December supplies",
  );
  await f.post(
    "2026-01-20",
    [
      ["1100", "2000.00", ""],
      ["1000", "", "2000.00"],
    ],
    "Laptop",
  );
  await f.post(
    "2026-02-14",
    [
      ["5000", "80.00", ""],
      ["2000", "", "80.00"],
    ],
    "Supplies on the card",
  );
  await f.post(
    "2026-03-03",
    [
      ["1000", "900.00", ""],
      ["4000", "", "900.00"],
    ],
    "March sales",
  );
  return f;
}

describe("a cash-basis book with an October fiscal year, through the API", () => {
  test("capabilities and the calendar say what the book keeps", async () => {
    const f = await seeded();
    const capabilities = (await f.call("capabilities.get")).body.data;
    expect(capabilities.basis).toBe("cash");
    expect(capabilities.fiscalYearStartMonth).toBe(10);
    const calendar = (await f.call("reports.calendar")).body.data;
    expect(calendar).toEqual({
      currency: "USD",
      basis: "cash",
      bookRevision: calendar.bookRevision,
      firstDate: "2025-10-01",
      lastDate: "2026-09-30",
      latestPostingDate: "2026-03-03",
      fiscalYears: [{ year: 2025, startsOn: "2025-10-01", endsOn: "2026-09-30" }],
    });
    expect(calendar.bookRevision).toMatch(/^[1-9][0-9]*$/);
  });

  test("reports.get labels the basis, starts the year in October and refuses what the book cannot do", async () => {
    const f = await seeded();
    const ok = await f.call("reports.get", { asOf: "2026-03-31" });
    expect(ok.status).toBe(200);
    const report = ok.body.data;
    expect(report.basis).toBe("cash");
    expect(report.periodStart).toBe("2025-10-01");
    expect(report.fiscalYear).toEqual({ year: 2025, startsOn: "2025-10-01", endsOn: "2026-09-30" });
    expect(report.compilerVersion).toBe("rastrata-core-report-v2");
    expect(report.profitAndLoss.netIncome).toBe("1720.00");
    expect(report.balanceSheet.assets).toBe("6800.00");
    expect(report.balanceSheet.balanced).toBe(true);
    expect(report.comparison).toBeNull();
    expect(report.warnings).toEqual([]);

    const accrual = await f.call("reports.get", { asOf: "2026-03-31", basis: "accrual" });
    expect(accrual.status).toBe(409);
    expect(accrual.body.error.code).toBe("basis_unavailable");
    expect(accrual.body.error.message).toMatch(/cash basis/);
    expect(
      (await f.call("reports.get", { asOf: "2026-03-31", basis: "cash" })).body.data.populationHash,
    ).toBe(report.populationHash);

    const outside = await f.call("reports.get", { asOf: "2026-10-01" });
    expect(outside.status).toBe(409);
    expect(outside.body.error.code).toBe("calendar_not_configured");
    expect(outside.body.error.message).toContain("2025-10-01 to 2026-09-30");
    expect(outside.body.error.details[0].path).toBe("asOf");
  });

  test("a range, a comparison and the roll-forward through the API", async () => {
    const f = await seeded();
    const quarter = (
      await f.call("reports.get", {
        asOf: "2026-03-31",
        from: "2026-01-01",
        compare: "previousPeriod",
      })
    ).body.data;
    expect(quarter.periodStart).toBe("2026-01-01");
    expect(quarter.profitAndLoss.netIncome).toBe("820.00");
    expect(quarter.comparison).toMatchObject({
      kind: "previousPeriod",
      periodStart: "2025-10-01",
      asOf: "2025-12-31",
    });
    const sales = quarter.profitAndLoss.rows.find((row: { code: string }) => row.code === "4000");
    expect(sales).toMatchObject({ amount: "900.00", comparative: "1200.00", change: "-300.00" });
    // The comparison column is the report that range has alone.
    const earlier = (await f.call("reports.get", { asOf: "2025-12-31", from: "2025-10-01" })).body
      .data;
    expect(quarter.comparison.populationHash).toBe(earlier.populationHash);
    // The balance sheet does not move with the profit and loss range, and still balances.
    const wholeYear = (await f.call("reports.get", { asOf: "2026-03-31" })).body.data;
    expect(quarter.balanceSheet.assets).toBe(wholeYear.balanceSheet.assets);
    expect(quarter.balanceSheet.equity).toBe(wholeYear.balanceSheet.equity);
    expect(quarter.balanceSheet.priorEarnings).toBe("0.00");
  });

  test("the cash-flow statement ties through the API, and tags are read from the book's own", async () => {
    const f = await seeded();
    const flow = (await f.call("reports.cashFlow", { asOf: "2026-03-31" })).body.data;
    expect(flow.available).toBe(true);
    expect(flow.openingCash).toBe("0.00");
    expect(flow.closingCash).toBe("4800.00");
    expect(flow.netChange).toBe("4800.00");
    expect(flow.ties).toBe(true);
    const bySection = Object.fromEntries(
      flow.sections.map((item: { key: string; total: string }) => [item.key, item.total]),
    );
    expect(bySection).toEqual({
      operating: "1800.00",
      investing: "-2000.00",
      financing: "5000.00",
    });
    expect(flow.warnings).toEqual([]);
    const sheet = (await f.call("reports.get", { asOf: "2026-03-31" })).body.data;
    expect(
      sheet.balanceSheet.rows.find((row: { code: string }) => row.code === "1000").amount,
    ).toBe(flow.closingCash);
  });

  test("retagging changes the cash-flow population, and the tag revision pins the old one", async () => {
    const f = await seeded();
    const before = (await f.call("reports.cashFlow", { asOf: "2026-03-31" })).body.data;
    const retag = await f.call(
      "accounts.setTags",
      { accountId: "1100", effectiveOn: "2025-10-01", tags: { cashFlowClass: "operating" } },
      crypto.randomUUID(),
    );
    expect(retag.body.ok, JSON.stringify(retag.body)).toBe(true);
    const after = (await f.call("reports.cashFlow", { asOf: "2026-03-31" })).body.data;
    expect(after.tagMapHash).not.toBe(before.tagMapHash);
    expect(after.populationHash).not.toBe(before.populationHash);
    expect(after.ledgerPopulationHash).toBe(before.ledgerPopulationHash);
    expect(after.closingCash).toBe(before.closingCash);
    const operating = (flow: typeof after) =>
      flow.sections.find((item: { key: string }) => item.key === "operating").total;
    expect(operating(after)).toBe("-200.00");
    expect(operating(before)).toBe("1800.00");
    // Pinning the tags as they were reproduces the first statement exactly.
    const pinned = (
      await f.call("reports.cashFlow", { asOf: "2026-03-31", tagsRevision: before.tagsRevision })
    ).body.data;
    expect(pinned).toEqual(before);
  });

  test("a book with no cash tag gets an honest unavailable statement, not an error", async () => {
    const f = await fixture();
    const untagged = { ...book, accounts: book.accounts.map(({ tags: _tags, ...rest }) => rest) };
    expect((await f.call("book.setup", untagged, crypto.randomUUID())).body.ok).toBe(true);
    await f.post(
      "2025-10-05",
      [
        ["1000", "10.00", ""],
        ["3000", "", "10.00"],
      ],
      "Owner contribution",
    );
    const flow = await f.call("reports.cashFlow", { asOf: "2025-10-31" });
    expect(flow.status).toBe(200);
    expect(flow.body.data.available).toBe(false);
    expect(flow.body.data.reason).toMatch(/in your chart of accounts/);
    expect(flow.body.data.sections).toEqual([]);
  });

  test("the general ledger pages and its lines drill through to the journal", async () => {
    const f = await seeded();
    const ledger = (await f.call("reports.generalLedger", { asOf: "2026-03-31" })).body.data;
    expect(ledger.count).toBe(12);
    expect(ledger.lines).toHaveLength(12);
    expect(ledger.pageSize).toBe(100);
    const cash = ledger.accounts.find((row: { code: string }) => row.code === "1000");
    expect(cash).toMatchObject({
      openingBalance: "0.00",
      closingBalance: "4800.00",
      balanceKind: "cumulative",
    });
    const report = (await f.call("reports.get", { asOf: "2026-03-31" })).body.data;
    expect(ledger.populationHash).toBe(report.populationHash);
    const line = ledger.lines.find((entry: { accountId: string }) => entry.accountId === "4000");
    const entry = await f.call("journal.get", {
      journalId: line.journalId,
      revision: report.bookRevision,
      asOf: report.asOf,
      populationHash: report.populationHash,
    });
    expect(entry.status).toBe(200);
    expect(entry.body.data.lines.length).toBe(2);
  });

  test("account activity ties to the statement and needs the report's own start", async () => {
    const f = await seeded();
    const report = (await f.call("reports.get", { asOf: "2026-03-31", from: "2026-01-01" })).body
      .data;
    const scope = {
      accountId: "4000",
      asOf: report.asOf,
      revision: report.bookRevision,
      populationHash: report.populationHash,
      from: report.periodStart,
      to: report.asOf,
    };
    const missing = await f.call("activity.get", scope);
    expect(missing.status).toBe(409);
    expect(missing.body.error.code).toBe("report_population_changed");
    const activity = (await f.call("activity.get", { ...scope, reportFrom: report.periodStart }))
      .body.data;
    expect(activity.balanceKind).toBe("fiscalYearToDate");
    expect(activity.netChange).toBe("-900.00");
    const sales = report.profitAndLoss.rows.find((row: { code: string }) => row.code === "4000");
    expect(sales.amount).toBe("900.00");
    expect(activity.rows).toHaveLength(1);
    expect(activity.basis).toBe("cash");
    const entry = await f.call("journal.get", {
      journalId: activity.rows[0].journalId,
      revision: report.bookRevision,
      asOf: report.asOf,
      populationHash: report.populationHash,
      reportFrom: report.periodStart,
    });
    expect(entry.status).toBe(200);
    // The same call without the report's start does not verify.
    expect(
      (
        await f.call("journal.get", {
          journalId: activity.rows[0].journalId,
          revision: report.bookRevision,
          asOf: report.asOf,
          populationHash: report.populationHash,
        })
      ).body.error.code,
    ).toBe("report_population_changed");
  });

  test("drill-through reads the current book: it fails honestly if the book moved, and a pin still reproduces", async () => {
    const f = await seeded();
    const report = (await f.call("reports.get", { asOf: "2026-03-31" })).body.data;
    const scope = {
      accountId: "4000",
      asOf: report.asOf,
      populationHash: report.populationHash,
      from: report.periodStart,
      to: report.asOf,
    };
    // No revision: the current book, with no replay of history.
    const current = await f.call("activity.get", scope);
    expect(current.status).toBe(200);
    expect(current.body.data.closingBalance).toBe("-2100.00");
    expect(current.body.data.revision).toBe(report.bookRevision);
    await f.post(
      "2026-03-20",
      [
        ["1000", "50.00", ""],
        ["4000", "", "50.00"],
      ],
      "Late sale",
    );
    // The book moved: the report on screen is older than the book, and the page must say so.
    const moved = await f.call("activity.get", scope);
    expect(moved.status).toBe(409);
    expect(moved.body.error.code).toBe("report_population_changed");
    expect(moved.body.error.message).toMatch(/read the report again/);
    // A caller that must reproduce the old report names its revision and still gets it.
    const pinned = await f.call("activity.get", { ...scope, revision: report.bookRevision });
    expect(pinned.status).toBe(200);
    expect(pinned.body.data.closingBalance).toBe("-2100.00");
    // Reading the report again gives a population that verifies against the current book.
    const fresh = (await f.call("reports.get", { asOf: "2026-03-31" })).body.data;
    const again = await f.call("activity.get", { ...scope, populationHash: fresh.populationHash });
    expect(again.body.data.closingBalance).toBe("-2150.00");
  });

  test("exports come back as CSV text with the population they were built from", async () => {
    const f = await seeded();
    const report = (await f.call("reports.get", { asOf: "2026-03-31" })).body.data;
    for (const statement of [
      "trial-balance",
      "profit-loss",
      "balance-sheet",
      "cash-flow",
      "general-ledger",
    ]) {
      const response = await f.call("reports.export", { statement, asOf: "2026-03-31" });
      expect(response.status, statement).toBe(200);
      const file = response.body.data;
      expect(file.mediaType).toBe("text/csv; charset=utf-8");
      expect(file.content.startsWith("Report,")).toBe(true);
      expect(file.content).toContain("Book,October Cash Co");
      expect(file.content).toContain("Basis,cash");
      expect(file.bookRevision).toBe(report.bookRevision);
      if (statement !== "cash-flow") expect(file.populationHash).toBe(report.populationHash);
    }
    expect(
      (
        await f.call("reports.export", {
          statement: "balance-sheet",
          asOf: "2026-03-31",
          basis: "accrual",
        })
      ).body.error.code,
    ).toBe("basis_unavailable");
    expect(
      (await f.call("reports.export", { statement: "income-statement", asOf: "2026-03-31" })).body
        .error.code,
    ).toBe("invalid_input");
  });

  test("a pinned book revision reproduces a report after the book moves on", async () => {
    const f = await seeded();
    const pinned = (await f.call("reports.get", { asOf: "2026-03-31" })).body.data;
    await f.post(
      "2026-03-20",
      [
        ["1000", "50.00", ""],
        ["4000", "", "50.00"],
      ],
      "Late sale",
    );
    const now = (await f.call("reports.get", { asOf: "2026-03-31" })).body.data;
    expect(now.populationHash).not.toBe(pinned.populationHash);
    expect(now.profitAndLoss.netIncome).toBe("1770.00");
    const again = (
      await f.call("reports.get", { asOf: "2026-03-31", revision: pinned.bookRevision })
    ).body.data;
    expect(again).toEqual(pinned);
    const flowThen = (
      await f.call("reports.cashFlow", { asOf: "2026-03-31", revision: pinned.bookRevision })
    ).body.data;
    expect(flowThen.closingCash).toBe("4800.00");
    expect((await f.call("reports.cashFlow", { asOf: "2026-03-31" })).body.data.closingCash).toBe(
      "4850.00",
    );
  });
});

describe("the contract at the boundary", () => {
  test("reads need only read permission, and every report operation checks it", async () => {
    const f = await seeded();
    const operations: [string, unknown][] = [
      ["reports.get", { asOf: "2026-03-31" }],
      ["reports.cashFlow", { asOf: "2026-03-31" }],
      ["reports.generalLedger", { asOf: "2026-03-31" }],
      ["reports.export", { statement: "trial-balance", asOf: "2026-03-31" }],
      ["reports.calendar", {}],
    ];
    for (const [name, input] of operations) {
      const denied = await f.call(name, input, undefined, [
        "draft",
        "post",
        "configure",
        "correct",
        "close",
        "provision",
      ]);
      expect(denied.status, name).toBe(403);
      expect(denied.body.error.code).toBe("permission_denied");
      expect((await f.call(name, input, undefined, ["read"])).status, name).toBe(200);
    }
  });

  test("malformed requests are refused before any work, with a path to the field", async () => {
    const f = await seeded();
    for (const [input, path] of [
      [{ asOf: "2026-3-31" }, "input.asOf"],
      [{ asOf: "2026-03-31", from: "March" }, "input.from"],
      [{ asOf: "2026-03-31", compare: "lastDecade" }, "input.compare"],
      [{ asOf: "2026-03-31", basis: "tax" }, "input.basis"],
      [{ asOf: "2026-03-31", revision: "-1" }, "input.revision"],
      [{ asOf: "2026-03-31", extra: true }, "input"],
      [{}, "input"],
    ] as const) {
      const response = await f.call("reports.get", input);
      expect(response.status, JSON.stringify(input)).toBe(400);
      expect(response.body.error.code).toBe("invalid_input");
      expect(response.body.error.details[0].path).toBe(path);
    }
    // A date the pattern accepts but the calendar does not is refused by the compiler, not coerced.
    const impossible = await f.call("reports.get", { asOf: "2026-02-30" });
    expect(impossible.status).toBe(400);
    expect(impossible.body.error.code).toBe("invalid_input");
    const backwards = await f.call("reports.get", { asOf: "2026-03-31", from: "2026-04-01" });
    expect(backwards.status).toBe(400);
    expect((await f.call("reports.generalLedger", { asOf: "2026-03-31", page: 0 })).status).toBe(
      400,
    );
    expect(
      (await f.call("reports.cashFlow", { asOf: "2026-03-31", tagsRevision: "x" })).status,
    ).toBe(400);
  });

  test("report operations are reads: they take no operation identity and leave the book unchanged", async () => {
    const f = await seeded();
    const before = (await f.call("book.get")).body.data.head;
    for (const name of ["reports.get", "reports.cashFlow", "reports.generalLedger"])
      expect((await f.call(name, { asOf: "2026-03-31" })).status, name).toBe(200);
    expect((await f.call("book.get")).body.data.head).toEqual(before);
    // A catalog entry marks them as reads, so a client never retains a request for them.
    const catalog = (await f.call("capabilities.get")).body.data.operations as {
      name: string;
      writes: boolean;
      permission: string;
    }[];
    for (const name of [
      "reports.get",
      "reports.cashFlow",
      "reports.generalLedger",
      "reports.export",
      "reports.calendar",
      "activity.get",
    ]) {
      const entry = catalog.find((item) => item.name === name);
      expect(entry, name).toMatchObject({ writes: false, permission: "read" });
    }
  });
});

describe("the legacy report routes are gone", () => {
  test("/api/reports, /api/ledger and the journal detail route no longer exist; /v1 serves the same figures", async () => {
    const f = await seeded();
    const handler = createLegacyBookHandler(f.service);
    for (const path of [
      "/api/reports?asOf=2026-03-31",
      "/api/reports?asOf=2026-03-31&format=csv&type=trial-balance",
      "/api/ledger?accountId=4000",
      "/api/journal/journal-1?revision=1",
    ])
      expect((await handler(new Request(`http://127.0.0.1${path}`))).status, path).toBe(404);
    // What they served is one operation each: the statements, the account activity and the entry.
    const report = (await f.call("reports.get", { asOf: "2026-03-31" })).body.data;
    expect(report.profitAndLoss.netIncome).toBe("1720.00");
    const csv = await f.call("reports.export", { statement: "trial-balance", asOf: "2026-03-31" });
    expect(csv.body.data.content).toContain("Operating cash");
  });
});
