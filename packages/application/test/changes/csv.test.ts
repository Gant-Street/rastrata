import { expect, test } from "bun:test";
import { CHANGES_COLUMNS, changesCsv } from "../../src/changes/csv.ts";
import type { ChangeRecord } from "../../src/client-contracts.gen.ts";
import { unsafeCells, parseCsv } from "../acceptance/drive.ts";

const header = {
  title: "Changes",
  book: "=cmd|' /C calc'!A0",
  currency: "USD",
  basis: "cash",
  periodStart: "2026-01-01",
  periodEnd: "2026-12-31",
  bookRevision: "12",
  populationHash: "a".repeat(64),
  compilerVersion: "rastrata-changes-v1",
  extra: [["Notice", "Not tax advice."]] as const,
};

const change = (over: Partial<ChangeRecord>): ChangeRecord => ({
  id: "ledger:12",
  at: "2026-03-20T12:00:00.000Z",
  revision: "12",
  kind: "entry.posted",
  summary: "Posted No. 5, Mar 20, 2026: Coffee 4.85",
  subject: { kind: "journal", id: "j1" },
  by: { kind: "agent", label: "weekly-run", id: "abc" },
  how: "Entered by hand and posted",
  entry: {
    journalId: "j1",
    number: 5,
    date: "2026-03-20",
    description: "Coffee",
    amount: "4.85",
    accounts: ["6170 Meals", "1000 Chase"],
    accountCount: 2,
  },
  ...over,
});

const withoutEntry = (record: ChangeRecord): ChangeRecord => {
  const { entry: _entry, ...rest } = record;
  return rest;
};

const sources = [
  { name: "ledger", title: "The books", read: true, reason: null, changes: 2 },
  {
    name: "access",
    title: "Who has access",
    read: false,
    reason: "Agent keys were not read: this sign-in may not manage access.",
    changes: 0,
  },
] as const;

test("every text cell that could run as a formula is text, and money stays a plain decimal", () => {
  const content = changesCsv(header, {
    changes: [
      change({
        summary: '=HYPERLINK("https://x.invalid","PAY")',
        how: "+1 (555) 010-0199",
        subject: { kind: "journal", id: "@SUM(1+1)" },
        by: { kind: "unknown", label: "not recorded" },
      }),
      withoutEntry(
        change({
          id: "rule:1:1",
          revision: null,
          kind: "rule.created",
          summary: "-2+3+cmd|' /C calc'!A0",
          by: { kind: "person", label: "\tadmin" },
        }),
      ),
    ],
    sources,
    attributionFrom: "3",
    from: "2026-01-01",
  });
  const table = parseCsv(content);
  expect(unsafeCells(table)).toEqual([]);
  const rows = table.filter((row) => row.length === CHANGES_COLUMNS.length);
  const [first, second] = rows.slice(1) as [string[], string[]];
  expect(first[3]).toBe('\'=HYPERLINK("https://x.invalid","PAY")');
  expect(first[5]).toBe("4.85");
  expect(first[9]).toBe("'@SUM(1+1)");
  expect(second[0]).toBe("");
  expect(second[3]).toBe("'-2+3+cmd|' /C calc'!A0");
  // The book's name is in the head, and is neutralised there too.
  expect(table.find((row) => row[0] === "Book")?.[1]).toBe("'=cmd|' /C calc'!A0");
});

test("the head says where the makers are known from and which sources were not read in full", () => {
  const content = changesCsv(header, {
    changes: [],
    sources,
    attributionFrom: null,
    from: "2026-01-01",
  });
  const head = new Map(
    parseCsv(content)
      .filter((row) => row.length === 2)
      .map((row) => [row[0], row[1]]),
  );
  expect(head.get("Makers recorded from revision")).toBe("never");
  expect(head.get("Sources read")).toBe("The books");
  expect(head.get("Sources not read in full")).toBe(
    "Who has access (Agent keys were not read: this sign-in may not manage access.)",
  );
});

test("a maker is said the way a person says it, and 'not recorded' is said as that", () => {
  const rows = parseCsv(
    changesCsv(header, {
      changes: [
        change({ by: { kind: "owner", label: "owner" } }),
        change({ by: { kind: "service", label: "control", id: "control" } }),
        change({ by: { kind: "unknown", label: "not recorded" } }),
      ],
      sources,
      attributionFrom: "1",
      from: "2026-01-01",
    }),
  ).filter((row) => row.length === CHANGES_COLUMNS.length);
  expect(rows.slice(1).map((row) => row[7])).toEqual(["owner", "service control", "not recorded"]);
});
