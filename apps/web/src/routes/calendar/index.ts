import type { LaneUi } from "../registry.ts";

// The Close the books screen itself (/periods) is a core destination in Accounting; the lane owns its
// page, `routes/periods.tsx`, and registers its Home card here.
export const ui: LaneUi = {
  routes: [],
  homeCards: [],
};
