/** Real-user measurement: how the pages felt, and how long a key action took from the click to the
 * screen showing it. OFF unless the service says it wants it: the document is served with a
 * `Server-Timing: rum;desc="<share>"` header when the hosted service has telemetry and RASTRATA_RUM
 * on, and without it (the local product, a self-hosted service, every test) this file is never even
 * loaded: main.tsx reads the header first and imports this module only when it is there.
 *
 * What is sent is one small message when the page is hidden or closed, to the service's own address,
 * with the service's own credentials (the same fetch the app uses): the web vitals the browser
 * measured and the timings of the actions taken. No page address, no identifier, no user agent, no
 * text; the service adds the size of the book, which only it knows, and drops anything outside the
 * fixed shape (see @rastrata/telemetry/web). A share of page views, set by the service, report at
 * all. */
import {
  BEACON_MAX_ACTIONS,
  BEACON_MAX_CLS,
  BEACON_MAX_MS,
  BEACON_PATH,
  type Beacon,
  type BeaconAction,
  type BeaconActionTiming,
  type BeaconOutcome,
} from "@rastrata/telemetry/web";
import { installActionTimer } from "./rum-hook.ts";

export type RumFetch = (input: string, init: RequestInit) => Promise<Response>;

/** The part of the web-vitals library this file uses: each function calls back with the metric's
 * value (milliseconds, or a score for layout shift) once it is final. */
export interface VitalsLibrary {
  onLCP(report: (metric: { value: number }) => void): void;
  onINP(report: (metric: { value: number }) => void): void;
  onTTFB(report: (metric: { value: number }) => void): void;
  onCLS(report: (metric: { value: number }) => void): void;
}

/** The share of page views that report, from the document's Server-Timing header; undefined when the
 * service did not ask for any. */
export function rumSample(): number | undefined {
  try {
    const navigation = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    const entry = navigation?.serverTiming?.find((item) => item.name === "rum");
    const sample = Number(entry?.description);
    return Number.isFinite(sample) && sample > 0 && sample <= 1 ? sample : undefined;
  } catch {
    return undefined;
  }
}

const KEY_ACTIONS: Readonly<Record<string, BeaconAction>> = {
  "inbox.accept": "accept",
  "inbox.post": "post",
  "journal.post": "post",
  "operations.commit": "post",
  "drafts.save": "save",
  "drafts.create": "save",
};

let active = false;
let sendBeacon: RumFetch = (input, init) => fetch(input, init);
let lastInteraction = Number.NEGATIVE_INFINITY;
/** How many times this page view has been hidden. A hidden page paints no frames and the browser holds
 * back `requestAnimationFrame`, so an action that was under way when the page was hidden would be
 * timed in seconds that nobody waited: it is dropped, not recorded. (Found by running the page in a
 * browser window that was in the background: every action took a second and a half.) */
let hiddenCount = 0;
const pageHidden = (): boolean =>
  typeof document !== "undefined" && document.visibilityState === "hidden";
let vitals: { lcp?: number; inp?: number; ttfb?: number; cls?: number } = {};
let actions: BeaconActionTiming[] = [];

const rounded = (value: number) => Math.round(value * 1000) / 1000;

/** The message to send now, or undefined when there is nothing to say. Empties what it takes. Every
 * number is brought into the range the service accepts, so that one odd value cannot make it refuse
 * the rest. */
export function takeBeacon(): Beacon | undefined {
  const measured: { lcp?: number; inp?: number; ttfb?: number; cls?: number } = {};
  for (const name of ["lcp", "inp", "ttfb", "cls"] as const) {
    const value = vitals[name];
    if (value === undefined || !Number.isFinite(value) || value < 0) continue;
    measured[name] = rounded(Math.min(name === "cls" ? BEACON_MAX_CLS : BEACON_MAX_MS, value));
  }
  const timings = actions.slice(0, BEACON_MAX_ACTIONS);
  vitals = {};
  actions = actions.slice(BEACON_MAX_ACTIONS);
  if (Object.keys(measured).length === 0 && timings.length === 0) return undefined;
  return {
    v: 1,
    ...(Object.keys(measured).length ? { vitals: measured } : {}),
    ...(timings.length ? { actions: timings } : {}),
  };
}

/** Send what has been measured. Never throws, never waits, survives the page closing (keepalive). */
export function flush(): void {
  const beacon = takeBeacon();
  if (!beacon) return;
  try {
    void sendBeacon(BEACON_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(beacon),
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => undefined);
  } catch {
    // A report that cannot be sent is not worth anything else happening.
  }
}

function record(timing: BeaconActionTiming): void {
  actions.push({ ...timing, ms: rounded(Math.min(BEACON_MAX_MS, Math.max(0, timing.ms))) });
  if (actions.length >= BEACON_MAX_ACTIONS) flush();
}

/** Begin timing a write, if it is a key action and this page view reports. The function it returns
 * says how it ended; the time recorded runs from the click that caused it (or from now, if nothing
 * was clicked in the last second) to the frame after the screen had the result. A page that is
 * hidden, or is hidden while it waits, is not timed: nobody was waiting on it. */
export function timeAction(operation: string): ((outcome: BeaconOutcome) => void) | undefined {
  if (!active) return undefined;
  const action = KEY_ACTIONS[operation];
  if (!action || pageHidden()) return undefined;
  const now = performance.now();
  const started = now - lastInteraction < 1000 ? lastInteraction : now;
  const hiddenAtStart = hiddenCount;
  return (outcome) => {
    requestAnimationFrame(() => {
      setTimeout(() => {
        if (pageHidden() || hiddenCount !== hiddenAtStart) return;
        record({ a: action, ms: performance.now() - started, o: outcome });
      }, 0);
    });
  };
}

/** Start measuring this page view, if the service asked for it and this view is among the share. */
export async function startRum(
  options: {
    fetcher?: RumFetch;
    random?: () => number;
    /** Replaces the dynamic import of the library, for tests. */
    loadVitals?: () => Promise<VitalsLibrary>;
  } = {},
): Promise<boolean> {
  const sample = rumSample();
  if (active || sample === undefined || (options.random ?? Math.random)() >= sample) return false;
  active = true;
  installActionTimer(timeAction);
  if (options.fetcher) sendBeacon = options.fetcher;
  for (const type of ["pointerdown", "keydown"])
    addEventListener(
      type,
      (event) => {
        lastInteraction = event.timeStamp;
      },
      { capture: true, passive: true },
    );
  addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenCount += 1;
      flush();
    }
  });
  addEventListener("pagehide", flush);
  // The library is loaded only now, and only for the share of views that report.
  const { onCLS, onINP, onLCP, onTTFB } = await (
    options.loadVitals ?? (() => import("web-vitals"))
  )();
  onLCP((metric) => {
    vitals.lcp = metric.value;
  });
  onINP((metric) => {
    vitals.inp = metric.value;
  });
  onTTFB((metric) => {
    vitals.ttfb = metric.value;
  });
  onCLS((metric) => {
    vitals.cls = metric.value;
  });
  return true;
}

/** For tests: forget everything. */
export function resetRum(): void {
  active = false;
  installActionTimer(undefined);
  vitals = {};
  actions = [];
  lastInteraction = Number.NEGATIVE_INFINITY;
  hiddenCount = 0;
  sendBeacon = (input, init) => fetch(input, init);
}
