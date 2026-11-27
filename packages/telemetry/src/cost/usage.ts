/** What a run used, in the shape the cost function prices: one vector per size bucket, every
 * quantity for a month and for all the tenants of the bucket together. */

export const BUCKETS = ["xs", "s", "m", "l", "xl"] as const;
export type Bucket = (typeof BUCKETS)[number];

/** Where the tail of a book's log lives. */
export const TAIL_KINDS = ["postgres", "durable_object", "r2"] as const;
export type TailKind = (typeof TAIL_KINDS)[number];

export interface BucketUsage {
  /** Tenants in the bucket. */
  readonly tenants: number;
  /** Requests a month, for the report's unit costs (they are not priced themselves). `write` is one
   * append to the tail. */
  readonly requests?: {
    readonly read?: number;
    readonly report?: number;
    readonly write?: number;
    readonly bulk?: number;
  };
  /** EVERY call to R2 a month, the sealing writes and an R2-only tail's appends and HEADs included;
   * `bytesStored` is the average over the month, in bytes. */
  readonly r2?: {
    readonly classA?: number;
    readonly classB?: number;
    readonly bytesStored?: number;
  };
  /** Only what a Durable Object or a Postgres tail is itself billed on; ignored for an R2 tail. */
  readonly tail?: {
    readonly rowsWritten?: number;
    readonly rowsRead?: number;
    /** Average bytes held over the month. */
    readonly bytesStored?: number;
    /** Requests to the tail (a Durable Object is billed per request, and so is the Worker in front). */
    readonly requests?: number;
    /** Seconds the Durable Object was active (billed at 128 MB). */
    readonly durationSeconds?: number;
    /** CPU milliseconds of the Worker in front of a Durable Object, when measured. */
    readonly workerCpuMs?: number;
    /** CPU seconds and memory of the Postgres server the tail uses, when a run measured them. */
    readonly cpuSeconds?: number;
    readonly residentMbSeconds?: number;
  };
  /** CPU seconds the application used, background jobs included. */
  readonly cpuSeconds?: number;
  /** Memory held by the application, in MiB-seconds: the average resident set times the month, plus
   * the memory held while books were being made ready. */
  readonly residentMbSeconds?: number;
  readonly activations?: number;
  /** Messages through a queue a month, if one is used. */
  readonly queueMessages?: number;
}

/** The numbers a run used per bucket. A bucket that is not there had no tenants. */
export type Usage = Partial<Record<Bucket, BucketUsage>>;

/** One usage for every tail, or a usage for each tail where the numbers differ (the R2 calls of an
 * R2-only tail are not those of a Postgres tail that is sealed to R2). */
export type TailUsages = Usage | Partial<Record<TailKind, Usage>>;

export class UsageError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`the usage is not valid:\n- ${problems.join("\n- ")}`);
    this.name = "UsageError";
  }
}

const GROUPS = {
  requests: ["read", "report", "write", "bulk"],
  r2: ["classA", "classB", "bytesStored"],
  tail: [
    "rowsWritten",
    "rowsRead",
    "bytesStored",
    "requests",
    "durationSeconds",
    "workerCpuMs",
    "cpuSeconds",
    "residentMbSeconds",
  ],
} as const;
const NUMBERS = ["tenants", "cpuSeconds", "residentMbSeconds", "activations", "queueMessages"];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isAmount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const isBucket = (key: string) => (BUCKETS as readonly string[]).includes(key);
const isTail = (key: string) => (TAIL_KINDS as readonly string[]).includes(key);

/** Check one usage and return it typed. Unknown keys are refused (a misspelt `classa` would
 * otherwise price a bucket's R2 calls at nothing), as is anything that is not a number, zero or
 * more. */
export function parseUsage(value: unknown, where = "usage"): Usage {
  const problems: string[] = [];
  const usage = checkUsage(value, where, problems);
  if (problems.length > 0) throw new UsageError(problems);
  return usage;
}

function checkUsage(value: unknown, where: string, problems: string[]): Usage {
  if (!isRecord(value)) {
    problems.push(`${where} is not an object`);
    return {};
  }
  for (const key of Object.keys(value))
    if (!isBucket(key))
      problems.push(`${where}: ${key} is not a size bucket (${BUCKETS.join(", ")})`);
  for (const bucket of BUCKETS) {
    const raw = value[bucket];
    if (raw === undefined) continue;
    const at = `${where}.${bucket}`;
    if (!isRecord(raw)) {
      problems.push(`${at} is not an object`);
      continue;
    }
    for (const key of Object.keys(raw))
      if (!NUMBERS.includes(key) && !(key in GROUPS)) problems.push(`${at}: unknown key ${key}`);
    if (!isAmount(raw.tenants)) problems.push(`${at}.tenants must be a number, zero or more`);
    for (const key of NUMBERS)
      if (key !== "tenants" && raw[key] !== undefined && !isAmount(raw[key]))
        problems.push(`${at}.${key} must be a number, zero or more`);
    for (const [group, keys] of Object.entries(GROUPS)) {
      const inner = raw[group];
      if (inner === undefined) continue;
      if (!isRecord(inner)) {
        problems.push(`${at}.${group} is not an object`);
        continue;
      }
      for (const key of Object.keys(inner))
        if (!(keys as readonly string[]).includes(key))
          problems.push(`${at}.${group}: unknown key ${key}`);
      for (const key of keys)
        if (inner[key] !== undefined && !isAmount(inner[key]))
          problems.push(`${at}.${group}.${key} must be a number, zero or more`);
    }
  }
  return value as Usage;
}

/** Check a usage that may be per tail and return the usage to price for each tail it covers. A usage
 * written for buckets covers every tail; one written for tails covers the tails it names. */
export function parseTailUsages(value: unknown, where = "usage"): Partial<Record<TailKind, Usage>> {
  if (!isRecord(value) || !Object.keys(value).some(isTail)) {
    const single = parseUsage(value, where);
    return { postgres: single, durable_object: single, r2: single };
  }
  const problems: string[] = [];
  const out: Partial<Record<TailKind, Usage>> = {};
  for (const key of Object.keys(value))
    if (!isTail(key)) problems.push(`${where}: ${key} is not a tail (${TAIL_KINDS.join(", ")})`);
  for (const tail of TAIL_KINDS)
    if (value[tail] !== undefined)
      out[tail] = checkUsage(value[tail], `${where}.${tail}`, problems);
  if (problems.length > 0) throw new UsageError(problems);
  return out;
}

export const tenantsOf = (usage: Usage): number =>
  BUCKETS.reduce((sum, bucket) => sum + (usage[bucket]?.tenants ?? 0), 0);

/** True when a bucket records any quantity besides its tenants. */
export function hasUsage(item: BucketUsage): boolean {
  const walk = (value: unknown): number =>
    typeof value === "number"
      ? value
      : isRecord(value)
        ? Object.values(value).reduce<number>((sum, inner) => sum + walk(inner), 0)
        : 0;
  return walk({ ...item, tenants: 0 }) > 0;
}
