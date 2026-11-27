import type {
  ChecklistInput,
  CutoverGetInput,
  CutoverSetInput,
  GapAddInput,
  GapListInput,
  GapUpdateInput,
  OpeningInput,
  TieoutInput,
  XeroAtInput,
  XeroChartImportInput,
  XeroChartInput,
  XeroMappingInput,
  XeroReconciledInput,
  XeroTbInput,
} from "../../client-contracts.gen.ts";
import type { SliceHandlers } from "../types.ts";
import { cutoverChecklist } from "./checklist.ts";
import { cutoverState, setCutover } from "./cutover.ts";
import { addGap, listGaps, recordTieOut, updateGap } from "./gaps.ts";
import { planOpening, reviewOpening } from "./opening.ts";
import { serialized } from "./queue.ts";
import { tieOutReport } from "./tieout.ts";
import {
  importChart,
  importTransactions,
  importTrialBalance,
  previewChart,
  previewTransactions,
  previewTrialBalance,
  setMapping,
  setReconciled,
  xeroStatus,
} from "./xero.ts";

export const shadowHandlers: SliceHandlers = {
  "opening.review": (input, context) => reviewOpening(context, input as unknown as OpeningInput),
  "opening.plan": (input, context) =>
    serialized(context.service, () =>
      planOpening(context, input as unknown as OpeningInput, context.operationId),
    ),
  "cutover.get": (input, context) => cutoverState(context, input as unknown as CutoverGetInput),
  "cutover.set": (input, context) =>
    serialized(context.service, () =>
      setCutover(context, input as unknown as CutoverSetInput, context.operationId),
    ),
  "cutover.checklist": (input, context) =>
    cutoverChecklist(context, input as unknown as ChecklistInput),

  // The Xero import: previews change nothing; every write goes through the same queue as the
  // cutover, so two imports never interleave their reads and their saves.
  "xero.chart.preview": (input, context) => previewChart(context, input as XeroChartInput),
  "xero.chart.import": (input, context) =>
    serialized(context.service, () =>
      importChart(context, input as unknown as XeroChartImportInput),
    ),
  "xero.mapping.set": (input, context) =>
    serialized(context.service, () => setMapping(context, input as XeroMappingInput)),
  "xero.trialBalance.preview": (input, context) =>
    previewTrialBalance(context, input as unknown as XeroTbInput),
  "xero.trialBalance.import": (input, context) =>
    serialized(context.service, () => importTrialBalance(context, input as unknown as XeroTbInput)),
  "xero.transactions.preview": (input, context) =>
    previewTransactions(context, input as unknown as XeroAtInput),
  "xero.transactions.import": (input, context) =>
    serialized(context.service, () => importTransactions(context, input as unknown as XeroAtInput)),
  "xero.reconciled.set": (input, context) =>
    serialized(context.service, async () => setReconciled(context, input as XeroReconciledInput)),
  "xero.status": (_input, context) => xeroStatus(context),

  // The tie-out and the gap log.
  "tieout.report": (input, context) => tieOutReport(context, input as TieoutInput),
  "tieout.record": (input, context) =>
    serialized(context.service, () => recordTieOut(context, input as TieoutInput)),
  "gaps.list": (input, context) => listGaps(context, input as GapListInput),
  "gaps.add": (input, context) =>
    serialized(context.service, async () => addGap(context, input as unknown as GapAddInput)),
  "gaps.update": (input, context) =>
    serialized(context.service, async () => updateGap(context, input as unknown as GapUpdateInput)),
};
