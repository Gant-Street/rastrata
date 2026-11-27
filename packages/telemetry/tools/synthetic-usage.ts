#!/usr/bin/env bun
/** The synthetic usage the cost report is exercised with: ops/examples/synthetic-usage.json.
 *
 *   bun packages/telemetry/tools/synthetic-usage.ts --write     rewrite the file
 *
 * EVERY NUMBER HERE IS MADE UP, to be of the right order of magnitude (the scale program's
 * measurements: a book is about 6.9 KB a journal on disk, a write is a millisecond, reading a book
 * back is 0.8 ms a journal, a resident book is 1.7 MB plus about 6 KB a journal). It exists so the
 * cost report has something to read before a load run produces the real vectors, and so the
 * arithmetic can be checked by hand. A test keeps the committed file equal to what this prints. */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BUCKETS,
  type Bucket,
  type BucketUsage,
  type TailKind,
  type Usage,
} from "../src/cost/index.ts";

export const FILE = resolve(import.meta.dir, "../../../ops/examples/synthetic-usage.json");

/** A thousand tenants, mostly small. */
const TENANTS: Record<Bucket, number> = { xs: 600, s: 250, m: 100, l: 40, xl: 10 };

/** What one tenant of a bucket does in a month, invented. */
const PER_TENANT: Record<
  Bucket,
  {
    journals: number;
    commits: number;
    secondsPerSession: number;
    readsPerSession: number;
    reportsPerSession: number;
  }
> = {
  xs: {
    journals: 300,
    commits: 80,
    secondsPerSession: 60,
    readsPerSession: 40,
    reportsPerSession: 2,
  },
  s: {
    journals: 1_200,
    commits: 250,
    secondsPerSession: 300,
    readsPerSession: 80,
    reportsPerSession: 3,
  },
  m: {
    journals: 3_000,
    commits: 600,
    secondsPerSession: 600,
    readsPerSession: 120,
    reportsPerSession: 4,
  },
  l: {
    journals: 10_000,
    commits: 1_500,
    secondsPerSession: 900,
    readsPerSession: 160,
    reportsPerSession: 5,
  },
  xl: {
    journals: 30_000,
    commits: 4_000,
    secondsPerSession: 1_500,
    readsPerSession: 200,
    reportsPerSession: 6,
  },
};

/** A person opens their book about twenty times a month, and a book sits in memory for fifteen
 * minutes after the last request. */
const SESSIONS = 20;
const RESIDENT_AFTER_USE_SECONDS = 900;
/** A Durable Object stays active about ten seconds after its last request. */
const DO_IDLE_SECONDS = 10;
/** The log, compressed, and the latest snapshot: bytes a journal in R2. */
const BYTES_PER_JOURNAL = 4_500;
/** A lease is renewed every ten seconds while a book is in use. */
const LEASE_RENEWAL_SECONDS = 10;
/** A sealing write covers about five commits; a snapshot is written every hundred. */
const COMMITS_PER_SEAL = 5;
const COMMITS_PER_SNAPSHOT = 100;
/** With a bounded-staleness read, a freshness HEAD every five seconds a book is in use. */
const STALENESS_SECONDS = 5;

const round = (value: number) => Math.round(value * 1000) / 1000;

function bucketUsage(
  bucket: Bucket,
  tail: TailKind,
  variant: "lease" | "bounded_staleness",
): BucketUsage {
  const p = PER_TENANT[bucket];
  const n = TENANTS[bucket];
  const activations = SESSIONS;
  const activeSeconds = SESSIONS * p.secondsPerSession;
  const reads = SESSIONS * p.readsPerSession;
  const reports = SESSIONS * p.reportsPerSession;
  const renewals = activeSeconds / LEASE_RENEWAL_SECONDS;
  const residentMb = 1.7 + p.journals * 0.006;
  const activationGets = 2 + p.journals / 1_000;
  const classA =
    tail === "r2"
      ? p.commits + p.commits / COMMITS_PER_SNAPSHOT
      : p.commits / COMMITS_PER_SEAL + p.commits / COMMITS_PER_SNAPSHOT;
  // An R2-only tail has no lease, so every read pays a freshness HEAD whichever variant is asked for.
  const freshnessHeads =
    tail === "r2"
      ? reads + reports
      : variant === "bounded_staleness"
        ? activeSeconds / STALENESS_SECONDS
        : 0;
  const classB =
    activations * (activationGets + (tail === "r2" ? p.commits / 20 / SESSIONS : 0)) +
    freshnessHeads;
  return {
    tenants: n,
    requests: {
      read: n * reads,
      report: n * reports,
      write: n * p.commits,
      bulk: 0,
    },
    r2: {
      classA: round(n * classA),
      classB: round(n * classB),
      bytesStored: n * p.journals * BYTES_PER_JOURNAL,
    },
    tail:
      tail === "durable_object"
        ? {
            requests: n * (p.commits + renewals),
            rowsWritten: n * p.commits * 2,
            rowsRead: n * activations * 20,
            bytesStored: n * 100_000,
            durationSeconds: n * SESSIONS * (p.secondsPerSession + DO_IDLE_SECONDS),
          }
        : tail === "postgres"
          ? {
              requests: n * (p.commits + renewals),
              rowsWritten: n * p.commits * 3,
              bytesStored: n * 50_000,
            }
          : {},
    cpuSeconds: round(
      n *
        (p.commits * 0.004 +
          reads * 0.003 +
          reports * p.journals * 0.00004 +
          activations * p.journals * 0.0003),
    ),
    residentMbSeconds: round(
      n * SESSIONS * (p.secondsPerSession + RESIDENT_AFTER_USE_SECONDS) * residentMb,
    ),
    activations: n * activations,
  };
}

function usageFor(tail: TailKind, variant: "lease" | "bounded_staleness"): Usage {
  return Object.fromEntries(BUCKETS.map((bucket) => [bucket, bucketUsage(bucket, tail, variant)]));
}

/** The whole file. */
export function syntheticUsage() {
  const variant = (name: "lease" | "bounded_staleness") => ({
    postgres: usageFor("postgres", name),
    durable_object: usageFor("durable_object", name),
    r2: usageFor("r2", name),
  });
  return {
    description:
      "SYNTHETIC. Every number is made up to be of the right order of magnitude, from the scale program's measurements, so the cost report has something to read before a load run produces real vectors. 1,000 tenants (600 xs, 250 s, 100 m, 40 l, 10 xl); each opens its book 20 times a month. An R2-only tail has no lease, so each read pays a freshness HEAD in both variants. Generated by packages/telemetry/tools/synthetic-usage.ts.",
    synthetic: true,
    variants: { lease: variant("lease"), bounded_staleness: variant("bounded_staleness") },
  };
}

export const render = () => `${JSON.stringify(syntheticUsage(), null, 2)}\n`;

if (import.meta.main) {
  if (process.argv.includes("--write")) {
    writeFileSync(FILE, render());
    console.log(`wrote ${FILE}`);
  } else process.stdout.write(render());
}
