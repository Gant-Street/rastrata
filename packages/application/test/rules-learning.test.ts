/** What the classifier knows is kept current from what changed (`slices/rules/learning.ts`), not made again
 * from the whole book. These tests hold each piece to what is made from nothing: the model that forgets an
 * example as well as learns one, the starter's history that does the same, the condition under which a change
 * to either cannot change any suggestion, and the examples that are kept against the ones made from the
 * whole book after every step of random histories of the Inbox. */
import { afterEach, describe, expect, test } from "bun:test";
import {
  ClassifierModel,
  type ClassifierConfig,
  DEFAULT_CLASSIFIER_CONFIG,
  type Direction,
  type TrainingExample,
  accept,
  features,
} from "../src/rules/classifier.ts";
import { MerchantHistory, merchantHistory } from "../src/rules/starter/proposer.ts";
import { ensureProposals } from "../src/slices/ingest/proposing.ts";
import { autoLearn, gatherExamples, learnIfBehind } from "../src/slices/rules/classifier-ops.ts";
import { learned, learnerOf } from "../src/slices/rules/learning.ts";
import { readExamples } from "../src/slices/rules/store.ts";
import {
  batchOf,
  closeFixtures,
  ingestFixture,
  type Fixture,
  type Json,
} from "./support/ingest-fixture.ts";
import { sequence } from "./support/kernel-book.ts";

afterEach(() => closeFixtures());

const WORDS = ["acme", "borealis", "cedar", "delta", "ember", "fjord", "garnet", "harbor", "iris"];
const ACCOUNTS = ["5000", "5100", "5200", "4000"];
const SOURCES = ["1000", "1100", undefined];

/** A random example from a small vocabulary, so words recur and some become strong. */
function example(random: () => number, key: string): TrainingExample {
  const below = (count: number) => Math.floor(random() * count);
  const words = Array.from({ length: 1 + below(3) }, () => WORDS[below(WORDS.length)] as string);
  const source = SOURCES[below(SOURCES.length)];
  return {
    key,
    accountId: ACCOUNTS[below(ACCOUNTS.length)] as string,
    text: `${words.join(" ")} ${below(900)}`,
    direction: random() < 0.5 ? "in" : "out",
    on: `2026-0${1 + below(6)}-1${below(9)}`,
    ...(source ? { source } : {}),
  };
}

describe("a model that forgets what it learned", () => {
  for (const seed of [701, 702, 703])
    test(`is the model made from the examples it has left, after every step (seed ${seed})`, () => {
      const random = sequence(seed);
      const below = (count: number) => Math.floor(random() * count);
      const held = new Map<string, TrainingExample>();
      const model = new ClassifierModel();
      const history = new MerchantHistory();
      let counter = 0;
      for (let step = 0; step < 300; step += 1) {
        if (held.size > 0 && random() < 0.4) {
          const key = [...held.keys()][below(held.size)] as string;
          const old = held.get(key) as TrainingExample;
          model.removeExample(old);
          history.remove(old);
          held.delete(key);
        } else {
          const added = example(random, `journal:${counter++}`);
          model.addExample(added);
          history.add(added);
          held.set(added.key, added);
        }
        if (step % 7 === 0 || step === 299) {
          expect(model.snapshot(), `seed ${seed} step ${step}`).toEqual(
            ClassifierModel.from(held.values()).snapshot(),
          );
          expect(model.examples).toBe(held.size);
          // Predictions are those of the model made from nothing.
          const fresh = ClassifierModel.from(held.values());
          for (const word of WORDS)
            for (const direction of ["in", "out"] as Direction[])
              for (const source of SOURCES)
                expect(model.predict(features(word), direction, source ? { source } : {})).toEqual(
                  fresh.predict(features(word), direction, source ? { source } : {}),
                );
        }
      }
    });
});

describe("the history of the merchants the starter list knows", () => {
  test("kept as examples come and go it is the history made from the ones left", () => {
    const known = ["GITHUB INC", "NOTION LABS", "BLUE BOTTLE COFFEE", "STAPLES 00441", "nobody"];
    const random = sequence(711);
    const below = (count: number) => Math.floor(random() * count);
    const held: { text: string; accountId: string; direction: Direction }[] = [];
    const history = new MerchantHistory();
    for (let step = 0; step < 200; step += 1) {
      if (held.length > 0 && random() < 0.4) {
        const [gone] = held.splice(below(held.length), 1);
        history.remove(gone as (typeof held)[number]);
      } else {
        const added = {
          text: known[below(known.length)] as string,
          accountId: ACCOUNTS[below(ACCOUNTS.length)] as string,
          direction: (random() < 0.5 ? "in" : "out") as Direction,
        };
        held.push(added);
        history.add(added);
      }
      const fresh = new MerchantHistory();
      for (const item of held) fresh.add(item);
      expect(history.snapshot(), `step ${step}`).toEqual(fresh.snapshot());
      const lookup = merchantHistory(held);
      for (const entry of history.snapshot()) {
        const [id, side] = entry[0].split("|") as [string, Direction];
        expect([...(history.bookedTo(id, side) ?? [])].sort()).toEqual(
          [...(lookup(id, side) ?? [])].sort(),
        );
      }
    }
  });
});

describe("when a model can suggest nothing at all", () => {
  // The condition `hasStrongWord` is "could suggest", never "does": if it says no word has a record to rest a
  // suggestion on, then no line, whatever it says, gets one, under any thresholds that ask for the lines the
  // classifier asks for. This is what lets a change to the examples leave the open lines alone.
  test("a model with no word that has gone to an account on enough lines suggests for no line", () => {
    const random = sequence(721);
    const below = (count: number) => Math.floor(random() * count);
    let quiet = 0;
    let loud = 0;
    for (let round = 0; round < 400; round += 1) {
      const examples = Array.from({ length: below(30) }, (_, index) =>
        example(random, `journal:${index}`),
      );
      const model = ClassifierModel.from(examples);
      const minExamples = 1 + below(4);
      const config: ClassifierConfig = {
        ...DEFAULT_CLASSIFIER_CONFIG,
        minExamples,
        minAgreement: 50 + below(50),
        minMargin: below(20),
      };
      let proposes = false;
      for (const word of WORDS)
        for (const second of WORDS)
          for (const direction of ["in", "out"] as Direction[])
            for (const source of SOURCES)
              if (
                accept(
                  model.predict(features(`${word} ${second}`), direction, source ? { source } : {}),
                  config,
                ) !== null
              )
                proposes = true;
      if (model.hasStrongWord(minExamples)) loud += 1;
      else {
        quiet += 1;
        expect(proposes, `round ${round}`).toBe(false);
      }
    }
    // Both kinds of model were tried.
    expect(quiet).toBeGreaterThan(20);
    expect(loud).toBeGreaterThan(20);
  });
});

/** The examples the book says there should be, as a plain map. */
async function wanted(f: Fixture): Promise<Map<string, TrainingExample>> {
  const { examples } = await gatherExamples(f.service);
  return new Map(examples.map((item) => [item.key, item]));
}

const plain = (items: Iterable<TrainingExample>) =>
  JSON.stringify(
    [...items]
      .map((item) => ({ ...item, source: item.source ?? null }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  );

/** A small history by hand: lines arrive, are decided, posted and undone, and entries are posted and reversed. */
async function hand(f: Fixture) {
  const call = async (name: string, input: unknown): Promise<Json> =>
    (await f.call(name, input, crypto.randomUUID())).body;
  const [line] = f.port
    .submit(
      batchOf(
        f.port,
        [
          { date: "2026-03-02", amount: "-4.00", description: "GITHUB, INC. SAN FRANCISCO CA" },
          { date: "2026-03-03", amount: "-4.00", description: "GITHUB, INC. SAN FRANCISCO CA" },
        ],
        { ledgerAccountId: "1000" },
      ),
    )
    .dispositions.map((item) => item.itemId as string);
  return { call, line: line as string };
}

describe("learning on its own, one thing at a time", () => {
  test("a decision is learned from as a decision and, once posted, through its entry, and an undo takes it back", async () => {
    const f = await ingestFixture();
    const { call, line } = await hand(f);
    await ensureProposals(f.service, { prepare: true });
    expect(learnerOf(f.service).stored.size).toBe(0);
    await call("inbox.categorize", { itemIds: [line], accountId: "5000" });
    await ensureProposals(f.service, { prepare: true });
    // Decided, not posted: one example, a decision.
    expect([...learnerOf(f.service).stored.keys()]).toEqual([`decision:${line}`]);
    expect(plain(learnerOf(f.service).stored.values())).toBe(plain((await wanted(f)).values()));
    const posted = await call("inbox.post", { itemIds: [line] });
    expect(posted.ok, JSON.stringify(posted)).toBe(true);
    await ensureProposals(f.service, { prepare: true });
    const keys = [...learnerOf(f.service).stored.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]?.startsWith("journal:")).toBe(true);
    expect(plain(learnerOf(f.service).stored.values())).toBe(plain((await wanted(f)).values()));
    // The example's text is the Inbox's reading of the line, not the entry's own.
    expect(learnerOf(f.service).stored.values().next().value?.text).toContain("GITHUB");
    const undone = await call("inbox.undo", { itemIds: [line] });
    expect(undone.ok, JSON.stringify(undone)).toBe(true);
    await ensureProposals(f.service, { prepare: true });
    expect(learnerOf(f.service).stored.size).toBe(0);
    expect(plain(learnerOf(f.service).stored.values())).toBe(plain((await wanted(f)).values()));
    expect(learnerOf(f.service).model.examples).toBe(0);
  });

  test("a history longer than it learns from on its own is held back, counted exactly, and learned on request", async () => {
    const f = await ingestFixture();
    const { call } = await hand(f);
    const previous = autoLearn.maxRows;
    autoLearn.maxRows = 3;
    try {
      // Entries by hand, each a decision about a category, before anyone reads the Inbox: more rows than it may
      // write at once, when it comes to learn them.
      const post = async (memo: string, day: string) => {
        const draft = await call("drafts.create", {
          data: {
            date: `2026-03-${day}`,
            reference: memo,
            narration: `${memo} lunch`,
            lines: [
              { accountId: "5100", debit: "10.00", credit: "" },
              { accountId: "1000", debit: "", credit: "10.00" },
            ],
          },
        });
        const prepared = await call("journal.prepare", {
          draftId: draft.data.id,
          expectedVersion: draft.data.version,
        });
        await call("operations.commit", {
          planId: prepared.data.planId,
          planHash: prepared.data.planHash,
        });
      };
      for (const [index, memo] of ["ACME", "BOREALIS", "CEDAR", "DELTA", "EMBER"].entries())
        await post(memo, `1${index}`);
      const held = async () => new Set(readExamples(f.service.store).map((item) => item.key));
      const behindBy = async () => {
        const scratch = await wanted(f);
        const stored = await held();
        return (
          [...scratch.keys()].filter((key) => !stored.has(key)).length +
          [...stored].filter((key) => !scratch.has(key)).length
        );
      };
      await ensureProposals(f.service, { prepare: true });
      let status = (await f.call("classifier.status")).body.data as Json;
      // It holds nothing, and says exactly how many it is behind by: the rows the whole book would write.
      expect((await held()).size).toBe(0);
      expect(status.heldBack).toBe(await behindBy());
      expect(status.heldBack).toBe(5);
      expect(status.notes.join(" ")).toContain("Train it to learn from all of them");
      // Another entry, and the count follows it, and is still the whole book's.
      await post("FJORD", "16");
      await ensureProposals(f.service, { prepare: true });
      status = (await f.call("classifier.status")).body.data as Json;
      expect((await held()).size).toBe(0);
      expect(status.heldBack).toBe(await behindBy());
      expect(status.heldBack).toBe(6);
      // An entry taken back is one row fewer.
      const first = (await f.call("journal.list", { status: "Posted" })).body.data.entries[0];
      const reversal = await call("journal.prepareReverse", {
        journalId: first.id,
        accountingDate: "2026-03-20",
        reason: "Wrong",
      });
      await call("operations.commit", {
        planId: reversal.data.planId,
        planHash: reversal.data.planHash,
      });
      await ensureProposals(f.service, { prepare: true });
      status = (await f.call("classifier.status")).body.data as Json;
      expect(status.heldBack).toBe(await behindBy());
      expect(status.heldBack).toBe(5);
      const trained = await call("classifier.train", {});
      expect(trained.ok, JSON.stringify(trained)).toBe(true);
      expect(trained.data.heldBack).toBe(0);
      expect(trained.data.examples).toBe(5);
      expect((await held()).size).toBe(5);
      // After a training on request the next learning on its own starts from the whole book once.
      await learnIfBehind(f.service);
      expect(plain(learnerOf(f.service).stored.values())).toBe(plain((await wanted(f)).values()));
    } finally {
      autoLearn.maxRows = previous;
    }
  });

  test("a line that comes to be posted as an entry already learned from gives the entry its reading of the text", async () => {
    const f = await ingestFixture();
    const { call, line } = await hand(f);
    // An entry by hand, learned from as it reads in the books.
    const draft = await call("drafts.create", {
      data: {
        date: "2026-03-05",
        reference: "Hand",
        narration: "Lunch by hand",
        lines: [
          { accountId: "5100", debit: "4.00", credit: "" },
          { accountId: "1000", debit: "", credit: "4.00" },
        ],
      },
    });
    const prepared = await call("journal.prepare", {
      draftId: draft.data.id,
      expectedVersion: draft.data.version,
    });
    await call("operations.commit", {
      planId: prepared.data.planId,
      planHash: prepared.data.planHash,
    });
    const journalId = prepared.data.effects.journals[0].id as string;
    await ensureProposals(f.service, { prepare: true });
    expect(learnerOf(f.service).stored.get(`journal:${journalId}`)?.text).toBe("Lunch by hand");
    // The line is then recorded as posted as that entry (as a draft posted outside the Inbox's own call
    // is found out to be): nothing in the ledger moved, only the line, and the example follows it.
    f.service.store
      .query("UPDATE app_ingest_items SET status='posted', journal_id=?, decision=? WHERE id=?")
      .run(
        journalId,
        JSON.stringify({
          kind: "categorize",
          by: "manual",
          at: "2026-03-06T00:00:00.000Z",
          legs: [
            { accountId: "1000", amount: "-4.00" },
            { accountId: "5100", amount: "4.00" },
          ],
        }),
        line,
      );
    // The books moving on (another entry) is what makes it learn again; the entry the line was linked to is
    // not among those the ledger's new revision touches.
    const other = await call("drafts.create", {
      data: {
        date: "2026-03-07",
        reference: "Other",
        narration: "Something else",
        lines: [
          { accountId: "5200", debit: "9.00", credit: "" },
          { accountId: "1000", debit: "", credit: "9.00" },
        ],
      },
    });
    const preparedOther = await call("journal.prepare", {
      draftId: other.data.id,
      expectedVersion: other.data.version,
    });
    await call("operations.commit", {
      planId: preparedOther.data.planId,
      planHash: preparedOther.data.planHash,
    });
    await ensureProposals(f.service, { prepare: true });
    const held = learnerOf(f.service).stored.get(`journal:${journalId}`);
    expect(held?.text).toContain("GITHUB");
    expect(plain(learnerOf(f.service).stored.values())).toBe(plain((await wanted(f)).values()));
  });

  test("a change that cannot change a suggestion leaves the open lines alone, and one that can marks them", async () => {
    const f = await ingestFixture();
    const { call } = await hand(f);
    const stamped = () =>
      (
        f.service.store
          .query(
            "SELECT COUNT(*) AS n FROM app_ingest_items WHERE status IN ('new', 'proposed') AND proposed_rev IS NOT NULL",
          )
          .get() as { n: number }
      ).n;
    await ensureProposals(f.service, { prepare: true });
    expect(stamped()).toBe(2);
    const before = { ...learned };
    // An entry by hand whose words are no line's and that no word has a record behind: learned, and nothing to
    // propose again.
    const entry = async (narration: string, date: string) => {
      const draft = await call("drafts.create", {
        data: {
          date,
          reference: narration,
          narration,
          lines: [
            { accountId: "5100", debit: "7.00", credit: "" },
            { accountId: "1000", debit: "", credit: "7.00" },
          ],
        },
      });
      const prepared = await call("journal.prepare", {
        draftId: draft.data.id,
        expectedVersion: draft.data.version,
      });
      await call("operations.commit", {
        planId: prepared.data.planId,
        planHash: prepared.data.planHash,
      });
    };
    await entry("Lunch downtown", "2026-03-20");
    await ensureProposals(f.service, { prepare: true });
    expect(learned.kept).toBe(before.kept + 1);
    expect(learned.invalidated).toBe(before.invalidated);
    expect(stamped()).toBe(2);
    // The same words three times to one account: a word now has a record to rest a suggestion on, so the
    // lines waiting might change, and are proposed again.
    await entry("Lunch downtown", "2026-03-21");
    await entry("Lunch downtown", "2026-03-22");
    await ensureProposals(f.service, { prepare: false });
    expect(stamped()).toBe(2);
    await learnIfBehind(f.service);
    expect(learned.invalidated).toBe(before.invalidated + 1);
    expect(stamped()).toBe(0);
  });
});
