/** Finding what the ledger holds for an operation does not depend on how long the book is.
 *
 * `service.operation(id)` used to read the ledger's outcomes from the first one on, decoding and
 * checking each, until it met the command: a cost that grows with the book, paid again by every posting
 * that had to look at an earlier one (a refused line, the source it names, a restore). It now goes to
 * the outcome, by a locator kept beside the action: the head the ledger had reached when the command was
 * sent, and the head just before its outcome. The locator is a hint, and the ledger is the authority:
 * these tests count the pages the ledger is asked for, which is what makes the lookup flat (a clock
 * would say the same thing less steadily on a busy machine). */
import { afterEach, expect, test } from "bun:test";
import type { ApplicationService } from "../src/service.ts";
import { deriveUuid } from "../src/ingest/hash.ts";
import { postBulk } from "./support/bulk-book.ts";
import {
  type Fixture,
  type Json,
  batchOf,
  closeFixtures,
  ingestFixture,
} from "./support/ingest-fixture.ts";

afterEach(() => closeFixtures());

const uuid = () => crypto.randomUUID();

/** The pages the ledger is asked for from now on: where each started, how many outcomes it was
 * allowed and how many it returned. */
function watch(service: ApplicationService) {
  const ledger = service.ledger;
  const original = ledger.outcomes.bind(ledger);
  const calls: { after: string | null; limit: number | undefined; returned: number }[] = [];
  ledger.outcomes = async (credential, after, limit) => {
    const page = await original(credential, after, limit);
    calls.push({ after: after?.sequence ?? null, limit, returned: page.outcomes.length });
    return page;
  };
  return {
    calls,
    stop: () => {
      ledger.outcomes = original;
    },
  };
}

/** How many times the event loop is handed back to, from now on. */
function countYields() {
  const original = globalThis.setImmediate;
  let count = 0;
  globalThis.setImmediate = ((...args: Parameters<typeof setImmediate>) => {
    count += 1;
    return original(...args);
  }) as typeof setImmediate;
  return {
    count: () => count,
    stop: () => {
      globalThis.setImmediate = original;
    },
  };
}

const entry = (date: string, cents: number) => ({
  date,
  reference: `ENTRY ${cents}`,
  narration: `Entry ${cents}`,
  lines: [
    { accountId: "1000", debit: `${cents}.00`, credit: "" },
    { accountId: "4000", debit: "", credit: `${cents}.00` },
  ],
});

/** Post `count` entries the way the Journal screen does (prepare, commit) and return their
 * operation identities. */
async function posted(f: Fixture, count: number, date = "2026-02-10"): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const draft = f.service.createDraft(entry(date, 10 + index + ids.length));
    const id = uuid();
    const prepared = await f.service.prepareDraft(draft.id, draft.version, id);
    expect(prepared.valid).toBe(true);
    expect((await f.service.commitAction(id, prepared.planHash)).disposition).toBe("committed");
    ids.push(id);
  }
  return ids;
}

const locators = (f: Fixture) =>
  f.service.store
    .query("SELECT id, submit_head, outcome_after FROM app_operation_locators ORDER BY rowid")
    .all() as { id: string; submit_head: string | null; outcome_after: string | null }[];
const locatorOf = (f: Fixture, id: string) =>
  f.service.store
    .query("SELECT submit_head, outcome_after FROM app_operation_locators WHERE id=?")
    .get(id) as { submit_head: string | null; outcome_after: string | null } | null;
const sequenceOf = (head: string | null) =>
  (JSON.parse(head ?? "null") as { sequence: string }).sequence;

test("a posting is found where it is: one outcome is read, whatever the size of the book", async () => {
  const sizes: number[] = [];
  for (const size of [10, 250]) {
    const f = await ingestFixture();
    await postBulk(f.service, size);
    const ids = await posted(f, 3);
    const found = await f.service.operation(ids[1] as string);
    expect(found.disposition).toBe("committed");
    const second = f.service.store
      .query("SELECT outcome_sequence FROM app_actions WHERE id=?")
      .get(ids[1] as string) as { outcome_sequence: string };
    expect(found.outcomeSequence).toBe(second.outcome_sequence);
    const spy = watch(f.service);
    const again = await f.service.operation(ids[1] as string);
    spy.stop();
    expect(again).toEqual(found);
    // One page, of one outcome, and the page returned it.
    expect(spy.calls).toEqual([
      { after: String(Number(second.outcome_sequence) - 1), limit: 1, returned: 1 },
    ]);
    // The place was kept when the command went: the head it was sent after is the one before it.
    const place = locatorOf(f, ids[1] as string);
    expect(sequenceOf(place?.submit_head ?? null)).toBe(
      String(Number(second.outcome_sequence) - 1),
    );
    expect(place?.outcome_after).toBe(place?.submit_head ?? "");
    sizes.push(spy.calls.length);
    closeFixtures();
  }
  expect(sizes).toEqual([1, 1]);
});

test("an action that was prepared and never sent is answered without reading the book", async () => {
  const f = await ingestFixture();
  await postBulk(f.service, 40);
  const draft = f.service.createDraft(entry("2026-02-10", 77));
  const id = uuid();
  await f.service.prepareDraft(draft.id, draft.version, id);
  const spy = watch(f.service);
  const found = await f.service.operation(id);
  spy.stop();
  expect(found.disposition).toBe("prepared");
  expect(spy.calls).toHaveLength(0);
});

test("an action sent whose answer was lost is looked for after the head it was sent at, not from the start", async () => {
  const f = await ingestFixture();
  await postBulk(f.service, 120);
  const draft = f.service.createDraft(entry("2026-02-10", 55));
  const id = uuid();
  const prepared = await f.service.prepareDraft(draft.id, draft.version, id);
  // The ledger takes the command and the answer is lost.
  const original = f.service.ledger.execute.bind(f.service.ledger);
  f.service.ledger.execute = async (credential, command) => {
    await original(credential, command);
    throw new Error("the connection dropped");
  };
  await expect(f.service.commitAction(id, prepared.planHash)).rejects.toThrow("dropped");
  f.service.ledger.execute = original;
  const sentAt = sequenceOf(locatorOf(f, id)?.submit_head ?? null);
  const spy = watch(f.service);
  const found = await f.service.operation(id);
  expect(found.disposition).toBe("committed");
  // It read from the head the command was sent after, and not from the beginning of the book.
  expect(spy.calls).toHaveLength(1);
  expect(spy.calls[0]?.after).toBe(sentAt);
  // The place is now kept, and the next look is one outcome.
  const next = await f.service.operation(id);
  spy.stop();
  expect(next.disposition).toBe("committed");
  expect(spy.calls[1]).toMatchObject({ limit: 1, returned: 1 });
  // Resubmitting it answers with the first outcome and posts nothing twice.
  const receipt = await f.service.commitAction(id, prepared.planHash);
  expect(receipt.disposition).toBe("committed");
  expect(receipt.outcomeSequence).toBe(found.outcomeSequence ?? "");
});

test("an action sent that the ledger never received stays unresolved, found out from where it was sent", async () => {
  const f = await ingestFixture();
  await postBulk(f.service, 120);
  const draft = f.service.createDraft(entry("2026-02-10", 56));
  const id = uuid();
  const prepared = await f.service.prepareDraft(draft.id, draft.version, id);
  const original = f.service.ledger.execute.bind(f.service.ledger);
  f.service.ledger.execute = async () => {
    throw new Error("the ledger did not answer");
  };
  await expect(f.service.commitAction(id, prepared.planHash)).rejects.toThrow("did not answer");
  f.service.ledger.execute = original;
  const sentAt = sequenceOf(locatorOf(f, id)?.submit_head ?? null);
  const spy = watch(f.service);
  const found = await f.service.operation(id);
  spy.stop();
  expect(found.disposition).toBe("unresolved");
  expect(spy.calls).toHaveLength(1);
  expect(spy.calls[0]?.after).toBe(sentAt);
  // Sent again, it is the same command and the ledger takes it.
  const receipt = await f.service.commitAction(id, prepared.planHash);
  expect(receipt.disposition).toBe("committed");
  expect((await f.service.operation(id)).disposition).toBe("committed");
});

test("a book whose actions have no locators is looked through once, in slices, and is flat from then on", async () => {
  const f = await ingestFixture();
  await postBulk(f.service, 700);
  const ids = await posted(f, 5);
  // A refusal too: January is closed and the entry is sent anyway.
  const periods = (await f.call("periods.list", {})).body.data.periods as Json[];
  const closing = await f.call(
    "periods.prepare",
    { periodId: periods[0].id, operation: "close", reason: "month end" },
    uuid(),
  );
  await f.call("operations.commit", {
    planId: closing.body.data.planId,
    planHash: closing.body.data.planHash,
  });
  const refusedDraft = f.service.createDraft(entry("2026-01-12", 91));
  const refusedId = uuid();
  const refusedPlan = await f.service.prepareDraft(refusedDraft.id, 1, refusedId);
  expect((await f.service.commitAction(refusedId, refusedPlan.planHash)).disposition).toBe(
    "rejected",
  );
  const all = [...ids, refusedId];
  // Every action that was sent has a place: the five postings, the period close and the refusal.
  const sent = (
    f.service.store.query("SELECT COUNT(*) AS n FROM app_actions WHERE submitted=1").get() as {
      n: number;
    }
  ).n;
  expect(sent).toBe(7);
  expect(locators(f)).toHaveLength(sent);
  // The book as it was made before locators: the actions are there, the hints are not.
  f.service.store.query("DELETE FROM app_operation_locators").run();
  await f.restart();
  const outcomesInBook = Number(
    ((await f.service.outcomePage()).observedTip as { sequence: string }).sequence,
  );
  const passPages = Math.ceil(outcomesInBook / 16);
  expect(passPages).toBeGreaterThan(40);

  const spy = watch(f.service);
  const yields = countYields();
  const first = await f.service.operation(ids[0] as string);
  expect(first.disposition).toBe("committed");
  const pass = spy.calls.length;
  // One pass over the whole book, and the thread was handed back while it ran.
  expect(pass).toBeGreaterThanOrEqual(passPages);
  expect(pass).toBeLessThanOrEqual(passPages + 2);
  expect(yields.count()).toBeGreaterThanOrEqual(2);
  // It placed every action, not just the one asked for, and the refusal too.
  expect(locators(f).filter((place) => place.outcome_after !== null)).toHaveLength(sent);
  // From then on every lookup is one outcome, the refused one included.
  for (const id of all) {
    const before = spy.calls.length;
    const found = await f.service.operation(id);
    expect(found.disposition, id).toBe(id === refusedId ? "rejected" : "committed");
    expect(spy.calls.length - before, id).toBe(1);
  }
  // And not again after a restart: the places were written down.
  await f.restart();
  const restarted = watch(f.service);
  const last = await f.service.operation(ids[4] as string);
  restarted.stop();
  spy.stop();
  yields.stop();
  expect(last.disposition).toBe("committed");
  expect(restarted.calls).toHaveLength(1);
});

test("lookups that arrive while the one pass runs wait for it instead of starting their own", async () => {
  const f = await ingestFixture();
  await postBulk(f.service, 400);
  const ids = await posted(f, 4);
  f.service.store.query("DELETE FROM app_operation_locators").run();
  await f.restart();
  const passPages = Math.ceil(Number((await f.service.outcomePage()).observedTip.sequence) / 16);
  const spy = watch(f.service);
  const found = await Promise.all(ids.map((id) => f.service.operation(id)));
  spy.stop();
  expect(found.map((item) => item.disposition)).toEqual(ids.map(() => "committed"));
  // One pass and one outcome read each; four passes would be four times the pages.
  expect(spy.calls.length).toBeLessThanOrEqual(passPages + ids.length + 2);
});

test("a locator that is wrong is no more than a bad hint: the answer is the ledger's", async () => {
  const f = await ingestFixture();
  await postBulk(f.service, 60);
  const [a, b, c, d] = (await posted(f, 4)) as [string, string, string, string];
  const truth = new Map<string, string>();
  for (const id of [a, b, c, d])
    truth.set(id, (await f.service.operation(id)).outcomeSequence ?? "");
  const place = (id: string) => locatorOf(f, id) as { submit_head: string; outcome_after: string };
  const set = (id: string, column: string, value: string | null) =>
    f.service.store
      .query(`UPDATE app_operation_locators SET ${column}=? WHERE id=?`)
      .run(value, id);
  // The place of another action's outcome.
  set(a, "outcome_after", place(b).outcome_after);
  // Not a head at all.
  set(b, "outcome_after", "not json");
  // A head the ledger has never had: the right shape, a chain hash that is nobody's.
  const head = JSON.parse(place(c).outcome_after) as {
    sequence: string;
    bookRevision: string;
    chainHash: string;
  };
  set(c, "outcome_after", JSON.stringify({ ...head, chainHash: "0".repeat(64) }));
  // A head after the outcome, for an action that has no place of its own kept.
  const tip = (await f.service.outcomePage()).observedTip;
  set(d, "outcome_after", null);
  set(d, "submit_head", JSON.stringify(tip));
  for (const id of [a, b, c, d]) {
    const found = await f.service.operation(id);
    expect(found.disposition, id).toBe("committed");
    expect(found.outcomeSequence, id).toBe(truth.get(id));
  }
  // What was wrong has been put right: each place is the one right before its own outcome.
  for (const id of [a, b, c, d]) {
    expect(Number(sequenceOf(locatorOf(f, id)?.outcome_after ?? null)) + 1, id).toBe(
      Number(truth.get(id)),
    );
  }
});

test("the command kept with an action must still be the one the ledger holds, found by locator or not", async () => {
  const f = await ingestFixture();
  await postBulk(f.service, 30);
  const [id, other] = (await posted(f, 2)) as [string, string];
  // The action's kept command is replaced by another one's: the outcome at its place is not its own.
  const kept = f.service.store
    .query("SELECT sealed_command FROM app_actions WHERE id=?")
    .get(other) as { sealed_command: string };
  f.service.store
    .query("UPDATE app_actions SET sealed_command=? WHERE id=?")
    .run(kept.sealed_command, id);
  await expect(f.service.operation(id)).rejects.toThrow();
});

test("a line whose source names an earlier refused posting is posted without reading the book again", async () => {
  const f = await ingestFixture();
  await postBulk(f.service, 300);
  const lines = Array.from({ length: 4 }, (_, index) => ({
    date: `2026-03-${String(2 + index).padStart(2, "0")}`,
    amount: `-${20 + index}.00`,
    description: `AFTER THE RACE ${index}`,
  }));
  const report = f.port.submit(batchOf(f.port, lines, { ledgerAccountId: "1000" }));
  const ids = report.dispositions.flatMap((item) => (item.itemId ? [item.itemId] : []));
  const act = async (name: string, input: unknown) => {
    const reply = await f.call(name, input, uuid());
    expect(reply.body.ok, JSON.stringify(reply.body)).toBe(true);
    return reply.body.data as Json;
  };
  await act("inbox.categorize", { itemIds: ids, accountId: "5000" });
  // The old race: each plan outrun by a write, the refusal kept against the source.
  for (const itemId of ids) {
    const row = f.service.store
      .query("SELECT draft_id FROM app_ingest_items WHERE id=?")
      .get(itemId) as { draft_id: string };
    const draft = f.service.draft(row.draft_id);
    if (!draft) throw new Error("no draft");
    const op = deriveUuid(["ingest.post", draft.id, String(draft.version)]);
    const prepared = await f.service.prepareDraft(draft.id, draft.version, op);
    await postBulk(f.service, 1);
    expect((await f.service.commitAction(op, prepared.planHash)).disposition).toBe("rejected");
  }
  // The way out that always worked: return them to review, decide them again. The sources still name
  // the refused postings, and each new posting looks at that owner.
  await act("inbox.restore", { itemIds: ids, reason: "refused as stale" });
  await act("inbox.categorize", { itemIds: ids, accountId: "5000" });
  const pagesInBook = Math.ceil(Number((await f.service.outcomePage()).observedTip.sequence) / 16);
  const spy = watch(f.service);
  const posted = await act("inbox.post", { itemIds: ids });
  spy.stop();
  expect(posted).toMatchObject({ applied: 4, failed: 0 });
  // Reading the book to its end once would be `pagesInBook` pages. Four postings, each of which looked
  // at the earlier owner twice, used to be eight times that; now every look is one outcome.
  expect(spy.calls.length).toBeLessThan(pagesInBook);
});
