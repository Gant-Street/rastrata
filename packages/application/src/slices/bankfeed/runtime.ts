import type { FetchFn } from "../../bankfeed/client.ts";
import type { CredentialStore, HostPolicy } from "../../bankfeed/credentials.ts";
import type { IngestPort } from "../../ingest-types.ts";
import type { ApplicationService } from "../../service.ts";
import { sliceState } from "../state.ts";

/** What the bankfeed lane needs from its host, replaceable per service so tests never touch the
 * network, the clock, a real credential or the real pipeline:
 *
 *  - `credentials`: where the access URL is kept. The local runtime installs a private file in the data
 *    directory; the default has nowhere to keep one, so a runtime that did not provide a place can
 *    never claim a setup token (which could be claimed only once) and lose what it returns.
 *  - `policy`: which hosts may receive a request. Only a test that runs a stand-in Bridge on this
 *    machine switches loopback on.
 *  - `fetch`: how the Bridge is reached. Always injected into the client; never a global read deep
 *    inside the lane.
 *  - `now`: the clock, as an ISO instant.
 *  - `port`: the ingestion pipeline. Absent means the service's own (`ingestPort(service)`).
 *  - `scheduler`: whether this process runs the optional daily sync (see local/bankfeed-scheduler.ts). */
export interface BankfeedRuntime {
  credentials: CredentialStore;
  policy: HostPolicy;
  fetch: FetchFn;
  now: () => string;
  sleep: ((ms: number) => Promise<void>) | undefined;
  timeoutMs: number | undefined;
  port: IngestPort | undefined;
  /** True while a scheduler is running in this process and can run the daily sync. */
  scheduler: boolean;
}

/** A place that cannot keep anything: reads find nothing, and the probe says why a claim is refused. */
const nowhere: CredentialStore = {
  read: () => null,
  probe: () =>
    "This copy of Rastrata has no private place to keep a bank connection, so none can be made here.",
  write() {
    throw new Error("no place to keep a credential");
  },
  remove() {},
};

export function bankfeedRuntime(service: ApplicationService): BankfeedRuntime {
  return sliceState(service, "bankfeed.runtime", () => ({
    credentials: nowhere,
    policy: { allowLoopback: false },
    fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
    now: () => new Date().toISOString(),
    sleep: undefined,
    timeoutMs: undefined,
    port: undefined,
    scheduler: false,
  }));
}

/** Replace parts of a service's runtime. Called by the local runtime at start and by tests. */
export function configureBankfeedRuntime(
  service: ApplicationService,
  patch: Partial<BankfeedRuntime>,
): void {
  Object.assign(bankfeedRuntime(service), patch);
}
