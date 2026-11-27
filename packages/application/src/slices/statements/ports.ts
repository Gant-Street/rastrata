import type { IngestPort, RawRef } from "../../ingest-types.ts";
import type { ApplicationService } from "../../service.ts";
import { ingestPort } from "../ingest/port.ts";

const ports = new WeakMap<ApplicationService, IngestPort>();
const clocks = new WeakMap<ApplicationService, () => Date>();

/** The ingestion pipeline for this service. Tests hand in a fake with {@link useIngestPort} to
 * rehearse failures; every other caller gets the real one. */
export function ingestFor(service: ApplicationService): IngestPort {
  return ports.get(service) ?? ingestPort(service);
}

/** Test seam: route this service's imports through `port`. */
export function useIngestPort(service: ApplicationService, port: IngestPort): void {
  ports.set(service, port);
}

/** Test seam: the instant "now" means for this service's imports. */
export function useClock(service: ApplicationService, clock: () => Date): void {
  clocks.set(service, clock);
}

export const nowOf = (service: ApplicationService): Date =>
  (clocks.get(service) ?? (() => new Date(service.now())))();

/** Today as a local `YYYY-MM-DD` date, from the service's own clock, never converted through a
 * time zone. */
export function todayOf(service: ApplicationService): string {
  return service.today();
}

/** The archive the pipeline returned must match the bytes we gave it, or it is a bug we must not
 * pass on to a client as a receipt. */
export function checkedReceipt(bytes: Uint8Array, receipt: RawRef): RawRef {
  if (!/^[0-9a-f]{64}$/.test(receipt.sha256) || receipt.size !== bytes.byteLength)
    throw new Error("The ingestion pipeline returned an archive reference that does not match");
  return receipt;
}
