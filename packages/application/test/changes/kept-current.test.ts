/** The changes the ledger holds are kept current from the ledger's own new revisions (`LedgerChanges` in
 * `changes/ledger.ts`), and the list is made from them without making each change into a candidate. These
 * tests hold that to what is made from the whole book: the changes kept from state to state against the
 * changes made from the state, at every state of random books with makers recorded as they come and some of
 * them late; and the list itself, for the inputs a client sends, against the list made from the whole book,
 * on a book that has had a change of every kind, before and after more changes. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type CommitIndex,
  buildLedgerChanges,
  ledgerChangesFor,
} from "../../src/changes/ledger.ts";
import { BUSINESS_PERMISSIONS } from "../../src/schema.ts";
import { listChanges } from "../../src/slices/changes/list.ts";
import { changesState } from "../../src/slices/changes/store.ts";
import { KernelBook, sequence } from "../support/kernel-book.ts";
import { playRandomBook } from "../support/random-book.ts";
import { CHART } from "../support/scenario.ts";
import { type MonthBook, monthBook } from "./support.ts";

/** Who asked for commands, as a test records it: the map and the order the rows came in. */
function commitsOf() {
  const index = { map: new Map(), ids: [] as string[], generation: 0 } satisfies {
    map: Map<string, { principal: string; label: string; operation: string; at: string }>;
    ids: string[];
    generation: number;
  };
  return {
    index: index as CommitIndex,
    record(id: string, principal: string, label: string, at: string) {
      index.map.set(id, { principal, label, operation: "journal.post", at });
      index.ids.push(id);
    },
  };
}

describe("the changes the ledger holds", () => {
  for (const seed of [1001, 1002, 1003, 1004])
    test(`kept current from state to state they are the changes made from the book (seed ${seed})`, () => {
      const random = sequence(seed);
      const below = (count: number) => Math.floor(random() * count);
      const commits = commitsOf();
      const commandIds: string[] = [];
      let visited = 0;
      let made = 0;
      const ledgerBuilds = { late: 0 };
      playRandomBook({
        seed,
        steps: 140,
        sources: true,
        onState: ({ state }) => {
          const revisions = state.revisions;
          while (commandIds.length < revisions.length) {
            const revision = revisions[commandIds.length];
            commandIds.push(String(revision?.command.id));
            // A maker is recorded for most commands, as they are committed.
            if (random() < 0.7)
              commits.record(
                commandIds.at(-1) as string,
                ["owner", "agent:0123456789abcdef", "member:user_1"][below(3)] as string,
                ["owner", "weekly-run", "admin"][below(3)] as string,
                `2026-04-02T12:${String(below(60)).padStart(2, "0")}:00.000Z`,
              );
          }
          // And now and then the maker of a command that has been in the book for a while is recorded late.
          if (random() < 0.08 && commandIds.length > 3) {
            const id = commandIds[below(commandIds.length - 1)] as string;
            if (!commits.index.map.has(id)) {
              commits.record(id, "owner", "owner", "2026-04-03T08:00:00.000Z");
              ledgerBuilds.late += 1;
            }
          }
          const kept = ledgerChangesFor(state, commits.index);
          expect(kept.snapshot(), `seed ${seed} step ${visited}`).toEqual(
            buildLedgerChanges(state, commits.index).snapshot(),
          );
          // A window of revisions is the changes whose revision is in it, as a count and as a place.
          const items = (kept.snapshot() as { items: [string, number][] }).items;
          for (let probe = 0; probe < 4; probe += 1) {
            const head = Number(state.bookRevision);
            const after = below(head + 1);
            const through = below(head + 1);
            const { low, high } = kept.range(BigInt(after), BigInt(through));
            const inside = items.filter(
              ([revision]) => Number(revision) > after && Number(revision) <= through,
            ).length;
            expect(high - low, `seed ${seed} step ${visited}: (${after}, ${through}]`).toBe(
              through > after ? inside : 0,
            );
            if (through > after)
              expect(low).toBe(items.filter(([revision]) => Number(revision) <= after).length);
          }
          made += kept.length;
          visited += 1;
        },
      });
      expect(visited).toBe(140);
      expect(made).toBeGreaterThan(1000);
      expect(ledgerBuilds.late).toBeGreaterThan(0);
    });

  for (const ordered of [true, false])
    test(`the window of a date, found by ${ordered ? "search" : "looking, the times being out of step"}, is the same`, () => {
      const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART, chainHead: true });
      const commits = commitsOf();
      for (let step = 0; step < 40; step += 1) {
        const id = book.post(`2025-0${1 + (step % 9)}-10`, [
          ["1000", 100n + BigInt(step)],
          ["4000", -(100n + BigInt(step))],
        ]);
        const revision = book.state.revisions.at(-1);
        // The times are in order for the first thirty revisions and out of step after.
        const day = ordered || step < 30 ? 1 + Math.floor(step / 4) : 5 + (step % 3);
        commits.record(
          String(revision?.command.id),
          "owner",
          "owner",
          `2026-05-${String(day).padStart(2, "0")}T10:00:00.000Z`,
        );
        expect(id).toBeString();
      }
      const changes = ledgerChangesFor(book.state, commits.index);
      expect((changes.snapshot() as { ordered: boolean }).ordered).toBe(ordered);
      const pin = book.state.bookRevision;
      const days = Array.from(
        { length: 12 },
        (_, at) => `2026-05-${String(at + 1).padStart(2, "0")}`,
      );
      const at = (revision: bigint) => (changes.atOf(revision) ?? "").slice(0, 10);
      for (const point of days) {
        let first = pin;
        for (let revision = 1n; revision <= pin; revision += 1n)
          if (at(revision) >= point) {
            first = revision - 1n;
            break;
          }
        expect(changes.lastBeforeDay(point, pin), point).toBe(first);
        let last = pin;
        while (last > 0n && at(last) > point) last -= 1n;
        expect(changes.lastOnDay(point, pin), point).toBe(last);
      }
    });
});

describe("the list of changes", () => {
  let m: MonthBook;
  beforeAll(async () => {
    m = await monthBook();
  }, 120_000);
  afterAll(() => m?.close());

  const context = () => ({
    service: m.world.service,
    access: { bookId: m.world.service.bookId, permissions: BUSINESS_PERMISSIONS },
    operationId: "",
  });

  /** The inputs a client sends: the first page, later pages, the windows, the filters. */
  async function inputs(): Promise<Record<string, unknown>[]> {
    const first = (await listChanges(context(), { pageSize: 5 })) as {
      revision: string;
      lastReview: { upToRevision: string } | null;
    };
    const head = Number(first.revision);
    return [
      {},
      { pageSize: 1 },
      { pageSize: 7, page: 2 },
      { pageSize: 200 },
      { pageSize: 200, page: 2 },
      { since: "lastReview" },
      { since: "lastClose", pageSize: 50 },
      { since: "2026-03-05", pageSize: 100 },
      { since: String(Math.max(1, head - 5)), pageSize: 100 },
      { until: String(Math.max(1, head - 3)) },
      { until: "2026-03-04", pageSize: 100 },
      { revision: String(Math.max(1, head - 4)), pageSize: 100 },
      { kinds: ["entry.posted"], pageSize: 100 },
      { kinds: ["account.added", "book.opened"] },
      { by: { kind: "owner" }, pageSize: 100 },
      { by: { kind: "agent" } },
      { text: "Posted", pageSize: 100 },
      { since: "2026-03-02", until: "2026-03-09", kinds: ["entry.posted"], pageSize: 100 },
    ];
  }

  async function same(label: string) {
    const { aggregate } = await m.world.service.readAggregate();
    const commits = changesState(m.world.service).commitIndex();
    for (const input of await inputs()) {
      const kept = await listChanges(context(), input);
      const whole = await listChanges(context(), input, {
        ledger: buildLedgerChanges(aggregate.state, commits),
      });
      expect(kept, `${label}: ${JSON.stringify(input)}`).toEqual(whole);
    }
  }

  test("is the list made from the whole book, for every input, as the book changes", async () => {
    await same("the book as the month leaves it");
    // An entry by hand, an account added, a month closed and opened again, an entry reversed: each is a
    // change of another kind, and the list is the same as made from the whole book after each.
    m.advance();
    const posted = await m.owner.ok("journal.post", {
      data: {
        date: "2026-03-25",
        reference: "Kept current",
        narration: "An entry to follow the list",
        lines: [
          { accountId: "6200", debit: "12.00", credit: "" },
          { accountId: "1000", debit: "", credit: "12.00" },
        ],
      },
    });
    expect(posted.receipt.disposition).toBe("committed");
    await same("after an entry by hand");
    m.advance();
    const account = await m.owner.ok("accounts.prepareCreate", {
      code: "6345",
      name: "Kept current account",
      role: "expense",
      effectiveOn: "2027-01-05",
    });
    const added = await m.owner.ok("operations.commit", {
      planId: account.planId,
      planHash: account.planHash,
    });
    expect(added.disposition).toBe("committed");
    await same("after an account");
    for (const operation of ["close", "reopen"]) {
      m.advance();
      const prepared = await m.owner.ok("periods.prepare", {
        periodId: "period-03",
        operation,
        reason: "Kept current",
      });
      const done = await m.owner.ok("operations.commit", {
        planId: prepared.planId,
        planHash: prepared.planHash,
      });
      expect(done.disposition).toBe("committed");
      await same(`after the month is ${operation}d`);
    }
    m.advance();
    const entries = await m.owner.ok("journal.list", { status: "Posted" });
    const newest = entries.entries[0];
    const reversal = await m.owner.ok("journal.prepareReverse", {
      journalId: newest.id,
      accountingDate: "2026-03-27",
      reason: "Kept current",
    });
    const reversed = await m.owner.ok("operations.commit", {
      planId: reversal.planId,
      planHash: reversal.planHash,
    });
    expect(reversed.disposition).toBe("committed");
    await same("after an entry is reversed");
    // A review: the next list can start from it.
    await m.owner.ok("changes.review", {});
    await same("after a review");
  }, 120_000);
});
