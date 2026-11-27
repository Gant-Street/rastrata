/** What the application keeps current from what changed is what is made from nothing, at the size of a business's
 * book: the Inbox's suggestions and the lines' counts, the classifier's examples and model, the periods that hold
 * an entry, the entries a line might be and the list of changes are each compared, after every step of a random
 * history, with the same thing made from the whole book or from every line (`test/support/kept-current.ts`).
 * The books are those of `bench/reads.ts`, with 2,000 journals and 1,500 lines waiting and with 10,000 journals
 * and 5,000 lines waiting; the histories are every kind of change that moves any of them (journals posted
 * straight to the ledger and others by hand, lines arriving, lines categorized, accepted, posted, undone and set
 * aside, entries reversed, a month closed and opened). The same comparisons are made at a modest size in
 * `test/proposals-kept-current.test.ts`, `test/changes/kept-current.test.ts` and the tests beside them, on
 * more books and more steps. Run it with `bun run --cwd packages/application test:slow`. */
import { afterAll, describe, expect, test } from "bun:test";
import { ingestPort } from "../src/slices/ingest/port.ts";
import type { BankLine } from "../src/ingest-types.ts";
import { postBulk, reverseBulk } from "../test/support/bulk-book.ts";
import { bulkInboxBook } from "../test/support/bulk-inbox.ts";
import { sequence } from "../test/support/kernel-book.ts";
import { callOn, checkKeptCurrent, postByHand } from "../test/support/kept-current.ts";

const MERCHANTS = [
  "GITHUB INC SAN FRANCISCO CA",
  "NOTION LABS INC",
  "BLUE BOTTLE COFFEE",
  "AMAZON WEB SERVICES",
  "STAPLES 00441",
  "MONTHLY SERVICE FEE",
  "UBER TRIP HELP",
  "DELTA AIR LINES",
  "COMCAST CABLE",
  "WEWORK MEMBERSHIP",
  "ZOOM VIDEO COMMUNICATIONS",
  "FEDEX OFFICE",
  "SHELL OIL SERVICE",
  "WHOLE FOODS MARKET",
  "ADOBE CREATIVE CLOUD",
  "SLACK TECHNOLOGIES",
];
const EXPENSES = ["5000", "6000", "6001", "6002", "6003"] as const;
/** The months the history closes and opens again: nothing is posted to the ledger straight into them, because a
 * closed month refuses it. */
const CLOSABLE = ["period-02", "period-03"] as const;
const OPEN_MONTHS = [1, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
const SIZES = [
  { journals: 2000, lines: 1500, steps: 30, seed: 3001 },
  { journals: 10000, lines: 5000, steps: 14, seed: 3002 },
] as const;

const cleanup: (() => void)[] = [];
afterAll(() => {
  for (const work of cleanup.splice(0).reverse()) work();
});

const KINDS = [
  "postings straight to the ledger",
  "an entry by hand",
  "lines categorized and posted",
  "a suggestion accepted",
  "a posting undone",
  "an entry reversed",
  "a line set aside and one restored",
  "a month closed or opened",
  "lines arrive",
  "nothing changes",
] as const;

describe("what is kept current from what changed, at the size of a business's book", () => {
  for (const { journals, lines, steps, seed } of SIZES)
    test(`is what is made from nothing, after every step of a random history on ${journals} journals and ${lines} lines`, async () => {
      const made = await bulkInboxBook(journals, lines, (work) => cleanup.push(work), {
        accounts: 8,
        description: (index) => `${MERCHANTS[index % MERCHANTS.length]} ${index}`,
        cleared: 0.8,
      });
      const { service } = made;
      const random = sequence(seed);
      const below = (count: number) => Math.floor(random() * count);
      const pick = <T>(list: readonly T[]): T => list[below(list.length)] as T;
      const day = (month: number) =>
        `2026-${String(month).padStart(2, "0")}-${String(1 + below(27)).padStart(2, "0")}`;
      const rows = (where: string, limit = 400) =>
        service.store
          .query(
            `SELECT id, posted_on, amount FROM app_ingest_items WHERE ${where} ORDER BY seq LIMIT ${limit}`,
          )
          .all() as { id: string; posted_on: string; amount: string }[];
      // The journals that are not yet reversed, and dated in a month that is never closed.
      const reversible = Array.from({ length: journals }, (_, at) => at + 1)
        .filter((n) => n % 20 !== 0 && (OPEN_MONTHS as readonly number[]).includes(1 + (n % 12)))
        .map((n) => `bulk-${n}`);
      const closed = new Set<string>();
      let arrived = 0;
      const hits = new Map<string, number>();

      await checkKeptCurrent(service, "the book as it was built");
      for (let step = 1; step <= steps; step += 1) {
        // Every kind in turn, in an order that changes with the seed, and then at random.
        const kind = (
          step <= KINDS.length ? KINDS[(step - 1 + seed) % KINDS.length] : pick(KINDS)
        ) as (typeof KINDS)[number];
        if (kind === "postings straight to the ledger")
          await postBulk(service, 1 + below(3), {
            entry: () => ({
              date: day(pick(OPEN_MONTHS)),
              debit: "1000",
              credit: pick(["4000", "4000", "3000"]),
              cents: BigInt(500 + below(40000)),
            }),
          });
        else if (kind === "an entry by hand") {
          // Very often for exactly the amount of a line waiting, near its date.
          const waiting = rows("status IN ('new', 'proposed') AND covered_by IS NULL", 50);
          const aimed = waiting.length > 0 && random() < 0.8 ? pick(waiting) : undefined;
          const size = (aimed ? aimed.amount : "25.00").replace("-", "");
          const date = aimed
            ? `${aimed.posted_on.slice(0, 7)}-${String(Math.min(28, Math.max(1, Number(aimed.posted_on.slice(8)) + below(7) - 3))).padStart(2, "0")}`
            : day(4);
          await postByHand(service, date, `By hand ${step}`, [
            { accountId: pick(EXPENSES), debit: size, credit: "" },
            { accountId: "1000", debit: "", credit: size },
          ]);
        } else if (kind === "lines categorized and posted") {
          const open = rows("status IN ('new', 'proposed') AND covered_by IS NULL", 400);
          const chosen = open.filter(() => random() < 0.08).slice(0, 8);
          if (chosen.length > 0) {
            for (const item of chosen)
              await callOn(
                service,
                "inbox.categorize",
                { itemIds: [item.id], accountId: pick(EXPENSES) },
                crypto.randomUUID(),
              );
            await callOn(
              service,
              "inbox.post",
              { itemIds: chosen.map((item) => item.id) },
              crypto.randomUUID(),
            );
          }
        } else if (kind === "a suggestion accepted") {
          const proposed = rows("status = 'proposed'", 100);
          if (proposed.length > 0)
            await callOn(
              service,
              "inbox.accept",
              { itemIds: [pick(proposed).id] },
              crypto.randomUUID(),
            );
        } else if (kind === "a posting undone") {
          const posted = rows("status = 'posted'", 100);
          if (posted.length > 0)
            await callOn(
              service,
              "inbox.undo",
              { itemIds: [pick(posted).id] },
              crypto.randomUUID(),
            );
        } else if (kind === "an entry reversed") {
          const id = reversible.splice(below(reversible.length), 1)[0];
          if (id !== undefined) await reverseBulk(service, [id]);
        } else if (kind === "a line set aside and one restored") {
          const open = rows("status IN ('new', 'proposed') AND covered_by IS NULL", 100);
          const aside = rows("status = 'excluded'", 100);
          if (open.length > 0)
            await callOn(
              service,
              "inbox.exclude",
              { itemIds: [pick(open).id], reason: "Not business" },
              crypto.randomUUID(),
            );
          if (aside.length > 0)
            await callOn(
              service,
              "inbox.restore",
              { itemIds: [pick(aside).id], reason: "It is business" },
              crypto.randomUUID(),
            );
        } else if (kind === "a month closed or opened") {
          const period = pick(CLOSABLE);
          const operation = closed.has(period) ? "reopen" : "close";
          const prepared = await callOn(
            service,
            "periods.prepare",
            { periodId: period, operation, reason: "Probe" },
            crypto.randomUUID(),
          );
          if (prepared.ok && prepared.data.valid !== false) {
            const done = await callOn(service, "operations.commit", {
              planId: prepared.data.planId,
              planHash: prepared.data.planHash,
            });
            if (done.ok && done.data.disposition === "committed") {
              if (operation === "close") closed.add(period);
              else closed.delete(period);
            }
          }
        } else if (kind === "lines arrive") {
          const port = ingestPort(service);
          const fresh: BankLine[] = Array.from({ length: 5 + below(25) }, (_, at) => ({
            kind: "bankLine",
            provider: "csv",
            accountKey: "csv:1000",
            rawIndex: at,
            postedOn: day(1 + below(12)),
            amount: `-${(1 + below(300)).toString()}.${String(below(100)).padStart(2, "0")}`,
            currency: "USD",
            description: `${pick(MERCHANTS)} ${1_000_000 + arrived + at}`,
          }));
          arrived += fresh.length;
          port.submit({
            provider: "csv",
            sourceKey: "csv:1000",
            raw: port.archive(
              new TextEncoder().encode(JSON.stringify(fresh)),
              "text/csv",
              `later-${step}.csv`,
            ),
            lines: fresh,
            balances: [],
            fetchedAt: new Date().toISOString(),
            ledgerAccountId: "1000",
          });
        }
        hits.set(kind, (hits.get(kind) ?? 0) + 1);
        await checkKeptCurrent(service, `step ${step} (${kind})`);
      }
      // Every kind of change happened, and the Inbox still had lines to make suggestions for.
      expect(hits.size).toBe(KINDS.length);
      const open = (
        service.store
          .query("SELECT COUNT(*) AS n FROM app_ingest_items WHERE status IN ('new', 'proposed')")
          .get() as { n: number }
      ).n;
      expect(open).toBeGreaterThan(100);
    }, 3_600_000);
});
