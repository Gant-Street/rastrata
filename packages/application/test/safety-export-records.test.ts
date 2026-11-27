import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationError } from "../src/errors.ts";
import { checkExportFiles, importOpenExport } from "../src/local.ts";
import { hashFile } from "../src/local/files.ts";
import { exportBook, readAsOwner } from "../src/safety/export-job.ts";
import type { ReadOperation } from "../src/safety/export-records.ts";
import { cleanupSafetyFixtures, safetyFixture, type SafetyFixture } from "./support/safety.ts";

afterEach(cleanupSafetyFixtures);

/** The open export carries the business's own records beside the ledger: the reconciliations it finished, its rules, its payees, the tags on its accounts and the history of
 * what changed. They are the replies of the application's own read operations, written as plain files and listed in the manifest like every other. */

const RECORDS = [
  "records-account-tags.jsonl",
  "records-changes.json",
  "records-payees.json",
  "records-reconciliations.jsonl",
  "records-rules.json",
];

const ask = async (f: SafetyFixture, name: string, input: unknown) => {
  const reply = await f.call(name, input, crypto.randomUUID());
  expect(reply.status, `${name}: ${JSON.stringify(reply.body)}`).toBe(200);
  return reply.body.data;
};

/** Three entries in January (cash 31.50), a payee, a rule, a cash-flow tag on the cash account, a finished reconciliation of January, and a draft one of February. */
async function keptBook(): Promise<SafetyFixture> {
  const f = await safetyFixture();
  await f.post(3, "J");
  await ask(f, "payees.save", { name: "GitHub", words: ["GITHUB"], note: "Source hosting" });
  await ask(f, "rules.create", {
    rule: {
      name: "GitHub",
      conditions: [{ field: "description", operator: "contains", value: "github" }],
      action: { kind: "categorize", accountId: "5000" },
    },
    madeBy: { kind: "person" },
  });
  await ask(f, "accounts.setTags", {
    accountId: "1000",
    effectiveOn: "2026-01-01",
    tags: { cashFlowClass: "cash" },
  });
  const started = await ask(f, "reconcile.start", {
    accountId: "1000",
    statementDate: "2026-01-31",
    statementBalance: "31.50",
  });
  const cleared = await ask(f, "reconcile.setCleared", {
    id: started.id,
    expectedVersion: started.version,
    reset: "all",
  });
  await ask(f, "reconcile.complete", { id: started.id, expectedVersion: cleared.version });
  await ask(f, "reconcile.start", {
    accountId: "1000",
    statementDate: "2026-02-28",
    statementBalance: "31.50",
  });
  return f;
}

const jsonLines = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

test("an export holds the records around the books, listed in its manifest and checked like the rest", async () => {
  const f = await keptBook();
  const record = (await f.finish("export.create")).export;
  const names = readdirSync(record.location);
  for (const name of RECORDS) expect(names, name).toContain(name);
  // Every name is one a reader of this format version admits (letters, digits, dots and hyphens, no folder).
  for (const file of record.files) expect(file.path).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/);
  const listed = Object.fromEntries(record.files.map((file) => [file.path, file]));
  for (const name of RECORDS) {
    expect(listed[name], name).toBeDefined();
    expect(hashFile(join(record.location, name)).sha256).toBe(String(listed[name]?.sha256));
  }
  // The files that hold one record to a line say how many lines, and the ones that are one document do not.
  expect(listed["records-reconciliations.jsonl"]?.lines).toBe(1);
  expect(listed["records-account-tags.jsonl"]?.lines).toBe(1);
  expect(listed["records-rules.json"]?.lines).toBeNull();
  const checked = await checkExportFiles(record.location);
  expect(checked.passed, JSON.stringify(checked.checks)).toBe(true);
  // The README says what each is, and no longer says the rules and reconciliations are missing.
  const readme = readFileSync(join(record.location, "README.md"), "utf8");
  for (const name of RECORDS) expect(readme).toContain(`\`${name}\``);
  expect(readme).toContain("The records around the books");
  expect(readme).not.toContain("rules, reconciliation records");
  expect(readme).toContain("connections to banks and payment providers");
});

test("a finished reconciliation is exported with the lines it cleared, and a draft is not a record", async () => {
  const f = await keptBook();
  const { location } = (await f.finish("export.create")).export;
  const [only, ...rest] = jsonLines(join(location, "records-reconciliations.jsonl"));
  expect(rest).toEqual([]);
  expect(only).toMatchObject({
    status: "completed",
    statementDate: "2026-01-31",
    statementBalance: "31.50",
    difference: "0.00",
  });
  expect(only.account).toMatchObject({ id: "1000", name: "Cash" });
  expect(only.lines).toHaveLength(3);
  expect(only.lines.every((line: { selected: boolean }) => line.selected)).toBe(true);
  expect(only.recordHash).toMatch(/^[0-9a-f]{64}$/);
  // Voided later, it is still a record, and says so.
  await ask(f, "reconcile.void", { id: only.id, reason: "Statement was for the wrong month" });
  await Bun.sleep(1100);
  const again = (await f.finish("export.create")).export;
  const [voided] = jsonLines(join(again.location, "records-reconciliations.jsonl"));
  expect(voided).toMatchObject({ id: only.id, status: "voided" });
  expect(voided.void.reason).toBe("Statement was for the wrong month");
});

test("the rules, the payees and the tags on the accounts are exported as they stand, and a deleted rule is kept apart", async () => {
  const f = await keptBook();
  const first = (await f.finish("export.create")).export;
  const rules = JSON.parse(readFileSync(join(first.location, "records-rules.json"), "utf8"));
  expect(rules.rules.map((rule: { name: string }) => rule.name)).toEqual(["GitHub"]);
  expect(rules.rules[0].action).toEqual({ kind: "categorize", accountId: "5000" });
  expect(rules.deletedRules).toEqual([]);
  const payees = JSON.parse(readFileSync(join(first.location, "records-payees.json"), "utf8"));
  expect(payees.payees).toHaveLength(1);
  expect(payees.payees[0]).toMatchObject({ name: "GitHub", note: "Source hosting" });
  expect(payees.payeesHash).toMatch(/^[0-9a-f]{64}$/);
  const [tagged, ...others] = jsonLines(join(first.location, "records-account-tags.jsonl"));
  expect(others).toEqual([]);
  expect(tagged).toMatchObject({ accountId: "1000", code: "1000", name: "Cash" });
  expect(tagged.events).toContainEqual(
    expect.objectContaining({ tag: "cashFlowClass", value: "cash", source: "change" }),
  );
  // Delete the rule: it moves from the rules in force to the rules deleted.
  await ask(f, "rules.delete", {
    ruleId: rules.rules[0].id,
    expectedRevision: rules.rules[0].revision,
    madeBy: { kind: "person" },
  });
  await Bun.sleep(1100);
  const second = (await f.finish("export.create")).export;
  const after = JSON.parse(readFileSync(join(second.location, "records-rules.json"), "utf8"));
  expect(after.rules).toEqual([]);
  expect(after.deletedRules.map((rule: { name: string }) => rule.name)).toEqual(["GitHub"]);
});

test("the history of changes is exported from the day the books were opened, oldest first, with what it does not hold", async () => {
  const f = await keptBook();
  const { location } = (await f.finish("export.create")).export;
  const history = JSON.parse(readFileSync(join(location, "records-changes.json"), "utf8"));
  expect(history.count).toBe(history.changes.length);
  expect(history.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(Array.isArray(history.notCovered)).toBe(true);
  const kinds = history.changes.map((change: { kind: string }) => change.kind);
  expect(kinds[0]).toBe("book.opened");
  expect(kinds.filter((kind: string) => kind === "entry.posted")).toHaveLength(3);
  for (const kind of ["rule.created", "account.tagged", "reconciliation.completed"])
    expect(kinds, kind).toContain(kind);
  // Oldest first: the sentence of each change reads in the order the books were changed.
  const at = history.changes.map((change: { at: string }) => change.at);
  expect([...at].sort()).toEqual(at);
  // It leaves out nothing that a reader could take for a person's data beyond what the books hold: no token, no key.
  expect(readFileSync(join(location, "records-changes.json"), "utf8")).not.toMatch(
    /rst_[A-Za-z0-9]{6}|rso_|rsa_/,
  );
});

test("two exports of the same book carry the same records, byte for byte", async () => {
  const f = await keptBook();
  const a = (await f.finish("export.create")).export;
  await Bun.sleep(1100);
  const b = (await f.finish("export.create")).export;
  expect(b.id).not.toBe(a.id);
  for (const name of RECORDS)
    expect(hashFile(join(b.location, name)).sha256, name).toBe(
      hashFile(join(a.location, name)).sha256,
    );
});

test("the book is rebuilt from the export just the same, and the records change nothing about it", async () => {
  const f = await keptBook();
  const { location, head } = (await f.finish("export.create")).export;
  const target = mkdtempSync(join(tmpdir(), "rastrata-export-records-"));
  try {
    const rebuilt = await importOpenExport({
      directory: location,
      to: join(target, "rebuilt.sqlite"),
    });
    expect(rebuilt.head.chainHash).toBe(head.chainHash);
    expect(rebuilt.journals).toBe(3);
    // A record that was altered is refused by its hash, like any other file of the export.
    const forged = join(location, "records-rules.json");
    await Bun.write(forged, `${readFileSync(forged, "utf8")} `);
    expect((await checkExportFiles(location)).passed).toBe(false);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("a record that cannot be read is left out and named in the README, and the books are exported whole", async () => {
  const f = await keptBook();
  const real = readAsOwner(f.service);
  const failing: ReadOperation = (async (name: string, input?: unknown) => {
    if (name === "rules.list")
      throw new ApplicationError("rules_unavailable", "The rules could not be read just now.", 500);
    return (real as (n: string, i?: unknown) => Promise<unknown>)(name, input);
  }) as ReadOperation;
  const result = await exportBook(f.service, () => {}, failing);
  const record = result.export;
  if (!record) throw new Error("no export");
  const names = readdirSync(record.location);
  expect(names).not.toContain("records-rules.json");
  for (const name of RECORDS.filter((name) => name !== "records-rules.json"))
    expect(names, name).toContain(name);
  // No half-written file is left, and the export checks.
  expect(existsSync(join(record.location, "records-rules.json"))).toBe(false);
  expect((await checkExportFiles(record.location)).passed).toBe(true);
  const readme = readFileSync(join(record.location, "README.md"), "utf8");
  expect(readme).toContain("These could not be read, and are not in this export");
  expect(readme).toContain("`records-rules.json` (The rules could not be read just now)");
  // The ledger is whole, and so it still rebuilds.
  const target = mkdtempSync(join(tmpdir(), "rastrata-export-records-"));
  try {
    const rebuilt = await importOpenExport({
      directory: record.location,
      to: join(target, "rebuilt.sqlite"),
    });
    expect(rebuilt.head.chainHash).toBe(record.head.chainHash);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
