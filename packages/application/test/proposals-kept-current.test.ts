/** The Inbox's suggestions are kept current from what changed, not worked out again from every entry of the
 * book at each reading (`keepProposalsCurrent` in `slices/ingest/proposing.ts`). These tests hold that to
 * account on random sequences of everything that changes what the Inbox shows: lines arriving, entries
 * posted by hand (here and by another process), lines categorized, accepted, posted, undone, set aside and
 * restored, entries reversed, a month closed and opened again, and the service restarted. After every step
 * the suggestions the Inbox holds are compared, line by line, with the ones made by proposing again for every
 * open line from nothing. */
import { afterEach, describe, expect, test } from "bun:test";
import { ApplicationHttp } from "../src/http.ts";
import type { LocalBookService } from "../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../src/schema.ts";
import { ClassifierModel, type TrainingExample } from "../src/rules/classifier.ts";
import { MerchantHistory } from "../src/rules/starter/proposer.ts";
import { ensureProposals, invalidateProposals } from "../src/slices/ingest/proposing.ts";
import { behind, gatherExamples } from "../src/slices/rules/classifier-ops.ts";
import { learnerOf } from "../src/slices/rules/learning.ts";
import { readExamples } from "../src/slices/rules/store.ts";
import {
  batchOf,
  closeFixtures,
  ingestFixture,
  type Fixture,
  type Json,
  type LineInit,
} from "./support/ingest-fixture.ts";
import { sequence } from "./support/kernel-book.ts";

afterEach(() => closeFixtures());

const MERCHANTS = [
  "GITHUB INC SAN FRANCISCO CA",
  "NOTION LABS INC",
  "BLUE BOTTLE COFFEE",
  "AMAZON WEB SERVICES",
  "STAPLES 00441",
  "MONTHLY SERVICE FEE",
  "ACH DEPOSIT ACME",
];
const AMOUNTS = ["-4.00", "-12.40", "-25.00", "-61.20", "-100.00", "-250.00", "40.00", "1200.00"];
const MONTHS = ["03", "04", "05"];
const uuid = () => crypto.randomUUID();

/** What the Inbox holds for every line: its status, what it said about its suggestions, and each
 * suggestion in order. */
function snapshot(f: Fixture): string {
  const store = f.service.store;
  return JSON.stringify([
    store.query("SELECT id, status, proposal_problems FROM app_ingest_items ORDER BY seq").all(),
    store
      .query(
        "SELECT item_id, rank, id, proposer, kind, confidence, body FROM app_ingest_proposals ORDER BY item_id, rank",
      )
      .all(),
  ]);
}

const openLines = (f: Fixture): number =>
  (
    f.service.store
      .query("SELECT COUNT(*) AS n FROM app_ingest_items WHERE status IN ('new', 'proposed')")
      .get() as { n: number }
  ).n;

async function callOn(
  service: LocalBookService,
  name: string,
  input: unknown,
  operationId?: string,
) {
  const http = new ApplicationHttp(service, {
    bookId: service.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  const response = await http.fetch(
    new Request(`http://127.0.0.1:4010/v1/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: service.bookId,
        input,
        ...(operationId ? { operationId } : {}),
      }),
    }),
  );
  return (await response.json()) as Json;
}

/** An entry posted through the application, as the Journal screen does it, by the given service. Null when
 * the book refuses it (a closed month). */
async function postBy(
  service: LocalBookService,
  date: string,
  narration: string,
  lines: readonly { accountId: string; debit: string; credit: string }[],
): Promise<string | null> {
  const draft = await callOn(
    service,
    "drafts.create",
    { data: { date, reference: narration.slice(0, 80), narration, lines } },
    uuid(),
  );
  if (!draft.ok) return null;
  const prepared = await callOn(
    service,
    "journal.prepare",
    { draftId: draft.data.id, expectedVersion: draft.data.version },
    uuid(),
  );
  if (!prepared.ok || !prepared.data.valid) return null;
  const done = await callOn(service, "operations.commit", {
    planId: prepared.data.planId,
    planHash: prepared.data.planHash,
  });
  return done.ok && done.data.disposition === "committed"
    ? (prepared.data.effects.journals[0].id as string)
    : null;
}

interface Totals {
  /** Readings at which a line held a suggestion from the classifier. */
  classified: number;
  steps: number;
  kept: number;
  examined: number;
  open: number;
  hits: Record<string, number>;
}

/** Run a random history and compare after every step. */
async function history(
  seed: number,
  steps: number,
  options: { classifier: boolean; wide?: boolean; consistent?: boolean },
): Promise<Totals> {
  const random = sequence(seed);
  const below = (count: number) => Math.floor(random() * count);
  const pick = <T>(list: readonly T[]): T => list[below(list.length)] as T;
  const f = await ingestFixture();
  const totals: Totals = { classified: 0, steps: 0, kept: 0, examined: 0, open: 0, hits: {} };
  // A book that is kept the same way each time has few merchants, each of them seen often.
  const merchants = options.consistent ? MERCHANTS.slice(0, 2) : MERCHANTS;
  const handMade: string[] = [];
  const closed = new Set<string>();
  const act = async (name: string, input: unknown) => {
    const reply = await f.call(name, input, uuid());
    return reply.body as Json;
  };
  const rows = (where: string) =>
    f.service.store
      .query(
        `SELECT id, posted_on, amount, status, json_extract(line, '$.description') AS description FROM app_ingest_items WHERE ${where} ORDER BY seq`,
      )
      .all() as {
      id: string;
      posted_on: string;
      amount: string;
      status: string;
      description: string;
    }[];
  const dateIn = (month: string) => `2026-${month}-${String(1 + below(27)).padStart(2, "0")}`;
  const lineInit = (): LineInit => ({
    date: dateIn(pick(MONTHS)),
    amount: pick(AMOUNTS),
    description: pick(merchants),
  });

  const check = async (label: string) => {
    const before = openLines(f);
    const report = await ensureProposals(f.service, { prepare: true });
    const maintained = snapshot(f);
    totals.classified +=
      (
        f.service.store
          .query("SELECT COUNT(*) AS n FROM app_ingest_proposals WHERE proposer = 'classifier'")
          .get() as { n: number }
      ).n > 0
        ? 1
        : 0;
    totals.kept += 1;
    totals.examined += report.examined;
    totals.open += before;
    // What the classifier holds, when it learns: the examples the whole book makes, the model and the
    // starter's history made from them, and the rows of the table, as they are before everything is marked.
    if (options.classifier) await learning(`seed ${seed} ${label}`);
    invalidateProposals(f.service);
    await ensureProposals(f.service, { prepare: true });
    expect(maintained, `seed ${seed} ${label}`).toEqual(snapshot(f));
  };
  const learning = async (label: string) => {
    const head = (await f.service.ledgerHead()).bookRevision;
    if (behind(f.service, head)) return;
    const { examples } = await gatherExamples(f.service);
    const learner = learnerOf(f.service);
    const order = (list: Iterable<TrainingExample>) =>
      JSON.stringify(
        [...list]
          .map((item) => ({ ...item, source: item.source ?? null }))
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
      );
    expect(order(learner.stored.values()), label).toEqual(order(examples));
    expect(order(readExamples(f.service.store)), label).toEqual(order(examples));
    expect(learner.model.snapshot(), label).toEqual(ClassifierModel.from(examples).snapshot());
    const history = new MerchantHistory();
    for (const item of examples) history.add(item);
    expect(learner.history.snapshot(), label).toEqual(history.snapshot());
    expect(learner.pending.size, label).toBe(0);
    const status = (await f.call("classifier.status")).body.data as Json;
    if (status.heldBack === 0) {
      expect(status.examples, label).toBe(examples.length);
      expect(status.sources.decisions, label).toBe(
        examples.filter((item) => item.key.startsWith("decision:")).length,
      );
    }
  };

  // With the classifier off nothing learns from the entries, so what the suggestions depend on of the book
  // is the entries alone, and those are what is being tested.
  if (!options.classifier) await act("classifier.configure", { enabled: false });
  // A matcher that looks two months either side, so a line far from an entry's date still depends on it
  // (the matcher's own default is ten days, which the neighbours a decision marks already cover).
  // A first batch, so there is something to match against from the start.
  f.port.submit(batchOf(f.port, Array.from({ length: 6 }, lineInit), { ledgerAccountId: "1000" }));
  if (options.wide)
    f.service.store
      .query("INSERT INTO app_ingest_settings (key, value) VALUES ('match', ?)")
      .run(JSON.stringify({ journal: { windowDays: 60 } }));
  await check("first batch");
  for (let step = 1; step <= steps; step += 1) {
    const roll = random();
    let what: string;
    if (roll < 0.14) {
      what = "lines arrive";
      // Often a line the same as one already waiting, a day or two off, so that two lines compete for the
      // one entry.
      const waiting = rows("status IN ('new', 'proposed')");
      const arrivals = Array.from({ length: 1 + below(4) }, (): LineInit => {
        const twin = waiting.length > 0 && random() < 0.5 ? pick(waiting) : undefined;
        return twin
          ? {
              date: options.wide
                ? `2026-${pick(MONTHS)}-${String(1 + below(27)).padStart(2, "0")}`
                : `2026-${twin.posted_on.slice(5, 7)}-${String(Math.min(28, Math.max(1, Number(twin.posted_on.slice(8)) + below(5) - 2))).padStart(2, "0")}`,
              amount: twin.amount,
              description: pick(merchants),
            }
          : lineInit();
      });
      f.port.submit(batchOf(f.port, arrivals, { ledgerAccountId: "1000" }));
    } else if (roll < 0.34) {
      // An entry by hand, very often for exactly the amount of a line waiting, near its date.
      what = "entry by hand";
      const line = rows("status IN ('new', 'proposed')");
      const aimed = line.length > 0 && random() < 0.8 ? pick(line) : undefined;
      const amount = aimed ? aimed.amount : pick(AMOUNTS);
      const date = aimed
        ? `2026-${aimed.posted_on.slice(5, 7)}-${String(Math.min(28, Math.max(1, Number(aimed.posted_on.slice(8)) + below(9) - 4))).padStart(2, "0")}`
        : dateIn(pick(MONTHS));
      const size = amount.replace("-", "");
      const out = amount.startsWith("-");
      const id = await postBy(f.service, date, `By hand ${step}`, [
        out
          ? { accountId: pick(["5000", "5100", "5200"]), debit: size, credit: "" }
          : { accountId: "1000", debit: size, credit: "" },
        out
          ? { accountId: "1000", debit: "", credit: size }
          : { accountId: pick(["4000", "3000"]), debit: "", credit: size },
      ]);
      if (id) handMade.push(id);
    } else if (roll < 0.42) {
      what = "entry by another process";
      const other = await f.second();
      const line = rows("status IN ('new', 'proposed')");
      const aimed = line.length > 0 ? pick(line) : undefined;
      const amount = aimed ? aimed.amount : pick(AMOUNTS);
      const size = amount.replace("-", "");
      const out = amount.startsWith("-");
      await postBy(other, aimed?.posted_on ?? dateIn("04"), `By another process ${step}`, [
        out
          ? { accountId: "5100", debit: size, credit: "" }
          : { accountId: "1000", debit: size, credit: "" },
        out
          ? { accountId: "1000", debit: "", credit: size }
          : { accountId: "4000", debit: "", credit: size },
      ]);
      other.close();
    } else if (roll < 0.56) {
      what = "categorize and post";
      const open = rows("status IN ('new', 'proposed') AND covered_by IS NULL");
      const chosen = open.filter(() => random() < 0.3).slice(0, 3);
      if (chosen.length > 0) {
        if (options.consistent) {
          // A merchant always goes to the same account, as a book that is kept does.
          for (const item of chosen)
            await act("inbox.categorize", {
              itemIds: [item.id],
              accountId: ["5000", "5100", "5200"][MERCHANTS.indexOf(item.description) % 3],
            });
        } else
          await act("inbox.categorize", {
            itemIds: chosen.map((item) => item.id),
            accountId: pick(["5000", "5100", "5200"]),
          });
        await act("inbox.post", { itemIds: chosen.map((item) => item.id) });
      }
    } else if (roll < 0.64) {
      what = "accept";
      const open = rows("status = 'proposed'");
      if (open.length > 0) {
        const item = pick(open);
        await act("inbox.accept", { itemIds: [item.id] });
        if (random() < 0.7) await act("inbox.post", { itemIds: [item.id] });
      }
    } else if (roll < 0.68) {
      what = "match to an entry";
      const matches = f.service.store
        .query(
          "SELECT p.item_id AS id FROM app_ingest_proposals p JOIN app_ingest_items i ON i.id = p.item_id WHERE p.proposer = 'journal-match' AND p.rank = 0 AND i.status = 'proposed' ORDER BY p.item_id",
        )
        .all() as { id: string }[];
      if (matches.length > 0)
        await act("inbox.accept", { itemIds: [pick(matches).id], proposer: "journal-match" });
    } else if (roll < 0.72) {
      what = "undo";
      const posted = rows("status = 'posted'");
      if (posted.length > 0) await act("inbox.undo", { itemIds: [pick(posted).id] });
    } else if (roll < 0.78) {
      what = "reverse by hand";
      const id = handMade.length > 0 ? pick(handMade) : undefined;
      if (id) {
        const prepared = await act("journal.prepareReverse", {
          journalId: id,
          accountingDate: dateIn(pick(MONTHS)),
          reason: "Probe",
        });
        if (prepared.ok && prepared.data.valid) {
          const done = await act("operations.commit", {
            planId: prepared.data.planId,
            planHash: prepared.data.planHash,
          });
          if (done.ok) handMade.splice(handMade.indexOf(id), 1);
        }
      }
    } else if (roll < 0.84) {
      what = "set aside and restore";
      const open = rows("status IN ('new', 'proposed') AND covered_by IS NULL");
      if (open.length > 0 && random() < 0.6)
        await act("inbox.exclude", { itemIds: [pick(open).id], reason: "Not business" });
      else {
        const aside = rows("status = 'excluded'");
        if (aside.length > 0)
          await act("inbox.restore", { itemIds: [pick(aside).id], reason: "It is business" });
      }
    } else if (roll < 0.9) {
      what = "close or reopen a month";
      const period = pick(["period-03", "period-04"]);
      const operation = closed.has(period) ? "reopen" : "close";
      const prepared = await act("periods.prepare", {
        periodId: period,
        operation,
        reason: "Probe",
      });
      if (prepared.ok && prepared.data.valid !== false) {
        const done = await act("operations.commit", {
          planId: prepared.data.planId,
          planHash: prepared.data.planHash,
        });
        if (done.ok && done.data.disposition === "committed") {
          if (operation === "close") closed.add(period);
          else closed.delete(period);
        }
      }
    } else if (roll < 0.94) {
      what = "restart";
      await f.restart();
    } else {
      what = "read again";
    }
    totals.hits[what] = (totals.hits[what] ?? 0) + 1;
    totals.steps += 1;
    await check(`step ${step} (${what})`);
  }
  return totals;
}

describe("the Inbox's suggestions, kept current from what changed", () => {
  for (const [classifier, wide, consistent, seeds] of [
    [false, false, false, [501, 502, 503, 504, 505, 506]],
    [false, true, false, [521, 522, 523, 524]],
    [true, false, false, [511, 512, 513]],
    [true, false, true, [531, 532, 533]],
  ] as const)
    for (const seed of seeds)
      test(`are the suggestions made for every open line from nothing, after every step (seed ${seed}, classifier ${classifier ? "on" : "off"}${wide ? ", wide window" : ""}${consistent ? ", a merchant always to one account" : ""})`, async () => {
        const totals = await history(seed, consistent ? 70 : 40, { classifier, wide, consistent });
        expect(totals.steps).toBe(consistent ? 70 : 40);
        // A book that is kept the same way teaches the classifier something to say.
        if (consistent) expect(totals.classified).toBeGreaterThan(0);
        // The check was not vacuous: every kind of change happened somewhere in the run, and with nothing
        // learning, most readings proposed for far fewer lines than were open.
        expect(Object.keys(totals.hits).length).toBeGreaterThanOrEqual(6);
        if (!classifier) expect(totals.examined).toBeLessThan(totals.open / 2);
      }, 120_000);
});

describe("what a line's suggestions depend on, one thing at a time", () => {
  const settle = async (f: Fixture, label: string) => {
    await ensureProposals(f.service, { prepare: true });
    const maintained = snapshot(f);
    invalidateProposals(f.service);
    await ensureProposals(f.service, { prepare: true });
    expect(maintained, label).toEqual(snapshot(f));
  };
  const topMatch = (f: Fixture, itemId: string) =>
    (
      f.service.store
        .query(
          "SELECT json_extract(body, '$.matchJournalId') AS id FROM app_ingest_proposals WHERE item_id = ? AND proposer = 'journal-match' AND rank = 0",
        )
        .get(itemId) as { id: string } | null
    )?.id ?? null;

  test("a line two months from an entry loses it when another line takes it, and gets it back when that is undone", async () => {
    const f = await ingestFixture();
    await callOn(f.service, "classifier.configure", { enabled: false }, uuid());
    // Two lines the same amount, forty-five days apart: more than any decision marks as a neighbour.
    const report = f.port.submit(
      batchOf(
        f.port,
        [
          { date: "2026-03-05", amount: "-42.00", description: "LUNCH DOWNTOWN CAFE" },
          { date: "2026-04-20", amount: "-42.00", description: "LUNCH DOWNTOWN CAFE" },
        ],
        { ledgerAccountId: "1000" },
      ),
    );
    const [one, two] = report.dispositions.map((item) => item.itemId as string);
    f.service.store
      .query("INSERT INTO app_ingest_settings (key, value) VALUES ('match', ?)")
      .run(JSON.stringify({ journal: { windowDays: 60 } }));
    await settle(f, "before the entry");
    expect(topMatch(f, one as string)).toBeNull();
    const entry = await postBy(f.service, "2026-04-01", "Lunch downtown cafe", [
      { accountId: "5100", debit: "42.00", credit: "" },
      { accountId: "1000", debit: "", credit: "42.00" },
    ]);
    expect(entry).not.toBeNull();
    await settle(f, "after the entry");
    expect(topMatch(f, one as string)).toBe(entry);
    expect(topMatch(f, two as string)).toBe(entry);
    // The first line takes the entry. The second no longer has it to match.
    const taken = await callOn(
      f.service,
      "inbox.accept",
      { itemIds: [one], proposer: "journal-match" },
      uuid(),
    );
    expect(taken.ok, JSON.stringify(taken)).toBe(true);
    await settle(f, "after the match");
    expect(topMatch(f, two as string)).toBeNull();
    // Taken back, the entry is the second line's again.
    const undone = await callOn(f.service, "inbox.undo", { itemIds: [one] }, uuid());
    expect(undone.ok, JSON.stringify(undone)).toBe(true);
    await settle(f, "after the undo");
    expect(topMatch(f, two as string)).toBe(entry);
    expect(topMatch(f, one as string)).toBe(entry);
  });

  test("an entry that is reversed stops being offered, and the lines that had it are proposed again", async () => {
    const f = await ingestFixture();
    await callOn(f.service, "classifier.configure", { enabled: false }, uuid());
    const [line] = f.port
      .submit(
        batchOf(
          f.port,
          [{ date: "2026-03-10", amount: "-18.00", description: "TAXI DOWNTOWN RIDE" }],
          { ledgerAccountId: "1000" },
        ),
      )
      .dispositions.map((item) => item.itemId as string);
    const entry = await postBy(f.service, "2026-03-09", "Taxi downtown ride", [
      { accountId: "5200", debit: "18.00", credit: "" },
      { accountId: "1000", debit: "", credit: "18.00" },
    ]);
    await settle(f, "with the entry");
    expect(topMatch(f, line as string)).toBe(entry);
    const prepared = await callOn(
      f.service,
      "journal.prepareReverse",
      { journalId: entry, accountingDate: "2026-03-12", reason: "Wrong" },
      uuid(),
    );
    expect(prepared.data.valid).toBe(true);
    await callOn(f.service, "operations.commit", {
      planId: prepared.data.planId,
      planHash: prepared.data.planHash,
    });
    await settle(f, "after the reversal");
    expect(topMatch(f, line as string)).toBeNull();
  });
});
