import {
  BOOK_COMMAND_PROTOCOL_VERSION,
  closePackageId,
  commandId,
  hashCanonical,
  instant,
  localDate,
  sealCommand,
  type ActorId,
  type BookCommand,
  type BookState,
  type FiscalPeriodId,
  type Instant,
} from "@rastrata/kernel";
import { compileCoreReports } from "../reports.ts";
import type { ExtensionPlan } from "./extend.ts";
import type { YearStartPlan } from "./year-start.ts";

/** Builders for the sealed kernel commands the calendar lane issues. Each is a pure function of the
 * book state it is given, so a chained plan can build the next command against the state the
 * previous one leaves (see slices/calendar/year-end.ts). */
export interface CommandContext {
  /** The durable action identity: the command id, and the prefix of the close package id. */
  readonly actionId: string;
  readonly actor: ActorId;
  /** The instant stamped on the command; the system clock in practice. */
  readonly now?: Instant;
}

const stamp = (context: CommandContext): Instant =>
  context.now ?? instant(new Date().toISOString());

function periodCore(
  state: BookState,
  context: CommandContext,
  periodId: FiscalPeriodId,
  reason: string,
) {
  const now = stamp(context);
  return {
    id: commandId(context.actionId),
    protocolVersion: BOOK_COMMAND_PROTOCOL_VERSION,
    bookId: state.identity.bookId,
    expectedBookRevision: state.bookRevision,
    actorId: context.actor,
    issuedAt: now,
    completedAt: now,
    committedAt: now,
    periodId,
    reason: reason.trim(),
  } as const;
}

/** Close one period. The close records the hash of the report population as of the period's last
 * day (the trial balance, profit and loss and balance sheet), compiled from `state`. The last close
 * of a fiscal year therefore records the year-end population. No closing journal is posted: the
 * kernel locks the period, and earnings roll forward by computation in the reports. */
export function closePeriodCommand(
  state: BookState,
  context: CommandContext,
  periodId: string,
  reason: string,
): BookCommand {
  const period = state.periods.find((item) => item.id === periodId);
  if (!period) throw new TypeError("Period not found");
  const report = compileCoreReports(state, period.endsOn);
  return sealCommand({
    ...periodCore(state, context, period.id, reason),
    type: "closePeriod",
    closePackageId: closePackageId(`${context.actionId}-package`),
    reportPopulationHash: {
      algorithm: "sha256",
      canonicalizationVersion: "rastrata-canonical-v1",
      digest: report.populationHash,
    },
    reportingPolicySnapshotHash: hashCanonical({
      type: "LocalCoreReportingPolicy",
      compilerVersion: report.compilerVersion,
      basis: report.basis,
      accountingPolicySnapshotHash: state.accountingPolicySnapshot.contentHash.digest,
    }),
  });
}

/** Reopen one closed period. The kernel supersedes the close of every period that ends on or after
 * it, so those periods open again too. */
export function reopenPeriodCommand(
  state: BookState,
  context: CommandContext,
  periodId: string,
  reason: string,
): BookCommand {
  const period = state.periods.find((item) => item.id === periodId);
  if (!period) throw new TypeError("Period not found");
  return sealCommand({ ...periodCore(state, context, period.id, reason), type: "reopenPeriod" });
}

/** Draw the whole calendar again under a new fiscal-year month. Only a book with no entry and no close
 * can have it (`planYearStart` refuses otherwise): the configuration it replaces has the same chart and
 * policies, and the periods are all new. */
export function changeYearStartCommand(
  state: BookState,
  context: CommandContext,
  plan: YearStartPlan,
): BookCommand {
  const now = stamp(context);
  return sealCommand({
    id: commandId(context.actionId),
    type: "replaceConfiguration",
    protocolVersion: BOOK_COMMAND_PROTOCOL_VERSION,
    bookId: state.identity.bookId,
    expectedBookRevision: state.bookRevision,
    expectedConfigurationRevision: state.configurationRevision,
    actorId: context.actor,
    issuedAt: now,
    completedAt: now,
    committedAt: now,
    effectiveOn: localDate(plan.effectiveOn),
    periods: [...plan.periods],
    admissionSnapshot: state.admissionSnapshot,
    policies: state.policies,
    quantizationPolicies: state.quantizationPolicies,
    accountingPolicies: state.accountingPolicySnapshot.policies,
  });
}

/** Add fiscal years to the calendar. It replaces the book's configuration with the same chart and
 * policies and every existing period unchanged, followed by the new periods, effective on the first
 * day of the first new period (the kernel requires a change to fall after every journal). */
export function extendCalendarCommand(
  state: BookState,
  context: CommandContext,
  plan: ExtensionPlan,
): BookCommand {
  const now = stamp(context);
  return sealCommand({
    id: commandId(context.actionId),
    type: "replaceConfiguration",
    protocolVersion: BOOK_COMMAND_PROTOCOL_VERSION,
    bookId: state.identity.bookId,
    expectedBookRevision: state.bookRevision,
    expectedConfigurationRevision: state.configurationRevision,
    actorId: context.actor,
    issuedAt: now,
    completedAt: now,
    committedAt: now,
    effectiveOn: localDate(plan.effectiveOn),
    periods: [...state.periods, ...plan.added],
    admissionSnapshot: state.admissionSnapshot,
    policies: state.policies,
    quantizationPolicies: state.quantizationPolicies,
    accountingPolicies: state.accountingPolicySnapshot.policies,
  });
}
