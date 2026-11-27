// Benchmark: what an Inbox posting costs as the book grows, and what a refused posting leaves behind.
//   SIZES=500,2000,5000 bun packages/application/bench/inbox-posting.ts
// For each size it builds a book of that many journals and measures, through the application's own
// operations (the races are made with the service's prepare and commit, the old API, so the same
// script runs against any tree):
//   - service.operation(id) for a posting that committed and for one the ledger refused (median of 5)
//   - a fresh posting (ms a line)
//   - ten lines the ledger refused because another write landed between prepare and commit (the
//     stale race), then (a) inbox.post on them, and (b) the way out that always worked: restore, decide
//     again, post, and what a fresh line then costs
//   - a post-all call (by filter) with ten refused lines at its head, three calls in a row
// It prints a table; times are wall milliseconds, with the process's CPU time beside them because that is
// steadier when the machine is shared.
import { deriveUuid } from "../src/ingest/hash.ts";
import type { SavedDraft } from "../src/contracts.ts";
import { ingestRuntime } from "../src/slices/ingest/store.ts";
import { postBulk } from "../test/support/bulk-book.ts";
import {
  batchOf,
  closeFixtures,
  ingestFixture,
  type Fixture,
} from "../test/support/ingest-fixture.ts";

type Json = Awaited<ReturnType<Response["json"]>>;

const sizes = (process.env.SIZES ?? "500,2000,5000").split(",").filter(Boolean).map(Number);
const cpuMs = () => {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1000;
};
async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number; cpu: number }> {
  const wall = performance.now();
  const cpu = cpuMs();
  const value = await work();
  return { value, ms: performance.now() - wall, cpu: cpuMs() - cpu };
}
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const fmt = (ms: number) => (ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2));

let serial = 0;
async function measure(size: number): Promise<void> {
  const f: Fixture = await ingestFixture();
  const built = await timed(() => postBulk(f.service, size));
  ingestRuntime(f.service).postBudgetMs = Number(process.env.BUDGET_MS ?? "5000");
  const act = async (name: string, input: unknown) => {
    const reply = await f.call(name, input, crypto.randomUUID());
    if (!reply.body.ok) throw new Error(`${name}: ${JSON.stringify(reply.body)}`);
    return reply.body.data as Json;
  };
  const lineSet = (count: number, month: (index: number) => number, label: string) =>
    Array.from({ length: count }, (_, index) => ({
      date: `2026-${String(month(index)).padStart(2, "0")}-${String(1 + ((index * 5 + serial) % 27)).padStart(2, "0")}`,
      amount: `-${(10 + index + serial).toString()}.${String(7 + (index % 90)).padStart(2, "0")}`,
      description: `${label} ${serial} LINE ${index}`,
    }));
  const importLines = (lines: ReturnType<typeof lineSet>): string[] => {
    serial += 1;
    const report = f.port.submit(batchOf(f.port, lines, { ledgerAccountId: "1000" }));
    return report.dispositions.flatMap((item) => (item.itemId ? [item.itemId] : []));
  };
  const decide = async (ids: string[]) => {
    await act("inbox.categorize", { itemIds: ids, accountId: "5000" });
  };
  const draftOf = (itemId: string): SavedDraft => {
    const row = f.service.store
      .query("SELECT draft_id FROM app_ingest_items WHERE id=?")
      .get(itemId) as { draft_id: string };
    const draft = f.service.draft(row.draft_id);
    if (!draft) throw new Error("no draft");
    return draft;
  };
  const identityOf = (draft: SavedDraft) =>
    deriveUuid(["ingest.post", draft.id, String(draft.version)]);
  /** What the race did to a line: its plan was made, another write landed, and the commit was refused as stale. */
  const refuseAsStale = async (itemId: string) => {
    const draft = draftOf(itemId);
    const id = identityOf(draft);
    const prepared = await f.service.prepareDraft(draft.id, draft.version, id);
    await postBulk(f.service, 1);
    const receipt = await f.service.commitAction(id, prepared.planHash);
    if (receipt.disposition !== "rejected") throw new Error("the race did not refuse the commit");
    return id;
  };
  /** A refusal that is about the entry: sent to the ledger though the plan was invalid (the period is closed). */
  const refuseForPeriod = async (itemId: string) => {
    const draft = draftOf(itemId);
    const id = identityOf(draft);
    const prepared = await f.service.prepareDraft(draft.id, draft.version, id);
    const receipt = await f.service.commitAction(id, prepared.planHash);
    if (receipt.disposition !== "rejected") throw new Error("the period close did not refuse");
    return id;
  };
  const operationMs = async (id: string) => {
    const times: number[] = [];
    let disposition = "";
    for (let repeat = 0; repeat < 5; repeat += 1) {
      const run = await timed(() => f.service.operation(id));
      times.push(run.ms);
      disposition = run.value.disposition;
    }
    return { ms: median(times), disposition };
  };

  const rows: string[][] = [];
  const row = (what: string, ...cells: string[]) => rows.push([what, ...cells]);

  // 1. A fresh posting, and a lookup of a posting that went through.
  const fresh = importLines(lineSet(20, (index) => 2 + (index % 10), "FRESH"));
  await decide(fresh);
  const freshRun = await timed(() => act("inbox.post", { itemIds: fresh }));
  row(
    "fresh posting, ms a line",
    fmt(freshRun.ms / fresh.length),
    `cpu ${fmt(freshRun.cpu / fresh.length)}`,
  );
  const postedIds = fresh.map(
    (id) =>
      (
        f.service.store
          .query("SELECT post_operation_id FROM app_ingest_items WHERE id=?")
          .get(id) as {
          post_operation_id: string;
        }
      ).post_operation_id,
  );
  const first = await operationMs(postedIds[0] as string);
  const last = await operationMs(postedIds[postedIds.length - 1] as string);
  row(
    "operation(id), a committed posting, first / last of 20, ms",
    `${fmt(first.ms)} / ${fmt(last.ms)}`,
    first.disposition,
  );

  // 2. Lines the stale race refused; the way out that always worked.
  const way = importLines(lineSet(10, (index) => 2 + (index % 10), "WAYOUT"));
  await decide(way);
  const refused: string[] = [];
  for (const id of way) refused.push(await refuseAsStale(id));
  const rejected = await operationMs(refused[refused.length - 1] as string);
  row("operation(id), a refused posting, ms", fmt(rejected.ms), rejected.disposition);
  const restore = await timed(() =>
    act("inbox.restore", { itemIds: way, reason: "refused as stale, post again" }),
  );
  row("restore 10 refused lines, ms", fmt(restore.ms), `cpu ${fmt(restore.cpu)}`);
  await decide(way);
  const after = await timed(() => act("inbox.post", { itemIds: way }));
  row(
    "post them again after the restore, ms a line",
    fmt(after.ms / way.length),
    `applied ${after.value.applied} failed ${after.value.failed}`,
  );

  // 3. The same refusal, posted without a restore.
  const heal = importLines(lineSet(10, (index) => 2 + (index % 10), "HEAL"));
  await decide(heal);
  for (const id of heal) await refuseAsStale(id);
  const healed = await timed(() => act("inbox.post", { itemIds: heal }));
  row(
    "post 10 stale-refused lines as they are, ms",
    fmt(healed.ms),
    `applied ${healed.value.applied} failed ${healed.value.failed} remaining ${healed.value.remaining}`,
  );
  const again = await timed(() => act("inbox.post", { itemIds: heal }));
  row(
    "  and once more, ms",
    fmt(again.ms),
    `applied ${again.value.applied} failed ${again.value.failed} remaining ${again.value.remaining}`,
  );

  // 4. A post-all call with ten refused lines at its head.
  const january = importLines(lineSet(10, () => 1, "SCENARIO4 JANUARY"));
  const rest = importLines(lineSet(25, (index) => 2 + (index % 10), "SCENARIO4 REST"));
  await decide([...january, ...rest]);
  const periods = (await f.call("periods.list", {})).body.data.periods as Json[];
  const closing = await f.call(
    "periods.prepare",
    { periodId: periods[0].id, operation: "close", reason: "month end" },
    crypto.randomUUID(),
  );
  await f.call("operations.commit", {
    planId: closing.body.data.planId,
    planHash: closing.body.data.planHash,
  });
  for (const id of january) await refuseForPeriod(id);
  for (let call = 1; call <= 3; call += 1) {
    const run = await timed(() =>
      act("inbox.post", { filter: { status: ["drafted"], text: "scenario4" }, limit: 25 }),
    );
    row(
      `post-all, call ${call}, 10 refused at the head, ms`,
      fmt(run.ms),
      `applied ${run.value.applied} failed ${run.value.failed} skipped ${run.value.skipped} remaining ${run.value.remaining}`,
    );
  }

  console.log(`\n== ${size} journals (built in ${(built.ms / 1000).toFixed(1)} s) ==`);
  const width = Math.max(...rows.map((cells) => (cells[0] ?? "").length));
  for (const [what, ...cells] of rows)
    console.log(`${(what ?? "").padEnd(width)}  ${cells.join("   ")}`);
  closeFixtures();
}

/** An Inbox client's company: another client posting at the same moments (the web screen and an
 * agent), and a writer outside the Inbox (the Journal screen, a sync) adding an entry every few
 * milliseconds. It counts what the ledger kept (refusals that changed nothing), the evaluations the
 * Inbox repeated (the versions its drafts went through) and what the clients heard. */
async function contention(size: number): Promise<void> {
  console.log(`\n== company, on a book of ${size} journals ==`);
  for (const scenario of ["two clients", "one client and an outside writer"] as const) {
    const f: Fixture = await ingestFixture();
    await postBulk(f.service, size);
    ingestRuntime(f.service).postBudgetMs = 20_000;
    const act = async (name: string, input: unknown) => {
      const reply = await f.call(name, input, crypto.randomUUID());
      if (!reply.body.ok) throw new Error(`${name}: ${JSON.stringify(reply.body)}`);
      return reply.body.data as Json;
    };
    const tags = scenario === "two clients" ? ["CLIENTA", "CLIENTB"] : ["CLIENTA"];
    for (const tag of tags) {
      serial += 1;
      const lines = Array.from({ length: 60 }, (_, index) => ({
        date: `2026-${String(2 + (index % 10)).padStart(2, "0")}-${String(1 + ((index * 5 + serial) % 27)).padStart(2, "0")}`,
        amount: `-${10 + index + serial}.${String(7 + (index % 90)).padStart(2, "0")}`,
        description: `${tag} ${serial} LINE ${index}`,
      }));
      const report = f.port.submit(batchOf(f.port, lines, { ledgerAccountId: "1000" }));
      const ids = report.dispositions.flatMap((item) => (item.itemId ? [item.itemId] : []));
      await act("inbox.categorize", { itemIds: ids, accountId: "5000" });
    }
    const heard: Record<string, number> = {};
    let applied = 0;
    let calls = 0;
    const client = async (tag: string) => {
      for (let call = 0; call < 12; call += 1) {
        const data = await act("inbox.post", {
          filter: { status: ["drafted"], text: tag.toLowerCase() },
        });
        calls += 1;
        applied += data.applied;
        for (const result of data.results as Json[])
          if (result.outcome !== "applied") {
            const key = `${result.outcome}:${result.code}`;
            heard[key] = (heard[key] ?? 0) + 1;
          }
        if (data.remaining === 0 || data.applied === 0) break;
      }
    };
    let writing = scenario === "one client and an outside writer";
    let outside = 0;
    let collided = 0;
    const writer = (async () => {
      while (writing) {
        try {
          await postBulk(f.service, 1);
          outside += 1;
        } catch {
          // The Inbox's commit landed first: the outside writer meets the same race and tries again.
          collided += 1;
        }
        await Bun.sleep(2);
      }
    })();
    const run = await timed(() => Promise.all(tags.map(client)));
    writing = false;
    await writer;
    let refusals = 0;
    let page = await f.service.outcomePage();
    for (;;) {
      refusals += page.outcomes.filter(
        (item) =>
          item.payload.originalResult.disposition === "rejected" &&
          !item.payload.command.id.startsWith("bulk-"),
      ).length;
      if (page.through.sequence === page.observedTip.sequence) break;
      page = await f.service.outcomePage(page.through);
    }
    const left = (
      f.service.store
        .query("SELECT COUNT(*) AS n FROM app_ingest_items WHERE status='drafted'")
        .get() as {
        n: number;
      }
    ).n;
    const evaluations = (
      f.service.store.query("SELECT COALESCE(SUM(version - 1), 0) AS n FROM app_drafts").get() as {
        n: number;
      }
    ).n;
    console.log(
      `${scenario.padEnd(34)} ${tags.length * 60} lines: posted ${applied}, still drafted ${left}, ${calls} calls, ${fmt(run.ms)} ms; ` +
        `refusals kept in the ledger ${refusals}, drafts reopened ${evaluations}, outside writes ${outside} (${collided} lost to the Inbox); heard ${JSON.stringify(heard)}`,
    );
    closeFixtures();
  }
}

for (const size of sizes) await measure(size);
if (process.env.CONTENTION !== "no") await contention(Number(process.env.CONTENTION_SIZE ?? "500"));
