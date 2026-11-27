import { sizeBucket } from "@rastrata/telemetry";

/** A book's size bucket for the metrics that have no "unknown" value. `journals` is the number of
 * journals in the book (from the verified state, or a snapshot manifest); when it is not known yet,
 * the log sequence stands in at about three entries to a journal (a draft, a preparation and a
 * commit), which is close enough to pick the bucket. */
export function knownBucket(
  journals: number | bigint | null | undefined,
  seq?: number,
): "xs" | "s" | "m" | "l" | "xl" {
  const bucket = sizeBucket(journals ?? (seq === undefined ? 0 : Math.floor(seq / 3)));
  return bucket === "unknown" ? "xs" : bucket;
}
