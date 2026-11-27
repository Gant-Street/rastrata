/** How the page's load went, sent once to the control plane (control-worker src/rum.ts, docs/reference/telemetry.md, "Load timings"): the milliseconds, from the moment the browser began the
 * load, to the first draw, the first paint, the largest paint, the first byte, the token and the book's first read, and how many reads were made before the first draw and how many of
 * them were answered from what the page held. Numbers and the name of the build; nothing that says whose page it was or what was on it. It is how the plan "Under 100 ms" is measured
 * where only a person's own browser can measure it.
 *
 * It is sent once for a load, when the page is left or hidden, or a few seconds after its first draw, whichever comes first, and only by a page that has a person signed in and was drawn. */
import { BUILD, deviceGiven, heldGiven } from "./held.ts";

export const REPORT_PATH = "/auth/rum";
/** How long after the first draw a page that is still open reports, so that its largest paint is nearly final. */
export const REPORT_AFTER_MS = 8_000;
const MAX_MS = 120_000;

export interface LoadMessage {
  readonly v: 1;
  readonly build: string;
  readonly kind: string;
  readonly draw: number;
  readonly fcp?: number;
  readonly lcp?: number;
  readonly ttfb?: number;
  readonly tokenAt?: number;
  readonly bookAt?: number;
  readonly reads?: number;
  readonly held?: number;
  readonly copy?: 0 | 1;
}

type Measured = Pick<Performance, "getEntriesByName" | "getEntriesByType">;

const whole = (ms: number | undefined): number | undefined =>
  ms === undefined || !Number.isFinite(ms) || ms < 0 ? undefined : Math.min(MAX_MS, Math.round(ms));

/** What the page's drawing noted at the moment it was drawn: how many answers it had been given from what it held, and how many of those came from the device. */
export interface Drawn {
  readonly held: number;
  readonly copy: number;
}

/** The message for this load, from what the browser has measured; `null` when the page was not drawn (nothing was measured). */
export function loadMessage(
  measured: Measured,
  context: { readonly largest?: number },
  build: string = BUILD,
): LoadMessage | null {
  const mark = measured.getEntriesByName("rastrata:drawn")[0] as
    | (PerformanceEntry & { detail?: Partial<Drawn> | null })
    | undefined;
  const draw = whole(mark?.startTime);
  if (mark === undefined || draw === undefined) return null;
  const navigation = measured.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  const resources = measured.getEntriesByType("resource") as PerformanceResourceTiming[];
  const first = (suffix: string): PerformanceResourceTiming | undefined =>
    resources.find((entry) => new URL(entry.name, "http://x").pathname.endsWith(suffix));
  const painted = measured.getEntriesByName("first-contentful-paint")[0];
  const reads = resources.filter(
    (entry) =>
      new URL(entry.name, "http://x").pathname.startsWith("/v1/") &&
      entry.responseEnd <= mark.startTime,
  ).length;
  const held = Math.max(0, Math.round(mark.detail?.held ?? 0));
  const message: Record<string, unknown> = {
    v: 1,
    build,
    kind: navigation?.type ?? "navigate",
    draw,
    fcp: whole(painted?.startTime),
    lcp: whole(context.largest),
    ttfb: whole(navigation?.responseStart),
    tokenAt: whole(first("/auth/workspace-token")?.responseEnd),
    bookAt: whole(first("/v1/book.get")?.responseEnd),
    reads: Math.min(1000, reads),
    held: Math.min(1000, held),
    copy: (mark.detail?.copy ?? 0) > 0 ? 1 : 0,
  };
  for (const name of Object.keys(message)) if (message[name] === undefined) delete message[name];
  return message as unknown as LoadMessage;
}

/** Note the moment the page was drawn: at the frame after the first render, with what the page had been given from what it held (`loadMessage` reads it back). */
export function noteDrawn(): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      try {
        performance.mark("rastrata:drawn", { detail: { held: heldGiven(), copy: deviceGiven() } });
      } catch {
        // A browser that cannot mark has nothing to report.
      }
    }),
  );
}

/** Send the load's message once: when the page is left or hidden, or `REPORT_AFTER_MS` after it was first seen, whichever comes first. `send` is the browser's `sendBeacon` unless a test gives one. */
export function reportLoad(
  options: {
    readonly send?: (body: string) => void;
    readonly after?: number;
    readonly measured?: Measured;
  } = {},
): void {
  if (typeof window === "undefined") return;
  const measured = options.measured ?? performance;
  let largest: number | undefined;
  let sent = false;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) largest = entry.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch {
    // Not every browser says what its largest paint was.
  }
  const send =
    options.send ??
    ((body: string) => {
      const blob = new Blob([body], { type: "application/json" });
      if (!navigator.sendBeacon(REPORT_PATH, blob))
        void fetch(REPORT_PATH, { method: "POST", body: blob, keepalive: true }).catch(() => {});
    });
  const once = () => {
    if (sent) return;
    const message = loadMessage(measured, largest === undefined ? {} : { largest });
    // Not drawn yet: nothing to say, and nothing is said if it never is.
    if (message === null) return;
    sent = true;
    try {
      send(JSON.stringify(message));
    } catch {
      // A report that cannot be sent is not the page's problem.
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") once();
  });
  window.addEventListener("pagehide", once);
  setTimeout(once, options.after ?? REPORT_AFTER_MS);
}
