/** The plan for a set of seeded tenants: how many journals each book has, how big its chart is, how many
 * configuration revisions it carries, and the manifest the load tests read. It is pure (no files, no
 * clock), so the same seed gives the same plan, and a test can check it. `scripts/seed-books.ts` carries
 * the plan out.
 *
 * Sizes follow a mix given as quantiles, interpolated on a log scale between neighbours. The default is
 * the one the hosting program fixed: a median tenant has 2,000 journals, the 90th percentile 10,000 and
 * the 99th 30,000. Tenants take evenly spaced quantiles (not random draws), so a handful of tenants
 * still covers the spread, and the order is shuffled so a tenant's number says nothing about its size. */
import { randomFrom } from "./random.ts";

/** Quantile points of the number of journals a tenant has: [quantile, journals], ascending in both. */
export type Mix = readonly (readonly [number, number])[];

export const DEFAULT_MIX: Mix = [
  [0, 20],
  [0.1, 300],
  [0.25, 800],
  [0.5, 2000],
  [0.75, 5000],
  [0.9, 10000],
  [0.99, 30000],
  [1, 45000],
];

/** Size buckets, by journals. They sit on the sizes the proof plan measures (500, 2,000, 5,000 and
 * 20,000), so a bucket's lower edge is a measured size. The telemetry labels use the same names. */
export const SIZE_BUCKETS = [
  { name: "xs", below: 500 },
  { name: "s", below: 2000 },
  { name: "m", below: 5000 },
  { name: "l", below: 20000 },
  { name: "xl", below: Number.POSITIVE_INFINITY },
] as const;
export type SizeBucket = (typeof SIZE_BUCKETS)[number]["name"];

export function bucketOf(journals: number): SizeBucket {
  for (const bucket of SIZE_BUCKETS) if (journals < bucket.below) return bucket.name;
  return "xl";
}

/** Journals at quantile `q` (0 to 1) of the mix, interpolating geometrically between its points. */
export function journalsAt(mix: Mix, q: number): number {
  const clamped = Math.min(1, Math.max(0, q));
  for (let index = 1; index < mix.length; index += 1) {
    const high = mix[index];
    const low = mix[index - 1];
    if (!high || !low) continue;
    if (clamped <= high[0]) {
      const span = high[0] - low[0];
      const t = span === 0 ? 1 : (clamped - low[0]) / span;
      return Math.exp(Math.log(low[1]) + t * (Math.log(high[1]) - Math.log(low[1])));
    }
  }
  return mix[mix.length - 1]?.[1] ?? 0;
}

/** The mean number of journals of a tenant under the mix (numerically, over many quantiles). */
export function meanJournals(mix: Mix): number {
  const steps = 10000;
  let total = 0;
  for (let step = 0; step < steps; step += 1) total += journalsAt(mix, (step + 0.5) / steps);
  return total / steps;
}

export interface TenantPlan {
  /** `t-000001`: letters, digits and hyphens only, so a store can key a book by it. */
  readonly tenantId: string;
  readonly journals: number;
  readonly bucket: SizeBucket;
  readonly accounts: number;
  readonly revisions: number;
  readonly fiscalYear: number;
  /** Seeds this tenant's journals, so a book can be built again identically. */
  readonly seed: number;
  /** True for the one tenant planted at the 99th percentile for the "one huge tenant" scenario. */
  readonly huge: boolean;
  /** For a tenant added to measure one size exactly (a rung of the ladder), that size; otherwise null. */
  readonly ladder: number | null;
}

export interface PlanOptions {
  readonly tenants: number;
  readonly mix?: Mix;
  /** Multiplies every size: the laptop-sized mix. Default 1. */
  readonly scale?: number;
  readonly seed?: number;
  /** Plant one tenant at the 99th percentile (default true). It counts among `tenants`. */
  readonly huge?: boolean;
  /** No book is larger than this many journals (default 45,000, the end of the default mix). */
  readonly maxJournals?: number;
  /** Tenants added, beyond `tenants`, with exactly these sizes (not scaled, not capped): the rungs the
   * proof plan measures, such as 500, 2,000, 5,000 and 20,000. Each has the realistic chart (100
   * accounts, 10 configuration revisions) so a cold load or a report on it is the one the plan names. */
  readonly ladder?: readonly number[];
}

/** A chart that grows with the book (a bookkeeper adds accounts as the business does things), with
 * some variety between businesses of the same size. */
function chartFor(journals: number, random: () => number): number {
  const base = 4 * journals ** 0.4;
  return Math.max(12, Math.min(400, Math.round(base * (0.7 + 0.6 * random()))));
}

/** Configuration revisions (account edits, a calendar extension): more in a book that has lived. */
function revisionsFor(journals: number, random: () => number): number {
  return Math.max(0, Math.round(journals ** 0.3 * (0.2 + 0.8 * random())));
}

export function planTenants(options: PlanOptions): TenantPlan[] {
  const mix = options.mix ?? DEFAULT_MIX;
  const scale = options.scale ?? 1;
  const seed = options.seed ?? 1;
  const cap = options.maxJournals ?? 45000;
  const huge = options.huge ?? true;
  if (!Number.isInteger(options.tenants) || options.tenants < 1)
    throw new Error("tenants must be a positive whole number");
  const random = randomFrom(seed);
  const stratified = options.tenants - (huge ? 1 : 0);
  // Evenly spaced quantiles over [0, 0.99): the 99th percentile itself is the planted tenant's.
  const quantiles = Array.from(
    { length: stratified },
    (_, index) => ((index + 0.5) / stratified) * 0.99,
  );
  // A deterministic shuffle (Fisher-Yates), so the order says nothing about size.
  for (let index = quantiles.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const held = quantiles[index] as number;
    quantiles[index] = quantiles[other] as number;
    quantiles[other] = held;
  }
  const sizes = [
    ...(huge ? [journalsAt(mix, 0.99)] : []),
    ...quantiles.map((q) => journalsAt(mix, q)),
  ];
  const mixed = sizes.map((raw, index): TenantPlan => {
    const journals = Math.max(1, Math.min(cap, Math.round(raw * scale)));
    const own = randomFrom(seed * 1_000_003 + index + 1);
    return {
      tenantId: tenantId(index),
      journals,
      bucket: bucketOf(journals),
      accounts: chartFor(journals, own),
      revisions: revisionsFor(journals, own),
      fiscalYear: own() < 0.25 ? 2025 : 2026,
      seed: Math.floor(own() * 2 ** 31),
      huge: huge && index === 0,
      ladder: null,
    };
  });
  const rungs = (options.ladder ?? []).map((journals, rung): TenantPlan => {
    const index = mixed.length + rung;
    const own = randomFrom(seed * 1_000_003 + index + 1);
    return {
      tenantId: tenantId(index),
      journals,
      bucket: bucketOf(journals),
      accounts: 100,
      revisions: 10,
      fiscalYear: 2026,
      seed: Math.floor(own() * 2 ** 31),
      huge: false,
      ladder: journals,
    };
  });
  return [...mixed, ...rungs];
}

/** `t-000001`: letters, digits and hyphens only, so a store can key a book by it. */
function tenantId(index: number): string {
  return `t-${String(index + 1).padStart(6, "0")}`;
}

/** What the load tests read about one seeded tenant. The token is a bearer credential for a throwaway
 * local book: keep the manifest out of git (the seeder writes a .gitignore beside it). */
export interface SeededTenant extends TenantPlan {
  /** The book file, relative to the manifest's directory. */
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  /** The application's own book id, which is the same constant in every file ("local-book"). */
  readonly bookId: string;
  /** An agent token with every permission an agent can hold. */
  readonly token: string;
  /** True when the builder saved a read snapshot (the default is not to: the cold path replays). */
  readonly snapshot: boolean;
  readonly buildMilliseconds: number;
}

export interface SeedManifest {
  readonly format: "rastrata-seed-manifest-v1";
  readonly createdAt: string;
  readonly seed: number;
  readonly scale: number;
  readonly mix: Mix;
  readonly sizeBuckets: readonly { readonly name: string; readonly below: number | null }[];
  readonly totals: {
    readonly tenants: number;
    readonly journals: number;
    readonly bytes: number;
    readonly byBucket: Readonly<Record<string, number>>;
  };
  readonly tenants: readonly SeededTenant[];
}

export function totalsOf(tenants: readonly SeededTenant[]): SeedManifest["totals"] {
  const byBucket: Record<string, number> = {};
  let journals = 0;
  let bytes = 0;
  for (const tenant of tenants) {
    byBucket[tenant.bucket] = (byBucket[tenant.bucket] ?? 0) + 1;
    journals += tenant.journals;
    bytes += tenant.bytes;
  }
  return { tenants: tenants.length, journals, bytes, byBucket };
}
