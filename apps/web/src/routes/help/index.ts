import { matchScore } from "../../search/builtin.ts";
import type { LaneUi } from "../registry.ts";
import { screen } from "../screen.ts";
import { helpAudience } from "./audience.ts";
import { helpTopics, topicFor } from "./topics.ts";

const HelpPage = screen(() => import("./page.tsx"), "HelpPage");
const HelpTopicPage = screen(() => import("./page.tsx"), "HelpTopicPage");

/** Help: the list of topics and one page for each. It is not one of the four places and not a setting; its
 * link is in the footer of every page, where it opens the topic for that page. Search finds "Help" and
 * every topic by its name, and the browser tab says the topic that is open. */
export const ui: LaneUi = {
  routes: [
    {
      path: "/help",
      component: HelpPage,
      nav: {
        section: "help",
        label: "Help",
        order: 10,
        keywords: ["how to", "guide", "guides", "documentation", "instructions"],
      },
    },
    {
      path: "/help/$topic",
      component: HelpTopicPage,
      nav: {
        section: "help",
        parent: "/help",
        title: (address) =>
          topicFor(decodeURIComponent(address.split("/")[2] ?? ""), helpAudience())?.title,
      },
    },
  ],
  homeCards: [],
  searchSources: [
    {
      id: "help",
      label: "Help",
      order: 90,
      instant: true,
      // Found by its words: an empty question lists the pages and the actions, not every topic.
      search: async (query) =>
        query.trim().length < 3
          ? []
          : helpTopics
              .filter((topic) => topic.only === undefined || topic.only === helpAudience())
              .map((topic) => ({ topic, score: matchScore(query, topic.title) }))
              .filter((entry) => entry.score > 0)
              .sort((left, right) => right.score - left.score)
              .slice(0, 4)
              .map(({ topic }) => ({
                id: `help:${topic.id}`,
                label: topic.title,
                href: `/help/${topic.id}`,
                kind: "page" as const,
              })),
    },
  ],
};
