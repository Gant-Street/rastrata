import type { LaneUi } from "../registry.ts";
import { screen } from "../screen.ts";

const PluginsPage = screen(() => import("./page.tsx"), "PluginsPage");

export const ui: LaneUi = {
  routes: [
    {
      path: "/settings/plugins",
      component: PluginsPage,
      nav: {
        section: "settings",
        label: "Plugins",
        order: 50,
        keywords: ["plugins", "connectors", "integrations", "mercury", "stripe", "shopify", "sync"],
      },
    },
  ],
  homeCards: [],
};
