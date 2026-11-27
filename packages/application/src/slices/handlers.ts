// One line per slice. Lanes edit their own folder, not this registry.
import type { SliceHandler, SliceHandlers } from "./types.ts";
import { agentHandlers } from "./agent/handlers.ts";
import { bankfeedHandlers } from "./bankfeed/handlers.ts";
import { banksHandlers } from "./banks/handlers.ts";
import { calendarHandlers } from "./calendar/handlers.ts";
import { changesHandlers } from "./changes/handlers.ts";
import { chartHandlers } from "./chart/handlers.ts";
import { entriesHandlers } from "./entries/handlers.ts";
import { ingestHandlers } from "./ingest/handlers.ts";
import { historyHandlers } from "./history/handlers.ts";
import { intakeHandlers } from "./intake/handlers.ts";
import { membersHandlers } from "./members/handlers.ts";
import { payeesHandlers } from "./payees/handlers.ts";
import { pluginsHandlers } from "./plugins/handlers.ts";
import { reconcileHandlers } from "./reconcile/handlers.ts";
import { reportsHandlers } from "./reports/handlers.ts";
import { rulesHandlers } from "./rules/handlers.ts";
import { safetyHandlers } from "./safety/handlers.ts";
import { shadowHandlers } from "./shadow/handlers.ts";
import { statementsHandlers } from "./statements/handlers.ts";
import { stripeHandlers } from "./stripe/handlers.ts";
import { taxHandlers } from "./tax/handlers.ts";

const parts: readonly (readonly [string, SliceHandlers])[] = [
  ["agent", agentHandlers],
  ["bankfeed", bankfeedHandlers],
  ["banks", banksHandlers],
  ["calendar", calendarHandlers],
  ["changes", changesHandlers],
  ["chart", chartHandlers],
  ["entries", entriesHandlers],
  ["ingest", ingestHandlers],
  ["history", historyHandlers],
  ["intake", intakeHandlers],
  ["members", membersHandlers],
  ["payees", payeesHandlers],
  ["plugins", pluginsHandlers],
  ["reconcile", reconcileHandlers],
  ["reports", reportsHandlers],
  ["rules", rulesHandlers],
  ["safety", safetyHandlers],
  ["shadow", shadowHandlers],
  ["statements", statementsHandlers],
  ["stripe", stripeHandlers],
  ["tax", taxHandlers],
];

/** Every handler by operation name. An operation without a handler, or a handler without an
 * operation, is a bug; test/slices.test.ts fails on either. */
export const sliceHandlers: Readonly<Record<string, SliceHandler>> = (() => {
  const merged: Record<string, SliceHandler> = {};
  const owner = new Map<string, string>();
  for (const [slice, handlers] of parts)
    for (const [name, handler] of Object.entries(handlers)) {
      if (Object.hasOwn(merged, name))
        throw new Error(`Duplicate handler ${name}: declared by ${owner.get(name)} and ${slice}`);
      merged[name] = handler;
      owner.set(name, slice);
    }
  return merged;
})();
