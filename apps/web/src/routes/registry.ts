// One line per lane. Lanes edit their own folder under routes/, not this registry.
import { ui as agent } from "./agent/index.ts";
import { ui as bankfeed } from "./bankfeed/index.ts";
import { ui as banks } from "./banks/index.ts";
import { ui as billing } from "./billing/index.ts";
import { ui as calendar } from "./calendar/index.ts";
import { ui as changes } from "./changes/index.ts";
import { ui as chart } from "./chart/index.ts";
import { ui as entries } from "./entries/index.ts";
import { ui as help } from "./help/index.ts";
import { ui as ingest } from "./ingest/index.ts";
import { ui as payees } from "./payees/index.ts";
import { ui as reconcile } from "./reconcile/index.ts";
import { ui as reports } from "./reports/index.ts";
import { ui as rules } from "./rules/index.ts";
import { ui as safety } from "./safety/index.ts";
import { ui as settings } from "./settings/index.ts";
import { ui as shadow } from "./shadow/index.ts";
import { ui as statements } from "./statements/index.ts";
import { ui as stripe } from "./stripe/index.ts";
import { ui as tax } from "./tax/index.ts";
import type { LaneUi } from "./registry-types.ts";

// What a lane registers: its routes (each says which section and tab it belongs to), its Home cards, the
// things "+ New" starts, the dialogs those open and the sources Search asks. The shapes are written out in
// registry-types.ts.
export type {
  AppRoute,
  HomeCard,
  LaneUi,
  NavSection,
  NewAction,
  NewDialog,
  RouteNav,
  SearchHit,
  SearchSource,
} from "./registry-types.ts";

export const lanes: readonly LaneUi[] = [
  agent,
  bankfeed,
  banks,
  billing,
  calendar,
  changes,
  chart,
  entries,
  help,
  ingest,
  payees,
  reconcile,
  reports,
  rules,
  safety,
  settings,
  shadow,
  statements,
  stripe,
  tax,
];
