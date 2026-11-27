import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { ADJUSTMENT_COLUMNS } from "../src/tax/adjustments.ts";
import {
  act,
  cleanUpTax,
  type Json,
  postBankLines,
  type TaxFixture,
  taxFixture,
} from "./tax-support.ts";

afterEach(cleanUpTax);

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** A reader for the CSV the pack writes (RFC 4180): quoted cells, doubled quotes, line breaks inside
 * quotes. Written here so the test does not depend on the code that writes the files. */
function readCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(cell);
      out.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

/** The table of a tax file: the rows after its header block, keyed by the column names. */
function table(text: string, firstColumn: string): Json[] {
  const all = readCsv(text);
  const start = all.findIndex((row) => row[0] === firstColumn);
  if (start < 0) throw new Error(`no table starting with ${firstColumn}`);
  const head = all[start] as string[];
  return all
    .slice(start + 1)
    .filter((row) => row.length > 1)
    .map((row) => Object.fromEntries(head.map((name, index) => [name, row[index] ?? ""])));
}

/** Every journal of the book as the register lists it, 25 a page. */
async function register(f: TaxFixture): Promise<Json[]> {
  const entries: Json[] = [];
  for (let page = 1; page < 50; page++) {
    const data = await act(f, "journal.list", { page });
    entries.push(...data.entries);
    if (entries.length >= data.count || data.entries.length === 0) break;
  }
  return entries;
}

/** A sole proprietor's 2026: money in, two contractor payments through the Inbox (one with text that
 * a spreadsheet would run as a formula) and a payment typed in by hand. */
async function book2026(): Promise<TaxFixture> {
  const f = await taxFixture({ today: "2027-02-01" });
  await f.setupFromTemplate({ templateId: "sole-proprietor", basis: "cash", taxYear: 2026 });
  await f.post(
    "2026-01-05",
    [
      ["1000", "50000.00", ""],
      ["3000", "", "50000.00"],
    ],
    "Owner investment",
  );
  await postBankLines(f, "6030", [
    {
      date: "2026-02-03",
      amount: "-1200.00",
      description: "ZELLE PAYMENT TO JANE DOE 5521",
      providerId: "p1",
    },
    {
      date: "2026-03-03",
      amount: "-1100.00",
      description: '=HYPERLINK("http://example.invalid","click")',
      counterparty: "+Jane Doe Design",
      providerId: "p2",
    },
  ]);
  await f.post(
    "2026-04-10",
    [
      ["6080", "300.00", ""],
      ["1000", "", "300.00"],
    ],
    "Typed in by hand",
  );
  return f;
}

const FILES = [
  "README.md",
  "chart-of-accounts.csv",
  "journal.csv",
  "changes.csv",
  "reconciliations.csv",
  "reconciliation-lines.csv",
  "trial-balance.csv",
  "general-ledger.csv",
  "adjusting-entries-template.csv",
  "manifest.json",
];

describe("the accountant pack", () => {
  test("is a set of files tied to a manifest: every size and SHA-256 is true, and the format says what it is", async () => {
    const f = await book2026();
    const pack = await act(f, "taxAccountant.build", { taxYear: 2026 });
    expect(pack.format).toBe("rastrata-accountant-pack-v1");
    expect(pack.folder).toBe("rastrata-accountant-2026");
    expect(pack.files.map((file: Json) => file.path)).toEqual(FILES);
    expect(pack.from).toBe("2026-01-01");
    expect(pack.to).toBe("2026-12-31");
    expect(pack.provenanceRead).toBe(true);
    for (const file of pack.files)
      expect<string>(file.sha256, file.path).toBe(sha256(file.content));
    const manifestFile = pack.files.at(-1);
    expect(pack.manifestSha256).toBe(manifestFile.sha256);
    const manifest = JSON.parse(manifestFile.content);
    expect(manifest.format).toBe("rastrata-accountant-pack-v1");
    expect(manifest.files.map((entry: Json) => entry.path)).toEqual(FILES.slice(0, -1));
    for (const entry of manifest.files) {
      const file = pack.files.find((candidate: Json) => candidate.path === entry.path);
      expect(entry.sha256).toBe(sha256(file.content));
      expect(entry.bytes).toBe(Buffer.byteLength(file.content, "utf8"));
    }
    expect(pack.disclaimer).toContain("does not give tax advice");
    // The README says what is and is not in it, and how to send entries back.
    const readme = pack.files[0].content as string;
    expect(readme).toContain("Accountant pack");
    expect(readme).toContain("Sending adjusting entries back");
    expect(readme).toContain("Nothing is posted");
    expect(readme).toContain("What is not in it");
    expect(readme).toContain(ADJUSTMENT_COLUMNS.join(","));
    for (const path of FILES.slice(1, -1)) expect(readme).toContain(`\`${path}\``);
  });

  test("the journal lists every journal of the range with its lines, and the amounts are the register's", async () => {
    const f = await book2026();
    const pack = await act(f, "taxAccountant.build", { taxYear: 2026 });
    const journalFile = pack.files.find((file: Json) => file.path === "journal.csv");
    const rows = table(journalFile.content, "Journal ID");
    const entries = await register(f);
    expect(new Set(rows.map((row) => row["Journal ID"]))).toEqual(
      new Set(entries.map((entry) => entry.id)),
    );
    for (const entry of entries) {
      const mine = rows.filter((row) => row["Journal ID"] === entry.id);
      expect(mine.length, entry.reference).toBe(entry.lines.length);
      const debit = mine.reduce((sum, row) => sum + Number(row.Debit || 0), 0);
      const credit = mine.reduce((sum, row) => sum + Number(row.Credit || 0), 0);
      expect(debit.toFixed(2)).toBe(credit.toFixed(2));
      expect(mine[0]?.Date).toBe(entry.isoDate);
    }
    expect(pack.journals).toBe(entries.length);
    expect(rows.length).toBe(entries.reduce((sum, entry) => sum + entry.lines.length, 0));
  });

  test("a journal posted from an imported bank line says where it came from, in the bank's own words, and who decided it", async () => {
    const f = await book2026();
    const pack = await act(f, "taxAccountant.build", { taxYear: 2026 });
    const rows = table(
      pack.files.find((file: Json) => file.path === "journal.csv").content,
      "Journal ID",
    );
    const zelle = rows.filter((row) => row["Narration"].includes("ZELLE"));
    expect(zelle.length).toBeGreaterThan(0);
    for (const row of zelle) {
      expect(row["Imported from"]).toBe("csv");
      expect(row["Import account"]).toBe("csv:1000");
      expect(row["Provider's transaction ID"]).toBe("p1");
      expect(row["Description (as the bank wrote it)"]).toBe("ZELLE PAYMENT TO JANE DOE 5521");
      expect(row["Decided by"]).toBe("owner");
      expect(row["How it was decided"]).toBe("categorize");
      // The ledger holds the source event the line was posted from, with its content hash.
      expect(row["Source ID"]).not.toBe("");
      expect(row["Source content hash"]).toMatch(/^[0-9a-f]{64}$/);
    }
    // Typed in by hand: nothing recorded, and the pack does not pretend otherwise.
    const typed = rows.filter((row) => row["Narration"] === "Typed in by hand");
    expect(typed).toHaveLength(2);
    for (const row of typed) {
      expect(row["Imported from"]).toBe("");
      expect(row["Decided by"]).toBe("");
      expect(row["Source ID"]).toBe("");
    }
  });

  test("text from a bank or a person that a spreadsheet would run as a formula is neutralised in every cell", async () => {
    const f = await book2026();
    const pack = await act(f, "taxAccountant.build", { taxYear: 2026 });
    const file = pack.files.find((entry: Json) => entry.path === "journal.csv");
    const hostile = table(file.content, "Journal ID").filter((row) =>
      row["Description (as the bank wrote it)"].includes("HYPERLINK"),
    );
    expect(hostile.length).toBeGreaterThan(0);
    for (const row of hostile) {
      expect(row["Description (as the bank wrote it)"].startsWith("'=")).toBe(true);
      expect(row["Counterparty (as the bank wrote it)"].startsWith("'+")).toBe(true);
    }
    for (const entry of pack.files)
      if (entry.path.endsWith(".csv"))
        for (const row of readCsv(entry.content))
          for (const cell of row)
            expect(/^[=+@\t\r]/.test(cell), `${entry.path}: ${cell}`).toBe(false);
  });

  test("the chart lists every account of the book with its type and the tags the books carry", async () => {
    const f = await book2026();
    const pack = await act(f, "taxAccountant.build", { taxYear: 2026 });
    const chart = table(
      pack.files.find((file: Json) => file.path === "chart-of-accounts.csv").content,
      "Code",
    );
    const accounts = (await act(f, "accounts.list", {})).accounts as Json[];
    expect(new Set(chart.map((row) => row.Code))).toEqual(
      new Set(accounts.map((account) => account.code)),
    );
    const contract = chart.find((row) => row.Code === "6030");
    expect(contract).toMatchObject({
      Type: "expense",
      "Normal side": "debit",
      "Takes entries": "yes",
    });
    expect(contract?.["Tax line"]).toBe("scheduleC.line11");
    expect(chart.find((row) => row.Code === "1000")?.Type).toBe("asset");
    expect(chart.every((row) => row["Opened on"] !== "")).toBe(true);
  });

  test("the trial balance and general ledger are the reports lane's own exports for the same dates", async () => {
    const f = await book2026();
    const pack = await act(f, "taxAccountant.build", { taxYear: 2026 });
    for (const [statement, path] of [
      ["trial-balance", "trial-balance.csv"],
      ["general-ledger", "general-ledger.csv"],
    ] as const) {
      const exported = await act(f, "reports.export", {
        statement,
        asOf: "2026-12-31",
        from: "2026-01-01",
      });
      expect(pack.files.find((file: Json) => file.path === path).content, path).toBe(
        exported.content,
      );
    }
    const report = await act(f, "reports.get", { asOf: "2026-12-31", from: "2026-01-01" });
    expect(pack.ledgerPopulationHash).toBe(report.populationHash);
    const manifest = JSON.parse(pack.files.at(-1).content);
    expect(manifest.populations.ledger).toBe(report.populationHash);
    expect(typeof manifest.populations.journals).toBe("string");
    // The journal file is tied to the exact book: its population differs from the ledger's.
    expect(manifest.populations.journals).not.toBe(manifest.populations.ledger);
  });

  test("the template is the header row alone, so nothing can be imported by mistake", async () => {
    const f = await book2026();
    const pack = await act(f, "taxAccountant.build", { taxYear: 2026 });
    const template = pack.files.find(
      (file: Json) => file.path === "adjusting-entries-template.csv",
    );
    expect(template.content).toBe("Entry,Date,Narration,Account,Debit,Credit\r\n");
    const preview = await act(f, "taxAdjustments.preview", { csv: template.content });
    expect(preview.entries).toEqual([]);
    expect(preview.canImport).toBe(false);
    expect(preview.problems.map((problem: Json) => problem.code)).toEqual(["no_entries"]);
  });

  test("builds the same bytes again from the same book, and a pinned revision rebuilds it after the book changes", async () => {
    const f = await book2026();
    const first = await act(f, "taxAccountant.build", { taxYear: 2026 });
    const again = await act(f, "taxAccountant.build", { taxYear: 2026 });
    expect(again.files.map((file: Json) => file.sha256)).toEqual(
      first.files.map((file: Json) => file.sha256),
    );
    expect(again.manifestSha256).toBe(first.manifestSha256);
    await f.post(
      "2026-05-01",
      [
        ["6080", "50.00", ""],
        ["1000", "", "50.00"],
      ],
      "Another entry",
    );
    const later = await act(f, "taxAccountant.build", { taxYear: 2026 });
    expect(later.manifestSha256).not.toBe(first.manifestSha256);
    const pinned = await act(f, "taxAccountant.build", {
      taxYear: 2026,
      revision: first.bookRevision,
    });
    expect(pinned.manifestSha256).toBe(first.manifestSha256);
    expect(pinned.files.map((file: Json) => file.sha256)).toEqual(
      first.files.map((file: Json) => file.sha256),
    );
  });

  test("a reversal is listed with the link in both directions", async () => {
    const f = await book2026();
    const entries = await register(f);
    const typed = entries.find((entry) => entry.reference === "Typed in by hand");
    const planId = crypto.randomUUID();
    const prepared = await act(
      f,
      "journal.prepareReverse",
      { journalId: typed.id, accountingDate: "2026-04-20", reason: "Entered twice" },
      planId,
    );
    await act(f, "operations.commit", { planId, planHash: prepared.planHash });
    const pack = await act(f, "taxAccountant.build", { taxYear: 2026 });
    const rows = table(
      pack.files.find((file: Json) => file.path === "journal.csv").content,
      "Journal ID",
    );
    const original = rows.find((row) => row["Journal ID"] === typed.id);
    expect(original?.["Corrected by"]).toMatch(/\(reversal\)$/);
    const reversal = rows.find(
      (row) => row["Journal ID"] === original?.["Corrected by"].split(" ")[0],
    );
    expect(reversal?.Corrects).toBe(`${typed.id} (reversal)`);
    expect(reversal?.Date).toBe("2026-04-20");
  });

  test("covers the range asked for, refuses what is not a year the books hold, and needs only read permission", async () => {
    const f = await book2026();
    const part = await act(f, "taxAccountant.build", {
      taxYear: 2026,
      from: "2026-03-01",
      to: "2026-03-31",
    });
    const rows = table(
      part.files.find((file: Json) => file.path === "journal.csv").content,
      "Journal ID",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.Date >= "2026-03-01" && row.Date <= "2026-03-31")).toBe(true);
    expect(part.journals).toBe(new Set(rows.map((row) => row["Journal ID"])).size);
    const unsupported = await f.call("taxAccountant.build", { taxYear: 2024 }, undefined);
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.error.code).toBe("tax_year_unsupported");
    expect(
      (await f.call("taxAccountant.build", { taxYear: 2026 }, undefined, ["read"])).status,
    ).toBe(200);
    expect((await f.call("taxAccountant.build", { taxYear: 2026 }, undefined, [])).status).toBe(
      403,
    );
    expect(
      (await f.call("taxAccountant.build", { taxYear: 2026, from: "2026-02-30" })).status,
    ).toBe(400);
  });
});
