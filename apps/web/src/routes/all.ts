import type { NavRoute } from "../nav.ts";
import { builtinSources } from "../search/builtin.ts";
import { ui as core } from "./core.ts";
import {
  type AppRoute,
  lanes,
  type LaneUi,
  type NewAction,
  type NewDialog,
  type SearchSource,
} from "./registry.ts";

/** Everything that is registered: the application's own screens, then each lane's. The router, the
 * navigation, "+ New" and Search all read this one list. */
export const registered: readonly LaneUi[] = [core, ...lanes];

export const allRoutes: readonly AppRoute[] = registered.flatMap((lane) => lane.routes);
export const allNewActions: readonly NewAction[] = registered.flatMap(
  (lane) => lane.newActions ?? [],
);
export const allDialogs: readonly NewDialog[] = registered.flatMap((lane) => lane.dialogs ?? []);

/** The routes as the navigation reads them (where each sits, without its component). */
export const navRoutes: readonly NavRoute[] = allRoutes.map((route) => ({
  path: route.path,
  nav: route.nav,
}));

/** What Search asks for these routes (the ones the service can back, see `availableRoutes`): the pages and actions that are built in, and each lane's sources. */
export const searchSourcesFor = (routes: readonly NavRoute[]): readonly SearchSource[] => [
  ...builtinSources(routes, allNewActions),
  ...registered.flatMap((lane) => lane.searchSources ?? []),
];

/** Search with every route there is (the tests, and a service that can back them all). */
export const allSearchSources: readonly SearchSource[] = searchSourcesFor(navRoutes);
