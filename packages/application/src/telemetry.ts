/** The application's telemetry, in one file. The hooks elsewhere are a line each:
 *
 *   ApplicationHttp.fetch        observeRequest   one operation: its span, latency, CPU, rows written
 *   LocalBookService.open        observeOpen      opening a book, and instrumentService on the result
 *   runInWorker                  observeJob       a backup or a verification
 *   ingestPort, ensureProposals  observeIngest    the pipeline's steps
 *
 * Everything here is off unless `@rastrata/telemetry` has a backend (an endpoint is configured, or a
 * test called recordTelemetry): then `observeRequest` is `run()`, `instrumentService` returns, and
 * nothing is wrapped, so the local product runs the code it always ran. When it is on, a service is
 * instrumented once, when it is opened, by wrapping three of its members on the instance:
 *
 *   readAggregateNow  (private) the read of the verified state, inside the read queue, so the kind of
 *                     read (the view in memory, a snapshot, the whole log) is exact for each call
 *   ledger.execute    one command through the native ledger
 *   loadSnapshot / saveSnapshot  (private) the saved verified state
 *
 * A private member another lane renames leaves its wrapper off (it checks the member exists) and
 * test/telemetry.test.ts fails, naming it. */
import {
  counter,
  histogram,
  outcomeOfStatus,
  requestCpu,
  sizeBucket,
  span,
  stopwatch,
  telemetryEnabled,
  trackPeakMemory,
  trackWork,
  type SizeBucket,
} from "@rastrata/telemetry";
import { operationClassOf } from "./operation-class.ts";
import { operationCatalog } from "./schema.ts";
import type { ApplicationService } from "./service.ts";

// ---- How big the book is, from what the service has already read ---------------------------------

const knownJournals = new WeakMap<object, number>();

/** The journals a service has seen the book hold: exact after a read (the kernel keeps the count),
 * approximate after a write (the ledger's outcome count), and unknown before either. */
export function journalsOf(service: object): number | undefined {
  return knownJournals.get(service);
}
export const sizeOf = (service: object): SizeBucket => sizeBucket(knownJournals.get(service));

function noteJournals(
  service: object,
  count: number | bigint | string | undefined,
  exact: boolean,
) {
  if (count === undefined) return;
  const value = Number(count);
  if (!Number.isFinite(value) || value < 0) return;
  // A write's outcome count may run a few ahead of the journals; a read corrects it.
  if (exact || value > (knownJournals.get(service) ?? -1)) knownJournals.set(service, value);
}

// ---- The operation -------------------------------------------------------------------------------

const catalog = new Map(operationCatalog.map((operation) => [operation.name, operation]));

/** `SELECT total_changes()`: the rows the connection has inserted, updated or deleted since it was
 * opened. Subtracting the value before a request from the value after is the rows it wrote (the
 * ledger shares the connection; index entries are not counted). Undefined where the store cannot say. */
function totalChanges(service: ApplicationService): number | undefined {
  try {
    const row = service.store.query("SELECT total_changes() AS n").get() as { n: number } | null;
    return typeof row?.n === "number" ? row.n : undefined;
  } catch {
    return undefined;
  }
}

/** What `ApplicationHttp` knows about a request while it runs. */
export interface RequestFacts {
  operation?: string;
  operationId?: string;
  code?: string;
}

/** Wrap one request: an `operation` span, the request counted and timed under its class, the CPU of
 * the thread shared out among the requests in flight, and the rows it wrote. Never changes the
 * response, and never throws on its own account. */
export function observeRequest(
  service: ApplicationService,
  facts: RequestFacts,
  run: () => Promise<Response>,
): Promise<Response> {
  if (!telemetryEnabled()) return run();
  const finished = trackWork();
  const ticket = requestCpu.begin();
  const elapsed = stopwatch();
  const rowsBefore = totalChanges(service);
  return span("operation", undefined, async (s) => {
    try {
      const response = await run();
      const definition = facts.operation ? catalog.get(facts.operation) : undefined;
      const operationClass = operationClassOf(facts.operation, definition?.permission);
      const seconds = elapsed();
      const size = sizeOf(service);
      // The API's only timeout is 408, a client too slow to send its request.
      const mapped = outcomeOfStatus(response.status);
      const outcome = mapped === "timeout" ? "client_error" : mapped;
      counter("requests").add(1, { operation_class: operationClass, outcome });
      histogram("request.duration").record(seconds, { operation_class: operationClass });
      if (operationClass === "report" && size !== "unknown")
        histogram("report.duration").record(seconds, { size_bucket: size });
      const rowsAfter = totalChanges(service);
      const rows =
        rowsBefore !== undefined && rowsAfter !== undefined
          ? Math.max(0, rowsAfter - rowsBefore)
          : 0;
      if (rows > 0) counter("db.rows.written").add(rows, { operation_class: operationClass });
      s.setAttributes({
        operation: definition ? definition.name : "unrouted",
        operation_class: operationClass,
        size_bucket: size,
        outcome,
        "http.response.status_code": response.status,
        rows,
        ...(facts.operationId ? { operation_id: facts.operationId } : {}),
        ...(facts.code ? { "error.code": facts.code } : {}),
      });
      return response;
    } finally {
      finished();
      const cpu = requestCpu.end(ticket);
      const definition = facts.operation ? catalog.get(facts.operation) : undefined;
      counter("request.cpu.time").add(cpu, {
        operation_class: operationClassOf(facts.operation, definition?.permission),
        size_bucket: sizeOf(service),
      });
    }
  });
}

// ---- Opening a book, and the instance's members ------------------------------------------------

/** Time opening a book, then instrument the service that came out. A no-op with telemetry off. */
export async function observeOpen<T extends ApplicationService>(
  open: () => Promise<T>,
): Promise<T> {
  if (!telemetryEnabled()) return open();
  const elapsed = stopwatch();
  const service = await span("service.open", undefined, open);
  histogram("service.open.duration").record(elapsed());
  instrumentService(service);
  return service;
}

const instrumented = new WeakSet<object>();
/** Services whose last attempt to save a snapshot failed, until the read that made it reports it. */
const failedSaves = new WeakSet<object>();

type Member = (...args: unknown[]) => unknown;

/** Replace `target[name]` with `wrap(original)`, if there is such a function to wrap. */
function wrapMember(
  target: Record<string, unknown>,
  name: string,
  wrap: (original: Member) => Member,
): boolean {
  const original = target[name];
  if (typeof original !== "function") return false;
  target[name] = wrap(original.bind(target) as Member);
  return true;
}

export function instrumentService(service: ApplicationService): void {
  if (!telemetryEnabled() || instrumented.has(service)) return;
  instrumented.add(service);
  const members = service as unknown as Record<string, unknown>;

  const readKind = (
    before: ApplicationService["readStats"],
    after: ApplicationService["readStats"],
  ) => (after.full > before.full ? "full" : after.snapshot > before.snapshot ? "snapshot" : "view");

  const timed = (original: Member): Member =>
    ((...args: unknown[]) => {
      const before = { ...service.readStats };
      // Only the first read of a process is a cold one worth watching the memory of; a read that
      // extends the view in memory takes microseconds and needs no timer.
      const cold = before.full + before.snapshot + before.incremental === 0;
      const memory = cold ? trackPeakMemory() : undefined;
      const elapsed = stopwatch();
      return span("read.aggregate", undefined, async (s) => {
        try {
          const result = (await original(...args)) as Awaited<
            ReturnType<ApplicationService["readAggregate"]>
          >;
          const kind = readKind(before, service.readStats);
          const verified = service.readStats.verified - before.verified;
          noteJournals(service, result.aggregate.state.latestPostingSequence, true);
          histogram("read.duration").record(elapsed(), { read_kind: kind });
          if (verified > 0) counter("read.entries.verified").add(verified, { read_kind: kind });
          const peak = memory?.stop() ?? 0;
          if (peak > 0)
            histogram("read.peak_memory").record(peak, {
              read_kind: kind,
              snapshot_attempt: failedSaves.delete(service) ? "failed" : "none",
            });
          s.setAttributes({
            read_kind: kind,
            entries: verified,
            size_bucket: sizeOf(service),
          });
          return result;
        } finally {
          memory?.stop();
        }
      });
    }) as Member;

  // The private member inside the read queue gives an exact kind; if it has been renamed, the public
  // one still gives the timing.
  if (!wrapMember(members, "readAggregateNow", timed)) wrapMember(members, "readAggregate", timed);

  const ledger = service.ledger as unknown as Record<string, unknown>;
  wrapMember(ledger, "execute", (original) => {
    return (...args: unknown[]) => {
      const elapsed = stopwatch();
      return span("ledger.execute", undefined, async (s) => {
        let result: "committed" | "rejected" | "error" = "error";
        try {
          const receipt = (await original(...args)) as {
            value?: {
              result?: { disposition?: string };
              originalResult?: { disposition?: string };
              outcomeSequence?: string;
            };
          };
          const disposition = (receipt.value?.originalResult ?? receipt.value?.result)?.disposition;
          result =
            disposition === "committed"
              ? "committed"
              : disposition === "rejected"
                ? "rejected"
                : "error";
          noteJournals(service, receipt.value?.outcomeSequence, false);
          return receipt;
        } finally {
          histogram("ledger.execute.duration").record(elapsed(), { ledger_result: result });
          s.setAttribute("ledger_result", result);
        }
      });
    };
  });

  const snapshotBytes = (): number | undefined => {
    try {
      const row = service.store
        .query("SELECT length(CAST(encoded AS BLOB)) AS bytes FROM app_read_snapshots WHERE id=1")
        .get() as { bytes: number } | null;
      return typeof row?.bytes === "number" ? row.bytes : undefined;
    } catch {
      return undefined;
    }
  };
  wrapMember(members, "saveSnapshot", (original) => {
    return (...args: unknown[]) => {
      const elapsed = stopwatch();
      return span("snapshot.save", undefined, (s) => {
        try {
          const result = original(...args);
          counter("snapshot.attempts").add(1, { snapshot_op: "save", snapshot_result: "ok" });
          const bytes = snapshotBytes();
          if (bytes !== undefined) {
            histogram("snapshot.bytes").record(bytes, { snapshot_op: "save" });
            s.setAttribute("bytes", bytes);
          }
          return result;
        } catch (error) {
          // The kernel refuses to encode a book past 16 MiB, after the memory has been spent.
          counter("snapshot.attempts").add(1, { snapshot_op: "save", snapshot_result: "failed" });
          failedSaves.add(service);
          throw error;
        } finally {
          histogram("snapshot.duration").record(elapsed(), { snapshot_op: "save" });
        }
      });
    };
  });
  wrapMember(members, "loadSnapshot", (original) => {
    return (...args: unknown[]) => {
      const elapsed = stopwatch();
      return span("snapshot.load", undefined, (s) => {
        try {
          const result = original(...args);
          counter("snapshot.attempts").add(1, {
            snapshot_op: "load",
            snapshot_result: result ? "ok" : "skipped",
          });
          if (result) {
            const bytes = snapshotBytes();
            if (bytes !== undefined) {
              histogram("snapshot.bytes").record(bytes, { snapshot_op: "load" });
              s.setAttribute("bytes", bytes);
            }
          }
          return result;
        } catch (error) {
          counter("snapshot.attempts").add(1, { snapshot_op: "load", snapshot_result: "failed" });
          throw error;
        } finally {
          histogram("snapshot.duration").record(elapsed(), { snapshot_op: "load" });
        }
      });
    };
  });
}

// ---- Jobs and the ingest pipeline ----------------------------------------------------------------

export type JobType = "verify" | "backup";

/** A background job: counted, timed, its memory peak watched, a span around it. `cpuSeconds` is the
 * CPU the worker thread reports for itself, which only the worker can know. */
export function observeJob<T>(
  type: JobType,
  run: (report: (cpuSeconds: number) => void) => Promise<T>,
): Promise<T> {
  if (!telemetryEnabled()) return run(() => {});
  const finished = trackWork();
  const memory = trackPeakMemory();
  const elapsed = stopwatch();
  return span(type === "verify" ? "job.verify" : "job.backup", { job_type: type }, async () => {
    let outcome: "ok" | "server_error" = "server_error";
    try {
      const value = await run((cpuSeconds) => {
        if (cpuSeconds > 0) counter("job.cpu.time").add(cpuSeconds, { job_type: type });
      });
      outcome = "ok";
      return value;
    } finally {
      finished();
      counter("jobs").add(1, { job_type: type, outcome });
      histogram("job.duration").record(elapsed(), { job_type: type });
      const peak = memory.stop();
      if (peak > 0) histogram("job.memory.peak").record(peak, { job_type: type });
    }
  });
}

/** A step of the ingest pipeline, as a span. A no-op with telemetry off. */
export function observeIngest<T>(
  step: "archive" | "preview" | "submit" | "propose" | "post",
  attributes: { bytes?: number; rows?: number } | undefined,
  run: () => T,
): T {
  if (!telemetryEnabled()) return run();
  const name = `ingest.${step}` as const;
  return span(name, attributes, run);
}
