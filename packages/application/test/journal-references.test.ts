/** What a person typed as the reference of a posted entry is found for the entries of a page through the indexes of
 * the drafts table, and is what the whole table gives for every entry (the way the Journal read it before it
 * read the entries of the page only): the draft of an entry typed in, the draft of an entry that came from a
 * source (known by the source, whatever its own id), the later of two drafts for the same entry, and nothing for
 * an entry no draft made (a reversal, an entry the book was given). The statements the page runs are held to the
 * indexes by their plans, so that they stay steps into an index as the table grows. */
import { afterEach, describe, expect, test } from "bun:test";
import type { LocalBookService } from "../src/local.ts";
import { type Fixture, type Json, closeFixtures, ingestFixture } from "./support/ingest-fixture.ts";

afterEach(() => closeFixtures());

const uuid = () => crypto.randomUUID();

const entry = (reference: string, source?: string, date = "2026-03-02") => ({
  date,
  reference,
  narration: `Narration of ${reference}`,
  ...(source ? { source: { id: source, description: `From ${source}` } } : {}),
  lines: [
    { accountId: "5000", debit: "12.00", credit: "" },
    { accountId: "1000", debit: "", credit: "12.00" },
  ],
});

async function post(f: Fixture, data: unknown): Promise<string> {
  const reply = await f.call("journal.post", { data }, uuid());
  expect(reply.body.ok, JSON.stringify(reply.body)).toBe(true);
  return reply.body.data.plan.effects.journals[0].id as string;
}

async function reverse(f: Fixture, journalId: string): Promise<void> {
  const prepared = await f.call(
    "journal.prepareReverse",
    { journalId, accountingDate: "2026-03-20", reason: "Entered twice" },
    uuid(),
  );
  expect(prepared.body.ok, JSON.stringify(prepared.body)).toBe(true);
  const done = await f.call("operations.commit", {
    planId: prepared.body.data.planId,
    planHash: prepared.body.data.planHash,
  });
  expect(done.body.data.disposition).toBe("committed");
}

/** The two readings of a reference, which the service keeps to itself. */
const readings = (service: LocalBookService) =>
  service as unknown as {
    postedReferences(): ReadonlyMap<string, string>;
    postedReference(booked: unknown): string | undefined;
    sourceJournalId(sourceId: string): string;
  };

const plan = (service: LocalBookService, sql: string, ...args: (string | number)[]): string =>
  (service.store.query(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[])
    .map((row) => row.detail)
    .join(" | ");

describe("the reference of a posted entry", () => {
  test("is what the whole table of drafts gives, for entries typed in, from every kind of source, reversed and odd", async () => {
    const f = await ingestFixture();
    const typed: string[] = [];
    for (const [at, reference] of ["INV-1", "INV-2", "Rent", "Cash sale", "payout 9"].entries())
      typed.push(
        await post(f, entry(reference, undefined, `2026-03-${String(2 + at).padStart(2, "0")}`)),
      );
    const sources = [
      "ingest-csv-aaa",
      "ingest-stripe-bbb",
      "stripe-payout-po_1",
      "opening-2026-01-01-abc",
      "typed-by-an-agent-7",
    ];
    const sourced: string[] = [];
    for (const source of sources) sourced.push(await post(f, entry(`From ${source}`, source)));
    // An entry that was reversed, and one of each kind that is reversed besides.
    await reverse(f, typed[1] as string);
    await reverse(f, sourced[0] as string);

    const service = f.service;
    const store = service.store;
    // What the table can hold besides: a second posted draft for a source (the later is the one a reading takes),
    // a posted draft typed in whose id is the id of an entry that came from a source (it is later too), a draft
    // that waits and one that is being posted with the id of an entry (neither is a reference), and a posted
    // draft that is the entry of no one.
    const insert = (id: string, status: string, data: unknown) =>
      store
        .query("INSERT INTO app_drafts (id, version, status, body) VALUES (?, 1, ?, ?)")
        .run(id, status, JSON.stringify(data));
    insert(uuid(), "posted", { ...entry("Later for the same source", sources[2]), lines: [] });
    insert(readings(service).sourceJournalId(sources[3] as string), "posted", {
      ...entry("Typed, with the id of a source's entry"),
    });
    insert(uuid(), "draft", entry("Waiting", sources[4]));
    insert(readings(service).sourceJournalId(sources[1] as string), "posting", entry("Posting"));
    insert("no-such-entry", "posted", entry("Of no entry"));

    const { aggregate } = await service.readAggregate();
    const whole = readings(service).postedReferences();
    const found = new Set<string>();
    for (const booked of aggregate.state.journals) {
      const id = booked.journal.id as string;
      expect(readings(service).postedReference(booked), id).toBe(whole.get(id));
      if (whole.has(id)) found.add(id);
    }
    // The reading is worth something: every entry that has a reference was found, among entries that have none.
    expect(found.size).toBeGreaterThanOrEqual(typed.length + sourced.length - 1);
    expect(found.size).toBeLessThan(aggregate.state.journals.length);
    // And the later draft for a source is the entry's reference, in both.
    const stripeId = readings(service).sourceJournalId(sources[2] as string);
    expect(whole.get(stripeId)).toBe("Later for the same source");
    // The page says the same as the whole table does: Rent keeps the reference that was typed for it.
    const page = await f.call("journal.list", { page: 1 });
    const rows = page.body.data.entries as Json[];
    expect(rows.find((row) => row.id === typed[2])?.reference).toBe(whole.get(typed[2] as string));
    expect(rows.find((row) => row.id === typed[3])?.reference).toBe("Cash sale");
  });

  test("is found through an index in every statement the Journal runs", async () => {
    const f = await ingestFixture();
    const service = f.service;
    expect(
      plan(
        service,
        "SELECT id FROM app_drafts WHERE status IN ('draft', 'posting') ORDER BY rowid DESC",
      ),
    ).toContain("app_drafts_waiting");
    expect(
      plan(
        service,
        "SELECT COUNT(*) AS count FROM app_drafts WHERE status IN ('draft', 'posting')",
      ),
    ).toContain("app_drafts_waiting");
    const byId = plan(
      service,
      "SELECT rowid, id, body FROM app_drafts WHERE id = ? AND status = 'posted'",
      "x",
    );
    expect(byId).toContain("sqlite_autoindex_app_drafts_1");
    expect(byId).not.toContain("SCAN");
    const bySource = plan(
      service,
      "SELECT rowid, id, body FROM app_drafts WHERE status = 'posted' AND json_extract(body, '$.source.id') = ? ORDER BY rowid DESC LIMIT 1",
      "x",
    );
    expect(bySource).toContain("app_drafts_source");
    expect(bySource).not.toContain("SCAN");
  });
});
