// One line per slice. Lanes edit their own folder, not this registry.
import type { SliceSchema } from "./types.ts";
import { agentSchema } from "./agent/schema.ts";
import { bankfeedSchema } from "./bankfeed/schema.ts";
import { banksSchema } from "./banks/schema.ts";
import { calendarSchema } from "./calendar/schema.ts";
import { changesSchema } from "./changes/schema.ts";
import { chartSchema } from "./chart/schema.ts";
import { entriesSchema } from "./entries/schema.ts";
import { historySchema } from "./history/schema.ts";
import { ingestSchema } from "./ingest/schema.ts";
import { intakeSchema } from "./intake/schema.ts";
import { membersSchema } from "./members/schema.ts";
import { payeesSchema } from "./payees/schema.ts";
import { pluginsSchema } from "./plugins/schema.ts";
import { reconcileSchema } from "./reconcile/schema.ts";
import { reportsSchema } from "./reports/schema.ts";
import { rulesSchema } from "./rules/schema.ts";
import { safetySchema } from "./safety/schema.ts";
import { shadowSchema } from "./shadow/schema.ts";
import { statementsSchema } from "./statements/schema.ts";
import { stripeSchema } from "./stripe/schema.ts";
import { taxSchema } from "./tax/schema.ts";

export const sliceSchemas: readonly SliceSchema[] = [
  agentSchema,
  bankfeedSchema,
  banksSchema,
  calendarSchema,
  changesSchema,
  chartSchema,
  entriesSchema,
  historySchema,
  ingestSchema,
  intakeSchema,
  membersSchema,
  payeesSchema,
  pluginsSchema,
  reconcileSchema,
  reportsSchema,
  rulesSchema,
  safetySchema,
  shadowSchema,
  statementsSchema,
  stripeSchema,
  taxSchema,
];
