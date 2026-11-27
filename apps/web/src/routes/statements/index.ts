import type { LaneUi } from "../registry.ts";
import { screen } from "../screen.ts";

const ImportPage = screen(() => import("./import-page.tsx"), "ImportPage");

// Importing a statement is an action on For review (and Search finds it by name), not a tab: it sits
// under For review, which is where what it imports is worked.
export const ui: LaneUi = {
  routes: [
    { path: "/import", component: ImportPage, nav: { section: "transactions", parent: "/inbox" } },
  ],
  homeCards: [],
  newActions: [
    {
      id: "import-statement",
      label: "Import statement",
      order: 60,
      searchOnly: true,
      href: "/import",
      keywords: ["csv", "ofx", "qfx", "bank file", "upload", "bank transactions"],
    },
  ],
};
