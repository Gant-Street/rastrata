import { readAccountTags } from "../../account-tags.ts";
import type {
  LargestKind,
  ReportBasis,
  ReportComparisonKind,
  ReportShare,
  ReportStatement,
} from "../../client-contracts.gen.ts";
import { compileGeneralLedger } from "../../reports/activity.ts";
import { compileCashFlow } from "../../reports/cash-flow.ts";
import type { ReportOptions } from "../../reports/core.ts";
import { exportStatement } from "../../reports/export.ts";
import { compileLargest, LARGEST_DEFAULT_LIMIT } from "../../reports/largest.ts";
import { reportCalendar } from "../../reports/window.ts";
import type { SliceContext, SliceHandlers } from "../types.ts";

const text = (input: Record<string, unknown>, key: string): string => String(input[key]);
const revisionOf = (input: Record<string, unknown>): bigint | undefined =>
  input.revision !== undefined ? BigInt(text(input, "revision")) : undefined;

/** The optional parts of a report request. Inputs have been validated against the schema by the
 * time a handler runs, so these are plain reads. */
function reportOptions(input: Record<string, unknown>): ReportOptions {
  return {
    ...(input.from !== undefined ? { from: text(input, "from") } : {}),
    ...(input.basis !== undefined ? { basis: text(input, "basis") as ReportBasis } : {}),
    ...(input.compare !== undefined
      ? { compare: text(input, "compare") as ReportComparisonKind }
      : {}),
    ...(input.share !== undefined ? { share: text(input, "share") as ReportShare } : {}),
  };
}

/** The account tags, read once from product state and passed to the pure compilers. A recorded tag
 * revision pins them, so a report at a pinned book revision reproduces after tags change. */
const tagsFor = (service: SliceContext["service"], input: Record<string, unknown>) =>
  readAccountTags(
    service.store,
    input.tagsRevision !== undefined ? { throughRevision: Number(input.tagsRevision) } : {},
  );

export const reportsHandlers: SliceHandlers = {
  "reports.get": (input, { service }) =>
    service.reports(text(input, "asOf"), revisionOf(input), reportOptions(input)),
  "reports.cashFlow": async (input, { service }) => {
    const { aggregate } = await service.readAggregate(revisionOf(input));
    return compileCashFlow(aggregate.state, text(input, "asOf"), {
      ...reportOptions(input),
      tags: tagsFor(service, input),
    });
  },
  "reports.export": async (input, { service }) => {
    const { aggregate } = await service.readAggregate(revisionOf(input));
    const options = reportOptions(input);
    return exportStatement(aggregate.state, {
      statement: text(input, "statement") as ReportStatement,
      asOf: text(input, "asOf"),
      ...(options.from !== undefined ? { from: options.from } : {}),
      ...(options.basis !== undefined ? { basis: options.basis } : {}),
      ...(options.compare !== undefined ? { compare: options.compare } : {}),
      ...(options.share !== undefined ? { share: options.share } : {}),
      ...(input.accountId !== undefined ? { accountId: text(input, "accountId") } : {}),
      bookName: service.setupState()?.name ?? "",
      tags: tagsFor(service, input),
    });
  },
  "reports.generalLedger": async (input, { service }) => {
    const { aggregate } = await service.readAggregate(revisionOf(input));
    const options = reportOptions(input);
    return compileGeneralLedger(aggregate.state, {
      asOf: text(input, "asOf"),
      page: input.page === undefined ? 1 : Number(input.page),
      ...(options.from !== undefined ? { from: options.from } : {}),
      ...(options.basis !== undefined ? { basis: options.basis } : {}),
    });
  },
  "reports.largest": async (input, { service }) => {
    const { aggregate } = await service.readAggregate(revisionOf(input));
    return compileLargest(aggregate.state, {
      asOf: text(input, "asOf"),
      ...(input.from !== undefined ? { from: text(input, "from") } : {}),
      kind: input.kind === undefined ? "expense" : (text(input, "kind") as LargestKind),
      limit: input.limit === undefined ? LARGEST_DEFAULT_LIMIT : Number(input.limit),
    });
  },
  "reports.calendar": async (_input, { service }) =>
    reportCalendar((await service.readAggregate()).aggregate.state),
  "activity.get": (input, { service }) =>
    service.accountActivity({
      accountId: text(input, "accountId"),
      asOf: text(input, "asOf"),
      // Omitted: read the current state. The population hash then fails with report_population_changed
      // if the book has moved since the report, which is the cheap and honest answer; a pinned
      // revision replays history and is for callers that must reproduce an old report exactly.
      ...(input.revision !== undefined ? { revision: BigInt(text(input, "revision")) } : {}),
      ...(input.populationHash !== undefined
        ? { populationHash: text(input, "populationHash") }
        : {}),
      from: text(input, "from"),
      to: text(input, "to"),
      page: input.page === undefined ? 1 : Number(input.page),
      ...(input.reportFrom !== undefined ? { reportFrom: text(input, "reportFrom") } : {}),
    }),
};
