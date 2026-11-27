// Stress: the Inbox's postings among other writers, with replies lost, checked against what must hold.
//   RUNS=20 SEED=1 bun packages/application/bench/inbox-stress.ts
// Each run is one book with a few Inbox clients posting their own lines at the same time (by filter, as a
// screen and an agent do), a writer outside the Inbox adding entries at random moments (the Journal
// screen, a sync), and a ledger that sometimes takes a command and loses the answer. When the clients
// have posted until nothing moves, it checks, from the ledger and the book's own tables:
//   - every line is posted, once: one journal for each source, no line left drafted or stuck in posting
//   - a line is never refused for good because the book moved: no draft is left refused (stale or time)
//   - no source names a posting that is not the one that made its journal
// The interleaving comes from the timing of the writers, so a run is not repeatable, but the seed fixes
// what each run does (how many lines, how often it lies, how often the outside writer writes).
import { ingestRuntime } from "../src/slices/ingest/store.ts";
import { postBulk } from "../test/support/bulk-book.ts";
import {
  batchOf,
  closeFixtures,
  type Fixture,
  ingestFixture,
} from "../test/support/ingest-fixture.ts";

type Json = Awaited<ReturnType<Response["json"]>>;

const runs = Number(process.env.RUNS ?? "10");
const seed0 = Number(process.env.SEED ?? "1");
function prng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

let serial = 0;
async function once(seed: number): Promise<string[]> {
  const random = prng(seed);
  const problems: string[] = [];
  const f: Fixture = await ingestFixture();
  await postBulk(f.service, 40 + Math.floor(random() * 60));
  ingestRuntime(f.service).postBudgetMs = 20_000;
  const act = async (name: string, input: unknown) => {
    const reply = await f.call(name, input, crypto.randomUUID());
    if (!reply.body.ok) throw new Error(`${name}: ${JSON.stringify(reply.body)}`);
    return reply.body.data as Json;
  };
  const clients = 2 + Math.floor(random() * 3);
  const perClient = 12 + Math.floor(random() * 25);
  const lieEvery = random() < 0.5 ? 0 : 6 + Math.floor(random() * 20);
  const outsideEveryMs = random() < 0.2 ? 0 : 1 + Math.floor(random() * 6);
  const tags: string[] = [];
  const allIds: string[] = [];
  for (let client = 0; client < clients; client += 1) {
    serial += 1;
    const tag = `STRESS${seed}C${client}`;
    tags.push(tag);
    const lines = Array.from({ length: perClient }, (_, index) => ({
      date: `2026-${String(2 + (index % 10)).padStart(2, "0")}-${String(1 + ((index * 7 + serial) % 27)).padStart(2, "0")}`,
      amount: `-${10 + index + serial * 3}.${String(10 + (index % 90))}`,
      description: `${tag} LINE ${index}`,
    }));
    const report = f.port.submit(batchOf(f.port, lines, { ledgerAccountId: "1000" }));
    const ids = report.dispositions.flatMap((item) => (item.itemId ? [item.itemId] : []));
    allIds.push(...ids);
    await act("inbox.categorize", { itemIds: ids, accountId: "5000" });
  }

  // The ledger takes some commands and loses the answer.
  const original = f.service.ledger.execute.bind(f.service.ledger);
  let executed = 0;
  let lost = 0;
  f.service.ledger.execute = async (credential, command) => {
    const receipt = await original(credential, command);
    executed += 1;
    if (lieEvery > 0 && command.type === "postJournal" && executed % lieEvery === 0) {
      lost += 1;
      throw new Error("the connection dropped");
    }
    return receipt;
  };

  let writing = outsideEveryMs > 0;
  let outside = 0;
  const writer = (async () => {
    while (writing) {
      try {
        await postBulk(f.service, 1);
        outside += 1;
      } catch {
        // the Inbox's commit landed first
      }
      await Bun.sleep(outsideEveryMs * (0.5 + random()));
    }
  })();

  const heard: Record<string, number> = {};
  const client = async (tag: string) => {
    for (let call = 0; call < 40; call += 1) {
      let data: Json;
      try {
        data = await act("inbox.post", {
          filter: { status: ["drafted"], text: tag.toLowerCase() },
          limit: 5 + Math.floor(random() * 20),
        });
      } catch (error) {
        problems.push(`a call failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      for (const result of data.results as Json[])
        if (result.outcome !== "applied") {
          const key = `${result.outcome}:${result.code}`;
          heard[key] = (heard[key] ?? 0) + 1;
        }
      if (data.remaining === 0 && data.failed === 0 && data.applied === 0) return;
      await Bun.sleep(random() * 3);
    }
  };
  await Promise.all(tags.map(client));
  writing = false;
  await writer;
  f.service.ledger.execute = original;
  // The ledger answers again: whatever was left uncertain is resumed.
  for (const tag of tags) await client(tag);

  // What must hold.
  const rows = f.service.store
    .query(
      "SELECT id, status, draft_id, journal_id, post_error, post_error_code FROM app_ingest_items",
    )
    .all() as {
    id: string;
    status: string;
    draft_id: string | null;
    journal_id: string | null;
    post_error: string | null;
    post_error_code: string | null;
  }[];
  const notPosted = rows.filter((row) => row.status !== "posted");
  if (notPosted.length > 0)
    problems.push(
      `${notPosted.length} of ${rows.length} lines are not posted: ${JSON.stringify(
        notPosted.slice(0, 2).map((row) => [row.status, row.post_error]),
      )}`,
    );
  const { aggregate } = await f.service.readAggregate();
  const journals = aggregate.state.journals
    .map((booked) => booked.journal.id as string)
    .filter((id) => id.startsWith("source-"));
  if (journals.length !== allIds.length)
    problems.push(`${journals.length} Inbox journals for ${allIds.length} lines`);
  if (new Set(journals).size !== journals.length)
    problems.push("a journal id is in the book twice");
  const stuck = f.service.store
    .query(
      "SELECT COUNT(*) AS n FROM app_drafts WHERE status IN ('draft', 'posting') AND body LIKE '%STRESS%'",
    )
    .get() as { n: number };
  if (stuck.n > 0) problems.push(`${stuck.n} drafts are still open or in posting`);
  const owners = f.service.store
    .query(
      "SELECT id, posting_operation_id FROM app_sources WHERE posting_operation_id IS NOT NULL",
    )
    .all() as { id: string; posting_operation_id: string }[];
  for (const owner of owners.slice(0, 400)) {
    const found = await f.service.operation(owner.posting_operation_id);
    if (found.disposition !== "committed")
      problems.push(`source ${owner.id} names a posting that is ${found.disposition}`);
  }
  // Nothing stale was kept as a verdict.
  let page = await f.service.outcomePage();
  let refusals = 0;
  for (;;) {
    refusals += page.outcomes.filter(
      (item) =>
        item.payload.originalResult.disposition === "rejected" &&
        !item.payload.command.id.startsWith("bulk-"),
    ).length;
    if (page.through.sequence === page.observedTip.sequence) break;
    page = await f.service.outcomePage(page.through);
  }
  const versions = f.service.store
    .query("SELECT COALESCE(SUM(version - 1), 0) AS n FROM app_drafts WHERE body LIKE '%STRESS%'")
    .get() as { n: number };
  console.log(
    `seed ${seed}: ${clients} clients x ${perClient} lines, lies every ${lieEvery || "never"}, outside writer ${outsideEveryMs ? `every ~${outsideEveryMs} ms (${outside} writes)` : "none"}; ` +
      `${lost} replies lost; refusals kept ${refusals}, drafts reopened or remade ${versions.n}; heard ${JSON.stringify(heard)} -> ${problems.length === 0 ? "ok" : "PROBLEMS"}`,
  );
  closeFixtures();
  return problems.map((problem) => `seed ${seed}: ${problem}`);
}

const all: string[] = [];
for (let run = 0; run < runs; run += 1) all.push(...(await once(seed0 + run)));
if (all.length > 0) {
  console.error(`\n${all.length} problems:\n${all.join("\n")}`);
  process.exit(1);
}
console.log(`\n${runs} runs, no problems`);
