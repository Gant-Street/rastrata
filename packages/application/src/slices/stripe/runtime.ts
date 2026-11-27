import type { IngestPort } from "../../ingest-types.ts";
import type { ApplicationService } from "../../service.ts";
import type { FetchFn } from "../../stripe/client.ts";
import { type KeySource, environmentKeySource } from "../../stripe/credentials.ts";
import { sliceState } from "../state.ts";

/** What the Stripe lane needs from its host, replaceable per service so tests never touch the
 * network, the clock, a real key or the real pipeline:
 *
 *  - `keySource`: where the key comes from. The local runtime installs one that also reads a
 *    private file in the data directory; the default reads the process environment.
 *  - `fetch`: how Stripe is reached. Always injected into the client; never a global read deep
 *    inside the lane.
 *  - `now`: the clock, as an ISO instant.
 *  - `port`: the ingestion pipeline. Absent means the service's own (`ingestPort(service)`). */

export interface StripeRuntime {
  keySource: KeySource;
  /** True when the service holds no Stripe key and never will (a service with many books, where a key kept beside the books would be every book's): Stripe is fetched by the
   * sender, with a key of their own, and delivered (`stripe.receive`). It changes what `stripe.sync` says when it has no key. */
  senderFetches: boolean;
  fetch: FetchFn;
  now: () => string;
  sleep: ((ms: number) => Promise<void>) | undefined;
  random: (() => number) | undefined;
  baseUrl: string | undefined;
  port: IngestPort | undefined;
  /** What a call that is given its answers may change in the book before it stops (bytes, roughly); left out, `DELIVERED_WORK_PER_CALL` in sync.ts. For tests. */
  workPerCall: number | undefined;
}

type ProcessLike = { env?: Record<string, string | undefined> };

export function stripeRuntime(service: ApplicationService): StripeRuntime {
  return sliceState(service, "stripe.runtime", () => ({
    keySource: environmentKeySource((globalThis as { process?: ProcessLike }).process?.env),
    senderFetches: false,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
    now: () => service.now(),
    sleep: undefined,
    random: undefined,
    baseUrl: undefined,
    port: undefined,
    workPerCall: undefined,
  }));
}

/** Replace parts of a service's runtime. Called by the local runtime at start and by tests. */
export function configureStripeRuntime(
  service: ApplicationService,
  patch: Partial<StripeRuntime>,
): void {
  Object.assign(stripeRuntime(service), patch);
}

export const todayOf = (runtime: Pick<StripeRuntime, "now">): string => runtime.now().slice(0, 10);
