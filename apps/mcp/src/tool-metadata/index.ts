// One line per slice. Lanes edit their own file, not this registry.
import { isHidden, type OperationMetadata } from "./types.ts";
import { agentTools } from "./agent.ts";
import { bankfeedTools } from "./bankfeed.ts";
import { banksTools } from "./banks.ts";
import { calendarTools } from "./calendar.ts";
import { changesTools } from "./changes.ts";
import { chartTools } from "./chart.ts";
import { entriesTools } from "./entries.ts";
import { historyTools } from "./history.ts";
import { ingestTools } from "./ingest.ts";
import { intakeTools } from "./intake.ts";
import { membersTools } from "./members.ts";
import { payeesTools } from "./payees.ts";
import { reconcileTools } from "./reconcile.ts";
import { reportsTools } from "./reports.ts";
import { rulesTools } from "./rules.ts";
import { safetyTools } from "./safety.ts";
import { shadowTools } from "./shadow.ts";
import { statementsTools } from "./statements.ts";
import { stripeTools } from "./stripe.ts";
import { taxTools } from "./tax.ts";

const parts: readonly (readonly [string, Readonly<Record<string, OperationMetadata>>])[] = [
  ["agent", agentTools],
  ["bankfeed", bankfeedTools],
  ["banks", banksTools],
  ["calendar", calendarTools],
  ["changes", changesTools],
  ["chart", chartTools],
  ["entries", entriesTools],
  ["history", historyTools],
  ["ingest", ingestTools],
  ["intake", intakeTools],
  ["members", membersTools],
  ["payees", payeesTools],
  ["reconcile", reconcileTools],
  ["reports", reportsTools],
  ["rules", rulesTools],
  ["safety", safetyTools],
  ["shadow", shadowTools],
  ["statements", statementsTools],
  ["stripe", stripeTools],
  ["tax", taxTools],
];

export const sliceToolMetadata: Readonly<Record<string, OperationMetadata>> = (() => {
  const merged: Record<string, OperationMetadata> = {};
  const names = new Map<string, string>();
  for (const [slice, tools] of parts)
    for (const [operation, tool] of Object.entries(tools)) {
      if (Object.hasOwn(merged, operation))
        throw new Error(`Duplicate MCP metadata for ${operation} (${slice})`);
      if (!isHidden(tool)) {
        if (names.has(tool.name))
          throw new Error(
            `Duplicate MCP tool name ${tool.name}: ${names.get(tool.name)} and ${slice}`,
          );
        names.set(tool.name, slice);
      }
      merged[operation] = tool;
    }
  return merged;
})();
