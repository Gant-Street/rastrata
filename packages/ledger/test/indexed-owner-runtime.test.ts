import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import {
  canonicalAccountingValue,
  canonicalEncode,
  encodeDurableBook,
  executeBookCommand,
  type DurableBookAggregate,
} from "@rastrata/kernel";
import { activation, genesis, posting } from "./fixtures.ts";

test("new indexed owner survives workerd replacement with exact retries and atomic root/catalog publication", async () => {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "runtime-indexed-owner-worker.ts")],
    target: "node",
    format: "esm",
    external: ["node:crypto"],
  });
  expect(build.success).toBe(true);
  const output = build.outputs[0];
  if (!output) throw new Error("Missing indexed-owner bundle");
  const script = await output.text();
  expect(script).toContain('from "node:crypto"');
  const directory = mkdtempSync(join(tmpdir(), "rastrata-indexed-owner-runtime-"));
  const options = {
    modules: true,
    script,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { BOOKS: { className: "IndexedOwnerObject", useSQLite: true } },
    durableObjectsPersist: directory,
    cf: false,
  };
  let runtime = new Miniflare(options);
  async function call(path: string) {
    const response = await runtime.dispatchFetch(`http://indexed-owner.test${path}`);
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw new Error(JSON.stringify(body));
    return body;
  }
  async function refused(path: string, message: string) {
    const response = await runtime.dispatchFetch(`http://indexed-owner.test${path}`);
    expect(response.status).toBe(500);
    expect(await response.text()).toContain(message);
  }
  let expected: DurableBookAggregate = genesis();
  const originals = new Map<string, string>();
  function apply(command: ReturnType<typeof posting>) {
    const transition = executeBookCommand(expected.state, expected.protocol, command);
    originals.set(
      command.id,
      new TextDecoder().decode(canonicalEncode(canonicalAccountingValue(transition.result))),
    );
    expected = { state: transition.state, protocol: transition.protocol };
  }
  try {
    await call("/provision");
    const early = posting("early-rejection", 0n);
    apply(early);
    const rejectedBeforeActivation = await call("/post?id=early-rejection&revision=0");
    expect(rejectedBeforeActivation.disposition).toBe("rejected");
    expect(rejectedBeforeActivation.original).toBe(originals.get(early.id));
    apply(activation());
    expect((await call("/activate")).outcomeSequence).toBe("2");
    apply(posting("runtime-sale"));
    const duplicate = await Promise.all([
      call("/post?id=runtime-sale"),
      call("/post?id=runtime-sale"),
    ]);
    expect(duplicate.map((r) => r.disposition).sort()).toEqual(["committed", "replayed"]);
    expect(duplicate.map((r) => r.original)).toEqual([
      originals.get("runtime-sale"),
      originals.get("runtime-sale"),
    ]);
    apply(posting("runtime-stale", 0n));
    expect((await call("/post?id=runtime-stale&revision=0")).outcomeSequence).toBe("4");
    const before = await call("/read");
    expect(before.snapshot).toBe(encodeDurableBook(expected));
    await refused("/rollback?id=rolled-back&revision=2", "injected workerd canonical rollback");
    expect(await call("/read")).toEqual(before);
    await refused("/lost?id=lost-runtime&revision=2", "injected workerd lost durability reply");
    apply(posting("lost-runtime", 2n));
    const beforeMaintenance = await call("/read");
    expect(beforeMaintenance.snapshot).toBe(encodeDurableBook(expected));
    expect(beforeMaintenance.sequence).toBe("5");
    await refused("/maintained?id=maintenance-sale&revision=3", "indexed_owner_maintenance");
    apply(posting("maintenance-sale", 3n));
    await refused("/read", "indexed_owner_maintenance");
    // Explicit harness authority release, not volatile-control recovery evidence.
    await call("/resume-maintenance");
    const selected = await call("/read");
    expect(selected.snapshot).toBe(encodeDurableBook(expected));
    expect(selected.sequence).toBe("6");
    await runtime.dispose();
    runtime = new Miniflare(options);
    expect(await call("/read")).toEqual(selected);
    for (const [id, revision, sequence] of [
      ["early-rejection", 0, "1"],
      ["runtime-sale", 1, "3"],
      ["runtime-stale", 0, "4"],
      ["lost-runtime", 2, "5"],
      ["maintenance-sale", 3, "6"],
    ] as const) {
      const retry = await call(`/post?id=${id}&revision=${revision}`);
      expect(retry.disposition).toBe("replayed");
      expect(retry.outcomeSequence).toBe(sequence);
      expect(retry.original).toBe(originals.get(id));
    }
    expect(await call("/read")).toEqual(selected);
    const count = await call("/raw-count");
    await call("/damage-source");
    // Warm cached state is not a full historical-storage audit. The explicit
    // audit and a retry touching the missing source must still refuse service.
    expect(await call("/read")).toEqual(selected);
    await refused("/audit", "indexed_source");
    await refused("/post?id=runtime-sale", "indexed_source");
    expect(await call("/raw-count")).toEqual(count);
  } finally {
    await runtime.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180000);

test("native Durable Object alarm resumes the outcome outbox into R2 after runtime replacement", async () => {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "runtime-indexed-owner-worker.ts")],
    target: "node",
    format: "esm",
    external: ["node:crypto"],
  });
  expect(build.success).toBe(true);
  const output = build.outputs[0];
  if (!output) throw new Error("Missing outbox worker bundle");
  const directory = mkdtempSync(join(tmpdir(), "rastrata-outbox-runtime-"));
  const options = {
    modules: true,
    script: await output.text(),
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { BOOKS: { className: "IndexedOwnerObject", useSQLite: true } },
    durableObjectsPersist: join(directory, "books"),
    r2Buckets: ["ARCHIVE"],
    r2Persist: join(directory, "archive"),
    cf: false,
  };
  let runtime = new Miniflare(options);
  const call = async (path: string) => {
    const response = await runtime.dispatchFetch(`http://outbox.test${path}`);
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()) as Record<string, unknown>;
  };
  try {
    await call("/provision");
    const alarm = await call("/outbox/alarm");
    expect(typeof alarm.scheduledAt).toBe("number");
    await call("/activate");
    await call("/post?id=archive-sale");
    await call("/post?id=archive-rejection&revision=0");
    const before = await call("/read");
    expect(await call("/outbox/alarm")).toEqual(alarm);
    await runtime.dispose();
    runtime = new Miniflare(options);
    expect(await call("/outbox/alarm")).toEqual(alarm);
    let archived: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      await call("/outbox/arm"); // Trigger actual alarm dispatch, not a direct drain call.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const response = await runtime.dispatchFetch("http://outbox.test/outbox/inspect");
      if (response.ok) {
        archived = (await response.json()) as Record<string, unknown>;
        if (archived.through === "3") break;
      }
    }
    expect(archived?.through).toBe("3");
    expect(archived?.outcomes).toHaveLength(3);
    if (!archived) throw new Error("Alarm did not archive the retained outcomes");
    expect(await call("/read")).toEqual(before);
    expect((await call("/post?id=archive-sale")).disposition).toBe("replayed");
    await runtime.dispose();
    runtime = new Miniflare(options);
    expect(await call("/outbox/inspect")).toEqual(archived);
  } finally {
    await runtime.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}, 90000);
