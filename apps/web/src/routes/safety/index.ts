import { whenTheServiceCan } from "../../service-needs.tsx";
import type { LaneUi } from "../registry.ts";
import { screen } from "../screen.ts";

const BackupsPage = screen(() => import("./page.tsx"), "BackupsPage");

export const ui: LaneUi = {
  routes: [
    {
      path: "/settings/backups",
      component: whenTheServiceCan("backups", BackupsPage),
      nav: {
        section: "settings",
        label: "Backups and export",
        order: 56,
        needs: "backups",
        keywords: ["backup", "restore", "export", "download", "verify"],
      },
    },
  ],
  homeCards: [],
};
