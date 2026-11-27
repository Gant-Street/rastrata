import { expect, test } from "bun:test";
import { API_VERSION } from "@rastrata/application/client-contracts";
import { type ApplicationFetch, BrowserApplicationClient } from "../../src/application-client";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

const job = (state: "running" | "done" | "failed", extra: Record<string, unknown> = {}) => ({
  state,
  kind: "verify",
  startedAt: "2026-10-03T18:15:00.000Z",
  stage: state === "running" ? "Replaying the ledger" : "Finished",
  done: state === "running" ? 3 : null,
  total: state === "running" ? 10 : null,
  elapsedMs: 100,
  remainingMs: null,
  ...extra,
});

test("a long job is asked again with the same identity and the same bytes until it ends, and its request is kept meanwhile", async () => {
  const store = storage();
  const key = `rastrata:${API_VERSION}:local-book:backups:verify:pending`;
  const bodies: string[] = [];
  const answers = [job("running"), job("running"), job("done", { verification: { passed: true } })];
  const fetcher = (async (_url, init) => {
    const body = String(init?.body);
    bodies.push(body);
    const request = JSON.parse(body);
    const data = answers.shift() ?? job("done");
    // While it runs the retained request is still there, so a reload could reach the same job.
    if (data.state === "running") expect(store.getItem(key)).not.toBeNull();
    return Response.json({
      version: API_VERSION,
      bookId: "local-book",
      ok: true,
      operationId: request.operationId,
      data,
    });
  }) as ApplicationFetch;
  const client = new BrowserApplicationClient(store, fetcher);
  const progress: number[] = [];
  const finished = await client.writeJob("backup.verify", {}, "backups:verify", {
    pollMs: 1,
    onProgress: (running) => progress.push(running.done ?? -1),
  });
  expect(finished.state).toBe("done");
  expect(bodies.length).toBe(3);
  expect(new Set(bodies).size).toBe(1);
  expect(JSON.parse(bodies[0] as string).operationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(progress).toEqual([3, 3]);
  expect(store.getItem(key)).toBeNull();
});

test("a failed job ends the request; a dropped connection keeps it and resumeJob reaches the same job", async () => {
  const store = storage();
  const key = `rastrata:${API_VERSION}:local-book:backups:drill:pending`;
  let firstBody = "";
  const dropped = (async (_url, init) => {
    firstBody = String(init?.body);
    throw new Error("Lost response");
  }) as ApplicationFetch;
  const first = new BrowserApplicationClient(store, dropped);
  await expect(
    first.writeJob("backup.drill", {}, "backups:drill", { pollMs: 1 }),
  ).rejects.toMatchObject({ code: "operation_unresolved", uncertain: true });
  expect(store.getItem(key)).not.toBeNull();
  // Another request cannot take its place.
  await expect(
    first.writeJob(
      "backup.drill",
      { backupId: "20261003T181500Z-00000004-1a2b3c4d" },
      "backups:drill",
    ),
  ).rejects.toThrow("Resume the original");
  const failing = (async (_url, init) => {
    expect(String(init?.body)).toBe(firstBody);
    const request = JSON.parse(firstBody);
    return Response.json({
      version: API_VERSION,
      bookId: "local-book",
      ok: true,
      operationId: request.operationId,
      data: job("failed", { kind: "drill", error: { code: "backup_failed", message: "No space" } }),
    });
  }) as ApplicationFetch;
  const second = new BrowserApplicationClient(store, failing);
  const ended = await second.resumeJob("backups:drill", { pollMs: 1 });
  expect(ended.state).toBe("failed");
  expect(store.getItem(key)).toBeNull();
  await expect(second.resumeJob("backups:drill")).rejects.toMatchObject({
    code: "request_not_found",
  });
});

test("a job request is refused for an operation that is not a job", async () => {
  const client = new BrowserApplicationClient(storage(), (async () =>
    Response.json({})) as ApplicationFetch);
  await expect(
    // @ts-expect-error not a job operation
    client.writeJob("drafts.discard", { draftId: "d", expectedVersion: 1 }, "x"),
  ).rejects.toThrow("Unsupported application job");
});
