/** Rendering priced results as the tables a person reads. Pure: values in, strings out. */
import { COMPONENTS, type Component, type PriceResult } from "./price.ts";
import { BUCKETS } from "./usage.ts";

/** The program's cost threshold: at most this many dollars per tenant-month, all components. */
export const BUDGET_PER_TENANT_MONTH = 0.02;

export interface ReportRow {
  /** What the row is: the variant of the read path, or the name of the run. */
  readonly label: string;
  readonly result: PriceResult;
}

export interface ReportOptions {
  readonly title: string;
  readonly budget?: number;
  /** Print each price applied to each quantity, so a row can be checked by hand. */
  readonly detail?: boolean;
  /** Where the numbers came from, in a line. */
  readonly source?: string;
  readonly oldestPriceRead?: string;
  /** What the reader of the numbers should know about how they were made (a dump's allocations). */
  readonly notes?: readonly string[];
}

/** Dollars, to the hundredth of a cent. Cost per tenant is a fraction of a cent. */
export function usd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.000005) return "<$0.00001";
  return `$${value.toFixed(5)}`;
}

const count = (value: number): string =>
  value.toLocaleString("en-US", { maximumFractionDigits: value >= 100 ? 0 : 2 });

export const COMPONENT_LABELS: Record<Component, string> = {
  r2_storage: "R2 storage",
  r2_class_a: "R2 Class A",
  r2_class_b: "R2 Class B",
  tail: "tail",
  compute_cpu: "CPU",
  compute_memory: "memory",
  queue: "queue (not in total)",
  observability: "observability",
};

/** Dollars per tenant of a component, averaged over all the tenants of a result. */
export function perTenant(result: PriceResult, component: Component): number {
  let dollars = 0;
  for (const bucket of BUCKETS)
    dollars +=
      (result.perTenantMonth[component][bucket] ?? 0) * (result.tenantsByBucket[bucket] ?? 0);
  return result.tenants > 0 ? dollars / result.tenants : 0;
}

const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;

/** The headline table: a line per row, a column per component, the total and the verdict. It is also
 * what docs/reference/program/hosting/hostobs.md quotes for the synthetic file, and a test keeps the
 * two equal. */
export function headlineTable(
  rows: readonly ReportRow[],
  budget = BUDGET_PER_TENANT_MONTH,
): string[] {
  const shown = COMPONENTS.filter(
    (component) =>
      component === "tail" || rows.some((entry) => perTenant(entry.result, component) > 0),
  );
  const out = [
    line([
      "row",
      "tail",
      ...shown.map((component) => COMPONENT_LABELS[component]),
      "total",
      "budget",
      "all tenants, a month",
    ]),
    line(["---", "---", ...shown.map(() => "---:"), "---:", "---", "---:"]),
  ];
  for (const { label, result } of rows)
    out.push(
      line([
        label,
        result.tail,
        ...shown.map((component) => usd(perTenant(result, component))),
        `**${usd(result.total.all)}**`,
        result.total.all <= budget ? "within" : "OVER",
        `${usd(result.monthlyTotal)} for ${count(result.tenants)} tenants`,
      ]),
    );
  return out;
}

/** The tables of a report in Markdown. */
export function renderMarkdown(rows: readonly ReportRow[], options: ReportOptions): string {
  const budget = options.budget ?? BUDGET_PER_TENANT_MONTH;
  const out: string[] = [`# ${options.title}`, ""];
  if (options.source) out.push(`Source: ${options.source}`, "");
  const first = rows[0]?.result;
  if (first)
    out.push(
      `Price book ${first.book}${options.oldestPriceRead ? `, oldest price read ${options.oldestPriceRead}` : ""}. ` +
        `Dollars per tenant per month; the budget is ${usd(budget)}.`,
      "",
    );

  out.push(...headlineTable(rows, budget), "");

  // By book size.
  out.push(
    "## By book size",
    "",
    "Total dollars per tenant per month, by the size bucket of the book.",
    "",
  );
  out.push(
    line([
      "row",
      "tail",
      ...BUCKETS.map((bucket) => `${bucket} (${count(first?.tenantsByBucket[bucket] ?? 0)})`),
    ]),
    line(["---", "---", ...BUCKETS.map(() => "---:")]),
  );
  for (const { label, result } of rows)
    out.push(
      line([
        label,
        result.tail,
        ...BUCKETS.map((bucket) =>
          result.total[bucket] === undefined ? "-" : usd(result.total[bucket] as number),
        ),
      ]),
    );
  out.push("", "The number in brackets is the tenants of that size in the first row.", "");

  // Density.
  out.push("## Density", "");
  out.push(
    line([
      "row",
      "tail",
      "tenants",
      "tenants per GB stored",
      "tenants per GiB resident, on average",
    ]),
    line(["---", "---", "---:", "---:", "---:"]),
  );
  for (const { label, result } of rows)
    out.push(
      line([
        label,
        result.tail,
        count(result.tenants),
        result.tenantsPerGB.stored === null ? "-" : count(result.tenantsPerGB.stored),
        result.tenantsPerGB.ram === null ? "-" : count(result.tenantsPerGB.ram),
      ]),
    );
  out.push("");

  if (options.detail) {
    out.push("## Prices applied", "");
    for (const { label, result } of rows) {
      out.push(`### ${label}, ${result.tail} tail`, "");
      out.push(
        line(["component", "price", "quantity", "billed", "per unit", "dollars a month"]),
        line(["---", "---", "---:", "---:", "---:", "---:"]),
      );
      for (const priced of result.lines)
        out.push(
          line([
            COMPONENT_LABELS[priced.component],
            `${priced.label} (${priced.unit})`,
            count(priced.quantity),
            count(priced.billable),
            `$${priced.price}`,
            usd(priced.dollars),
          ]),
        );
      out.push("");
    }
  }

  const assumptions = [...new Set(rows.flatMap((entry) => entry.result.assumptions))];
  out.push("## Assumptions", "", ...assumptions.map((text) => `- ${text}`), "");
  if (options.notes && options.notes.length > 0)
    out.push("## About the numbers", "", ...options.notes.map((text) => `- ${text}`), "");
  return out.join("\n");
}
