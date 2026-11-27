/** Turning what a run used into dollars per tenant-month, by component, for each candidate tail.
 *
 * Pure: usage and a price book in, numbers out. Prices come from the book and nothing is rounded here,
 * so a result can be checked by hand from `lines` (each line is one price, the quantity it applied to,
 * and the dollars). */
import { type PriceEntry, type Pricebook, paramOf, priceOf } from "./pricebook.ts";
import {
  BUCKETS,
  type Bucket,
  type BucketUsage,
  TAIL_KINDS,
  type TailKind,
  type TailUsages,
  type Usage,
  UsageError,
  hasUsage,
  parseTailUsages,
  tenantsOf,
} from "./usage.ts";

export const COMPONENTS = [
  "r2_storage",
  "r2_class_a",
  "r2_class_b",
  "tail",
  "compute_cpu",
  "compute_memory",
  "queue",
  "observability",
] as const;
export type Component = (typeof COMPONENTS)[number];

/** The components that add up to the total. The queue is shown beside it: the job queue is proposed
 * to be a Postgres table, so no queue is paid for. */
export const COMPONENTS_IN_TOTAL: readonly Component[] = COMPONENTS.filter(
  (component) => component !== "queue",
);

/** A core is busy half the time at most, to keep a request from waiting for one. */
export const DEFAULT_CPU_UTILIZATION = 0.5;
/** A pod's memory is 70% used at most, to keep the peak of a cold open inside the limit. */
export const DEFAULT_MEMORY_UTILIZATION = 0.7;
/** CloudNativePG keeps three copies. */
export const POSTGRES_REPLICAS = 3;

const GB = 1e9;
const GIB_IN_MIB = 1024;
const MILLION = 1e6;
const THOUSAND = 1e3;

type PerBucket = Partial<Record<Bucket, number>>;

export interface PriceOptions {
  /** Where the tail of a book's log lives. */
  readonly tail: TailKind;
  /** Take the plans' free allowances off the fleet's total, and not charge a plan fee the account
   * already pays. Off by default: every unit is priced at its list price, which is the conservative
   * reading and does not depend on what else the account uses. */
  readonly freeTier?: boolean;
  /** How much of a core the CPU seconds can fill, 0 to 1. */
  readonly cpuUtilization?: number;
  /** How much of a pod's memory the resident set can fill, 0 to 1. */
  readonly memoryUtilization?: number;
  /** What the fleet sends to Grafana Cloud. Nothing given means the Free plan, at $0. */
  readonly observability?: { readonly activeSeries?: number; readonly tracesGb?: number };
}

/** One price applied to one quantity: enough to check a result by hand. */
export interface PriceLine {
  readonly component: Component;
  readonly id: string;
  readonly label: string;
  readonly unit: string;
  /** What the fleet used, in `unit`. */
  readonly quantity: number;
  /** What is charged for, after the allowance (equal to quantity at list price). */
  readonly billable: number;
  readonly price: number;
  readonly dollars: number;
}

export interface PriceResult {
  readonly tail: TailKind;
  readonly freeTier: boolean;
  readonly book: string;
  readonly tenants: number;
  readonly tenantsByBucket: PerBucket;
  /** Dollars per tenant per month, for each component and size bucket. */
  readonly perTenantMonth: Record<Component, PerBucket>;
  /** Dollars per tenant per month, all components but the queue; `all` is the mean over tenants. */
  readonly total: PerBucket & { all: number };
  /** Dollars a month for all the tenants together. */
  readonly monthlyTotal: number;
  /** Tenants per gigabyte stored in R2 (decimal GB) and per GiB of memory held on average; null
   * when nothing was stored or held. */
  readonly tenantsPerGB: { readonly stored: number | null; readonly ram: number | null };
  readonly lines: readonly PriceLine[];
  readonly assumptions: readonly string[];
}

const sumOf = (values: PerBucket): number =>
  BUCKETS.reduce((total, bucket) => total + (values[bucket] ?? 0), 0);

function ratio(value: number, name: string): number {
  if (!(value > 0 && value <= 1)) throw new RangeError(`${name} must be above 0 and at most 1`);
  return value;
}

/** The dollars a month a usage would cost with the tail named in the options. */
export function priceUsage(usage: Usage, book: Pricebook, options: PriceOptions): PriceResult {
  const free = options.freeTier === true;
  const cpuUtilization = ratio(options.cpuUtilization ?? DEFAULT_CPU_UTILIZATION, "cpuUtilization");
  const memoryUtilization = ratio(
    options.memoryUtilization ?? DEFAULT_MEMORY_UTILIZATION,
    "memoryUtilization",
  );
  const buckets = BUCKETS.filter((bucket) => (usage[bucket]?.tenants ?? 0) > 0);
  for (const bucket of BUCKETS) {
    const item = usage[bucket];
    if (item && item.tenants === 0 && hasUsage(item))
      throw new UsageError([`${bucket} has usage but no tenants`]);
  }
  if (buckets.length === 0) throw new UsageError(["the usage has no tenants"]);
  const monthSeconds = book.hoursPerMonth * 3600;
  const tenantsIn = (bucket: Bucket) => usage[bucket]?.tenants ?? 0;
  const totalTenants = tenantsOf(usage);

  const dollars = Object.fromEntries(COMPONENTS.map((component) => [component, {}])) as Record<
    Component,
    PerBucket
  >;
  const lines: PriceLine[] = [];

  /** The quantity of each bucket, read from its usage and scaled into the unit of a price. */
  const pick = (read: (item: BucketUsage) => number | undefined, scale: number): PerBucket => {
    const out: PerBucket = {};
    for (const bucket of buckets) {
      const item = usage[bucket];
      if (item) out[bucket] = (read(item) ?? 0) * scale;
    }
    return out;
  };

  const record = (
    component: Component,
    entry: PriceEntry,
    quantity: number,
    billable: number,
    amount: number,
  ) => {
    if (quantity > 0 || amount > 0)
      lines.push({
        component,
        id: entry.id,
        label: entry.label,
        unit: entry.unit,
        quantity,
        billable,
        price: entry.price,
        dollars: amount,
      });
  };

  /** Charge quantities, in the unit of the price `id`, to components. The allowance comes off the
   * fleet's total once, even when several components draw on it, and what remains is shared out in
   * proportion to use. */
  const charge = (id: string, parts: ReadonlyArray<readonly [Component, PerBucket]>) => {
    const entry = priceOf(book, id);
    const total = parts.reduce((sum, [, quantity]) => sum + sumOf(quantity), 0);
    const allowance = free ? Math.max(0, (entry.included ?? 0) - (entry.alreadyUsed ?? 0)) : 0;
    const share = total > 0 ? Math.max(0, total - allowance) / total : 0;
    for (const [component, quantity] of parts) {
      for (const bucket of buckets)
        dollars[component][bucket] =
          (dollars[component][bucket] ?? 0) + (quantity[bucket] ?? 0) * share * entry.price;
      const amount = sumOf(quantity);
      record(component, entry, amount, amount * share, amount * share * entry.price);
    }
  };

  /** A charge that belongs to the fleet as a whole, shared out by tenants. */
  const fixed = (component: Component, entry: PriceEntry, quantity: number, billable: number) => {
    const amount = billable * entry.price;
    for (const bucket of buckets)
      dollars[component][bucket] =
        (dollars[component][bucket] ?? 0) + (amount * tenantsIn(bucket)) / totalTenants;
    record(component, entry, quantity, billable, amount);
  };

  // R2 itself: the same whichever tail sits in front of it.
  charge("r2.storage", [["r2_storage", pick((item) => item.r2?.bytesStored, 1 / GB)]]);
  charge("r2.class_a", [["r2_class_a", pick((item) => item.r2?.classA, 1 / MILLION)]]);
  charge("r2.class_b", [["r2_class_b", pick((item) => item.r2?.classB, 1 / MILLION)]]);

  // The tail.
  if (options.tail === "durable_object") {
    const memoryGb = paramOf(book, "do.duration", "memoryGB");
    charge("do.requests", [["tail", pick((item) => item.tail?.requests, 1 / MILLION)]]);
    charge("workers.requests", [["tail", pick((item) => item.tail?.requests, 1 / MILLION)]]);
    charge("do.duration", [
      ["tail", pick((item) => item.tail?.durationSeconds, memoryGb / MILLION)],
    ]);
    charge("do.rows_written", [["tail", pick((item) => item.tail?.rowsWritten, 1 / MILLION)]]);
    charge("do.rows_read", [["tail", pick((item) => item.tail?.rowsRead, 1 / MILLION)]]);
    charge("do.stored", [["tail", pick((item) => item.tail?.bytesStored, 1 / GB)]]);
    charge("workers.cpu", [["tail", pick((item) => item.tail?.workerCpuMs, 1 / MILLION)]]);
    // The plan minimum is already paid for the account's other Workers when allowances are applied.
    if (!free) fixed("tail", priceOf(book, "workers.plan"), 1, 1);
  } else if (options.tail === "postgres" && !free) {
    // Three replicas of the (tiny) tail on block volumes at list price. With allowances applied the
    // cluster's local disks are already paid for.
    charge("oci.block_volume", [
      ["tail", pick((item) => item.tail?.bytesStored, POSTGRES_REPLICAS / GB)],
    ]);
  }

  // The application's compute. The Postgres server's own CPU and memory, when a run measured them,
  // draw on the same allowance.
  const onPostgres = options.tail === "postgres";
  const cores = (read: (item: BucketUsage) => number | undefined) =>
    pick(read, 1 / 3600 / cpuUtilization);
  const memory = (read: (item: BucketUsage) => number | undefined) =>
    pick(read, 1 / GIB_IN_MIB / 3600 / memoryUtilization);
  charge("oci.a1.ocpu_hour", [
    ["compute_cpu", cores((item) => item.cpuSeconds)],
    ["tail", onPostgres ? cores((item) => item.tail?.cpuSeconds) : {}],
  ]);
  charge("oci.a1.memory_gb_hour", [
    ["compute_memory", memory((item) => item.residentMbSeconds)],
    ["tail", onPostgres ? memory((item) => item.tail?.residentMbSeconds) : {}],
  ]);

  // Informational.
  charge("queues.operations", [
    [
      "queue",
      pick(
        (item) => item.queueMessages,
        paramOf(book, "queues.operations", "operationsPerMessage") / MILLION,
      ),
    ],
  ]);

  // Observability: Grafana Cloud Free costs nothing while the fleet stays inside it; past it the Pro
  // plan's fee and overage are shared by tenants.
  const series = options.observability?.activeSeries ?? 0;
  const tracesGb = options.observability?.tracesGb ?? 0;
  const plan = priceOf(book, "grafana.free").params ?? {};
  const onFreePlan = series <= (plan.activeSeries ?? 0) && tracesGb <= (plan.tracesGb ?? 0);
  if (!onFreePlan) {
    const seriesEntry = priceOf(book, "grafana.pro.series");
    const tracesEntry = priceOf(book, "grafana.pro.traces_gb");
    fixed("observability", priceOf(book, "grafana.pro.platform"), 1, 1);
    const kilo = series / THOUSAND;
    fixed("observability", seriesEntry, kilo, Math.max(0, kilo - (seriesEntry.included ?? 0)));
    fixed(
      "observability",
      tracesEntry,
      tracesGb,
      Math.max(0, tracesGb - (tracesEntry.included ?? 0)),
    );
  }

  // Per tenant, and the totals.
  const perTenantMonth = Object.fromEntries(
    COMPONENTS.map((component) => [component, {}]),
  ) as Record<Component, PerBucket>;
  const total: PerBucket & { all: number } = { all: 0 };
  let monthlyTotal = 0;
  for (const bucket of buckets) {
    let perTenant = 0;
    for (const component of COMPONENTS) {
      const value = (dollars[component][bucket] ?? 0) / tenantsIn(bucket);
      perTenantMonth[component][bucket] = value;
      if (COMPONENTS_IN_TOTAL.includes(component)) perTenant += value;
    }
    total[bucket] = perTenant;
    monthlyTotal += perTenant * tenantsIn(bucket);
  }
  total.all = monthlyTotal / totalTenants;

  const storedGb = sumOf(pick((item) => item.r2?.bytesStored, 1 / GB));
  const residentGib = sumOf(pick((item) => item.residentMbSeconds, 1 / GIB_IN_MIB)) / monthSeconds;
  const assumptions = [
    `prices from the price book ${book.version}`,
    `a month is ${book.hoursPerMonth} hours`,
    free
      ? "free allowances are applied once to the fleet's total, less what the existing cluster already uses; an account plan that is already paid is not charged"
      : "every unit is priced at its list price: no free allowance is applied and plan fees are charged",
    `R2 storage is priced on decimal gigabytes; memory is binary (MiB-seconds to GiB-hours)`,
    `CPU seconds are priced as OCI Ampere A1 OCPU-hours at ${Math.round(cpuUtilization * 100)}% utilization, memory as GB-hours at ${Math.round(memoryUtilization * 100)}%: the pod that serves them has to be that much bigger than what they use`,
    ...tailAssumptions(options.tail, book, free),
    "the job queue is a Postgres table, so the queue line is informational and not in the total",
    onFreePlan
      ? "observability fits Grafana Cloud Free (10,000 active series, 50 GB of traces), so it costs nothing"
      : "observability exceeds Grafana Cloud Free, so the Pro plan's fee and overage are charged",
    "network egress is not priced: R2 egress is free and a hosted book moves megabytes a month",
  ];

  return {
    tail: options.tail,
    freeTier: free,
    book: book.version,
    tenants: totalTenants,
    tenantsByBucket: Object.fromEntries(buckets.map((bucket) => [bucket, tenantsIn(bucket)])),
    perTenantMonth,
    total,
    monthlyTotal,
    tenantsPerGB: {
      stored: storedGb > 0 ? totalTenants / storedGb : null,
      ram: residentGib > 0 ? totalTenants / residentGib : null,
    },
    lines,
    assumptions,
  };
}

function tailAssumptions(tail: TailKind, book: Pricebook, free: boolean): string[] {
  if (tail === "r2")
    return [
      "the tail is R2 itself: its appends and freshness HEADs are in the R2 call counts, and the tail line is zero",
    ];
  if (tail === "postgres")
    return [
      "the tail is Postgres on the existing cluster: nothing marginal for requests or rows, because the CloudNativePG cluster exists for the control plane",
      free
        ? "its disk is not charged (the cluster's local disks are already paid for); its CPU and memory are charged only if the run measured them"
        : `its disk is charged at ${POSTGRES_REPLICAS} replicas of the block volume price; its CPU and memory are charged only if the run measured them`,
    ];
  const memoryGb = paramOf(book, "do.duration", "memoryGB");
  return [
    `the tail is a Durable Object per book: each tail request is one Durable Object request and one Worker request; duration is billed at ${memoryGb * 1000} MB for the seconds the object is active`,
    "Worker CPU time is priced only if the run measured it (usage tail.workerCpuMs)",
  ];
}

// ---- The matrix: every tail for every variant of the read path ----------------------------------

export interface MatrixRow extends PriceResult {
  /** The variant of the read path the usage is for ("lease", "bounded_staleness", or any name). */
  readonly variant: string;
}

/** Price every variant with every tail it has a usage for. A usage written for buckets is priced with
 * all three tails; a usage written for tails, with the ones it names. */
export function priceMatrix(
  usageByVariant: Readonly<Record<string, TailUsages>>,
  book: Pricebook,
  options: Omit<PriceOptions, "tail"> = {},
): MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const [variant, raw] of Object.entries(usageByVariant)) {
    const byTail = parseTailUsages(raw, `variants.${variant}`);
    for (const tail of TAIL_KINDS) {
      const usage = byTail[tail];
      if (usage) rows.push({ variant, ...priceUsage(usage, book, { ...options, tail }) });
    }
  }
  return rows;
}
