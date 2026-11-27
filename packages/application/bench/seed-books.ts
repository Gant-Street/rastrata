#!/usr/bin/env bun
/** Seed books for the hosting program's load tests: T tenants whose sizes follow a mix, each a closed
 * SQLite book file made through the bulk path (about a millisecond a journal; posting through the API
 * would take hours), plus a manifest the load tests read: tenant id, size bucket, token.
 *
 *   bun scripts/seed-books.ts --out /data/seed --tenants 20 --scale 0.25
 *   (or this file directly: bun packages/application/bench/seed-books.ts ...)
 *
 * Options (all but --out have defaults):
 *   --out DIR         where books/<tenant>/book.sqlite and manifest.json go (required)
 *   --tenants T       how many tenants, the planted huge one included (default 20)
 *   --scale F         multiplies every size; the full mix averages about 4,300 journals and 30 MB a
 *                     book, so 1,000 tenants would be 30 GB (default 1)
 *   --mix NAME|FILE   "default" (median 2,000 journals, p90 10,000, p99 30,000) or a JSON file holding
 *                     { "quantiles": [[0, 20], [0.5, 2000], [1, 45000]] }
 *   --seed S          the same seed gives the same plan and the same books (default 1)
 *   --huge yes|no     plant one tenant at the 99th percentile, for the "one huge tenant" scenario
 *   --ladder A,B,C    also add tenants of exactly these sizes (not scaled), such as 500,2000,5000,20000:
 *                     the rungs the proof plan measures. They are not counted in --tenants.
 *   --spread yes|no   journals over the whole chart instead of cash against sales (default yes)
 *   --snapshot yes|no save a read snapshot where the book fits under the kernel's cap (default no, so
 *                     the first read of a book is the cold path, a replay)
 *   --jobs J          books built at once, each in its own process (default 2)
 *   --max-gb G        refuse a plan whose books would take more disk than this (default 8)
 *   --resume          keep the books already in --out and build the rest
 *   --hook "COMMAND"  run COMMAND once per finished tenant with `--tenant ID --file PATH --journals N
 *                     --bucket B` appended (no shell: the words are split on spaces). This is where the
 *                     hoststore lane's `importBookFile` is attached to write a book into the object
 *                     store's log format instead of leaving a file.
 *
 * The manifest holds one agent token per tenant, a bearer credential for a throwaway local book. A
 * .gitignore that ignores everything is written beside it; never commit or paste the manifest.
 *
 * Every file keeps the application's own book id, "local-book": the scope is a constant of the local
 * service. A store that keys books by tenant uses the manifest's tenant id (letters, digits, hyphens). */
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { buildBook } from "./support/book.ts";
import {
  DEFAULT_MIX,
  type Mix,
  meanJournals,
  planTenants,
  SIZE_BUCKETS,
  type SeedManifest,
  type SeededTenant,
  type TenantPlan,
  totalsOf,
} from "./support/seed-plan.ts";
import { ApplicationHttp } from "../src/http.ts";
import { LocalBookService } from "../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../src/schema.ts";

/** What a closed book costs on disk per journal, measured by the scale program (6.9 KB). */
const BYTES_PER_JOURNAL = 7000;

function option(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}
const flag = (args: readonly string[], name: string) => args.includes(`--${name}`);
const yes = (value: string | undefined, fallback: boolean) =>
  value === undefined ? fallback : value === "yes" || value === "true";

async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const reader = Bun.file(path).stream().getReader();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    hasher.update(chunk.value);
  }
  return hasher.digest("hex");
}

/** An agent token with every permission an agent can hold, minted the way the owner would: through
 * the application's own `tokens.create`, so the book stores its hash and nothing else. */
async function issueToken(path: string): Promise<string> {
  const service = await LocalBookService.open(path, { safety: false, snapshots: false });
  try {
    const http = new ApplicationHttp(service, {
      bookId: service.bookId,
      permissions: BUSINESS_PERMISSIONS,
    });
    const reply = await http.fetch(
      new Request("http://127.0.0.1:4010/v1/tokens.create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: service.bookId,
          operationId: crypto.randomUUID(),
          input: {
            label: "load test",
            permissions: ["read", "draft", "post", "configure", "correct", "close"],
            expiresInDays: 365,
          },
        }),
      }),
    );
    const body = (await reply.json()) as { ok?: boolean; data?: { secret?: string | null } };
    if (!body.ok || !body.data?.secret) throw new Error(`tokens.create answered ${reply.status}`);
    return body.data.secret;
  } finally {
    service.close();
  }
}

/** The child process: build one tenant's book from a plan on stdin, print the SeededTenant as JSON. */
async function buildOne(directory: string, plan: TenantPlan, snapshot: boolean, spread: boolean) {
  const folder = join(directory, "books", plan.tenantId);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "book.sqlite");
  // Build under another name and rename, so a book that is not finished is never mistaken for one.
  const partial = `${path}.partial`;
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${partial}${suffix}`, { force: true });
  const built = await buildBook({
    path: partial,
    journals: plan.journals,
    accounts: plan.accounts,
    revisions: plan.revisions,
    spread,
    snapshot,
    seed: plan.seed,
    fiscalYear: plan.fiscalYear,
    name: `Load tenant ${plan.tenantId}`,
  });
  const token = await issueToken(partial);
  // The book is in write-ahead mode. Fold anything still in the log into the file, then check that the
  // log is empty before the file is renamed: a book is one file, and an unfolded log must never be
  // deleted.
  const settle = new Database(partial);
  try {
    settle.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } finally {
    settle.close();
  }
  if (existsSync(`${partial}-wal`) && statSync(`${partial}-wal`).size > 0)
    throw new Error(`${plan.tenantId} still has a write-ahead log after a checkpoint`);
  for (const suffix of ["-wal", "-shm"]) rmSync(`${partial}${suffix}`, { force: true });
  renameSync(partial, path);
  const tenant: SeededTenant = {
    ...plan,
    file: join("books", plan.tenantId, "book.sqlite"),
    bytes: statSync(path).size,
    sha256: await sha256File(path),
    bookId: "local-book",
    token,
    snapshot,
    buildMilliseconds: Math.round(built.milliseconds),
  };
  return tenant;
}

const args = process.argv.slice(2);

if (flag(args, "build-one")) {
  // `--build-one <plan.json> --out DIR [--snapshot yes] [--spread yes]`: the worker a job runs.
  const planFile = option(args, "build-one");
  const out = option(args, "out");
  if (!planFile || !out) throw new Error("--build-one needs a plan file and --out");
  const plan = JSON.parse(readFileSync(planFile, "utf8")) as TenantPlan;
  const tenant = await buildOne(
    resolve(out),
    plan,
    yes(option(args, "snapshot"), false),
    yes(option(args, "spread"), true),
  );
  console.log(JSON.stringify(tenant));
  process.exit(0);
}

const out = option(args, "out");
if (!out) {
  console.error(
    "usage: bun scripts/seed-books.ts --out DIR [--tenants 20] [--scale 1] (see the file header)",
  );
  process.exit(2);
}
const directory = resolve(out);
const tenantsWanted = Number(option(args, "tenants") ?? "20");
const scale = Number(option(args, "scale") ?? "1");
const seed = Number(option(args, "seed") ?? "1");
const jobs = Math.max(1, Number(option(args, "jobs") ?? "2"));
const maxGb = Number(option(args, "max-gb") ?? "8");
const spread = yes(option(args, "spread"), true);
const snapshot = yes(option(args, "snapshot"), false);
const hook = option(args, "hook");
const mixName = option(args, "mix") ?? "default";
const mix: Mix =
  mixName === "default"
    ? DEFAULT_MIX
    : (JSON.parse(readFileSync(mixName, "utf8")) as { quantiles: Mix }).quantiles;

const plans = planTenants({
  tenants: tenantsWanted,
  mix,
  scale,
  seed,
  huge: yes(option(args, "huge"), true),
  ladder: (option(args, "ladder") ?? "").split(",").filter(Boolean).map(Number),
});
const plannedJournals = plans.reduce((sum, plan) => sum + plan.journals, 0);
const plannedGb = (plannedJournals * BYTES_PER_JOURNAL) / 1e9;
console.log(
  `plan: ${plans.length} tenants, ${plannedJournals} journals (the mix averages ${Math.round(meanJournals(mix) * scale)} a tenant), about ${plannedGb.toFixed(2)} GB on disk, about ${Math.round(plannedJournals / 1000 / 60 / jobs)} minutes of building with ${jobs} job(s)`,
);
if (plannedGb > maxGb) {
  console.error(
    `refusing: ${plannedGb.toFixed(1)} GB is over --max-gb ${maxGb}; use a smaller --scale or --tenants`,
  );
  process.exit(1);
}

mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, ".gitignore"), "*\n");
const manifestPath = join(directory, "manifest.json");
const done = new Map<string, SeededTenant>();
if (flag(args, "resume") && existsSync(manifestPath)) {
  const earlier = JSON.parse(readFileSync(manifestPath, "utf8")) as SeedManifest;
  for (const tenant of earlier.tenants)
    if (existsSync(join(directory, tenant.file))) done.set(tenant.tenantId, tenant);
}

function writeManifest() {
  const tenants = plans.flatMap((plan) => {
    const tenant = done.get(plan.tenantId);
    return tenant ? [tenant] : [];
  });
  const manifest: SeedManifest = {
    format: "rastrata-seed-manifest-v1",
    createdAt: new Date().toISOString(),
    seed,
    scale,
    mix,
    sizeBuckets: SIZE_BUCKETS.map((bucket) => ({
      name: bucket.name,
      below: Number.isFinite(bucket.below) ? bucket.below : null,
    })),
    totals: totalsOf(tenants),
    tenants,
  };
  writeFileSync(`${manifestPath}.partial`, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(`${manifestPath}.partial`, manifestPath);
}

const started = performance.now();
const queue = plans.filter((plan) => !done.has(plan.tenantId));
// Biggest first: the long builds start early, so the last job does not run alone for minutes.
queue.sort((a, b) => b.journals - a.journals);
const script = process.argv[1] ?? "scripts/seed-books.ts";

async function work() {
  for (let plan = queue.shift(); plan; plan = queue.shift()) {
    const planFile = join(directory, `.plan-${plan.tenantId}.json`);
    writeFileSync(planFile, JSON.stringify(plan));
    const child = Bun.spawn(
      [
        process.execPath,
        script,
        "--build-one",
        planFile,
        "--out",
        directory,
        "--snapshot",
        snapshot ? "yes" : "no",
        "--spread",
        spread ? "yes" : "no",
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    const text = await new Response(child.stdout).text();
    const code = await child.exited;
    rmSync(planFile, { force: true });
    const line = text.trim().split("\n").at(-1) ?? "";
    if (code !== 0 || !line.startsWith("{"))
      throw new Error(`building ${plan.tenantId} failed (exit ${code})`);
    const tenant = JSON.parse(line) as SeededTenant;
    done.set(plan.tenantId, tenant);
    writeManifest();
    console.log(
      `${tenant.tenantId} ${tenant.bucket.padEnd(2)} ${String(tenant.journals).padStart(6)} journals, ${String(tenant.accounts).padStart(3)} accounts, ${String(tenant.revisions).padStart(2)} revisions, ${(tenant.bytes / 1048576).toFixed(1)} MB, ${(tenant.buildMilliseconds / 1000).toFixed(1)} s`,
    );
    if (hook) {
      const run = Bun.spawnSync(
        [
          ...hook.split(" ").filter(Boolean),
          "--tenant",
          tenant.tenantId,
          "--file",
          join(directory, tenant.file),
          "--journals",
          String(tenant.journals),
          "--bucket",
          tenant.bucket,
        ],
        { stdout: "inherit", stderr: "inherit" },
      );
      if (run.exitCode !== 0)
        console.error(`hook failed for ${tenant.tenantId} (exit ${run.exitCode})`);
    }
  }
}
await Promise.all(Array.from({ length: jobs }, work));
writeManifest();

const totals = totalsOf([...done.values()]);
console.log(
  `\nseeded ${totals.tenants} tenants, ${totals.journals} journals, ${(totals.bytes / 1048576).toFixed(0)} MB in ${((performance.now() - started) / 1000).toFixed(0)} s: ${Object.entries(
    totals.byBucket,
  )
    .map(([bucket, count]) => `${bucket} ${count}`)
    .join(", ")}`,
);
console.log(`manifest: ${manifestPath}`);
