#!/usr/bin/env bun
/** Run every query of every dashboard, and every alert and recording rule expression, against a
 * Prometheus, and say which fail to parse or evaluate and which return nothing:
 *
 *   bun packages/telemetry/tools/check-dashboards.ts [--prometheus http://127.0.0.1:9090]
 *
 * It is how the local stack is checked by hand (docs/reference/program/hosting/hostobs.md). Exit 1
 * when a query is an error; an empty result is reported and is not an error, because a panel is empty
 * until the traffic it measures has happened. */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DEPLOY } from "./deploy-files.ts";

const args = process.argv.slice(2);
const base = args[args.indexOf("--prometheus") + 1] ?? "http://127.0.0.1:9090";
const prometheus = args.includes("--prometheus") ? base : "http://127.0.0.1:9090";

/** What Grafana fills in. */
const fill = (expr: string) =>
  expr
    .replaceAll("$__rate_interval", "1m")
    .replaceAll("$window", "5m")
    .replaceAll("$__range", "15m")
    .replaceAll("$__interval", "30s");

interface Query {
  readonly where: string;
  readonly expr: string;
}

const queries: Query[] = [];
for (const file of readdirSync(resolve(DEPLOY, "dashboards")).filter((name) =>
  name.endsWith(".json"),
)) {
  const dashboard = JSON.parse(readFileSync(resolve(DEPLOY, "dashboards", file), "utf8")) as {
    panels: { title: string; targets?: { expr?: string }[] }[];
  };
  for (const panel of dashboard.panels)
    for (const target of panel.targets ?? [])
      if (target.expr) queries.push({ where: `${file}: ${panel.title}`, expr: fill(target.expr) });
}
for (const file of ["ops.rules.yaml", "slo.rules.yaml"]) {
  const parsed = Bun.YAML.parse(readFileSync(resolve(DEPLOY, "alerts", file), "utf8")) as {
    groups: { rules: { alert?: string; record?: string; expr: string }[] }[];
  };
  for (const group of parsed.groups)
    for (const rule of group.rules)
      queries.push({ where: `${file}: ${rule.alert ?? rule.record}`, expr: rule.expr });
}

let errors = 0;
let empty = 0;
for (const query of queries) {
  const url = new URL("/api/v1/query", prometheus);
  url.searchParams.set("query", query.expr);
  const started = performance.now();
  const response = await fetch(url);
  const body = (await response.json()) as {
    status: string;
    error?: string;
    data?: { result: unknown[] };
  };
  const ms = Math.round(performance.now() - started);
  if (body.status !== "success") {
    errors += 1;
    console.log(`ERROR  ${query.where}: ${body.error}`);
  } else if ((body.data?.result.length ?? 0) === 0) {
    empty += 1;
    console.log(`empty  ${query.where}`);
  } else if (ms > 2000) console.log(`slow   ${query.where}: ${ms} ms`);
}
console.log(`${queries.length} queries: ${errors} errors, ${empty} empty`);
process.exit(errors > 0 ? 1 : 0);
