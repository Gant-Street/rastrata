import type { LaneUi } from "../registry.ts";
import { screen } from "../screen.ts";

const EditRulePage = screen(() => import("./editor.tsx"), "EditRulePage");
const NewRulePage = screen(() => import("./editor.tsx"), "NewRulePage");
const RulesPage = screen(() => import("./page.tsx"), "RulesPage");

// `/rules/new` takes `?item=<Inbox item id>` to start a rule from a line in the Inbox. The Inbox
// links to it; nothing here posts anything.
export const ui: LaneUi = {
  routes: [
    {
      path: "/rules",
      component: RulesPage,
      nav: {
        section: "transactions",
        label: "Rules",
        parent: "/inbox",
        keywords: ["bank rules", "automation", "classifier", "always"],
      },
    },
    {
      path: "/rules/new",
      component: NewRulePage,
      nav: { section: "transactions", parent: "/rules" },
    },
    {
      path: "/rules/$ruleId",
      component: EditRulePage,
      nav: { section: "transactions", parent: "/rules" },
    },
  ],
  homeCards: [],
  newActions: [
    {
      id: "bank-rule",
      label: "Bank rule",
      order: 80,
      // The Rules page has the button; Search finds it by name.
      searchOnly: true,
      href: "/rules/new",
      keywords: ["automation", "always categorize"],
    },
  ],
};
