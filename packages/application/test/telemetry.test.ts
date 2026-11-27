import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordTelemetry } from "@rastrata/telemetry/testing";
import { ApplicationHttp } from "../src/http.ts";
import { LocalBookService } from "../src/local.ts";
import { runInWorker, workerEntry } from "../src/local/worker.ts";
import { LISTED_OPERATIONS, operationClassOf } from "../src/operation-class.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS, operationCatalog } from "../src/schema.ts";
import { ingestPort } from "../src/slices/ingest/port.ts";
import { ensureProposals } from "../src/slices/ingest/proposing.ts";
import { BULK_BOOK, postBulk } from "./support/bulk-book.ts";

const OPENING = {
  date: "2026-01-15",
  reference: "OPEN",
  narration: "Owner contribution",
  lines: [
    { accountId: "1000", debit: "1000.00", credit: "" },
    { accountId: "3000", debit: "", credit: "1000.00" },
  ],
};

// biome-ignore lint/suspicious/noExplicitAny: decoded JSON in a test
type Json = Record<string, any>;

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const work of cleanup.splice(0).reverse()) await work();
});

async function fixture(options: { setup?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-telemetry-"));
  const path = join(directory, "book.sqlite");
  const service = await LocalBookService.open(path);
  const http = new ApplicationHttp(service, {
    bookId: service.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  cleanup.push(() => {
    try {
      service.close();
    } catch {
      // A test that closed the service itself.
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const call = async (name: string, input: unknown = {}, operationId?: string, body?: string) => {
    const response = await http.fetch(
      new Request(`http://127.0.0.1:4010/v1/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body:
          body ??
          JSON.stringify({
            version: APPLICATION_API_VERSION,
            bookId: "local-book",
            input,
            ...(operationId ? { operationId } : {}),
          }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Json };
  };
  if (options.setup !== false) {
    const done = await call("book.setup", BULK_BOOK, crypto.randomUUID());
    expect(done.status).toBe(200);
  }
  return { service, http, call, path, directory };
}

describe("with telemetry off", () => {
  test("nothing is wrapped: the service runs the code it always ran", async () => {
    const { service } = await fixture({ setup: false });
    for (const member of ["readAggregate", "readAggregateNow", "saveSnapshot", "loadSnapshot"])
      expect(Object.hasOwn(service, member), member).toBe(false);
    expect(Object.hasOwn(service.ledger, "execute")).toBe(false);
  });
});

describe("with telemetry on", () => {
  test("a request is a span, a count, a latency, some CPU and the rows it wrote", async () => {
    const telemetry = recordTelemetry();
    try {
      const { call } = await fixture();
      const created = await call(
        "drafts.create",
        { data: { ...OPENING, narration: "CANARY-narration-4417" } },
        crypto.randomUUID(),
      );
      expect(created.status).toBe(200);
      await call("drafts.list", { page: 1 });
      await call("no.such.operation", {});
      await call("drafts.list", {}, undefined, "{not json");

      // Counted by the class of the operation and how it ended.
      expect(telemetry.sum("requests", { operation_class: "draft", outcome: "ok" })).toBe(1);
      expect(telemetry.sum("requests", { operation_class: "read", outcome: "ok" })).toBe(1);
      expect(telemetry.sum("requests", { operation_class: "other", outcome: "not_found" })).toBe(1);
      expect(telemetry.sum("requests", { operation_class: "read", outcome: "client_error" })).toBe(
        1,
      );
      expect(telemetry.stats("request.duration", { operation_class: "draft" }).count).toBe(1);
      expect(telemetry.stats("request.duration", { operation_class: "read" }).count).toBe(2);
      // The book setup and the draft wrote rows; reads wrote none.
      expect(telemetry.sum("db.rows.written", { operation_class: "draft" })).toBeGreaterThan(0);
      expect(telemetry.sum("db.rows.written", { operation_class: "read" })).toBe(0);
      expect(telemetry.sum("request.cpu.time")).toBeGreaterThan(0);

      // The spans carry what was asked and how it went, not the payload.
      const spans = telemetry.spansNamed("operation");
      const draft = spans.find((span) => span.attributes.operation === "drafts.create");
      expect(draft?.attributes).toMatchObject({
        operation_class: "draft",
        "http.response.status_code": 200,
        outcome: "ok",
      });
      expect(Number(draft?.attributes.rows)).toBeGreaterThan(0);
      expect(spans.find((span) => span.attributes.operation === "unrouted")).toBeDefined();
      expect(JSON.stringify(telemetry.spans)).not.toContain("CANARY");
      expect(telemetry.invalid).toEqual([]);
    } finally {
      telemetry.stop();
    }
  });

  test("a commit shows its reads and its ledger command as children of the operation", async () => {
    const telemetry = recordTelemetry();
    try {
      const { call } = await fixture();
      const draft = await call("drafts.create", { data: OPENING }, crypto.randomUUID());
      const prepared = await call(
        "journal.prepare",
        { draftId: draft.body.data.id, expectedVersion: 1 },
        crypto.randomUUID(),
      );
      expect(prepared.status).toBe(200);
      telemetry.reset();
      const committed = await call("operations.commit", {
        planId: prepared.body.data.planId,
        planHash: prepared.body.data.planHash,
      });
      expect(committed.status).toBe(200);

      const [operation] = telemetry.spansNamed("operation");
      expect(operation?.attributes.operation).toBe("operations.commit");
      expect(operation?.attributes.operation_class).toBe("post");
      const inside = (name: "ledger.execute" | "read.aggregate") =>
        telemetry.spansNamed(name).filter((span) => span.traceId === operation?.traceId);
      expect(inside("ledger.execute")).toHaveLength(1);
      expect(inside("ledger.execute")[0]?.attributes.ledger_result).toBe("committed");
      // The commit itself reads nothing (the preview already did); whatever it did read is inside it.
      for (const read of inside("read.aggregate"))
        expect(read.traceId).toBe(operation?.traceId as string);
      // Every child's parent is a span of the same trace, and the operation is the root here.
      const ids = new Set(telemetry.spans.map((span) => span.spanId));
      for (const span of telemetry.spans)
        if (span !== operation) expect(ids.has(span.parentSpanId ?? "")).toBe(true);
      expect(operation?.parentSpanId).toBeUndefined();
      expect(telemetry.stats("ledger.execute.duration", { ledger_result: "committed" }).count).toBe(
        1,
      );
      expect(telemetry.sum("requests", { operation_class: "post", outcome: "ok" })).toBe(1);
      expect(telemetry.sum("db.rows.written", { operation_class: "post" })).toBeGreaterThan(0);
    } finally {
      telemetry.stop();
    }
  });

  test("reads say where they started, and the first read after an open is the cold one", async () => {
    const telemetry = recordTelemetry();
    try {
      const { service, path, directory } = await fixture();
      await postBulk(service, 30);
      await service.readAggregate(); // the view covers the book, so closing saves a snapshot
      service.close();
      const reopened = await LocalBookService.open(path);
      cleanup.push(() => {
        try {
          reopened.close();
        } catch {
          // Closed by the test.
        }
      });
      telemetry.reset();
      await reopened.readAggregate();
      await reopened.readAggregate();
      const kinds = telemetry.spansNamed("read.aggregate").map((span) => span.attributes.read_kind);
      // The service saved a snapshot when it closed, so the first read starts from it; the second
      // extends the state already in memory.
      expect(kinds).toEqual(["snapshot", "view"]);
      expect(telemetry.stats("read.duration", { read_kind: "snapshot" }).count).toBe(1);
      expect(telemetry.stats("read.duration", { read_kind: "view" }).count).toBe(1);
      // A cold read watches the memory of the process; a read in memory does not.
      expect(
        telemetry.stats("read.peak_memory", { read_kind: "snapshot", snapshot_attempt: "none" })
          .count,
      ).toBe(1);
      expect(telemetry.stats("read.peak_memory", { read_kind: "view" }).count).toBe(0);
      expect(
        telemetry.sum("snapshot.attempts", { snapshot_op: "load", snapshot_result: "ok" }),
      ).toBe(1);
      expect(telemetry.stats("snapshot.bytes", { snapshot_op: "load" }).sum).toBeGreaterThan(1000);
      expect(directory).toBeTruthy();
    } finally {
      telemetry.stop();
    }
  });

  test("the size bucket follows the journals the kernel counted, not the entries of any log", async () => {
    const telemetry = recordTelemetry();
    try {
      const { service, call } = await fixture();
      await call("reports.get", { asOf: "2026-12-31" });
      expect(telemetry.stats("report.duration", { size_bucket: "xs" }).count).toBe(1);
      await postBulk(service, 520);
      await call("reports.get", { asOf: "2026-12-31" });
      // 520 journals: the bucket for 500 to 1,999.
      expect(telemetry.stats("report.duration", { size_bucket: "s" }).count).toBe(1);
      expect(
        telemetry.sum("request.cpu.time", { operation_class: "report", size_bucket: "s" }),
      ).toBeGreaterThan(0);
    } finally {
      telemetry.stop();
    }
  });

  test("a snapshot that cannot be saved is counted as failed and flagged on the cold read", async () => {
    const telemetry = recordTelemetry();
    try {
      const { service, path } = await fixture();
      await postBulk(service, 130);
      // Nothing has verified the 130 journals, so closing saves no snapshot and the next open
      // replays them all, and a replay of 100 or more outcomes tries to save one at its end.
      service.close();
      const reopened = await LocalBookService.open(path, { safety: false });
      cleanup.push(() => {
        try {
          reopened.close();
        } catch {
          // Closed by the test.
        }
      });
      // Make the save fail the way it does for a book past the kernel's 16 MiB cap: after the work
      // is done, with an error, while the read itself must still succeed.
      reopened.store.exec(
        "CREATE TRIGGER refuse_snapshots BEFORE INSERT ON app_read_snapshots BEGIN SELECT RAISE(ABORT, 'full'); END",
      );
      telemetry.reset();
      const { aggregate } = await reopened.readAggregate();
      expect(aggregate.state.latestPostingSequence).toBe(130n);
      expect(
        telemetry.sum("snapshot.attempts", { snapshot_op: "save", snapshot_result: "failed" }),
      ).toBe(1);
      expect(
        telemetry.sum("snapshot.attempts", { snapshot_op: "save", snapshot_result: "ok" }),
      ).toBe(0);
      expect(telemetry.spansNamed("snapshot.save")[0]?.status).toBe("error");
      // The first read of the process is the cold one, and it says that a save failed during it.
      expect(
        telemetry.stats("read.peak_memory", { read_kind: "full", snapshot_attempt: "failed" })
          .count,
      ).toBe(1);
      expect(telemetry.invalid).toEqual([]);
    } finally {
      telemetry.stop();
    }
  });

  test("overlapping requests keep their own spans and share the CPU between them", async () => {
    const telemetry = recordTelemetry();
    try {
      const { service, call } = await fixture();
      await postBulk(service, 60);
      telemetry.reset();
      await Promise.all(
        Array.from({ length: 24 }, () => call("reports.get", { asOf: "2026-12-31" })),
      );
      const operations = telemetry.spansNamed("operation");
      expect(operations).toHaveLength(24);
      expect(new Set(operations.map((span) => span.traceId)).size).toBe(24);
      const byId = new Map(telemetry.spans.map((span) => [span.spanId, span]));
      for (const span of telemetry.spansNamed("read.aggregate")) {
        const parent = byId.get(span.parentSpanId ?? "");
        expect(parent?.name).toBe("operation");
        expect(parent?.traceId).toBe(span.traceId);
      }
      expect(telemetry.sum("requests", { operation_class: "report", outcome: "ok" })).toBe(24);
    } finally {
      telemetry.stop();
    }
  });

  test("the private members it wraps still exist; if one is renamed, update telemetry.ts", async () => {
    const telemetry = recordTelemetry();
    try {
      const { service } = await fixture({ setup: false });
      // readAggregateNow is the read inside the queue, where the kind of read is exact.
      expect(Object.hasOwn(service, "readAggregateNow")).toBe(true);
      expect(Object.hasOwn(service, "saveSnapshot")).toBe(true);
      expect(Object.hasOwn(service, "loadSnapshot")).toBe(true);
      expect(Object.hasOwn(service.ledger, "execute")).toBe(true);
      // And once, however often it is opened or told.
      const before = service.readAggregate;
      const { instrumentService } = await import("../src/telemetry.ts");
      instrumentService(service);
      expect(service.readAggregate).toBe(before);
    } finally {
      telemetry.stop();
    }
  });
});

describe("jobs and the ingest pipeline", () => {
  test("a task in a worker is a job with its type, duration, memory and the CPU the worker spent", async () => {
    const telemetry = recordTelemetry();
    try {
      const { service, path, directory } = await fixture();
      await postBulk(service, 40);
      const target = join(directory, "copy.sqlite");
      await runInWorker(workerEntry("snapshot-worker.ts"), { source: path, target });
      expect(telemetry.sum("jobs", { job_type: "backup", outcome: "ok" })).toBe(1);
      expect(telemetry.stats("job.duration", { job_type: "backup" }).count).toBe(1);
      expect(telemetry.stats("job.memory.peak", { job_type: "backup" }).count).toBe(1);
      expect(telemetry.sum("job.cpu.time", { job_type: "backup" })).toBeGreaterThan(0);
      expect(telemetry.spansNamed("job.backup")).toHaveLength(1);

      await expect(
        runInWorker(workerEntry("verify-worker.ts"), { kind: "nonsense" }),
      ).rejects.toThrow();
      expect(telemetry.sum("jobs", { job_type: "verify", outcome: "server_error" })).toBe(1);
    } finally {
      telemetry.stop();
    }
  });

  test("the pipeline's steps are spans", async () => {
    const telemetry = recordTelemetry();
    try {
      const { service } = await fixture();
      ingestPort(service).archive(new Uint8Array([1, 2, 3]), "text/plain", "x.txt");
      await ensureProposals(service);
      expect(telemetry.spansNamed("ingest.archive")[0]?.attributes.bytes).toBe(3);
      expect(telemetry.spansNamed("ingest.propose")).toHaveLength(1);
    } finally {
      telemetry.stop();
    }
  });
});

describe("operation classes", () => {
  test("every operation has a class that is not other, and every named one exists", () => {
    const counts = new Map<string, number>();
    for (const operation of operationCatalog) {
      const cls = operationClassOf(operation.name, operation.permission);
      expect(cls, operation.name).not.toBe("other");
      counts.set(cls, (counts.get(cls) ?? 0) + 1);
    }
    const names = new Set(operationCatalog.map((operation) => operation.name));
    for (const listed of LISTED_OPERATIONS)
      expect(names.has(listed), `${listed} is listed but gone`).toBe(true);
    console.info(
      `operation classes: ${[...counts].map(([name, count]) => `${name} ${count}`).join(", ")}`,
    );
    for (const cls of ["read", "report", "draft", "prepare", "post", "maintain", "ingest", "job"])
      expect(counts.get(cls) ?? 0, cls).toBeGreaterThan(0);
  });

  test("an unknown name, and one that is a property of Object, are other", () => {
    expect(operationClassOf(undefined)).toBe("other");
    expect(operationClassOf("no.such")).toBe("other");
    expect(operationClassOf("__proto__")).toBe("other");
    expect(operationClassOf("constructor", "read")).toBe("read");
  });
});
