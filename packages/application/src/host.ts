import type { ExportHost, SafetyHost } from "./safety/host.ts";

/** Ports a runtime injects into the portable service through `ApplicationServiceOptions.host`.
 * Each lane that needs the file system or a database file adds one optional port here and
 * reaches it as `service.host.<name>`, always checking that it is present: a runtime that cannot
 * offer it (the hosted ledger, a test double) simply leaves it out. Portable code never imports
 * an implementation. */
export interface ApplicationHost {
  /** Backups, restore drills and exports (the safety lane). */
  readonly safety?: SafetyHost;
  /** Exports alone, for a runtime that keeps its own backups (a hosted pod). A runtime with `safety` exports through that. */
  readonly exports?: ExportHost;
}
