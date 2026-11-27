/** What an account's status says of its cleared postings is kept beside the book (`slices/reconcile/figures.ts`): the
 * number of uncleared postings, what they add up to and the date of the oldest are three numbers made from every
 * posting of the account when the cleared set changes and moved on by each posting that arrives, and not a pass over
 * the account's postings at each reading.
 *
 * Held to the pass over every posting after every step of a random history on the real operations: entries posted
 * (many dated before the newest), reconciliations started, cleared and completed, voided again, on a checking account
 * and a card; and to a count of the times the figures were made from every posting, which a look at a book that
 * only gets postings must not raise. */
import { afterEach, describe, expect, test } from "bun:test";
import { figuresMade } from "../src/slices/reconcile/figures.ts";
import { type Fixture, type Json, closeFixtures, ingestFixture } from "./support/ingest-fixture.ts";
import { sequence } from "./support/kernel-book.ts";
import { lookedAtEveryPosting, reportedStatus } from "./support/reconcile-status.ts";

afterEach(() => closeFixtures());

const uuid = () => crypto.randomUUID();
const ok = async (f: Fixture, name: string, input: unknown, operationId?: string) => {
  const reply = await f.call(name, input, operationId);
  expect(reply.body.ok, JSON.stringify(reply.body)).toBe(true);
  return reply.body.data as Json;
};

describe("the status of an account", () => {
  for (const seed of [701, 702, 703])
    test(`says what looking at every posting says, after every step of a random history of postings, reconciliations and voids (seed ${seed})`, async () => {
      const f = await ingestFixture();
      const random = sequence(seed);
      const below = (count: number) => Math.floor(random() * count);
      const pick = <T>(list: readonly T[]): T => list[below(list.length)] as T;
      const day = () =>
        `2026-${String(1 + below(12)).padStart(2, "0")}-${String(1 + below(27)).padStart(2, "0")}`;
      /** Every posting of the two accounts, so that the balance through a date is summed by hand. */
      const lines: { account: string; date: string; cents: number }[] = [];
      const post = async (date: string) => {
        const account = pick(["1000", "1000", "1100", "2000"]);
        const cents = 100 * (1 + below(500));
        const other = pick(["4000", "5000", "5100"]);
        // An asset is debited by money coming in; the card (a liability) is credited by money spent.
        const into = account !== "2000";
        const data = {
          date,
          reference: `Entry ${lines.length}`,
          narration: `Entry ${lines.length}`,
          lines: [
            {
              accountId: account,
              debit: into ? (cents / 100).toFixed(2) : "",
              credit: into ? "" : (cents / 100).toFixed(2),
            },
            {
              accountId: other,
              debit: into ? "" : (cents / 100).toFixed(2),
              credit: into ? (cents / 100).toFixed(2) : "",
            },
          ],
        };
        await ok(f, "journal.post", { data }, uuid());
        lines.push({ account, date, cents: into ? cents : -cents });
      };
      const completed: { id: string; account: string; date: string }[] = [];
      const reconcile = async (account: string) => {
        // A statement does not end in the future, and the book's year is the year of the clock these tests run in.
        const through = `2026-${String(1 + below(9)).padStart(2, "0")}-${String(1 + below(27)).padStart(2, "0")}`;
        const statement = lines
          .filter((line) => line.account === account && line.date <= through)
          .reduce((sum, line) => sum + line.cents, 0);
        // A card's statement balance is what is owed, the other way about.
        const shown = account === "2000" ? -statement : statement;
        const last = completed.filter((item) => item.account === account).at(-1);
        if (last && through <= last.date) return;
        const draft = (await ok(
          f,
          "reconcile.start",
          {
            accountId: account,
            statementDate: through,
            statementBalance: (shown / 100).toFixed(2),
          },
          uuid(),
        )) as Json;
        const all = (await ok(
          f,
          "reconcile.setCleared",
          { id: draft.id, expectedVersion: draft.version, reset: "all" },
          uuid(),
        )) as Json;
        if (!all.canComplete) {
          await ok(f, "reconcile.discard", { id: draft.id, expectedVersion: all.version }, uuid());
          return;
        }
        const done = (await ok(
          f,
          "reconcile.complete",
          { id: draft.id, expectedVersion: all.version },
          uuid(),
        )) as Json;
        completed.push({ id: done.id, account, date: through });
      };
      const voidLast = async () => {
        const last = completed.pop();
        if (last) await ok(f, "reconcile.void", { id: last.id, reason: "Wrong statement" }, uuid());
      };

      expect(await reportedStatus(f.service)).toEqual(await lookedAtEveryPosting(f.service));
      const seen = { posted: 0, completed: 0, voided: 0, someCleared: 0, rebuilt: 0 };
      for (let step = 1; step <= 60; step += 1) {
        const roll = random();
        const before = figuresMade();
        let onlyPostings = false;
        if (roll < 0.55 || lines.length < 4) {
          await post(day());
          seen.posted += 1;
          onlyPostings = true;
        } else if (roll < 0.85) {
          const count = completed.length;
          await reconcile(pick(["1000", "1100", "2000"]));
          seen.completed += completed.length - count;
        } else {
          const count = completed.length;
          await voidLast();
          seen.voided += count - completed.length;
        }
        const got = await reportedStatus(f.service);
        expect(got, `step ${step}`).toEqual(await lookedAtEveryPosting(f.service));
        seen.someCleared += Object.values(got).some((row) => row.unclearedCount > 0) ? 1 : 0;
        // Postings alone never start the figures again: one made after the last change of the cleared set is carried.
        if (onlyPostings) {
          const made = figuresMade() - before;
          seen.rebuilt += made;
        }
      }
      // The history is worth something: entries, completed and voided reconciliations, and accounts that were
      // partly cleared when they were read.
      expect(seen.posted).toBeGreaterThan(20);
      expect(seen.completed).toBeGreaterThan(3);
      expect(seen.voided).toBeGreaterThan(0);
      expect(seen.someCleared).toBeGreaterThan(20);
      // A posting that arrives and is read costs no pass over any account's postings: every account was looked at
      // after the last change of the cleared set, and the figures were moved on.
      expect(seen.rebuilt).toBe(0);
    });

  test("are made from every posting once for a look at an account, and then moved on by the postings that come", async () => {
    const f = await ingestFixture();
    const data = (date: string, cents: string) => ({
      date,
      reference: "x",
      narration: "x",
      lines: [
        { accountId: "1000", debit: cents, credit: "" },
        { accountId: "4000", debit: "", credit: cents },
      ],
    });
    await ok(f, "journal.post", { data: data("2026-01-10", "10.00") }, uuid());
    await reportedStatus(f.service);
    const base = figuresMade();
    for (let n = 1; n <= 12; n += 1) {
      await ok(
        f,
        "journal.post",
        { data: data(`2026-02-${String(n).padStart(2, "0")}`, "5.00") },
        uuid(),
      );
      expect((await reportedStatus(f.service))["1000"]).toMatchObject({
        unclearedCount: 1 + n,
        oldestUnclearedDate: "2026-01-10",
      });
    }
    // Twelve postings, twelve readings: no account's figures were made again.
    expect(figuresMade()).toBe(base);
    // A reconciliation completed makes them again, for the account that is asked about, once.
    const draft = (await ok(
      f,
      "reconcile.start",
      { accountId: "1000", statementDate: "2026-01-31", statementBalance: "10.00" },
      uuid(),
    )) as Json;
    const all = (await ok(
      f,
      "reconcile.setCleared",
      { id: draft.id, expectedVersion: draft.version, reset: "all" },
      uuid(),
    )) as Json;
    await ok(f, "reconcile.complete", { id: draft.id, expectedVersion: all.version }, uuid());
    expect((await reportedStatus(f.service))["1000"]).toMatchObject({
      unclearedCount: 12,
      oldestUnclearedDate: "2026-02-01",
    });
    const rebuilt = figuresMade();
    expect(rebuilt).toBeGreaterThan(base);
    await reportedStatus(f.service);
    expect(figuresMade()).toBe(rebuilt);
  });
});
