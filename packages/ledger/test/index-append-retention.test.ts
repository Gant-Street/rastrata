import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { hashCanonical } from "@rastrata/kernel";
import { SqliteIndexControl, type IndexAnchor, type IndexReaderPin } from "../src/index-control.ts";
import { SqliteIndexPageStore } from "../src/index-page-store.ts";
import {
  auditBalancedIndex,
  createIndexRoot,
  encodeIndexPage,
  enumerateIndexPages,
  INDEX_KEY_SCHEMA,
  prepareIndexInsert,
  type BalancedIndex,
  type IndexChild,
} from "../src/index-pages.ts";
import type { SqliteStorage } from "../src/sqlite.ts";
import { workflowValue } from "./accounting-workflows.ts";

const key = (n: number) => n.toString(16).padStart(64, "0");
const hash = (n: number) => hashCanonical({ n: BigInt(n) }).digest;
async function fixture() {
  const db = new Database(":memory:");
  db.exec(
    "PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY; PRAGMA cache_size = -64000; PRAGMA temp_store = MEMORY;",
  );
  db.exec("CREATE TABLE test_anchor (body TEXT NOT NULL)");
  db.query("INSERT INTO test_anchor VALUES (?)").run(
    JSON.stringify({
      identityHash: hash(0),
      headHash: hash(1),
      sequence: "0",
      fence: "1",
      provisioning: true,
      pending: false,
    }),
  );
  const faults = { pageReads: 0, syncs: 0, failSync: false, afterSql: "", now: 10n };
  const stmtCache = new Map<string, ReturnType<Database["query"]>>();
  const storage: SqliteStorage = {
    sql: {
      exec(sql, ...bindings) {
        if (
          sql.includes("FROM ledger_index_pages WHERE location = ?") &&
          sql.startsWith("SELECT substr")
        )
          faults.pageReads++;
        let stmt = stmtCache.get(sql);
        if (!stmt) {
          stmt = db.query(sql);
          stmtCache.set(sql, stmt);
        }
        const rows = stmt.all(
          ...bindings.map((value) =>
            value instanceof ArrayBuffer ? new Uint8Array(value) : value,
          ),
        ) as Record<string, unknown>[];
        if (faults.afterSql && sql.startsWith(faults.afterSql))
          throw new Error("injected retention SQL failure");
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          for (const name in row) {
            const value = row[name];
            if (value instanceof Uint8Array) {
              row[name] = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            }
          }
        }
        return rows;
      },
    },
    transactionSync: (operation) => db.transaction(operation)(),
    sync: async () => {
      faults.syncs++;
      if (faults.failSync) {
        faults.failSync = false;
        throw new Error("lost retention durability");
      }
    },
  };
  const anchor = () =>
    JSON.parse(
      (db.query("SELECT body FROM test_anchor").get() as { body: string }).body,
    ) as IndexAnchor;
  const writeAnchor = (next: IndexAnchor) => {
    storage.sql.exec("UPDATE test_anchor SET body = ?", JSON.stringify(next));
  };
  const control = new SqliteIndexControl(storage, anchor, () => faults.now),
    pages = new SqliteIndexPageStore(storage, hash(0));
  await control.initialize(INDEX_KEY_SCHEMA);
  await pages.initialize("allocated");
  writeAnchor({ ...anchor(), provisioning: false });
  const pin = async () =>
    control.pinCurrent((await control.readMetadata()).view, "construction", "1000000");
  async function insert(index: BalancedIndex, pin: IndexReaderPin, number: number) {
    const ids = await pages.reserve(control, pin, 2 * index.height + 1);
    let offset = 0;
    const plan = await prepareIndexInsert(
      index,
      { key: key(number), sequence: BigInt(pin.view.sequence) + 1n },
      (id) => pages.read(id),
      () => workflowValue(ids[offset++]),
    );
    for (const page of plan.pages)
      await pages.putReserved(control, pin, page.descriptor.page, page.bytes);
    if (offset < ids.length) await pages.abandon(control, pin, ids.slice(offset));
    return plan;
  }
  async function populated(count: number) {
    const construction = await pin();
    const leaves = Math.ceil(count / 200),
      mids = leaves > 50 ? Math.ceil(leaves / 50) : 0;
    const ids = await pages.reserve(control, construction, leaves + mids + (leaves > 1 ? 1 : 0));
    let offset = 0,
      level: IndexChild[] = [];
    const put = async (rows: { key: string; sequence: bigint }[], children: IndexChild[] = []) => {
      const page = encodeIndexPage(workflowValue(ids[offset++]), rows, children);
      await pages.putReserved(control, construction, page.descriptor.page, page.bytes);
      return page.descriptor;
    };
    for (let start = 1; start <= count; start += 200)
      level.push(
        await put(
          Array.from({ length: Math.min(200, count - start + 1) }, (_, i) => ({
            key: key(start + i),
            sequence: 1n,
          })),
        ),
      );
    if (mids) {
      const next: IndexChild[] = [];
      for (let i = 0; i < level.length; i += 50) next.push(await put([], level.slice(i, i + 50)));
      level = next;
    }
    const top = level.length === 1 ? workflowValue(level[0]) : await put([], level);
    const root = createIndexRoot(BigInt(count), top.page);
    const target = { ...anchor(), sequence: "1", headHash: hash(2) };
    const ready = await pages.retainPreparedRoot(
      control,
      construction,
      root,
      root.contentHash,
      target,
    );
    await control.publishPrepared(construction, ready.digest, () => {
      writeAnchor(target);
      return undefined;
    });
    return auditBalancedIndex(root, root.contentHash, (id) => pages.read(id));
  }
  return {
    db,
    storage,
    faults,
    control,
    pages,
    anchor,
    writeAnchor,
    pin,
    insert,
    populated,
    close: () => db.close(),
  };
}

test("COW retention reads only new pages as retained identity populations grow", async () => {
  const measurements: { population: number; full: number; incremental: number; created: number }[] =
    [];
  for (const population of [400, 4000, 16000]) {
    const f = await fixture();
    try {
      const base = await f.populated(population),
        pin = await f.pin();
      const plan = await f.insert(base, pin, population + 1);
      f.faults.pageReads = 0;
      const retained = await f.pages.retainInsertion(f.control, pin, plan);
      const incremental = f.faults.pageReads;
      expect(incremental).toBe(plan.pages.length);
      const target = { ...f.anchor(), sequence: "2", headHash: hash(3) };
      f.faults.pageReads = 0;
      const ready = await f.pages.registerRetainedAppend(f.control, pin, retained, target);
      expect(f.faults.pageReads).toBe(0);
      await f.control.publishPrepared(pin, ready.digest, () => {
        f.writeAnchor(target);
        return undefined;
      });
      // Measure the full-scan baseline only AFTER publication, so it cannot
      // supply missing retention work to the incremental path being tested.
      f.faults.pageReads = 0;
      await f.pages.retainRoot(plan.after, plan.after.contentHash);
      const full = f.faults.pageReads;
      measurements.push({ population, full, incremental, created: plan.pages.length });
      let ordinal = 0;
      for await (const entry of enumerateIndexPages(plan.after, plan.after.contentHash, (id) =>
        f.pages.read(id),
      )) {
        expect(entry.key).toBe(key(++ordinal));
        expect(entry.sequence).toBe(ordinal > population ? 2n : 1n);
      }
      expect(ordinal).toBe(population + 1);
      expect((await f.control.readMetadata()).view.hotRoot).toBe(plan.after.contentHash);
    } finally {
      f.close();
    }
  }
  expect(measurements.map((m) => m.incremental)).toEqual([2, 2, 3]);
  expect(measurements.map((m) => m.full)).toEqual([3, 21, 83]);
  expect(workflowValue(measurements.at(-1)).full).toBeGreaterThanOrEqual(80);
});

test("retained COW chains begin at the selected root, bind the pin, and reject forged provenance", async () => {
  const f = await fixture(),
    other = await fixture();
  try {
    const empty = createIndexRoot(0n, null),
      base = await auditBalancedIndex(empty, empty.contentHash, async () => undefined);
    const pin = await f.pin(),
      plan = await f.insert(base, pin, 1);
    expect(() => f.pages.retainInsertion(f.control, pin, { ...plan })).toThrow(
      "index_insertion_unprepared",
    );
    const first = await f.pages.retainInsertion(f.control, pin, plan);
    const next = await f.insert(plan.index, pin, 2);
    expect(() => f.pages.retainInsertion(f.control, pin, next)).toThrow(
      "index_append_context_mismatch",
    );
    expect(() => f.pages.retainInsertion(f.control, pin, next, { ...first })).toThrow(
      "index_append_unretained",
    );
    expect(() => other.pages.retainInsertion(other.control, pin, next, first)).toThrow(
      "index_append_unretained",
    );
    const second = await f.pages.retainInsertion(f.control, pin, next, first);
    expect(second.added).toBe(2n);
    const secondPin = await f.pin();
    expect(() =>
      f.pages.registerRetainedAppend(f.control, secondPin, second, {
        ...f.anchor(),
        sequence: "1",
        headHash: hash(4),
      }),
    ).toThrow("index_append_unretained");
    const target = { ...f.anchor(), sequence: "1", headHash: hash(4) };
    const ready = await f.pages.registerRetainedAppend(f.control, pin, second, target);
    await f.control.publishPrepared(pin, ready.digest, () => {
      f.writeAnchor(target);
      return undefined;
    });
    await expect(f.pages.registerRetainedAppend(f.control, pin, second, target)).rejects.toThrow();
  } finally {
    f.close();
    other.close();
  }
});

test("retention fails closed on missing new bytes and lost durability, then requires reconciliation", async () => {
  for (const defect of [
    "missing-page",
    "changed-page",
    "missing-base",
    "SQL-rollback",
    "lost-sync",
  ] as const) {
    const f = await fixture();
    try {
      const base = await f.populated(400),
        pin = await f.pin(),
        plan = await f.insert(base, pin, 401);
      if (defect === "missing-page")
        f.db
          .query("DELETE FROM ledger_index_pages WHERE location = ?")
          .run(workflowValue(plan.pages[0]).descriptor.page.location);
      if (defect === "changed-page") {
        const page = encodeIndexPage(workflowValue(plan.pages[0]).descriptor.page.location, [
          { key: key(999), sequence: 2n },
        ]);
        f.db
          .query(
            "UPDATE ledger_index_pages SET digest = ?, byte_count = ?, bytes = ? WHERE location = ?",
          )
          .run(
            page.descriptor.page.digest,
            page.bytes.length,
            page.bytes,
            page.descriptor.page.location,
          );
      }
      if (defect === "missing-base")
        f.db.query("DELETE FROM ledger_index_roots WHERE digest = ?").run(base.root.contentHash);
      if (defect === "SQL-rollback") f.faults.afterSql = "INSERT INTO ledger_index_roots";
      if (defect === "lost-sync") f.faults.failSync = true;
      await expect(f.pages.retainInsertion(f.control, pin, plan)).rejects.toThrow();
      expect(f.anchor().sequence).toBe("1");
      if (defect !== "lost-sync")
        expect(
          f.db
            .query("SELECT * FROM ledger_index_roots WHERE digest = ?")
            .get(plan.after.contentHash),
        ).toBeNull();
      await expect(f.pages.readRootDescriptor(base.root.contentHash)).rejects.toThrow(
        "index_page_store_uncertain",
      );
      f.faults.afterSql = "";
      await f.control.recoverMetadata();
      await f.pages.recover();
      if (defect === "SQL-rollback" || defect === "lost-sync")
        expect((await f.pages.retainInsertion(f.control, pin, plan)).added).toBe(1n);
    } finally {
      f.close();
    }
  }
});

test("retention requires globally allocated same-pin pages, unchanged fence, and exact publication rollback", async () => {
  const f = await fixture();
  try {
    const base = await f.populated(400),
      pin = await f.pin(),
      foreign = await f.pin();
    const foreignPlan = await f.insert(base, foreign, 401);
    await expect(f.pages.retainInsertion(f.control, pin, foreignPlan)).rejects.toThrow();
    await f.control.recoverMetadata();
    await f.pages.recover();
    const plan = await f.insert(base, pin, 402);
    const retained = await f.pages.retainInsertion(f.control, pin, plan);
    const target = { ...f.anchor(), sequence: "2", headHash: hash(9) };
    const ready = await f.pages.registerRetainedAppend(f.control, pin, retained, target);
    await expect(
      f.control.publishPrepared(pin, ready.digest, () => {
        f.writeAnchor(target);
        throw new Error("after canonical write");
      }),
    ).rejects.toThrow("after canonical write");
    expect(f.anchor().sequence).toBe("1");
    await f.control.recoverMetadata();
    await f.control.publishPrepared(pin, ready.digest, () => {
      f.writeAnchor(target);
      return undefined;
    });
    expect(f.anchor().sequence).toBe("2");
    const nextPin = await f.pin(),
      next = await f.insert(plan.index, nextPin, 403);
    f.writeAnchor({ ...f.anchor(), fence: "2" });
    await expect(f.pages.retainInsertion(f.control, nextPin, next)).rejects.toThrow();
    expect(f.anchor().sequence).toBe("2");
  } finally {
    f.close();
  }
});
