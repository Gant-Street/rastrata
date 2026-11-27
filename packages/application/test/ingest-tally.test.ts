/** The counts of the Inbox's lines by state are kept by the database beside the lines (`app_ingest_tally`,
 * moved by triggers on `app_ingest_items`), so that a screen's counts are a few rows and not a pass over every
 * line. These tests hold the tally to the lines, and the counts made from it to the counts a pass over the
 * lines makes, after every one of many random changes made straight to the lines (a line arriving, changing
 * state, being covered by a payout or held back by the cutover, changing account or provider, going away),
 * which is every way a path could change a line. */
import { afterEach, describe, expect, test } from "bun:test";
import type { InboxCounts } from "../src/client-contracts.gen.ts";
import { MIGRATIONS, ingestRuntime, inboxLineDates } from "../src/slices/ingest/store.ts";
import { inboxCounts } from "../src/slices/ingest/view.ts";
import { closeFixtures, ingestFixture, type Fixture } from "./support/ingest-fixture.ts";
import { SOURCES, type Store, changeLine, insertLine } from "./support/ingest-rows.ts";
import { sequence } from "./support/kernel-book.ts";

afterEach(() => closeFixtures());

/** What the counts were before the tally: a pass over the lines that match. The tally's must be these. */
function reference(store: Store, where = "1", bindings: (string | number)[] = []): InboxCounts {
  const rows = store
    .query(
      `SELECT i.status AS status, COUNT(*) AS n FROM app_ingest_items i WHERE ${where} GROUP BY i.status`,
    )
    .all(...bindings) as { status: keyof InboxCounts; n: number }[];
  const counts = {
    total: 0,
    new: 0,
    proposed: 0,
    drafted: 0,
    posted: 0,
    excluded: 0,
    toReview: 0,
    covered: 0,
    postable: 0,
    beforeCutover: 0,
  };
  for (const row of rows) counts[row.status] = row.n;
  counts.total = rows.reduce((total, row) => total + row.n, 0);
  const count = (extra: string) =>
    (
      store
        .query(`SELECT COUNT(*) AS n FROM app_ingest_items i WHERE ${where} AND ${extra}`)
        .get(...bindings) as { n: number }
    ).n;
  counts.covered = count("i.covered_by IS NOT NULL AND i.status IN ('new', 'proposed')");
  counts.postable = counts.drafted - count("i.covered_by IS NOT NULL AND i.status = 'drafted'");
  counts.toReview = counts.new + counts.proposed - counts.covered;
  counts.beforeCutover = count(
    "i.exclusion_code IN ('before_cutover', 'catch_up') AND i.status = 'excluded'",
  );
  return counts;
}

/** Everything the tally holds, as plain data: rows that count something, in a fixed order. */
const tallied = (store: Store) =>
  store
    .query(
      "SELECT provider, account_key, status, covered, held, n FROM app_ingest_tally WHERE n != 0 ORDER BY provider, account_key, status, covered, held",
    )
    .all();

/** What a pass over the lines gives, grouped the way the tally is. */
const counted = (store: Store) =>
  store
    .query(
      `SELECT provider, account_key, status, covered_by IS NOT NULL AS covered,
         (exclusion_code IS NOT NULL AND exclusion_code IN ('before_cutover', 'catch_up') AND status = 'excluded') AS held, COUNT(*) AS n
       FROM app_ingest_items
       GROUP BY provider, account_key, status, covered_by IS NOT NULL,
         (exclusion_code IS NOT NULL AND exclusion_code IN ('before_cutover', 'catch_up') AND status = 'excluded')
       ORDER BY provider, account_key, status, covered, held`,
    )
    .all();

/** The same by day, as the list of what waits reads it: a row for each source, day and state. */
const talliedDays = (store: Store) =>
  store
    .query(
      "SELECT provider, account_key, day, status, covered, n FROM app_ingest_tally_days WHERE n != 0 ORDER BY provider, account_key, day, status, covered",
    )
    .all();
const countedDays = (store: Store) =>
  store
    .query(
      `SELECT provider, account_key, posted_on AS day, status, covered_by IS NOT NULL AS covered, COUNT(*) AS n
       FROM app_ingest_items
       GROUP BY provider, account_key, posted_on, status, covered_by IS NOT NULL
       ORDER BY provider, account_key, day, status, covered`,
    )
    .all();

function same(f: Fixture, label: string) {
  const store = ingestRuntime(f.service).store;
  expect(tallied(store), label).toEqual(counted(store));
  expect(talliedDays(store), label).toEqual(countedDays(store));
  // The days the bank lines are dated on, as the calendar reads them, are the days a pass over the lines finds.
  expect(inboxLineDates(f.service), label).toEqual(
    (
      store
        .query(
          "SELECT DISTINCT posted_on AS day FROM app_ingest_items WHERE kind = 'bankLine' ORDER BY posted_on",
        )
        .all() as { day: string }[]
    ).map((row) => row.day),
  );
  expect(inboxCounts(store), label).toEqual(reference(store));
  for (const [provider, accountKey] of SOURCES) {
    expect(inboxCounts(store, { provider }), label).toEqual(
      reference(store, "i.provider = ?", [provider]),
    );
    expect(inboxCounts(store, { provider, accountKey }), label).toEqual(
      reference(store, "i.provider = ? AND i.account_key = ?", [provider, accountKey]),
    );
  }
}

describe("the Inbox's tally of its lines", () => {
  for (const seed of [801, 802, 803])
    test(`is a pass over the lines after every random change made to them (seed ${seed})`, async () => {
      const f = await ingestFixture();
      const store = ingestRuntime(f.service).store;
      const random = sequence(seed);
      const below = (count: number) => Math.floor(random() * count);
      const ids: string[] = [];
      same(f, "empty");
      for (let step = 0; step < 150; step += 1) {
        const roll = random();
        if (ids.length === 0 || roll < 0.3) ids.push(insertLine(store, random));
        else if (roll < 0.85) {
          changeLine(store, random, ids[below(ids.length)] as string, step);
        } else {
          const [id] = ids.splice(below(ids.length), 1);
          store.query("DELETE FROM app_ingest_items WHERE id=?").run(id as string);
        }
        same(f, `seed ${seed} step ${step}`);
      }
    });

  test("a book that had lines before the tally is counted from them when the tally is made", async () => {
    const f = await ingestFixture();
    const store = ingestRuntime(f.service).store;
    const random = sequence(811);
    for (let index = 0; index < 40; index += 1) insertLine(store, random);
    // The tally as a book made before it would have none; the migration counts the lines that are there.
    store.query("DELETE FROM app_ingest_tally").run();
    // The statement the migration makes it with, as the migration says it.
    const backfill = /INSERT INTO app_ingest_tally[^;]*;/.exec(MIGRATIONS[7] as string)?.[0];
    expect(backfill).toBeString();
    store.exec(backfill as string);
    store.query("DELETE FROM app_ingest_days").run();
    const days = /INSERT INTO app_ingest_days[^;]*;/.exec(MIGRATIONS[8] as string)?.[0];
    expect(days).toBeString();
    store.exec(days as string);
    store.query("DELETE FROM app_ingest_tally_days").run();
    const byDay = /INSERT INTO app_ingest_tally_days[^;]*;/.exec(MIGRATIONS[9] as string)?.[0];
    expect(byDay).toBeString();
    store.exec(byDay as string);
    same(f, "after the backfill");
  });
});
