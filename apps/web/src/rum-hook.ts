/** The only part of real-user measurement the rest of the app imports, and it is a few lines. The
 * measurement itself (rum.ts, and the web-vitals library behind it) is loaded only when the service
 * asks for it, and installs itself here; until then `timeAction` returns undefined and a write is
 * exactly the write it always was. */
import type { BeaconOutcome } from "@rastrata/telemetry/web";

export type ActionTimer = (operation: string) => ((outcome: BeaconOutcome) => void) | undefined;

let installed: ActionTimer | undefined;

export function installActionTimer(timer: ActionTimer | undefined): void {
  installed = timer;
}

/** Begin timing a write if this page view reports and the write is a key action (accept, post,
 * save). The function returned says how it ended. */
export const timeAction: ActionTimer = (operation) => installed?.(operation);

/** How a failed write reads from the browser: the service's own failure, a refusal, or not knowing
 * whether the write happened (a dropped connection). */
export function outcomeOfError(error: unknown): BeaconOutcome {
  const failure = error as { code?: unknown; uncertain?: unknown } | null;
  if (failure?.uncertain === true) return "other";
  if (failure?.code === "service_unavailable" || failure?.code === "operation_unresolved")
    return "server_error";
  return typeof failure?.code === "string" ? "client_error" : "other";
}

/** Whether the service asked this page to measure itself: it says so with a `rum` entry in the
 * Server-Timing header of the document. */
export function serviceAsksForRum(): boolean {
  try {
    const navigation = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    return navigation?.serverTiming?.some((entry) => entry.name === "rum") === true;
  } catch {
    return false;
  }
}
