/** Having the files of the screens ahead of the click (docs/reference/program/performance.md, "The critical script"). The page's first script holds only the shell, Home and what they share; every other
 * screen is a file of its own (routes/screen.ts). So that this costs nobody a wait at a click:
 *  - a link that is pointed at, pressed or focused asks for the file of the screen it opens (`preloadAddress`, which app-link.tsx calls), which is the 100 ms or so a person takes to
 *    click anyway;
 *  - once the page is drawn, every screen is asked for, one at a time and only when the browser has nothing better to do (`preloadScreensWhenIdle`), the places first, so that nearly
 *    every click finds its screen already here. A connection that asks to save data, or a slow one, is left alone and gets the screens it points at. */
import { allDialogs, allRoutes } from "./routes/all";

/** The places a person goes first: their screens are the first asked for. */
const FIRST = ["/inbox", "/journal", "/accounts", "/reports"];

/** A route's path as a pattern of addresses. A path that names its pages (`/journal/new`) is tried before one with a parameter in its place (`/journal/$entryId`), whichever the registry lists first. */
const patterns = allRoutes
  .map((route) => ({
    route,
    pattern: new RegExp(`^${route.path.replace(/\$[^/]+/g, "[^/]+")}/?$`),
    parameters: (route.path.match(/\$/g) ?? []).length,
  }))
  .sort((a, b) => a.parameters - b.parameters);

/** Ask for the file of the screen that `address` opens, if it is not here yet. Never throws, and never waits. */
export function preloadAddress(address: string): void {
  let path: string;
  try {
    const target = new URL(address, window.location.origin);
    // An address on another site is not a screen of this one.
    if (target.origin !== window.location.origin) return;
    path = target.pathname;
  } catch {
    return;
  }
  const hit = patterns.find((entry) => entry.pattern.test(path));
  hit?.route.component.preload?.()?.catch(() => {});
}

/** What the browser says of the connection (not in every browser): asking to save data, or a slow link, means the screens are not fetched until they are wanted. */
export function savingData(): boolean {
  const connection = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } })
    .connection;
  return (
    connection?.saveData === true ||
    connection?.effectiveType === "slow-2g" ||
    connection?.effectiveType === "2g"
  );
}

/** What is asked for ahead, in the order it is asked: the places, then the rest as the registry lists them, then the dialogs. A screen two routes share is asked for once. */
export function queueOfScreens(): (() => Promise<void>)[] {
  const wanted = [
    ...allRoutes
      .map((route, order) => ({
        preload: route.component.preload,
        rank: FIRST.indexOf(route.path) === -1 ? FIRST.length : FIRST.indexOf(route.path),
        order,
      }))
      .sort((a, b) => a.rank - b.rank || a.order - b.order),
    ...allDialogs.map((dialog, order) => ({
      preload: dialog.component.preload,
      rank: FIRST.length + 1,
      order,
    })),
  ];
  const seen = new Set<() => Promise<void>>();
  const queue: (() => Promise<void>)[] = [];
  for (const { preload } of wanted) {
    if (preload === undefined || seen.has(preload)) continue;
    seen.add(preload);
    queue.push(preload);
  }
  return queue;
}

interface Scheduling {
  /** Runs `work` when the browser is idle, and no later than `within` milliseconds from now. */
  readonly idle: (work: () => void, within: number) => void;
  readonly saving: () => boolean;
  /** Resolves when the page's own load is over. */
  readonly loaded: () => Promise<void>;
}

/** The files of the screens come after the page's own load is over, so that they never hold it up: a page is loaded when its own files have come, and a person, a test and the browser's own
 * sign that a page is loading wait for that (found on 2026-11-22: a pause of 100 ms between screens in a browser with no idle callback kept WebKit's load event waiting for the whole line of them,
 * and a test that opens forty pages timed out). */
const afterLoad = (): Promise<void> =>
  document.readyState === "complete"
    ? Promise.resolve()
    : new Promise((resolve) => window.addEventListener("load", () => resolve(), { once: true }));

const browser: Scheduling = {
  idle: (work, within) => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(work, { timeout: within });
    // A browser with no idle callback (Safari) gets half a second between screens: a line of requests closer together than that is a page that is never "idle" to a test that waits for the network to be (found
    // on 2026-11-22: at 100 and 250 ms the pages that wait for it took four seconds each and a test that opens forty timed out).
    else setTimeout(work, Math.min(within, 500));
  },
  saving: savingData,
  loaded: afterLoad,
};

/** Ask for every screen, one at a time, when the browser is idle. Gives back a promise that is over when the last has come (for a test); the page does not wait for it. */
export async function preloadScreensWhenIdle(
  queue: readonly (() => Promise<void>)[] = queueOfScreens(),
  scheduling: Scheduling = browser,
): Promise<void> {
  if (scheduling.saving()) return;
  await scheduling.loaded();
  for (const preload of queue) {
    await new Promise<void>((resume) => scheduling.idle(resume, 3_000));
    // A file that cannot be had is asked for again when the screen is wanted, which is when it matters.
    await preload().catch(() => {});
  }
}
