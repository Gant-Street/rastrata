import type { PreparedOperation } from "@rastrata/application/client-contracts";
import { isDeepStrictEqual } from "node:util";
import { operationCatalog } from "@rastrata/application/schema";
import { financialProblems } from "./oracle.ts";
import { SETUP, type Snapshot, type Trace } from "./runtime.ts";
import type { Turn } from "./scenarios.ts";

/** `book.get` reports the setup with its defaults filled in, so the fixture is compared as the
 * service reports it: an accrual book with a January fiscal year. */
const REPORTED_SETUP = { ...SETUP, basis: "accrual", fiscalYearStartMonth: 1 };

export interface TurnGrade {
  turn: number;
  mechanical: "pass" | "fail";
  problems: string[];
  review: { question: string; status: "pending" | "pass" | "fail"; evidence?: string };
}

export function gradeTurn(
  turn: number,
  spec: Turn,
  before: Snapshot,
  after: Snapshot,
  trace: readonly Trace[],
  surface: "mcp" | "cli" = "mcp",
): TurnGrade {
  const problems = spec.unconfigured
    ? after.setup === null && after.journals.length === 0
      ? []
      : ["Read-only inspection configured or posted the book"]
    : financialProblems(spec.events, after.reports, after.journals);
  if (!spec.unconfigured && !isDeepStrictEqual(after.setup, REPORTED_SETUP))
    problems.push("Setup differs from the exact fixture settings");
  const api = trace.filter(
    (entry) => entry.actor === "agent" && entry.channel === "api" && entry.turn === turn,
  );
  const mcp = trace.filter(
    (entry) => entry.actor === "agent" && entry.channel === "mcp" && entry.turn === turn,
  );
  const calls = mcp.length ? mcp : api;
  const writes = api.filter(
    (entry) => operationCatalog.find((operation) => operation.name === entry.operation)?.writes,
  );
  const attempts = [...api, ...mcp].filter(
    (entry) => operationCatalog.find((operation) => operation.name === entry.operation)?.writes,
  );
  for (const entry of attempts)
    if (!spec.allowedWrites.includes(entry.operation))
      problems.push(`Unauthorized write attempt in turn ${turn}: ${entry.operation}`);
  const observed = (operation: string) =>
    calls.some(
      (entry) =>
        entry.operation === operation &&
        (entry.channel === "api"
          ? entry.result.ok === true
          : Boolean(entry.result.result) &&
            (entry.result.result as { isError?: boolean }).isError !== true),
    );
  for (const operation of spec.requires ?? [])
    if (
      !(surface === "cli" && operation === "rastrata_get_bookkeeping_guide") &&
      !observed(operation)
    )
      problems.push(`Missing observable call: ${operation}`);
  for (const alternatives of spec.requiresAny ?? [])
    if (!alternatives.some(observed))
      problems.push(`Missing observable call: one of ${alternatives.join(", ")}`);
  if (spec.draftCount !== undefined && after.drafts.length !== spec.draftCount)
    problems.push(`Expected ${spec.draftCount} unposted drafts, received ${after.drafts.length}`);
  if (spec.prepared) {
    const name = {
      journal: "journal.prepare",
      reversal: "journal.prepareReverse",
      period: "periods.prepare",
    }[spec.prepared];
    if (
      !api.some(
        (entry) =>
          entry.operation === name &&
          entry.result.ok === true &&
          (entry.result.data as PreparedOperation).valid,
      )
    )
      problems.push(`No valid ${spec.prepared} preview`);
  }
  for (const source of before.sources) {
    const current = after.sources.find((item) => item.source.id === source.source.id);
    if (
      !current ||
      !isDeepStrictEqual(current.source, source.source) ||
      current.contentHash !== source.contentHash
    )
      problems.push(`Retained source facts changed: ${source.source.id}`);
  }
  for (const [id, operation] of Object.entries(before.operations)) {
    if (
      ["rejected", "committed", "completed"].includes(operation.disposition) &&
      !isDeepStrictEqual(after.operations[id], operation)
    )
      problems.push(`Retained outcome changed: ${id}`);
  }
  for (const entry of writes.filter((entry) => entry.operation === "drafts.create")) {
    const data = entry.input.data as { source?: { id: string } } | undefined;
    if (!data?.source?.id) problems.push("Agent created an untagged economic event");
  }
  if (spec.reviewedCommit) {
    const proposals = trace
      .filter(
        (entry) =>
          entry.turn < turn &&
          entry.channel === "api" &&
          entry.result.ok === true &&
          ["journal.prepare", "journal.prepareReverse", "periods.prepare"].includes(
            entry.operation,
          ),
      )
      .map((entry) => entry.result.data as unknown as PreparedOperation);
    for (const entry of writes.filter((item) => item.operation === "operations.commit"))
      if (
        !proposals.some(
          (plan) =>
            plan.valid &&
            plan.planId === entry.input.planId &&
            plan.planHash === entry.input.planHash,
        )
      )
        problems.push("Commit did not use a previously reviewed exact plan/hash");
  }
  if (spec.recovery) {
    const original = before.drafts[0] ?? after.drafts[0];
    const recoveries = api.filter(
      (entry) => entry.operation === "drafts.recover" && entry.result.ok,
    );
    for (const entry of recoveries) {
      const draft = entry.result.data as {
        id: string;
        version: number;
        recoveredFromOperationId?: string;
      };
      if (
        draft.id !== entry.input.draftId ||
        draft.version !== Number(entry.input.expectedVersion) + 1 ||
        draft.recoveredFromOperationId !== entry.input.postingOperationId ||
        (original && draft.id !== original.id)
      )
        problems.push("Recovery did not retain the same draft and rejected-operation link");
    }
  }
  if (spec.interrupted) {
    const lost = trace.filter(
      (entry) => entry.actor === "agent" && entry.channel === "api" && !entry.delivered,
    );
    if (!lost.length) problems.push("Required interruption did not occur");
    for (const entry of writes) {
      if (entry.operation !== "operations.commit") {
        problems.push("Interrupted posting recovery minted another write");
        continue;
      }
      const initial = lost[0];
      if (initial && !isDeepStrictEqual(entry.input, initial.input))
        problems.push("Interrupted posting recovery changed the original input/identity");
      if (initial && turn === 1 && entry.sequence > initial.sequence)
        problems.push("Did not stop after the first interrupted reply as requested");
    }
  }
  if (spec.periodStatus && after.periods?.periods[0]?.status !== spec.periodStatus)
    problems.push(`January is not ${spec.periodStatus}`);
  if (spec.periodStatus === "closed") {
    const january = after.periods?.periods[0];
    if (
      !january?.closePackageId ||
      !january.reportPopulationHash ||
      january.closingRevision === null
    )
      problems.push("Close package or population was not retained");
  }
  if (spec.pinned) {
    const reports = api.filter((entry) => entry.operation === "reports.get" && entry.result.ok);
    for (const entry of api.filter(
      (item) => item.operation === "activity.get" || item.operation === "journal.get",
    )) {
      if (
        !reports.some(
          (report) =>
            report.sequence < entry.sequence &&
            entry.input.revision === (report.result.data as Record<string, unknown>).bookRevision &&
            entry.input.asOf === (report.result.data as Record<string, unknown>).asOf &&
            entry.input.populationHash ===
              (report.result.data as Record<string, unknown>).populationHash,
        )
      )
        problems.push("Drill-through did not retain a returned report population");
    }
  }
  // Narrative quality cannot be established by balances, keyword matching or a model's self-report.
  return {
    turn,
    mechanical: problems.length ? "fail" : "pass",
    problems,
    review: { question: spec.review, status: "pending" },
  };
}

export function applyReview(
  grade: TurnGrade,
  status: "pass" | "fail",
  evidence: string,
): TurnGrade {
  if (!evidence.trim()) throw new Error("A narrative review needs observed evidence");
  return { ...grade, review: { question: grade.review.question, status, evidence } };
}

export function qualification(grades: readonly TurnGrade[]): "fail" | "pending_review" | "pass" {
  if (
    !grades.length ||
    grades.some((grade) => grade.mechanical === "fail" || grade.review.status === "fail")
  )
    return "fail";
  return grades.some((grade) => grade.review.status === "pending") ? "pending_review" : "pass";
}
