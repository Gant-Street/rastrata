// Every slice makes its own tables the first time it is used (sliceState and migrate). For a book in
// a file that is fine. For a host that keeps a log of every change to the book it is not: the first
// read of a slice becomes a change to the schema, and a read can no longer be only a read. A host
// calls this once, when it opens the book, so that the schema changes at one known moment.
import type { ApplicationService } from "../service.ts";
import { safetyStore } from "../safety/store.ts";
import { agentState } from "./agent/store.ts";
import { bankfeedStore } from "./bankfeed/store.ts";
import { banksStore } from "./banks/store.ts";
import { changesState } from "./changes/store.ts";
import { chartState } from "./chart/handlers.ts";
import { readBookSettings } from "./entries/settings.ts";
import { ingestRuntime } from "./ingest/store.ts";
import { intakeState } from "./intake/store.ts";
import { memberState } from "./members/store.ts";
import { payeesRuntime } from "./payees/store.ts";
import { pluginState } from "./plugins/store.ts";
import { reconcileState } from "./reconcile/state.ts";
import { rulesState } from "./rules/store.ts";
import { shadowStore } from "./shadow/store.ts";
import { statementsState } from "./statements/store.ts";
import { stripeStore } from "./stripe/store.ts";
import { taxRuntime } from "./tax/store.ts";

/** Make the tables of every slice that keeps any. Idempotent: a slice already at its latest step
 * does nothing. A slice added later must be added here (test/slices.test.ts checks that no
 * operation creates a table afterwards). */
export function prepareSlices(service: ApplicationService): void {
  chartState(service);
  reconcileState(service);
  readBookSettings(service);
  bankfeedStore(service);
  banksStore(service);
  ingestRuntime(service);
  shadowStore(service);
  taxRuntime(service);
  payeesRuntime(service);
  pluginState(service);
  agentState(service);
  memberState(service);
  statementsState(service);
  intakeState(service);
  rulesState(service);
  stripeStore(service);
  safetyStore(service);
  changesState(service);
}
