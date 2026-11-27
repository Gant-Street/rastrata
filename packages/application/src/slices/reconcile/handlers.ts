import type {
  ReconcileClearedInput,
  ReconcileIdInput,
  ReconcileListInput,
  ReconcileReportInput,
  ReconcileSetClearedInput,
  ReconcileSetStatementInput,
  ReconcileStartInput,
  ReconcileStatusInput,
  ReconcileVersionInput,
  ReconcileVoidInput,
} from "../../client-contracts.gen.ts";
import type { SliceHandlers } from "../types.ts";
import {
  clearedPostings,
  completeReconciliation,
  discardReconciliation,
  getReconciliation,
  listReconciliations,
  reconcileStatus,
  setCleared,
  setStatement,
  startReconciliation,
  voidReconciliation,
} from "./reconciliations.ts";
import { reconciliationReport } from "./report.ts";

/** Inputs arrive validated against the operation's schema and permission-checked; the book is
 * configured. Everything else (calendar dates, versions, ordering) is checked in the operations. */
export const reconcileHandlers: SliceHandlers = {
  "reconcile.start": (input, { service, operationId }) =>
    startReconciliation(service, operationId, input as unknown as ReconcileStartInput),
  "reconcile.get": (input, { service }) =>
    getReconciliation(service, input as unknown as ReconcileIdInput),
  "reconcile.setCleared": (input, { service, operationId }) =>
    setCleared(service, operationId, input as unknown as ReconcileSetClearedInput),
  "reconcile.setStatement": (input, { service, operationId }) =>
    setStatement(service, operationId, input as unknown as ReconcileSetStatementInput),
  "reconcile.discard": (input, { service, operationId }) =>
    discardReconciliation(service, operationId, input as unknown as ReconcileVersionInput),
  "reconcile.complete": (input, { service, operationId }) =>
    completeReconciliation(service, operationId, input as unknown as ReconcileVersionInput),
  "reconcile.void": (input, { service, operationId }) =>
    voidReconciliation(service, operationId, input as unknown as ReconcileVoidInput),
  "reconcile.list": (input, { service }) =>
    listReconciliations(service, input as unknown as ReconcileListInput),
  "reconcile.status": (input, { service }) =>
    reconcileStatus(service, input as unknown as ReconcileStatusInput),
  "reconcile.cleared": (input, { service }) =>
    clearedPostings(service, (input as unknown as ReconcileClearedInput).journalIds),
  "reconcile.report": (input, { service }) =>
    reconciliationReport(service, input as unknown as ReconcileReportInput),
};
