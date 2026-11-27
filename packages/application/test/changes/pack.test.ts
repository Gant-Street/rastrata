/** `changes.csv` in the accountant pack: what it holds, that it is tied to the manifest like every other
 * file, that it is the same bytes when made again, and that text from outside cannot become a formula. */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseCsv, unsafeCells } from "../acceptance/drive.ts";
import { PACK_CONTRIBUTORS, packContributions } from "../../src/slices/tax/accountant.ts";
import { ApplicationError } from "../../src/errors.ts";
import { BUSINESS_PERMISSIONS } from "../../src/schema.ts";
import { type Caller, type Json, type MonthBook, agentCaller, monthBook } from "./support.ts";

let m: MonthBook;
let agent: Awaited<ReturnType<typeof agentCaller>>;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The body of the file: the rows under its head, as a spreadsheet reads them. */
function rowsOf(content: string): Json[] {
  const table = parseCsv(content);
  const head = table.findIndex((row) => row[0] === "Revision");
  const names = table[head] as string[];
  return table
    .slice(head + 1)
    .filter((row) => row.length === names.length)
    .map((row) => Object.fromEntries(names.map((name, index) => [name, row[index] ?? ""])));
}

const headOf = (content: string): Map<string, string> => {
  const found = new Map<string, string>();
  for (const row of parseCsv(content)) {
    if (row[0] === "Revision") break;
    if (row.length === 2) found.set(row[0] as string, row[1] as string);
  }
  return found;
};

const build = async (who: Caller, input: Record<string, unknown> = { taxYear: 2026 }) =>
  who.ok("taxAccountant.build", input);

beforeAll(async () => {
  m = await monthBook();
  agent = await agentCaller(m.world, "weekly-run", ["read", "draft", "post", "configure"]);
  // An agent's work in April, and text from outside in the places the file copies it from.
  m.advance(60 * 24);
  await agent.ok("journal.post", {
    data: {
      date: "2026-03-20",
      reference: "AGENT-1",
      narration: '=HYPERLINK("https://pay.example.invalid/x","PAY")',
      lines: [
        { accountId: "6200", debit: "20.00", credit: "" },
        { accountId: "1000", debit: "", credit: "20.00" },
      ],
    },
  });
  m.advance();
  await m.owner.ok("rules.create", {
    rule: {
      name: "+1 (555) 010-0199 SUPPORT RENEWAL",
      conditions: [{ field: "description", operator: "contains", value: "ZZZ" }],
      action: { kind: "exclude" },
    },
  });
  // A pack is of the books at their latest version, and what is kept outside them is read up to the time
  // of that version: one more entry after the rule puts the rule inside it.
  m.advance();
  await m.owner.ok("journal.post", {
    data: {
      date: "2026-03-22",
      reference: "OWNER-1",
      narration: "Closing the day",
      lines: [
        { accountId: "6200", debit: "2.00", credit: "" },
        { accountId: "1000", debit: "", credit: "2.00" },
      ],
    },
  });
}, 120_000);
afterAll(() => m?.close());

describe("the pack", () => {
  test("holds changes.csv, listed in the manifest with its size, SHA-256 and population", async () => {
    const pack = await build(m.owner);
    expect(pack.files.map((file: Json) => file.path)).toContain("changes.csv");
    const file = pack.files.find((item: Json) => item.path === "changes.csv") as Json;
    const manifest = JSON.parse(pack.files.at(-1).content);
    const entry = manifest.files.find((item: Json) => item.path === "changes.csv");
    expect(entry).toMatchObject({
      path: "changes.csv",
      mediaType: "text/csv; charset=utf-8",
      bytes: new TextEncoder().encode(file.content).length,
      sha256: sha256(file.content),
      population: file.population,
    });
    expect(manifest.populations.changes).toBe(file.population);
    expect(file.sha256).toBe(sha256(file.content));
    // The README says what the file is and what "not recorded" means.
    const readme = pack.files.find((item: Json) => item.path === "README.md").content as string;
    expect(readme).toContain("| `changes.csv` |");
    expect(readme).toContain("### The list of changes: `changes.csv`");
    expect(readme).toContain(
      '"not recorded" in **By** means the books did not keep who made that change',
    );
  });

  test("lists the changes of the year newest first, with who made each and how", async () => {
    const pack = await build(m.owner);
    const file = pack.files.find((item: Json) => item.path === "changes.csv") as Json;
    const rows = rowsOf(file.content);
    const head = headOf(file.content);
    expect(head.get("Report")).toBe("Changes");
    expect(head.get("Book revision")).toBe(pack.bookRevision);
    expect(head.get("Changes recorded from")).toBe("2026-01-01");
    expect(head.get("Makers recorded from revision")).toBe("1");
    expect(head.get("Sources not read in full")).toBe("none");
    expect(head.get("Not covered by this list")).toContain("Changes to 1099 vendors");
    // The books' own changes are one for each revision, and the numbers fall one at a time.
    const own = rows.filter((row) => row.Revision !== "");
    expect(own.map((row) => Number(row.Revision))).toEqual(
      Array.from({ length: own.length }, (_, index) => Number(pack.bookRevision) - index),
    );
    expect(rows.slice(0, 2).map((row) => `${row.Kind} | ${row.By}`)).toEqual([
      "entry.posted | owner",
      "rule.created | person person",
    ]);
    const agents = rows.filter((row) => row.By === "agent weekly-run");
    expect(agents.map((row) => row.Kind)).toEqual(["entry.posted"]);
    const posted = agents[0] as Json;
    expect(posted).toMatchObject({
      "Entry date": "2026-03-20",
      Amount: "20.00",
      How: "Entered by hand and posted",
    });
    expect(posted.Accounts).toBe("6200 Software and subscriptions; 1000 Chase business checking");
    // A reference is the identifier the other files use.
    expect(posted.Reference).toMatch(/^[A-Za-z0-9_-]+$/);
    const journal = pack.files.find((item: Json) => item.path === "journal.csv").content as string;
    expect(journal).toContain(posted.Reference);
  });

  test("copies text from outside as text: nothing in it can run as a formula in a spreadsheet", async () => {
    const pack = await build(m.owner);
    const file = pack.files.find((item: Json) => item.path === "changes.csv") as Json;
    expect(unsafeCells(parseCsv(file.content))).toEqual([]);
    const rows = rowsOf(file.content);
    const formula = rows.find(
      (row) => row.Kind === "entry.posted" && row.What.includes("HYPERLINK"),
    );
    expect(formula?.What).toContain("=HYPERLINK(");
    // The sentence is ours and begins with a letter; the formula sits inside it. Where a cell would have
    // begun with one, the file puts a quote in front.
    expect(formula?.What.startsWith("Posted No.")).toBe(true);
    const rule = rows.find((row) => row.Kind === "rule.created") as Json;
    expect(rule.What).toContain('"+1 (555) 010-0199 SUPPORT RENEWAL"');
  });

  test("is the same bytes when made again from the same book, and a pinned revision ignores what came later", async () => {
    const first = await build(m.owner);
    const again = await build(m.owner);
    const changes = (pack: Json) =>
      (pack.files.find((item: Json) => item.path === "changes.csv") as Json).sha256;
    expect(changes(again)).toBe(changes(first));
    expect(again.manifestSha256).toBe(first.manifestSha256);
    // Something is changed outside the books afterwards, and then something inside them.
    m.advance();
    await m.owner.ok("rules.create", {
      rule: {
        name: "A rule made after the pack",
        conditions: [{ field: "description", operator: "contains", value: "YYY" }],
        action: { kind: "exclude" },
      },
    });
    const sameRevision = await build(m.owner, { taxYear: 2026, revision: first.bookRevision });
    expect(changes(sameRevision)).toBe(changes(first));
    m.advance();
    await agent.ok("journal.post", {
      data: {
        date: "2026-03-21",
        reference: "AGENT-2",
        narration: "Another entry",
        lines: [
          { accountId: "6200", debit: "1.00", credit: "" },
          { accountId: "1000", debit: "", credit: "1.00" },
        ],
      },
    });
    const later = await build(m.owner);
    expect(changes(later)).not.toBe(changes(first));
    const pinned = await build(m.owner, { taxYear: 2026, revision: first.bookRevision });
    expect(changes(pinned)).toBe(changes(first));
    expect(pinned.manifestSha256).toBe(first.manifestSha256);
  });

  test("says what was left out for this reader, and what the list leaves out", async () => {
    // A reader who may not manage access gets the pack, and the file's head says what was left out for
    // them: the agent keys are the owner's to see, which is not a failure to read.
    const reader = await agentCaller(m.world, "reader", ["read"]);
    const pack = await build(reader);
    const file = pack.files.find((item: Json) => item.path === "changes.csv") as Json;
    const head = headOf(file.content);
    expect(head.get("Sources not read in full")).toBe("none");
    expect(head.get("Left out for this reader")).toBe(
      "Who has access (Changes to agent keys are shown to the owner.)",
    );
  });
});

describe("the seam", () => {
  test("a contributor that fails is named in the README with the reason, and the rest of the pack is made", async () => {
    const context = {
      service: m.world.service,
      access: { bookId: m.world.service.bookId, permissions: BUSINESS_PERMISSIONS },
      operationId: "",
    };
    const range = { taxYear: 2026, from: "2026-01-01", to: "2026-12-31", revision: 1n };
    const failing = {
      name: "failing",
      title: "The list of oddities (`oddities.csv`)",
      contribute: async () => {
        throw new ApplicationError("source_unreadable", "Its source could not be read.", 403);
      },
    };
    const broken = {
      name: "broken",
      title: "The list of surprises (`surprises.csv`)",
      contribute: async () => {
        throw new Error("secret detail that must not be printed");
      },
    };
    const made = await packContributions(context, range, [failing, broken, ...PACK_CONTRIBUTORS]);
    // The changes file and the two reconciliation files: what the real contributors add.
    expect(made.extras).toHaveLength(3);
    expect(made.notes).toEqual([
      "The list of oddities (`oddities.csv`) could not be made: Its source could not be read. The other files are not affected.",
      "The list of surprises (`surprises.csv`) could not be made, and nothing says why. The other files are not affected.",
    ]);
  });
});
