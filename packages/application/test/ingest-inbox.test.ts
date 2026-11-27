import { afterEach, expect, test } from "bun:test";
import type { Proposal } from "../src/ingest-types.ts";
import { DEFAULT_MATCH_CONFIG, scoreJournal } from "../src/ingest/match.ts";
import { ensureProposals } from "../src/slices/ingest/proposing.ts";
import { registerProposer, type ProposerRegistration } from "../src/slices/ingest/proposers.ts";
import { decidedItems, itemStates, listItems } from "../src/slices/ingest/read.ts";
import {
  batchOf,
  closeFixtures,
  ingestFixture,
  type Fixture,
  type Json,
  postManual,
} from "./support/ingest-fixture.ts";
import { expectWithin } from "./support/budget.ts";

const undo: (() => void)[] = [];
afterEach(() => {
  closeFixtures();
  for (const work of undo.splice(0).reverse()) work();
});

const list = async (f: Fixture, input: unknown = {}) => {
  const reply = await f.call("inbox.list", input);
  expect(reply.body.ok, JSON.stringify(reply.body)).toBe(true);
  return reply.body.data as Json;
};

async function twoAccounts(f: Fixture) {
  // Checking and savings, each mapped on its first batch.
  f.port.submit(
    batchOf(
      f.port,
      [
        { date: "2026-03-01", amount: "-500.00", description: "ONLINE TRANSFER TO SAVINGS" },
        { date: "2026-03-04", amount: "-12.40", description: "LUNCH" },
      ],
      { ledgerAccountId: "1000" },
    ),
  );
  f.port.submit(
    batchOf(
      f.port,
      [{ date: "2026-03-02", amount: "500.00", description: "TRANSFER FROM CHECKING" }],
      {
        ledgerAccountId: "1100",
        provider: "csv",
        sourceKey: "csv:1100",
        accountKey: "csv:1100",
      },
    ),
  );
}

test("the Inbox lists what was imported, with counts, in the shape the contract promises", async () => {
  const f = await ingestFixture();
  f.port.submit(
    batchOf(
      f.port,
      [
        {
          date: "2026-01-02",
          amount: "-4.50",
          description: "COFFEE",
          reference: "1042",
          excerpt: "2026-01-02,-4.50,COFFEE",
        },
        { date: "2026-01-05", amount: "1200.00", description: "ACH DEPOSIT" },
      ],
      { ledgerAccountId: "1000" },
    ),
  );
  const page = await list(f);
  expect(page.count).toBe(2);
  expect(page.counts).toMatchObject({ total: 2, new: 2, toReview: 2, posted: 0 });
  expect(page.items.map((item: Json) => item.line.description)).toEqual(["ACH DEPOSIT", "COFFEE"]);
  expect(page.items[1]).toMatchObject({
    status: "new",
    ledgerAccountId: "1000",
    proposalCount: 0,
    line: { kind: "bankLine", date: "2026-01-02", amount: "-4.50", reference: "1042" },
  });
});

test("reading needs read permission", async () => {
  const f = await ingestFixture();
  const denied = await f.call("inbox.list", {}, undefined, ["draft"]);
  expect(denied.status).toBe(403);
  expect(denied.body.error.code).toBe("permission_denied");
});

test("filters, search and sorting use bound values only, so a memo cannot become a query", async () => {
  const f = await ingestFixture();
  f.port.submit(
    batchOf(f.port, [
      { date: "2026-02-01", amount: "-10.00", description: "100% ORGANIC_FOODS" },
      { date: "2026-02-02", amount: "-10.00", description: "100X ORGANIC FOODS" },
      {
        date: "2026-02-03",
        amount: "250.00",
        description: "DEPOSIT '; DROP TABLE app_ingest_items; --",
      },
      { date: "2026-02-04", amount: "-99.99", description: "SOFTWARE" },
    ]),
  );
  const names = async (filter: unknown, sort?: string) =>
    ((await list(f, { filter, ...(sort ? { sort } : {}) })).items as Json[]).map(
      (item) => item.line.description,
    );
  // A percent sign and an underscore are ordinary characters in a search, not wildcards.
  expect(await names({ text: "100%" })).toEqual(["100% ORGANIC_FOODS"]);
  expect(await names({ text: "organic_f" })).toEqual(["100% ORGANIC_FOODS"]);
  expect(await names({ text: "drop table" })).toEqual([
    "DEPOSIT '; DROP TABLE app_ingest_items; --",
  ]);
  expect(await names({ direction: "in" })).toHaveLength(1);
  expect(await names({ direction: "out", minAmount: "50.00" })).toEqual(["SOFTWARE"]);
  expect(await names({ maxAmount: "10.00", from: "2026-02-02" })).toEqual(["100X ORGANIC FOODS"]);
  expect(await names({ text: "99.99" })).toEqual(["SOFTWARE"]);
  expect(await names({ status: ["posted"] })).toEqual([]);
  expect(await names({}, "amount_desc")).toEqual([
    "DEPOSIT '; DROP TABLE app_ingest_items; --",
    "SOFTWARE",
    "100X ORGANIC FOODS",
    "100% ORGANIC_FOODS",
  ]);
  expect(await names({}, "date_asc")).toHaveLength(4);
  const bad = await f.call("inbox.list", { filter: { minAmount: "-1.00" } });
  expect(bad.body.ok).toBe(false);
  expect((await f.call("inbox.list", { filter: { flag: "x' OR '1'='1" } })).body.data.count).toBe(
    0,
  );
  // The table is still there.
  expect((await list(f)).count).toBe(4);
});

test("paging reports the whole count and does not reshuffle between pages", async () => {
  const f = await ingestFixture();
  f.port.submit(
    batchOf(
      f.port,
      Array.from({ length: 130 }, (_, index) => ({
        date: "2026-02-01",
        amount: `-${index + 1}.00`,
        description: `LINE ${index}`,
      })),
    ),
  );
  const seen = new Set<string>();
  for (const page of [1, 2, 3]) {
    const result = await list(f, { page, pageSize: 50 });
    expect(result.count).toBe(130);
    for (const item of result.items) seen.add(item.id);
  }
  expect(seen.size).toBe(130);
  expect((await list(f, { page: 3, pageSize: 50 })).items).toHaveLength(30);
});

test("a transfer between two of your accounts is proposed from both sides, pairing the lines", async () => {
  const f = await ingestFixture();
  await twoAccounts(f);
  const page = await list(f);
  const out = page.items.find((item: Json) => item.line.amount === "-500.00");
  const into = page.items.find((item: Json) => item.line.amount === "500.00");
  expect(out.status).toBe("proposed");
  expect(into.status).toBe("proposed");
  expect(out.suggestion).toMatchObject({ proposer: "transfer", kind: "transfer", confidence: 85 });
  const detail = (await f.call("inbox.get", { itemId: out.id })).body.data;
  expect(detail.proposals).toHaveLength(1);
  expect(detail.proposals[0]).toMatchObject({
    proposer: "transfer",
    kind: "transfer",
    pairItemId: into.id,
    legs: [
      { accountId: "1000", amount: "-500.00" },
      { accountId: "1100", amount: "500.00" },
    ],
    narration: "Transfer from 1000 Checking to 1100 Savings",
  });
  expect(detail.proposals[0].reasons[0]).toContain("-500.00".replace("-", "")); // 500.00 appears
  const back = (await f.call("inbox.get", { itemId: into.id })).body.data;
  expect(back.proposals[0]).toMatchObject({ kind: "transfer", pairItemId: out.id });
  // Nothing was drafted or posted by proposing.
  expect((await list(f)).counts).toMatchObject({ drafted: 0, posted: 0 });
  expect((await f.call("drafts.list", {})).body.data.count).toBe(0);
});

test("a line's suggestion carries the legs it would book, so a list can name the category without opening each line", async () => {
  const f = await ingestFixture();
  await twoAccounts(f);
  const page = await list(f);
  const suggested = page.items.filter((item: Json) => item.suggestion);
  expect(suggested).toHaveLength(2);
  for (const item of suggested) {
    const detail = (await f.call("inbox.get", { itemId: item.id })).body.data;
    // Exactly the legs of the proposal the line would take, the line's own account among them.
    expect(item.suggestion.legs).toEqual(detail.proposals[0].legs);
    expect(item.suggestion.legs.length).toBeGreaterThanOrEqual(2);
  }
  // A line with nothing suggested has no suggestion, and so no legs to name.
  const lunch = page.items.find((item: Json) => item.line.description === "LUNCH");
  expect(lunch.suggestion).toBeUndefined();
});

test("a transfer needs the exact opposite amount, another account and a near date", async () => {
  const f = await ingestFixture();
  f.port.submit(
    batchOf(f.port, [{ date: "2026-03-01", amount: "-500.00", description: "OUT" }], {
      ledgerAccountId: "1000",
    }),
  );
  const submit = (date: string, amount: string, key: string, account: string) =>
    f.port.submit(
      batchOf(f.port, [{ date, amount, description: "IN" }], {
        ledgerAccountId: account,
        sourceKey: key,
        accountKey: key,
      }),
    );
  submit("2026-03-02", "500.01", "csv:1100", "1100");
  submit("2026-03-20", "500.00", "csv:2000", "2000");
  expect((await list(f, { filter: { proposer: "transfer" } })).count).toBe(0);
  // The same account is never its own transfer.
  f.port.submit(
    batchOf(f.port, [{ date: "2026-03-02", amount: "500.00", description: "REFUND" }], {
      ledgerAccountId: "1000",
    }),
  );
  expect((await list(f, { filter: { proposer: "transfer" } })).count).toBe(0);
  // The right amount on another account within the window is.
  submit("2026-03-03", "500.00", "csv:1100b", "1100");
  expect((await list(f, { filter: { proposer: "transfer" } })).count).toBe(2);
});

test("two equally near candidates hold the confidence down and say so", async () => {
  const f = await ingestFixture();
  f.port.submit(
    batchOf(f.port, [{ date: "2026-03-01", amount: "-500.00", description: "OUT" }], {
      ledgerAccountId: "1000",
    }),
  );
  for (const [key, account] of [
    ["csv:1100", "1100"],
    ["csv:2000", "2000"],
  ] as const)
    f.port.submit(
      batchOf(f.port, [{ date: "2026-03-02", amount: "500.00", description: "IN" }], {
        ledgerAccountId: account,
        sourceKey: key,
        accountKey: key,
      }),
    );
  const out = (await list(f, { filter: { direction: "out" } })).items[0];
  expect(out.suggestion.confidence).toBeLessThanOrEqual(50);
  const detail = (await f.call("inbox.get", { itemId: out.id })).body.data;
  expect(detail.proposals[0].reasons.join(" ")).toContain("equally near");
});

test("a bank line is matched to an entry that was already booked, with the reasons", async () => {
  const f = await ingestFixture();
  const journalId = await postManual(f, "2026-01-09", "SaaS subscription acme", [
    { accountId: "5000", debit: "30.00", credit: "" },
    { accountId: "1000", debit: "", credit: "30.00" },
  ]);
  f.port.submit(
    batchOf(
      f.port,
      [
        { date: "2026-01-09", amount: "-30.00", description: "ACME SAAS SUBSCRIPTION" },
        { date: "2026-01-09", amount: "-30.01", description: "ACME SAAS SUBSCRIPTION" },
      ],
      { ledgerAccountId: "1000" },
    ),
  );
  const page = await list(f);
  const matched = page.items.find((item: Json) => item.line.amount === "-30.00");
  const off = page.items.find((item: Json) => item.line.amount === "-30.01");
  expect(off.proposalCount).toBe(0);
  expect(matched.suggestion).toMatchObject({ proposer: "journal-match", kind: "match" });
  const detail = (await f.call("inbox.get", { itemId: matched.id })).body.data;
  expect(detail.proposals[0].matchJournalId).toBe(journalId);
  expect(detail.proposals[0].reasons.join(" ")).toContain("amount matches exactly");
  expect(detail.proposals[0].reasons.join(" ")).toContain("Same date");
  expect(detail.proposals[0].confidence).toBeGreaterThanOrEqual(80);
});

test("a match is not proposed when the date is far or the entry has nothing else in common", async () => {
  const f = await ingestFixture();
  await postManual(f, "2026-01-09", "Something else entirely", [
    { accountId: "5000", debit: "30.00", credit: "" },
    { accountId: "1000", debit: "", credit: "30.00" },
  ]);
  f.port.submit(
    batchOf(
      f.port,
      [
        { date: "2026-01-16", amount: "-30.00", description: "NO RELATION" },
        { date: "2026-03-01", amount: "-30.00", description: "MUCH LATER" },
      ],
      { ledgerAccountId: "1000" },
    ),
  );
  // Seven days apart with no shared words scores 3 (the exact amount) and 0: below the threshold.
  expect((await list(f, { filter: { proposer: "journal-match" } })).count).toBe(0);
});

test("the matching weights are configuration: the same facts score differently under another config", () => {
  const facts = { date: "2026-01-09", text: "ACME SAAS" };
  const journal = { id: "j1", date: "2026-01-12", narration: "acme saas fee" };
  const standard = scoreJournal("-30.00", facts, journal, DEFAULT_MATCH_CONFIG);
  expect(standard.score).toBe(3 + 2 + 2);
  const strict = scoreJournal("-30.00", facts, journal, {
    ...DEFAULT_MATCH_CONFIG,
    journal: {
      ...DEFAULT_MATCH_CONFIG.journal,
      weights: { ...DEFAULT_MATCH_CONFIG.journal.weights, nearDays: 0, wordsMany: 0 },
    },
  });
  expect(strict.score).toBe(3);
  expect(standard.reasons.join(" ")).toContain("3 days apart");
});

test("registered proposers are checked: bad suggestions are dropped with the reason, errors are isolated", async () => {
  const f = await ingestFixture();
  let version = 1;
  let calls = 0;
  const good = (account: string, id: string): Proposal => ({
    proposer: `rule:${id}`,
    kind: "categorize",
    confidence: 1,
    reasons: ["Description contains SAAS"],
    legs: [
      { accountId: "1000", amount: "-30.00" },
      { accountId: account, amount: "30.00" },
    ],
  });
  const rules: ProposerRegistration = {
    name: "example.rules",
    revision: () => `v${version}`,
    create: () => ({
      name: "example.rules",
      propose: (item) => {
        calls += 1;
        if (item.line.kind !== "bankLine" || !item.line.description.includes("SAAS")) return [];
        return [
          good("5000", "r1"),
          {
            ...good("5100", "r2"),
            legs: [
              { accountId: "1000", amount: "-30.00" },
              { accountId: "5100", amount: "29.99" },
            ],
          },
          { ...good("5100", "r3"), reasons: [] },
          { ...good("9999", "r4") },
          {
            ...good("5100", "r5"),
            legs: [
              { accountId: "5000", amount: "-30.00" },
              { accountId: "5100", amount: "30.00" },
            ],
          },
        ];
      },
    }),
  };
  undo.push(registerProposer(rules));
  undo.push(
    registerProposer({
      name: "example.broken",
      create: () => ({
        name: "example.broken",
        propose: () => {
          throw new Error("secret internals");
        },
      }),
    }),
  );
  f.port.submit(
    batchOf(f.port, [{ date: "2026-01-09", amount: "-30.00", description: "SAAS" }], {
      ledgerAccountId: "1000",
    }),
  );
  const item = (await list(f)).items[0];
  expect(item.status).toBe("proposed");
  expect(item.proposalCount).toBe(1);
  const detail = (await f.call("inbox.get", { itemId: item.id })).body.data;
  expect(detail.proposals[0]).toMatchObject({ proposer: "rule:r1", confidence: 100 });
  const problems = detail.proposalProblems.join("\n");
  expect(problems).toContain("do not add up to exactly 0.00");
  expect(problems).toContain("no reason");
  expect(problems).toContain("not in the chart");
  expect(problems).toContain("must move the line's own account by exactly -30.00");
  expect(problems).toContain("example.broken: failed on this line");
  expect(problems).not.toContain("secret internals");
  // Proposing again with nothing changed does not ask the proposer again.
  const before = calls;
  await list(f);
  await list(f);
  expect(calls).toBe(before);
  // A new revision proposes every open item again.
  version = 2;
  await list(f);
  expect(calls).toBeGreaterThan(before);
});

test("new lines make open ones propose again, so a transfer is found when the second side arrives", async () => {
  const f = await ingestFixture();
  f.port.submit(
    batchOf(f.port, [{ date: "2026-03-01", amount: "-500.00", description: "OUT" }], {
      ledgerAccountId: "1000",
    }),
  );
  expect((await list(f)).items[0].status).toBe("new");
  f.port.submit(
    batchOf(f.port, [{ date: "2026-03-02", amount: "500.00", description: "IN" }], {
      ledgerAccountId: "1100",
      sourceKey: "csv:1100",
      accountKey: "csv:1100",
    }),
  );
  const page = await list(f);
  expect(page.items.map((item: Json) => item.status)).toEqual(["proposed", "proposed"]);
});

test("an entry booked by hand after the import is found without a manual refresh", async () => {
  const f = await ingestFixture();
  f.port.submit(
    batchOf(f.port, [{ date: "2026-01-09", amount: "-30.00", description: "ACME SAAS" }], {
      ledgerAccountId: "1000",
    }),
  );
  expect((await list(f)).items[0].status).toBe("new");
  await postManual(f, "2026-01-09", "acme saas subscription", [
    { accountId: "5000", debit: "30.00", credit: "" },
    { accountId: "1000", debit: "", credit: "30.00" },
  ]);
  expect((await list(f)).items[0].status).toBe("proposed");
});

test("proposing never drafts or posts anything", async () => {
  const f = await ingestFixture();
  await twoAccounts(f);
  await ensureProposals(f.service);
  expect((await f.call("drafts.list", {})).body.data.count).toBe(0);
  expect((await f.call("sources.list", {})).body.data.count).toBe(0);
  expect((await list(f)).counts).toMatchObject({ drafted: 0, posted: 0 });
});

test("get shows provenance back to the file and row, and says plainly when an item does not exist", async () => {
  const f = await ingestFixture();
  const batch = batchOf(
    f.port,
    [
      {
        date: "2026-01-02",
        amount: "-4.50",
        description: "COFFEE",
        excerpt: "2026-01-02,-4.50,COFFEE",
      },
      { date: "2026-01-03", amount: "-1.00", description: "SECOND" },
    ],
    { ledgerAccountId: "1000" },
  );
  const report = f.port.submit(batch);
  const second = report.dispositions[1]?.itemId as string;
  const detail = (await f.call("inbox.get", { itemId: second })).body.data;
  expect(detail.provenance).toMatchObject({
    batchId: report.batchId,
    rawIndex: 1,
    rawSha256: batch.raw.sha256,
    rawName: "statement.csv",
    rawMediaType: "text/csv",
    evidenceReference: `ingest:${report.batchId}:1`,
  });
  expect(detail.provenance.sourceEventId).toMatch(/^ingest-csv-[0-9a-f]{32}$/);
  const first = (await f.call("inbox.get", { itemId: report.dispositions[0]?.itemId })).body.data;
  expect(first.provenance.excerpt).toBe("2026-01-02,-4.50,COFFEE");
  const missing = await f.call("inbox.get", { itemId: "it_nothing" });
  expect(missing.status).toBe(404);
  expect(missing.body.error.code).toBe("item_not_found");
});

test("summary, sources and balance checks tell the state of the Inbox without changing it", async () => {
  const f = await ingestFixture();
  f.port.submit(
    batchOf(
      f.port,
      [
        { date: "2026-01-02", amount: "-4.50", description: "COFFEE" },
        { date: "2025-12-30", amount: "-9.00", description: "BEFORE" },
      ],
      {
        ledgerAccountId: "1000",
        startOn: "2026-01-01",
        balances: [{ accountKey: "csv:1000", asOf: "2026-01-31", balance: "-4.50" }],
      },
    ),
  );
  f.port.submit(
    batchOf(f.port, [{ date: "2026-01-02", amount: "-2.00", description: "UNMAPPED" }], {
      sourceKey: "csv:other",
      accountKey: "csv:other",
    }),
  );
  const summary = (await f.call("inbox.summary", {})).body.data;
  expect(summary.counts).toMatchObject({
    total: 3,
    new: 2,
    excluded: 1,
    toReview: 2,
    beforeCutover: 1,
  });
  expect(summary.unmapped).toBe(1);
  expect(summary.oldestToReviewOn).toBe("2026-01-02");
  expect(summary.sources).toHaveLength(2);
  const sources = (await f.call("inbox.sources", {})).body.data.sources;
  expect(sources[0]).toMatchObject({
    accountKey: "csv:1000",
    ledgerAccountId: "1000",
    startOn: "2026-01-01",
    firstLineOn: "2025-12-30",
    lastLineOn: "2026-01-02",
    batches: 1,
  });
  const checks = (await f.call("inbox.balanceChecks", {})).body.data.checks;
  expect(checks).toEqual([
    expect.objectContaining({
      accountKey: "csv:1000",
      reported: "-4.50",
      ledger: "0.00",
      waiting: "-4.50",
      excluded: "0.00",
      difference: "0.00",
    }),
  ]);
});

test("5,000 open lines are proposed once, and reading again is fast", async () => {
  const f = await ingestFixture();
  const lines = (sign: number) =>
    Array.from({ length: 2500 }, (_, index) => ({
      date: `2026-${String(1 + (index % 12)).padStart(2, "0")}-${String(1 + (index % 27)).padStart(2, "0")}`,
      amount: `${sign < 0 ? "-" : ""}${(1 + (index % 300)).toString()}.${String(index % 100).padStart(2, "0")}`,
      description: `VENDOR ${index % 400} CARD PURCHASE ${index}`,
    }));
  f.port.submit(batchOf(f.port, lines(-1), { ledgerAccountId: "1000" }));
  f.port.submit(
    batchOf(f.port, lines(1), {
      ledgerAccountId: "1100",
      sourceKey: "csv:1100",
      accountKey: "csv:1100",
    }),
  );
  const first = performance.now();
  const page = await list(f, { pageSize: 50 });
  const firstMs = performance.now() - first;
  const second = performance.now();
  await list(f, { pageSize: 50 });
  const secondMs = performance.now() - second;
  expect(page.counts.total).toBeGreaterThan(4000);
  expect(page.counts.proposed).toBeGreaterThan(1000);
  expectWithin("the first read of the Inbox, which proposes", firstMs, 15_000);
  expectWithin("the next read of the Inbox", secondMs, 1_000);
  console.log(
    `inbox: ${page.counts.total} lines, ${page.counts.proposed} proposed; first read (proposes) ${firstMs.toFixed(0)} ms, next read ${secondMs.toFixed(0)} ms`,
  );
});

test("other lanes can read lines in pages, by provider id and decided, without touching tables", async () => {
  const f = await ingestFixture();
  f.port.submit(
    batchOf(
      f.port,
      Array.from({ length: 25 }, (_, index) => ({
        date: "2026-02-01",
        amount: `-${index + 1}.00`,
        description: `LINE ${index}`,
      })),
      { ledgerAccountId: "1000" },
    ),
  );
  const seen: string[] = [];
  let after: string | undefined;
  do {
    const page = listItems(f.service, {
      limit: 10,
      ...(after ? { after } : {}),
      statuses: ["new"],
    });
    seen.push(...page.items.map((item) => item.id));
    after = page.next ?? undefined;
  } while (after);
  expect(new Set(seen).size).toBe(25);
  expect(listItems(f.service, { limit: 5, ledgerAccountId: "1100" }).items).toHaveLength(0);
  expect(decidedItems(f.service)).toEqual([]);
  expect(itemStates(f.service, "csv", ["nope"]).size).toBe(0);
});
