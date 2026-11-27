/** The reconciliation files of the accountant pack: what they hold, that they are listed in the manifest and
 * checked by it like every other file (so `rastrata tax verify-pack` needs no change), that they are the same
 * bytes when the pack is made again, which reconciliations a pack made from an older version of the books
 * has, how a voided one reads, and what the pack does when one cannot be reported on. */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BUSINESS_PERMISSIONS } from "../../src/schema.ts";
import { makeReconcileContributor } from "../../src/slices/reconcile/pack.ts";
import { packContributions } from "../../src/slices/tax/accountant.ts";
import { cents, dec } from "../acceptance/month.ts";
import { parseCsv, unsafeCells } from "../acceptance/drive.ts";
import {
  type Finished,
  type Json,
  type MonthBook,
  agentCaller,
  monthBook,
  postPayment,
  reconcileTo,
  reportOf,
} from "./support.ts";

let m: MonthBook;
let first: Finished;
let second: Finished;
let rho: Finished;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const build = (input: Record<string, unknown> = { taxYear: 2026 }, who = m.owner) =>
  who.ok("taxAccountant.build", input);
const fileOf = (pack: Json, path: string): Json =>
  pack.files.find((item: Json) => item.path === path) as Json;

/** The rows under the head of one of the two files, keyed by their column names. */
function rowsOf(content: string, firstColumn: string): Json[] {
  const table = parseCsv(content);
  const head = table.findIndex((row) => row[0] === firstColumn);
  const names = table[head] as string[];
  return table
    .slice(head + 1)
    .filter((row) => row.length === names.length)
    .map((row) => Object.fromEntries(names.map((name, index) => [name, row[index] ?? ""])));
}

const headOf = (content: string, firstColumn: string): Map<string, string> => {
  const found = new Map<string, string>();
  for (const row of parseCsv(content)) {
    if (row[0] === firstColumn) break;
    if (row.length === 2) found.set(row[0] as string, row[1] as string);
  }
  return found;
};

const VOID_REASON =
  '=HYPERLINK("https://pay.example.invalid/x","March"), then\nthe wrong statement';

beforeAll(async () => {
  m = await monthBook();
  // A formula for the name of an account, before it is reconciled: the record keeps the name it had.
  const when = (await m.owner.ok("accounts.list")).suggestedEffectiveOn as string;
  const change = await m.owner.ok("accounts.prepareChange", {
    accountId: "1010",
    name: "=Rho business checking",
    close: false,
    effectiveOn: when,
  });
  await m.owner.ok("operations.commit", { planId: change.planId, planHash: change.planHash });
  m.advance();
  first = await reconcileTo(
    m.owner,
    "1000",
    "2026-03-06",
    (line) => line.narration.includes("NORTHWIND") || line.narration.includes("CHIPOTLE"),
  );
  // The books move between them, so each is finished at a version of its own: finishing a reconciliation is not
  // a change to the books, and two finished with nothing between them are finished at the same version.
  m.advance();
  await postPayment(m.owner, {
    date: "2026-03-12",
    amount: "5.55",
    narration: "Between the statements",
  });
  m.advance();
  second = await reconcileTo(m.owner, "1000", "2026-03-13", (line) =>
    line.narration.includes("GOOGLE"),
  );
  m.advance();
  await postPayment(m.owner, { date: "2026-03-20", amount: "6.66", narration: "Before the third" });
  m.advance();
  rho = await reconcileTo(m.owner, "1010", "2026-03-31");
  m.advance();
  await m.owner.ok("reconcile.void", { id: second.record.id, reason: VOID_REASON });
  // One entry after all of it, so that the pack is made from a later version of the books than any record.
  m.advance();
  await postPayment(m.owner, {
    date: "2026-03-14",
    amount: "1.00",
    narration: "Last of the month",
  });
}, 120_000);
afterAll(() => m?.close());

describe("the two files", () => {
  test("are in the manifest with their size, SHA-256 and population, like every other file", async () => {
    const pack = await build();
    const names = pack.files.map((item: Json) => item.path);
    expect(names).toContain("reconciliations.csv");
    expect(names).toContain("reconciliation-lines.csv");
    const manifest = JSON.parse(pack.files.at(-1).content);
    for (const path of ["reconciliations.csv", "reconciliation-lines.csv"]) {
      const file = fileOf(pack, path);
      const entry = manifest.files.find((item: Json) => item.path === path);
      expect(entry).toMatchObject({
        path,
        mediaType: "text/csv; charset=utf-8",
        bytes: new TextEncoder().encode(file.content).length,
        sha256: sha256(file.content),
        population: file.population,
      });
      expect(file.sha256).toBe(sha256(file.content));
    }
    expect(manifest.populations.reconciliations).toBe(
      fileOf(pack, "reconciliations.csv").population,
    );
    expect(manifest.populations.reconciliationLines).toBe(
      fileOf(pack, "reconciliation-lines.csv").population,
    );
  });

  test("a pack built and left alone verifies: every file in it is the manifest's, and nothing else is in it", async () => {
    // What `rastrata tax verify-pack` does, from the manifest alone: every listed file hashes to its entry,
    // and every file the pack holds is listed.
    const pack = await build();
    const manifestFile = pack.files.at(-1);
    expect(manifestFile.path).toBe("manifest.json");
    expect(sha256(manifestFile.content)).toBe(pack.manifestSha256);
    const manifest = JSON.parse(manifestFile.content);
    const listed = new Set<string>();
    for (const entry of manifest.files) {
      const file = fileOf(pack, entry.path);
      expect(sha256(file.content), entry.path).toBe(entry.sha256);
      expect(new TextEncoder().encode(file.content).length, entry.path).toBe(entry.bytes);
      listed.add(entry.path);
    }
    expect(
      pack.files
        .map((item: Json) => item.path)
        .filter((path: string) => path !== "manifest.json")
        .sort(),
    ).toEqual([...listed].sort());
  });

  test("the README says what they are, in plain words", async () => {
    const readme = fileOf(await build(), "README.md").content as string;
    expect(readme).toContain("| `reconciliations.csv` |");
    expect(readme).toContain("| `reconciliation-lines.csv` |");
    expect(readme).toContain(
      "### Reconciliations: `reconciliations.csv` and `reconciliation-lines.csv`",
    );
    expect(readme).toContain("A reconciliation is the owner's check of one bank or card account");
    expect(readme).toContain("**Outstanding total**");
    expect(readme).toContain("**Difference**");
    expect(readme).toContain("**Record hash**");
    expect(readme).toContain("**Book revision**");
    expect(readme).toContain("### The lines behind them: `reconciliation-lines.csv`");
    expect(readme).toContain("**State** is `cleared`");
  });

  test("one row for each finished reconciliation with a statement date in the year, with the figures of its report", async () => {
    const pack = await build();
    const rows = rowsOf(fileOf(pack, "reconciliations.csv").content, "Reconciliation");
    // Oldest first, then by account; the voided one is listed too.
    expect(rows.map((row) => `${row["Statement date"]} ${row["Account code"]}`)).toEqual([
      "2026-03-06 1000",
      "2026-03-13 1000",
      "2026-03-31 1010",
    ]);
    for (const [row, done] of [
      [rows[0], first],
      [rows[1], second],
      [rows[2], rho],
    ] as const) {
      const report = await reportOf(m.owner, done.record.id);
      expect(row).toMatchObject({
        Reconciliation: report.id,
        "Account code": report.account.code,
        "Statement date": report.statementDate,
        "Statement balance": report.statementBalance,
        "Opening balance": report.openingBalance,
        "Cleared total": report.cleared.total,
        "Outstanding total": report.outstanding.total,
        Difference: "0.00",
        "Record hash": report.recordHash,
        "Book revision": report.bookRevision,
        Voided: report.void ? "yes" : "no",
      });
    }
    expect(rows.map((row) => row.Voided)).toEqual(["no", "yes", "no"]);
    // The account is named as it was when it was reconciled.
    expect(rows[0]?.Account).toBe("Chase business checking");
    const head = headOf(fileOf(pack, "reconciliations.csv").content, "Reconciliation");
    expect(head.get("Report")).toBe("Reconciliations");
    expect(head.get("Book revision")).toBe(pack.bookRevision);
    expect(head.get("Reconciliations in this file")).toBe("3");
    expect(head.get("Voided")).toBe("1");
    expect(head.get("Finished after this version of the books (left out)")).toBe("0");
  });

  test("every row of the second file belongs to a row of the first: cleared and outstanding, in the order of the first", async () => {
    const pack = await build();
    const rows = rowsOf(fileOf(pack, "reconciliations.csv").content, "Reconciliation");
    const lines = rowsOf(fileOf(pack, "reconciliation-lines.csv").content, "Reconciliation");
    let expected = 0;
    for (const row of rows) {
      const mine = lines.filter((line) => line.Reconciliation === row.Reconciliation);
      const report = await reportOf(m.owner, row.Reconciliation);
      expect(mine.filter((line) => line.State === "cleared")).toHaveLength(report.cleared.count);
      expect(mine.filter((line) => line.State === "outstanding")).toHaveLength(
        report.outstanding.count,
      );
      // The lines add up to the row's totals, in cents.
      const total = (state: string) =>
        mine
          .filter((line) => line.State === state)
          .reduce((sum, line) => sum + cents(line.Amount as string), 0n);
      expect(dec(total("cleared"))).toBe(row["Cleared total"]);
      expect(dec(total("outstanding"))).toBe(row["Outstanding total"]);
      expect(mine.map((line) => line.State)).toEqual(
        [...mine.map((line) => line.State)].sort((a, b) =>
          a === b ? 0 : a === "cleared" ? -1 : 1,
        ),
      );
      expected += mine.length;
    }
    expect(lines).toHaveLength(expected);
    expect(lines.length).toBeGreaterThan(10);
    // The first statement left two lines off, and they are named.
    const outstanding = lines.filter(
      (line) => line.Reconciliation === first.record.id && line.State === "outstanding",
    );
    expect(outstanding.map((line) => line.Amount).sort()).toEqual(["-18.45", "1200.00"]);
    expect(outstanding.map((line) => line["Posting ID"])).toEqual(
      first.unselected.map((line) => line.postingId),
    );
  });
});

describe("a voided reconciliation, and text from outside", () => {
  test("is listed as voided, with when and why, and its lines are the lines it had", async () => {
    const pack = await build();
    const rows = rowsOf(fileOf(pack, "reconciliations.csv").content, "Reconciliation");
    const voided = rows.find((row) => row.Reconciliation === second.record.id) as Json;
    expect(voided.Voided).toBe("yes");
    expect(voided["Voided at"]).toMatch(/^2026-04-02T/);
    const lines = rowsOf(fileOf(pack, "reconciliation-lines.csv").content, "Reconciliation").filter(
      (line) => line.Reconciliation === second.record.id,
    );
    expect(lines).toHaveLength(second.selected.length + second.unselected.length);
  });

  test("no cell of either file can run as a formula or hides what it says, whatever a bank, a person or an account's name wrote", async () => {
    const pack = await build();
    for (const path of ["reconciliations.csv", "reconciliation-lines.csv"]) {
      const content = fileOf(pack, path).content as string;
      expect(unsafeCells(parseCsv(content)), path).toEqual([]);
    }
    const rows = rowsOf(fileOf(pack, "reconciliations.csv").content, "Reconciliation");
    // The reason a reconciliation was voided begins as a formula; it is text here, with its comma and line break.
    const voided = rows.find((row) => row.Reconciliation === second.record.id) as Json;
    expect(voided["Void reason"].startsWith("'=HYPERLINK(")).toBe(true);
    expect(voided["Void reason"]).toContain("the wrong statement");
    // And an account named as a formula is text.
    const renamed = rows.find((row) => row.Reconciliation === rho.record.id) as Json;
    expect(renamed.Account).toBe("'=Rho business checking");
  });
});

describe("made again, and made from an older version of the books", () => {
  test("the same books give the same bytes: the files, their hashes and the manifest", async () => {
    const one = await build();
    const two = await build();
    for (const path of ["reconciliations.csv", "reconciliation-lines.csv"])
      expect(fileOf(two, path).sha256).toBe(fileOf(one, path).sha256);
    expect(two.manifestSha256).toBe(one.manifestSha256);
    expect(fileOf(two, "README.md").sha256).toBe(fileOf(one, "README.md").sha256);
  });

  test("a pack made from an older version of the books leaves out a reconciliation finished after it, and says how many", async () => {
    const whole = await build();
    // The version of the books the first reconciliation finished at: the later two did not exist yet.
    const older = await build({ taxYear: 2026, revision: first.record.snapshotRevision });
    const rows = rowsOf(fileOf(older, "reconciliations.csv").content, "Reconciliation");
    expect(rows.map((row) => row.Reconciliation)).toEqual([first.record.id]);
    const head = headOf(fileOf(older, "reconciliations.csv").content, "Reconciliation");
    expect(head.get("Reconciliations in this file")).toBe("1");
    expect(head.get("Finished after this version of the books (left out)")).toBe("2");
    expect(head.get("Book revision")).toBe(first.record.snapshotRevision);
    expect(fileOf(older, "reconciliations.csv").sha256).not.toBe(
      fileOf(whole, "reconciliations.csv").sha256,
    );
    // Made again from that version, it is the same bytes.
    const again = await build({ taxYear: 2026, revision: first.record.snapshotRevision });
    expect(again.manifestSha256).toBe(older.manifestSha256);
  });

  test("a range inside the year has the reconciliations whose statement ends in it", async () => {
    const pack = await build({ taxYear: 2026, from: "2026-03-07", to: "2026-03-31" });
    const rows = rowsOf(fileOf(pack, "reconciliations.csv").content, "Reconciliation");
    expect(rows.map((row) => row["Statement date"])).toEqual(["2026-03-13", "2026-03-31"]);
  });

  test("an entry made later, even one dated inside a statement's period, changes no row of the reconciliations already finished", async () => {
    const before = await build();
    m.advance();
    await postPayment(m.owner, {
      date: "2026-03-05",
      amount: "4.44",
      narration: "Dated inside the first statement, made after it",
    });
    const after = await build();
    // The books moved on: the pack is of a later version, and the journal has the entry.
    expect(after.bookRevision).not.toBe(before.bookRevision);
    expect(fileOf(after, "journal.csv").content).toContain("made after it");
    // But each reconciliation is what it was: the same rows, the same lines, and no mention of the entry.
    for (const path of ["reconciliations.csv", "reconciliation-lines.csv"]) {
      expect(rowsOf(fileOf(after, path).content, "Reconciliation"), path).toEqual(
        rowsOf(fileOf(before, path).content, "Reconciliation"),
      );
      expect(fileOf(after, path).content).not.toContain("made after it");
    }
    // Only the head moved, and it says which version the file is of.
    const heads = [before, after].map((pack) =>
      headOf(fileOf(pack, "reconciliations.csv").content, "Reconciliation"),
    );
    expect(heads[0]?.get("Book revision")).toBe(before.bookRevision);
    expect(heads[1]?.get("Book revision")).toBe(after.bookRevision);
    expect(heads[1]?.get("Reconciliations in this file")).toBe(
      heads[0]?.get("Reconciliations in this file"),
    );
    // The next reconciliation of the account is offered the entry, which is where it belongs.
    const next = await m.owner.ok("reconcile.start", {
      accountId: "1000",
      statementDate: "2026-03-20",
      statementBalance: "0.00",
    });
    expect((next.lines as Json[]).map((line) => line.narration)).toContain(
      "Dated inside the first statement, made after it",
    );
    await m.owner.ok("reconcile.discard", { id: next.id, expectedVersion: next.version });
  });

  test("a reconciliation voided afterwards shows as voided the next time, though the books have not moved", async () => {
    const before = await build();
    const rowBefore = rowsOf(fileOf(before, "reconciliations.csv").content, "Reconciliation").find(
      (row) => row.Reconciliation === rho.record.id,
    ) as Json;
    expect(rowBefore.Voided).toBe("no");
    m.advance();
    await m.owner.ok("reconcile.void", { id: rho.record.id, reason: "Wrong account" });
    const after = await build();
    const rowAfter = rowsOf(fileOf(after, "reconciliations.csv").content, "Reconciliation").find(
      (row) => row.Reconciliation === rho.record.id,
    ) as Json;
    expect(rowAfter.Voided).toBe("yes");
    expect(rowAfter["Void reason"]).toBe("Wrong account");
    expect(after.bookRevision).toBe(before.bookRevision);
    expect(fileOf(after, "reconciliations.csv").sha256).not.toBe(
      fileOf(before, "reconciliations.csv").sha256,
    );
  });
});

describe("a book that was never reconciled, and a book that cannot be reported on", () => {
  test("a pack with no reconciliation has both files, with nothing in them but the head, and says so", async () => {
    const other = await monthBook();
    try {
      const pack = await build({ taxYear: 2026 }, other.owner);
      const content = fileOf(pack, "reconciliations.csv").content as string;
      expect(rowsOf(content, "Reconciliation")).toEqual([]);
      expect(headOf(content, "Reconciliation").get("Reconciliations in this file")).toBe("0");
      expect(rowsOf(fileOf(pack, "reconciliation-lines.csv").content, "Reconciliation")).toEqual(
        [],
      );
    } finally {
      await other.close();
    }
  });

  test("when one reconciliation cannot be reported on, neither file is made, the README names it, and the rest of the pack is", async () => {
    const other = await monthBook();
    try {
      const done = await reconcileTo(other.owner, "1000", "2026-03-10");
      other.world.service.store.query("DROP TRIGGER recon_lines_frozen_update").run();
      other.world.service.store
        .query("UPDATE recon_lines SET amount='0.01' WHERE session_id=? AND ordinal=0")
        .run(done.record.id);
      const pack = await build({ taxYear: 2026 }, other.owner);
      const names = pack.files.map((item: Json) => item.path);
      expect(names).not.toContain("reconciliations.csv");
      expect(names).not.toContain("reconciliation-lines.csv");
      expect(names).toEqual(
        expect.arrayContaining(["journal.csv", "changes.csv", "trial-balance.csv"]),
      );
      const readme = fileOf(pack, "README.md").content as string;
      expect(readme).toContain("## Files that could not be made");
      expect(readme).toContain(
        "The reconciliation reports (`reconciliations.csv` and `reconciliation-lines.csv`) could not be made",
      );
      expect(readme).toContain(done.record.id);
      expect(readme).toContain("The other files are not affected.");
      // The manifest still tells the truth about what is in the pack.
      const manifest = JSON.parse(pack.files.at(-1).content);
      for (const entry of manifest.files)
        expect(sha256(fileOf(pack, entry.path).content), entry.path).toBe(entry.sha256);
    } finally {
      await other.close();
    }
  });

  test("when the lines would not fit in one pack the summary is made, the lines file is not, and the README says so", async () => {
    const context = {
      service: m.world.service,
      access: { bookId: m.world.service.bookId, permissions: BUSINESS_PERMISSIONS },
      operationId: "",
    };
    const range = {
      taxYear: 2026,
      from: "2026-01-01",
      to: "2026-12-31",
      revision: BigInt((await build()).bookRevision),
    };
    const small = await packContributions(context, range, [
      makeReconcileContributor({ mostLineRows: 5 }),
    ]);
    expect(small.extras).toHaveLength(1);
    expect(small.notes).toHaveLength(1);
    expect(small.notes[0]).toMatch(
      /^The lines behind the reconciliations \(`reconciliation-lines\.csv`\) are \d+ rows, more than one pack holds\./,
    );
    expect(small.notes[0]).toContain("rastrata reconcile report");
    const whole = await packContributions(context, range, [makeReconcileContributor()]);
    expect(whole.extras).toHaveLength(2);
    expect(whole.notes).toEqual([]);
  });

  test("a reader who may only read gets the same files", async () => {
    const reader = await agentCaller(m.world, "reader", ["read"]);
    const pack = await build({ taxYear: 2026 }, reader);
    const whole = await build();
    expect(fileOf(pack, "reconciliations.csv").sha256).toBe(
      fileOf(whole, "reconciliations.csv").sha256,
    );
  });
});
