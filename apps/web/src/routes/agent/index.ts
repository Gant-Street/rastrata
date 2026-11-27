import { whenTheServiceCan } from "../../service-needs.tsx";
import type { LaneUi } from "../registry.ts";
import { screen } from "../screen.ts";

const AgentsPage = screen(() => import("./keys-page.tsx"), "AgentsPage");

export const ui: LaneUi = {
  routes: [
    {
      path: "/settings/agent",
      component: whenTheServiceCan("agents", AgentsPage),
      nav: {
        section: "settings",
        label: "Agents",
        order: 30,
        needs: "agents",
        keywords: ["agent access", "tokens", "api", "claude", "codex", "connect"],
      },
    },
  ],
  homeCards: [],
};
