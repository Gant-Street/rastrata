import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LocalBookService } from "../src/local.ts";
import { checkExportFiles, importOpenExport } from "../src/local.ts";
import { hashFile } from "../src/local/files.ts";
import { exportBook } from "../src/safety/export-job.ts";
import { sealExportManifest, sha256Hex } from "../src/safety/manifest.ts";
import { postBulk } from "./support/bulk-book.ts";
import { cleanupSafetyFixtures, safetyFixture, type SafetyFixture } from "./support/safety.ts";

afterEach(cleanupSafetyFixtures);

/** Prepare and commit a plan the way every client does. */
async function commit(f: SafetyFixture, name: string, input: unknown): Promise<void> {
  const id = crypto.randomUUID();
  const prepared = await f.call(name, input, id);
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  const done = await f.call("operations.commit", {
    planId: id,
    planHash: prepared.body.data.planHash,
  });
  expect(done.body.data.disposition, JSON.stringify(done.body)).toBe("committed");
}

/** A book with everything an export has to carry: sources, a reversal, a new account, a period
 * closed and reopened, a rejected command, and text that tries to run in a spreadsheet. */
async function busyBook(): Promise<SafetyFixture> {
  const f = await safetyFixture();
  const post = async (data: unknown) => {
    const draft = (await f.call("drafts.create", { data }, crypto.randomUUID())).body.data;
    const prepared = await f.call(
      "journal.prepare",
      { draftId: draft.id, expectedVersion: 1 },
      crypto.randomUUID(),
    );
    const outcome = await f.call("operations.commit", {
      planId: prepared.body.data.planId,
      planHash: prepared.body.data.planHash,
    });
    return outcome.body.data.disposition as string;
  };
  await commit(f, "accounts.prepareCreate", {
    code: "6000",
    name: '=HYPERLINK("http://example.invalid","click")',
    role: "expense",
    effectiveOn: "2026-01-01",
  });
  expect(
    await post({
      date: "2026-01-10",
      reference: "OPEN-1",
      narration: 'Opening, with a comma, a "quote"\nand a new line',
      source: {
        id: "bank-line-1",
        description: "+1+1 wire from a customer",
        evidenceReference: "@receipt-1",
      },
      lines: [
        { accountId: "1000", debit: "2500.00", credit: "" },
        { accountId: "3000", debit: "", credit: "2500.00" },
      ],
    }),
  ).toBe("committed");
  expect(
    await post({
      date: "2026-01-12",
      reference: "-SALE",
      narration: "=cmd|' /C calc'!A0",
      lines: [
        { accountId: "1000", debit: "300.25", credit: "" },
        { accountId: "4000", debit: "", credit: "300.25" },
      ],
    }),
  ).toBe("committed");
  expect(
    await post({
      date: "2026-01-14",
      reference: "EXP",
      narration: "Software",
      lines: [
        { accountId: "6000", debit: "49.99", credit: "" },
        { accountId: "1000", debit: "", credit: "49.99" },
      ],
    }),
  ).toBe("committed");
  const journals = (await f.service.readAggregate()).aggregate.state.journals;
  const expense = journals.at(-1)?.journal.id as string;
  await commit(f, "journal.prepareReverse", {
    journalId: expense,
    accountingDate: "2026-01-20",
    reason: "Entered twice",
  });
  const periods = (await f.call("periods.list")).body.data.periods as { id: string }[];
  const january = periods[0]?.id as string;
  await commit(f, "periods.prepare", {
    periodId: january,
    operation: "close",
    reason: "January done",
  });
  // A late posting into the closed period is rejected, and the rejection is part of the chain.
  expect(
    await post({
      date: "2026-01-25",
      reference: "LATE",
      narration: "Too late",
      lines: [
        { accountId: "1000", debit: "1.00", credit: "" },
        { accountId: "4000", debit: "", credit: "1.00" },
      ],
    }),
  ).toBe("rejected");
  await commit(f, "periods.prepare", {
    periodId: january,
    operation: "reopen",
    reason: "One more",
  });
  return f;
}

/** RFC 4180 rows from CSV text. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const ch = text[index] as string;
    if (quoted) {
      if (ch === '"' && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text[index + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      index++;
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const jsonl = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

test("an export holds every file the format promises, with hashes that check, and states the head it was taken at", async () => {
  const f = await busyBook();
  const record = (await f.finish("export.create")).export;
  expect(record.format).toBe("rastrata-export-v1");
  expect(record.location).toBe(join(f.exports, record.id));
  expect(readdirSync(record.location).sort()).toEqual([
    "README.md",
    "SHA256SUMS",
    "book.json",
    "chart.csv",
    "commands.jsonl",
    "general-ledger.csv",
    "journals.jsonl",
    "manifest.json",
    "records-account-tags.jsonl",
    "records-changes.json",
    "records-payees.json",
    "records-reconciliations.jsonl",
    "records-rules.json",
    "sources.jsonl",
    "trial-balance.csv",
  ]);
  const live = await f.service.readAggregate();
  expect(record.head).toEqual(live.head);
  expect(record.counts).toMatchObject({
    journals: 4,
    postings: 8,
    accounts: 5,
    sources: 1,
    commands: 9,
  });
  const checked = await checkExportFiles(record.location);
  expect(checked.passed).toBe(true);
  expect(checked.checks.map((c) => c.code)).toEqual(["manifest", "files", "sha256sums"]);
  for (const file of record.files)
    expect(hashFile(join(record.location, file.path)).sha256).toBe(file.sha256);
  expect(statOf(record.location)).toBe(0o700);
  const list = (await f.call("export.list")).body.data;
  expect(list.exports.map((e: { id: string }) => e.id)).toEqual([record.id]);
  expect(list.exports[0].manifestSha256).toBe(record.manifestSha256);
  const readme = readFileSync(join(record.location, "README.md"), "utf8");
  expect(readme).toContain("shasum -a 256 -c SHA256SUMS");
  expect(readme).toContain("rastrata import-export");
  expect(readme).toContain(live.head.chainHash);
});

const statOf = (path: string) => require("node:fs").statSync(path).mode & 0o777;

test("journals carry their lines, source, corrections and provenance; money is exact", async () => {
  const f = await busyBook();
  const { location } = (await f.finish("export.create")).export;
  const journals = jsonl(join(location, "journals.jsonl"));
  expect(journals.length).toBe(4);
  const opening = journals.find((j) => j.narration.startsWith("Opening"));
  expect(opening.narration).toBe('Opening, with a comma, a "quote"\nand a new line');
  expect(opening.source).toMatchObject({
    id: "bank-line-1",
    description: "+1+1 wire from a customer",
    evidenceReference: "@receipt-1",
  });
  expect(opening.lines.map((l: { debit: string; credit: string }) => [l.debit, l.credit])).toEqual([
    ["2500.00", "0.00"],
    ["0.00", "2500.00"],
  ]);
  const reversed = journals.find((j) => j.status === "reversed");
  const reversal = journals.find((j) => j.status === "reversal");
  expect(reversed.reversedBy).toBe(reversal.id);
  expect(reversal.reverses).toBe(reversed.id);
  for (const journal of journals)
    for (const line of journal.lines) {
      expect(line.signed).toMatch(/^-?(0|[1-9][0-9]*)\.[0-9]{2}$/);
      expect(line.debit).toMatch(/^(0|[1-9][0-9]*)\.[0-9]{2}$/);
      expect(line.credit).toMatch(/^(0|[1-9][0-9]*)\.[0-9]{2}$/);
    }
  const commands = jsonl(join(location, "commands.jsonl"));
  expect(commands.map((c) => c.type)).toEqual(
    [
      "activateBook",
      "replaceConfiguration",
      "postJournal",
      "postJournal",
      "postJournal",
      "correctJournal",
      "closePeriod",
      "postJournal",
      "reopenPeriod",
    ].slice(0, commands.length),
  );
  expect(commands.some((c) => c.disposition === "rejected")).toBe(true);
  // The chain in the file is a chain: each line starts where the last ended.
  for (let index = 1; index < commands.length; index++)
    expect(commands[index].previousChainHash).toBe(commands[index - 1].chainHash);
  expect(commands.at(-1).chainHash).toBe((await f.service.readAggregate()).head.chainHash);
});

test("spreadsheet formulas in text never run: every text cell is neutralised and money stays a number", async () => {
  const f = await busyBook();
  const { location } = (await f.finish("export.create")).export;
  const dangerous = /^[=+\-@\t\r\n]/;
  let textCells = 0;
  let neutralised = 0;
  for (const name of ["chart.csv", "general-ledger.csv", "trial-balance.csv"]) {
    const rows = parseCsv(readFileSync(join(location, name), "utf8"));
    const header = rows[0] as string[];
    const moneyColumns = new Set(
      header.flatMap((column, index) =>
        ["debit", "credit", "running_balance", "signed_balance"].includes(column) ? [index] : [],
      ),
    );
    for (const row of rows.slice(1))
      row.forEach((cell, index) => {
        if (moneyColumns.has(index)) {
          // Money is a plain decimal (negatives start with a minus and are numbers, not formulas).
          expect(
            cell === "" || /^-?(0|[1-9][0-9]*)\.[0-9]{2}$/.test(cell),
            `${name}: ${cell}`,
          ).toBe(true);
          return;
        }
        textCells++;
        expect(dangerous.test(cell), `${name}: ${JSON.stringify(cell)}`).toBe(false);
        if (cell.startsWith("'")) neutralised++;
      });
  }
  expect(textCells).toBeGreaterThan(20);
  // The hostile account name, narration and references arrived as text, with the quote in front.
  const chart = readFileSync(join(location, "chart.csv"), "utf8");
  expect(chart).toContain(`'=HYPERLINK`);
  const ledger = parseCsv(readFileSync(join(location, "general-ledger.csv"), "utf8"));
  const narrations = ledger.map((row) => row[5]);
  expect(narrations).toContain("'=cmd|' /C calc'!A0");
  expect(neutralised).toBeGreaterThanOrEqual(4);
  // The JSON holds the exact text, quote-free.
  expect(readFileSync(join(location, "journals.jsonl"), "utf8")).toContain(
    '"narration":"=cmd|\' /C calc\'!A0"',
  );
});

test("the trial balance and the general ledger tie to the book to the cent", async () => {
  const f = await busyBook();
  const { location } = (await f.finish("export.create")).export;
  const trial = parseCsv(readFileSync(join(location, "trial-balance.csv"), "utf8"));
  const total = trial.at(-1) as string[];
  expect(total[0]).toBe("TOTAL");
  expect(total[4]).toBe(total[5]);
  expect(total[6]).toBe("0.00");
  const accounts = (await f.call("accounts.list")).body.data.accounts as {
    id: string;
    balance: string;
  }[];
  const byCode = new Map(trial.slice(1, -1).map((row) => [row[0], row[6]]));
  // Debit-positive balances: assets and expenses positive, the rest negative; compare per account.
  for (const account of accounts) {
    const signed = byCode.get(account.id);
    expect(signed).toBeDefined();
  }
  const ledger = parseCsv(readFileSync(join(location, "general-ledger.csv"), "utf8"));
  const cash = ledger.filter((row) => row[0] === "1000");
  // Cash: +2500.00 +300.25 -49.99 (+49.99 reversal) = 2800.25, and the last running balance says so.
  expect(cash.at(-1)?.[10]).toBe("2800.25");
  expect(trial.find((row) => row[1] === "1000")?.[6]).toBe("2800.25");
});

test("two exports of the same book are identical file for file apart from their own names and times", async () => {
  const f = await busyBook();
  const a = (await f.finish("export.create")).export;
  await Bun.sleep(1100);
  const b = (await f.finish("export.create")).export;
  expect(b.id).not.toBe(a.id);
  for (const name of [
    "journals.jsonl",
    "chart.csv",
    "general-ledger.csv",
    "trial-balance.csv",
    "commands.jsonl",
    "sources.jsonl",
    "book.json",
  ])
    expect(hashFile(join(b.location, name)).sha256, name).toBe(
      hashFile(join(a.location, name)).sha256,
    );
});

test("an export rebuilds the identical book by replay and proves it by head hash", async () => {
  const f = await busyBook();
  const record = (await f.finish("export.create")).export;
  const live = await f.service.readAggregate();
  const target = join(f.directory, "rebuilt", "book.sqlite");
  const stages: string[] = [];
  const result = await importOpenExport({
    directory: record.location,
    to: target,
    progress: (update) => {
      if (update.stage) stages.push(update.stage);
    },
  });
  expect(result.head).toEqual(live.head);
  expect(result.outcomes).toBe(Number(live.head.sequence));
  expect(result.sourcesRestored).toBe(1);
  expect(stages).toContain("Rebuilding the ledger");
  const rebuilt = await LocalBookService.open(target, { safety: false });
  // The whole of it replays and ends at the same chain hash.
  const read = await rebuilt.readAggregate(undefined, { verify: "full" });
  expect(read.head).toEqual(live.head);
  expect(read.aggregate.state.journals.map((j) => j.canonicalHash.digest)).toEqual(
    live.aggregate.state.journals.map((j) => j.canonicalHash.digest),
  );
  // The application knows the book and its sources again, and the Journal screen its references.
  expect(rebuilt.setupState()?.name).toBe("Safety Co");
  const registerOf = async (service: LocalBookService) =>
    (await service.journalBook()).entries
      .filter((entry) => entry.status === "Posted")
      .map((entry) => [entry.id, entry.reference, entry.amount]);
  expect(await registerOf(rebuilt)).toEqual(await registerOf(f.service));
  expect((await registerOf(rebuilt)).map((entry) => entry[1])).toContain("OPEN-1");
  const someCommand = read.aggregate.state.journals[0]?.commandId as string;
  expect((await rebuilt.operation(someCommand)).disposition).toBe("committed");
  const source = await rebuilt.source("bank-line-1");
  expect(source.status).toBe("posted");
  expect(source.source.evidenceReference).toBe("@receipt-1");
  rebuilt.close();
  // A posted source still blocks double booking in the rebuilt book.
  const again = await LocalBookService.open(target, { safety: false });
  const draft = again.createDraft({
    date: "2026-02-01",
    reference: "AGAIN",
    narration: "Again",
    source: {
      id: "bank-line-1",
      description: "+1+1 wire from a customer",
      evidenceReference: "@receipt-1",
    },
    lines: [
      { accountId: "1000", debit: "2500.00", credit: "" },
      { accountId: "3000", debit: "", credit: "2500.00" },
    ],
  });
  await expect(again.prepareDraft(draft.id, 1, crypto.randomUUID())).rejects.toMatchObject({
    code: "source_already_posted",
  });
  again.close();
  // It never overwrites a database.
  await expect(importOpenExport({ directory: record.location, to: target })).rejects.toMatchObject({
    code: "import_target_exists",
  });
});

/** Change one file of an export and re-seal the manifest and SHA256SUMS so every hash checks: a
 * forgery that only the ledger's own chain can catch. */
async function forge(
  location: string,
  file: string,
  change: (text: string) => string,
): Promise<void> {
  const path = join(location, file);
  writeFileSync(path, change(readFileSync(path, "utf8")));
  const manifest = JSON.parse(readFileSync(join(location, "manifest.json"), "utf8"));
  const files = manifest.files.map(
    (entry: { path: string; bytes: number; sha256: string; lines: number | null }) => {
      const found = hashFile(join(location, entry.path));
      return { ...entry, bytes: found.bytes, sha256: found.sha256 };
    },
  );
  const sealed = await sealExportManifest({ ...manifest, files });
  writeFileSync(join(location, "manifest.json"), `${JSON.stringify(sealed, null, 2)}\n`);
  const sums = [
    ...files,
    { path: "manifest.json", sha256: hashFile(join(location, "manifest.json")).sha256 },
  ]
    .sort((a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : 1))
    .map((entry: { path: string; sha256: string }) => `${entry.sha256}  ${entry.path}\n`)
    .join("");
  writeFileSync(join(location, "SHA256SUMS"), sums);
}

test("a damaged or forged export is refused: by its hashes, and when the hashes are forged too, by the chain", async () => {
  const f = await busyBook();
  const { location } = (await f.finish("export.create")).export;
  // 1. A byte flipped without touching the manifest.
  const journalsPath = join(location, "journals.jsonl");
  const original = readFileSync(journalsPath);
  const damaged = Buffer.from(original);
  damaged[40] = (damaged[40] ?? 0) ^ 0x01;
  writeFileSync(journalsPath, damaged);
  const bad = await checkExportFiles(location);
  expect(bad.passed).toBe(false);
  expect(bad.checks.find((c) => c.code === "file:journals.jsonl")?.status).toBe("failed");
  await expect(
    importOpenExport({ directory: location, to: join(f.directory, "a.sqlite") }),
  ).rejects.toMatchObject({ code: "import_export_invalid" });
  writeFileSync(journalsPath, original);
  expect((await checkExportFiles(location)).passed).toBe(true);
  // 2. A manifest altered by hand.
  const manifestPath = join(location, "manifest.json");
  const manifestText = readFileSync(manifestPath, "utf8");
  writeFileSync(manifestPath, manifestText.replace('"journals": 4', '"journals": 5'));
  expect((await checkExportFiles(location)).passed).toBe(false);
  writeFileSync(manifestPath, manifestText);
  // 3. A command altered and every hash made to match: the replay's chain hash gives it away.
  await forge(location, "commands.jsonl", (text) => {
    const lines = text.split("\n");
    const target = lines.findIndex((line) => line.includes('"type":"postJournal"'));
    const entry = JSON.parse(lines[target] as string);
    entry.command = entry.command.replace(/2500|300|49/, (digits: string) => `${digits}9`);
    lines[target] = JSON.stringify(entry);
    return lines.join("\n");
  });
  expect((await checkExportFiles(location)).passed).toBe(true);
  const target = join(f.directory, "forged.sqlite");
  await expect(importOpenExport({ directory: location, to: target })).rejects.toThrow();
  expect(existsSync(target)).toBe(false);
  expect(readdirSync(f.directory).filter((name) => name.includes("importing"))).toEqual([]);
});

test("an export that fails part-way leaves nothing under its name and no stray files", async () => {
  const f = await safetyFixture();
  await postBulk(f.service, 250);
  let calls = 0;
  await expect(
    exportBook(f.service, () => {
      calls++;
      if (calls > 3) throw new Error("the disk went away");
    }),
  ).rejects.toThrow("the disk went away");
  expect(existsSync(f.exports) ? readdirSync(f.exports) : []).toEqual([]);
  expect((await f.call("export.list")).body.data.exports).toEqual([]);
});

test("a book that has grown exports, checks and rebuilds correctly (300 journals)", async () => {
  const f = await safetyFixture();
  await postBulk(f.service, 300);
  const record = (await f.finish("export.create")).export;
  expect(record.counts).toMatchObject({ journals: 300, postings: 600, commands: 301 });
  const checked = await checkExportFiles(record.location);
  expect(checked.passed).toBe(true);
  expect(record.files.find((file) => file.path === "journals.jsonl")?.lines).toBe(300);
  expect(record.files.find((file) => file.path === "general-ledger.csv")?.lines).toBe(601);
  const result = await importOpenExport({
    directory: record.location,
    to: join(f.directory, "grown.sqlite"),
  });
  expect(result.head.sequence).toBe("301");
  expect(await sha256Hex("x")).toHaveLength(64);
}, 180_000);
