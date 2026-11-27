import { NAMED_SECTIONS, namedRoutes, sectionLabel, type NavRoute } from "../nav.ts";
import type { NewAction, SearchHit, SearchSource } from "../routes/registry-types.ts";

const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");

/** How well `query` fits a name and the other words people use for it. 0 is no match. Every word of the
 * query must start a word of the name or of its keywords (so "rec" finds Reconcile, "bank rules" finds
 * Rules, "profit" finds Reports); punctuation only separates words. A word that starts the name beats a
 * later word of the name, which beats a keyword. The empty query fits everything equally. */
export function matchScore(query: string, name: string, keywords: readonly string[] = []): number {
  const wanted = wordsOf(query);
  if (wanted.length === 0) return 1;
  const nameWords = wordsOf(name);
  const keywordWords = keywords.flatMap(wordsOf);
  let score = 0;
  for (const word of wanted) {
    if (nameWords.some((candidate) => candidate.startsWith(word))) {
      score += nameWords[0]?.startsWith(word) ? 4 : 3;
    } else if (keywordWords.some((candidate) => candidate.startsWith(word))) {
      score += 1;
    } else {
      return 0;
    }
  }
  return score;
}

/** The pages a person can open by name: every route that has one (the tabs, and the named pages under
 * them), in the order the header lists them, each with the section it is in. */
export function pageHits(routes: readonly NavRoute[], query: string): SearchHit[] {
  const order = new Map(NAMED_SECTIONS.map((section, index) => [section.id, index]));
  return NAMED_SECTIONS.flatMap((section) => namedRoutes(routes, section.id))
    .map((route, index) => ({
      route,
      index,
      score: matchScore(query, route.nav.label ?? "", route.nav.keywords),
    }))
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        (order.get(left.route.nav.section) ?? 0) - (order.get(right.route.nav.section) ?? 0) ||
        left.index - right.index,
    )
    .map(({ route }) => ({
      id: route.path,
      label: route.nav.label ?? route.path,
      detail: sectionLabel(route.nav.section),
      href: route.path,
      kind: "page" as const,
    }));
}

/** The things a person starts, by name: what "+ New" lists, and the actions that are buttons on their
 * own pages. */
export function actionHits(actions: readonly NewAction[], query: string): SearchHit[] {
  const seen = new Set<string>();
  return actions
    .filter((action) => {
      if (seen.has(action.id)) return false;
      seen.add(action.id);
      return true;
    })
    .map((action) => ({ action, score: matchScore(query, action.label, action.keywords) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.action.order - right.action.order)
    .map(({ action }) => ({
      id: action.id,
      label: action.label,
      kind: "action" as const,
      ...(action.href !== undefined ? { href: action.href } : {}),
      ...(action.dialog !== undefined ? { dialog: action.dialog } : {}),
    }));
}

/** The two sources that need no read: what "+ New" can start, and the pages of the app. They answer on
 * every keystroke. With nothing typed they are the whole list: Search is also a way to go anywhere. */
export function builtinSources(
  routes: readonly NavRoute[],
  actions: readonly NewAction[],
): readonly SearchSource[] {
  return [
    {
      id: "actions",
      label: "Actions",
      order: 10,
      instant: true,
      search: async (query) => actionHits(actions, query),
    },
    {
      id: "pages",
      label: "Pages",
      order: 20,
      instant: true,
      search: async (query) => pageHits(routes, query),
    },
  ];
}
