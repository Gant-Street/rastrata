/** The Inbox's list finds what it is asked for without looking at every line: how many lines match is a sum
 * over the days the database keeps (`app_ingest_tally_days`) when the filter says only what that counts by, and
 * the lines that wait are read in the order of their days from an index of them (`app_ingest_items_waiting`).
 * These tests hold both to the answer that looks at the lines, for many random filters, sorts and pages on lines
 * that keep changing, and hold the plans of the two queries to what makes them cheap: no pass over the lines
 * and no sort of them. */
import { afterEach, describe, expect, test } from "bun:test";
import type { InboxFilter } from "../src/client-contracts.gen.ts";
import { countFromDays, findLines, waitingScan } from "../src/slices/ingest/find.ts";
import { ingestRuntime } from "../src/slices/ingest/store.ts";
import { closeFixtures, ingestFixture } from "./support/ingest-fixture.ts";
import {
  DAYS,
  KINDS,
  SOURCES,
  STATUSES,
  type Store,
  changeLine,
  insertLine,
  looked,
} from "./support/ingest-rows.ts";
import { sequence } from "./support/kernel-book.ts";

afterEach(() => closeFixtures());

const WAITING = ["new", "proposed", "drafted"] as const;
const LEDGER_ACCOUNTS = ["acct-a", "acct-b", "acct-none"] as const;
const RANGE_DAYS = [...DAYS, "2026-01-01", "2026-03-15", "2026-06-30"] as const;

/** A random filter. Some say only what the day tally counts by, some of the lines that wait, some more. */
function randomFilter(random: () => number): InboxFilter {
  const below = (count: number) => Math.floor(random() * count);
  const some = <T>(list: readonly T[], most: number): T[] =>
    list.filter(() => random() < 0.5).slice(0, most);
  const filter: { -readonly [K in keyof InboxFilter]: InboxFilter[K] } = {};
  if (random() < 0.4) {
    // The lines that wait.
    const statuses = some(WAITING, 3);
    filter.status = statuses.length > 0 ? statuses : ["new"];
    filter.covered = false;
  } else if (random() < 0.7) {
    const statuses = some(STATUSES, 4);
    if (statuses.length > 0)
      filter.status = (random() < 0.1 ? [...statuses, "bogus"] : statuses) as NonNullable<
        InboxFilter["status"]
      >;
    if (random() < 0.5) filter.covered = random() < 0.5;
  }
  if (random() < 0.25)
    filter.provider = (SOURCES[below(SOURCES.length)] as (typeof SOURCES)[number])[0];
  if (random() < 0.2)
    filter.accountKey = (SOURCES[below(SOURCES.length)] as (typeof SOURCES)[number])[1];
  if (random() < 0.3)
    filter.ledgerAccountId = LEDGER_ACCOUNTS[below(LEDGER_ACCOUNTS.length)] as string;
  if (random() < 0.4) filter.from = RANGE_DAYS[below(RANGE_DAYS.length)] as string;
  if (random() < 0.5) filter.to = RANGE_DAYS[below(RANGE_DAYS.length)] as string;
  // What the tally does not count by, now and then, so that the lines are looked at.
  if (random() < 0.08) filter.kind = KINDS[below(KINDS.length)] as "bankLine" | "event";
  if (random() < 0.06) filter.text = `vendor${below(5)}`;
  if (random() < 0.04) filter.text = "   ";
  if (random() < 0.05) filter.direction = random() < 0.5 ? "in" : "out";
  if (random() < 0.05) filter.minAmount = "10.00";
  if (random() < 0.04) filter.exclusion = "manual";
  return filter;
}

const SORTS = [undefined, "date_asc", "date_desc", "amount_desc", "amount_asc"] as const;

/** A store that tells what it was asked, for looking at the plans of what the list asks. */
function watched(store: Store) {
  const asked: { sql: string; args: unknown[] }[] = [];
  const spy = {
    query(sql: string) {
      const statement = store.query(sql);
      return {
        get: (...args: unknown[]) => {
          asked.push({ sql, args });
          return statement.get(...(args as never[]));
        },
        all: (...args: unknown[]) => {
          asked.push({ sql, args });
          return statement.all(...(args as never[]));
        },
        run: (...args: unknown[]) => statement.run(...(args as never[])),
      };
    },
  } as unknown as Store;
  return { spy, asked };
}

function plan(store: Store, sql: string, args: unknown[]): string {
  return (
    store.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])) as { detail: string }[]
  )
    .map((row) => row.detail)
    .join(" | ");
}

describe("the Inbox's list", () => {
  for (const seed of [901, 902, 903])
    test(`is what looking at every line makes of it, as the lines change (seed ${seed})`, async () => {
      const f = await ingestFixture();
      const store = ingestRuntime(f.service).store;
      // Two of the three sources are mapped to accounts, the third has no row, as a source not yet mapped.
      const mapped = store.query(
        "INSERT INTO app_ingest_sources (provider, account_key, ledger_account_id, start_on, created_at) VALUES (?, ?, ?, NULL, '2026-01-01T00:00:00Z')",
      );
      mapped.run("csv", "csv:1000", "acct-a");
      mapped.run("csv", "csv:1100", "acct-b");
      const random = sequence(seed);
      const below = (count: number) => Math.floor(random() * count);
      const ids: string[] = [];
      let fromDays = 0;
      let fromWaiting = 0;
      let checks = 0;
      for (let round = 0; round < 8; round += 1) {
        for (let step = 0; step < 30; step += 1) {
          const roll = random();
          if (ids.length < 20 || roll < 0.35) ids.push(insertLine(store, random));
          else if (roll < 0.9) changeLine(store, random, ids[below(ids.length)] as string, step);
          else {
            const [id] = ids.splice(below(ids.length), 1);
            store.query("DELETE FROM app_ingest_items WHERE id=?").run(id as string);
          }
        }
        for (let probe = 0; probe < 60; probe += 1) {
          const filter = randomFilter(random);
          const sort = SORTS[below(SORTS.length)];
          const pageSize = [3, 7, 50][below(3)] as number;
          const page = 1 + below(3);
          const found = findLines(store, filter, sort, page, pageSize);
          const reference = looked(store, filter, sort, page, pageSize);
          const label = `seed ${seed} round ${round} ${JSON.stringify({ filter, sort, page, pageSize })}`;
          expect({ total: found.total, ids: found.rows.map((row) => row.id) }, label).toEqual(
            reference,
          );
          if (countFromDays(store, filter) !== null) fromDays += 1;
          if (waitingScan(filter, sort) !== null) fromWaiting += 1;
          checks += 1;
        }
      }
      // Both ways of answering were used a good many times, and neither one was the only one.
      expect(checks).toBe(480);
      expect(fromDays).toBeGreaterThan(100);
      expect(fromDays).toBeLessThan(checks);
      expect(fromWaiting).toBeGreaterThan(40);
      expect(fromWaiting).toBeLessThan(checks);
    });

  test("counts from the days and reads what waits from its index, with no pass over the lines and no sort of them", async () => {
    const f = await ingestFixture();
    const store = ingestRuntime(f.service).store;
    const random = sequence(911);
    for (let index = 0; index < 60; index += 1) insertLine(store, random);
    const filter: InboxFilter = { status: ["new", "proposed"], covered: false, to: "2026-03-31" };
    for (const sort of ["date_asc", "date_desc"] as const) {
      const { spy, asked } = watched(store);
      findLines(spy, filter, sort, 1, 50);
      expect(asked.length).toBe(2);
      const [count, rows] = asked as [(typeof asked)[number], (typeof asked)[number]];
      // The count is a sum over the tally of days. It does not touch the lines.
      expect(count.sql).toContain("app_ingest_tally_days");
      expect(plan(store, count.sql, count.args)).not.toContain("app_ingest_items");
      // The page is a step into the index of what waits, in the order asked for.
      const steps = plan(store, rows.sql, rows.args);
      expect(steps).toContain("app_ingest_items_waiting");
      expect(steps).not.toContain("TEMP B-TREE");
    }
    // A list that is not of what waits is read as it was, and says so in its plan.
    const { spy, asked } = watched(store);
    findLines(spy, { status: ["posted"] }, "date_desc", 1, 50);
    const rows = asked[1] as (typeof asked)[number];
    expect(plan(store, rows.sql, rows.args)).not.toContain("app_ingest_items_waiting");
  });

  test("a filter with a search, an amount or a kind is looked at line by line, and answers the same", async () => {
    const f = await ingestFixture();
    const store = ingestRuntime(f.service).store;
    const random = sequence(921);
    for (let index = 0; index < 80; index += 1) insertLine(store, random);
    for (const filter of [
      { text: "vendor2" },
      { kind: "event", status: ["new", "proposed"] },
      { minAmount: "5.00", maxAmount: "20.00" },
      { direction: "out", covered: false, status: ["new"] },
      { exclusion: "manual" },
    ] as InboxFilter[]) {
      expect(countFromDays(store, filter), JSON.stringify(filter)).toBeNull();
      expect(findLines(store, filter, "date_desc", 1, 50), JSON.stringify(filter)).toEqual({
        total: looked(store, filter, "date_desc", 1, 50).total,
        rows: expect.any(Array),
      });
    }
  });
});
