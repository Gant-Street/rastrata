/** Manual, isolated Cloudflare acceptance campaign. No production namespaces.
 * Run without --deploy for read-only preflight. Secrets never enter CLI arguments
 * or reports. Wall-clock observations are not CPU or end-user latency guarantees. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeBookCommand, encodeDurableBook, executeBookCommand } from "@rastrata/kernel";
import type {
  CompleteBookScope,
  NativeCatalogSnapshot,
  NativeRecoveryEvidence,
} from "@rastrata/ledger";
import { BOOK, activation, genesis, issuer, posting } from "../test/fixtures.ts";
import {
  observeSaveLatency,
  observeClientLatency,
  summarizeFreshSaves,
  summarizeSingleWrites,
  measuredDurationHeader,
  type SaveSample,
} from "./acceptance-metrics.ts";

const root = resolve(import.meta.dir, "../../.."),
  app = resolve(import.meta.dir, "..");
const worker = "rastrata-ledger-acceptance",
  bucket = "rastrata-ledger-acceptance";
const marker = join(root, ".env.ledger-acceptance");
const account = process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(
  account && /^[a-f0-9]{32}$/i.test(account) && apiToken,
  "Cloudflare credentials required",
);
const count = Number(process.argv.find((arg) => arg.startsWith("--count="))?.slice(8) ?? "128");
const compareRef = process.argv.find((arg) => arg.startsWith("--compare-baseline="))?.slice(19);
const latencyLayers = process.argv.includes("--latency-layers");
const platformDefaultCpu = process.argv.includes("--platform-default-cpu");
if (platformDefaultCpu)
  assert.ok(
    latencyLayers && process.argv.includes("--saves-only"),
    "Default CPU is diagnostic only, not production acceptance",
  );
if (latencyLayers)
  assert.ok(
    process.argv.includes("--saves-only") && count <= 256 && !compareRef,
    "Layer profiling requires bounded saves-only run without redeployment comparisons",
  );
const locationHint = process.argv
  .find((arg) => arg.startsWith("--location-hint="))
  ?.slice("--location-hint=".length);
assert.ok(locationHint === undefined || locationHint === "wnam" || locationHint === "enam");
if (compareRef !== undefined) {
  assert.match(compareRef, /^[0-9a-f]{7,40}$/);
  assert.ok(process.argv.includes("--saves-only"), "Baseline comparison requires --saves-only");
}
const recoveryMode =
  process.argv.find((arg) => arg.startsWith("--recovery="))?.slice(11) ?? "snapshot";
assert.ok(
  recoveryMode === "snapshot" || recoveryMode === "archive" || recoveryMode === "unplanned",
  "Recovery must be snapshot, archive or unplanned",
);
assert.ok(
  Number.isSafeInteger(count) && count >= 16 && count <= 10_000,
  "Acceptance count must be 16..10000",
);
const api = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const value = (await response.json()) as { success: boolean; result: T };
  assert.ok(
    response.ok && value.success,
    `Cloudflare ${method} ${path} failed (${response.status}); response redacted`,
  );
  return value.result;
};
const resource = async (
  path: string,
): Promise<{ bindings?: { name: string; text?: string }[] } | null> => {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    headers: { authorization: `Bearer ${apiToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) return null;
  const body = (await response.json()) as {
    success: boolean;
    result: { bindings?: { name: string; text?: string }[] };
  };
  assert.ok(
    response.ok && body.success,
    `Exact resource preflight failed (${response.status}); details redacted`,
  );
  return body.result;
};
const [script, existingBucket, subdomain] = await Promise.all([
  resource(`/workers/scripts/${worker}/settings`),
  resource(`/r2/buckets/${bucket}`),
  api<{ subdomain: string }>("/workers/subdomain"),
]);
assert.match(subdomain.subdomain, /^[a-z0-9-]+$/);
const exists = script !== null,
  bucketExists = existingBucket !== null;
assert.ok(
  !(exists || bucketExists) || existsSync(marker),
  "Acceptance resources exist without an ownership marker; inspect before adopting",
);
if (script)
  assert.ok(
    script.bindings?.some(
      (binding) =>
        binding.name === "LEDGER_NAMESPACE_ID" && binding.text === "rastrata-ledger-acceptance-v1",
    ),
    "Existing Worker is not the isolated acceptance service",
  );
console.log(
  JSON.stringify({
    preflight: "passed",
    worker,
    bucket,
    existingWorker: exists,
    existingBucket: bucketExists,
    writesRequested: process.argv.includes("--deploy"),
  }),
);
if (!process.argv.includes("--deploy")) process.exit(0);
assert.equal(
  Bun.spawnSync(["git", "check-ignore", "--quiet", ".env.ledger-acceptance"], { cwd: root })
    .exitCode,
  0,
  "Acceptance credentials must be ignored",
);
const url = `https://${worker}.${subdomain.subdomain}.workers.dev`;
let operatorKey: string;
if (existsSync(marker)) {
  const stored = readFileSync(marker, "utf8");
  assert.equal(
    /^LEDGER_ACCEPTANCE_URL=(.+)$/m.exec(stored)?.[1],
    url,
    "Acceptance ownership marker belongs to another account",
  );
  operatorKey = /^ACCEPTANCE_KEY=([a-f0-9]{64})$/m.exec(stored)?.[1] ?? "";
  assert.match(operatorKey, /^[a-f0-9]{64}$/);
  chmodSync(marker, 0o600);
} else {
  operatorKey = Buffer.from(randomBytes(32)).toString("hex");
  writeFileSync(
    marker,
    `# Isolated test deployment only. Never commit.\nLEDGER_ACCEPTANCE_URL=${url}\nACCEPTANCE_KEY=${operatorKey}\n`,
    { flag: "wx", mode: 0o600 },
  );
}
const runId = Buffer.from(randomBytes(8)).toString("hex"),
  tenant = `acceptance-${runId}`;
const directory = mkdtempSync(join(tmpdir(), "rastrata-deployed-acceptance-"));
const signer = await issuer();
const recoverySigner = await issuer();
const sourceFiles = Bun.spawnSync(
  [
    "git",
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "apps/ledger-service",
    "packages/kernel/src",
    "packages/ledger/src",
    "bun.lock",
  ],
  { cwd: root },
);
assert.equal(sourceFiles.exitCode, 0);
const paths = [...new Set(new TextDecoder().decode(sourceFiles.stdout).trim().split("\n"))].sort();
const fingerprint = () =>
  createHash("sha256")
    .update(
      JSON.stringify(
        paths.map((path) => [
          path,
          existsSync(join(root, path))
            ? createHash("sha256")
                .update(readFileSync(join(root, path)))
                .digest("hex")
            : null,
        ]),
      ),
    )
    .digest("hex");
const sourceHash = fingerprint();
// Use the production maintenance allowance, not a faster/looser test-only limit.
const { limits } = JSON.parse(readFileSync(join(app, "wrangler.jsonc"), "utf8")) as {
  limits: { cpu_ms: number };
};
assert.ok(Number.isSafeInteger(limits.cpu_ms) && limits.cpu_ms > 0 && limits.cpu_ms <= 300000);
const configuration = {
  name: worker,
  main: join(app, "scripts/acceptance-worker.ts"),
  compatibility_date: "2026-07-30",
  compatibility_flags: ["nodejs_compat"],
  ...(platformDefaultCpu ? {} : { limits }),
  workers_dev: true,
  preview_urls: false,
  observability: { enabled: false },
  vars: {
    LEDGER_NAMESPACE_ID: "rastrata-ledger-acceptance-v1",
    BOOK_AUTHORIZATION: signer.configuration,
    RECOVERY_AUTHORIZATION: recoverySigner.configuration,
    ACCEPTANCE_ALLOW_ACTIVE_LOSS: recoveryMode === "unplanned" ? "true" : "false",
    ACCEPTANCE_EXPIRES_AT: String(Date.now() + 3_500_000),
    ACCEPTANCE_TENANT: tenant,
    ACCEPTANCE_VARIANT: "optimized",
    ACCEPTANCE_TRACE_LATENCY: latencyLayers ? "true" : "false",
    ...(locationHint === undefined ? {} : { ACCEPTANCE_LOCATION_HINT: locationHint }),
  },
  durable_objects: {
    bindings: [
      { name: "BOOKS", class_name: "LedgerBook" },
      { name: "CATALOGS", class_name: "LedgerCatalog" },
    ],
  },
  migrations: [{ tag: "v1", new_sqlite_classes: ["LedgerBook", "LedgerCatalog"] }],
  r2_buckets: [{ binding: "ARCHIVE", bucket_name: bucket }],
};
const configPath = join(directory, "wrangler.json");
writeFileSync(configPath, JSON.stringify(configuration), { mode: 0o600 });
const cli = async (args: string[], stdin?: string) => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--bun",
      join(app, "node_modules/wrangler/bin/wrangler.js"),
      ...args,
      "--config",
      configPath,
    ],
    {
      cwd: app,
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
      stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  assert.equal(code, 0, `Wrangler ${args[0]} failed; credential-bearing output suppressed`);
};
await cli(["deploy", "--dry-run", "--outdir", join(directory, "bundle")]);
if (!bucketExists) await api("/r2/buckets", "POST", { name: bucket });
console.log(
  "Deploying isolated acceptance Worker; production and development resources are unchanged.",
);
await cli(["deploy"]);
// Wrangler preserves secret bindings during deploy. Re-putting an unchanged
// secret creates a second deployment and can reset objects while the first
// rollout is still converging. Install it only for a missing binding.
const installedAcceptanceSecret =
  script?.bindings?.some((binding) => binding.name === "ACCEPTANCE_KEY") ?? false;
if (!installedAcceptanceSecret) await cli(["secret", "put", "ACCEPTANCE_KEY"], operatorKey);
type Receipt = {
  result: { disposition: string; resultHash: unknown };
  outcomeSequence: string;
  head: unknown;
};
const rpc = async <T>(method: string, ...args: unknown[]): Promise<T> => {
  const body = JSON.stringify({ method, args });
  const started = performance.now();
  console.log(JSON.stringify({ rpc: method, phase: "started", at: Date.now() }));
  const response = await fetch(`${url}/acceptance`, {
    method: "POST",
    headers: {
      "x-acceptance-key": operatorKey,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    },
    body,
    redirect: "error",
    // An alarm may deliver eight bounded batches. This background maintenance
    // deadline is independent of the measured, unmodified command-save deadline.
    signal: AbortSignal.timeout(method === "alarm" ? 120_000 : 30_000),
  }).catch((error: unknown) => {
    console.log(
      JSON.stringify({
        rpc: method,
        phase: "transport_failed",
        elapsedMs: performance.now() - started,
      }),
    );
    throw error;
  });
  console.log(
    JSON.stringify({
      rpc: method,
      phase: "received",
      status: response.status,
      elapsedMs: performance.now() - started,
    }),
  );
  const value = (await response.json()) as T & {
    error?: string;
    categories?: string[];
    deploymentRestarted?: boolean;
  };
  if (!response.ok) {
    console.log(
      JSON.stringify({
        rpc: method,
        error: value.error,
        categories: value.categories,
        deploymentRestarted: value.deploymentRestarted,
      }),
    );
    if (
      (value.error === "ledger_unauthorized" ||
        value.categories?.includes("ledger_unauthorized")) &&
      method !== "tokenDiagnostic" &&
      scope
    ) {
      const signed = args.find((arg) => typeof arg === "string" && arg.startsWith("Bearer "));
      if (signed)
        console.log({
          method,
          categories: value.categories,
          authorizationDiagnostic: await rpc("tokenDiagnostic", scope, signed),
        });
    }
    throw new Error(
      value.deploymentRestarted
        ? "acceptance_deployment_restarted"
        : (value.error ?? `acceptance_http_${response.status}`),
    );
  }
  return value;
};
let scope: CompleteBookScope | undefined;
for (let attempt = 0; attempt < 30 && !scope; attempt++) {
  try {
    scope = await rpc<CompleteBookScope>("resolveIdentity", tenant, BOOK);
  } catch (error) {
    if (attempt === 29) throw error;
    await Bun.sleep(1_000);
  }
}
assert.ok(scope, "Acceptance route never became ready");
let authorizationRevision = "0";
const token = (fence = "0") => signer.token(scope, { writerFence: fence, authorizationRevision });
// Deployments of the gateway and existing Durable Object classes do not become
// visible simultaneously. Wait for configuration convergence before any book
// mutation; never hide an accounting failure by retrying the workload itself.
let configurationReady = false;
for (let attempt = 0; attempt < 60 && !configurationReady; attempt++) {
  try {
    const observed = await rpc<
      Record<"gateway" | "book" | "catalog", { result: string; deploymentTenant: string }>
    >("tokenDiagnostic", scope, await token());
    configurationReady = ["gateway", "book", "catalog"].every((key) => {
      const value = observed[key as keyof typeof observed];
      return value.result === "verified" && value.deploymentTenant === tenant;
    });
  } catch (error) {
    if (attempt === 59) throw error;
  }
  if (!configurationReady) await Bun.sleep(1_000);
}
assert.ok(configurationReady, "Acceptance deployment configuration never converged");
const samples: SaveSample[] = [];
const singleWriteControls: { index: number; clientMs: number; bookMs: number }[] = [];
const layerSamples: {
  mode: string;
  round: number;
  clientMs: number;
  workerMs: number;
  bookMs: number;
  colo: string;
}[] = [];
const save = async (command: ReturnType<typeof posting>, fence = "0") => {
  const authorization = await token(fence),
    body = encodeBookCommand(command),
    start = performance.now();
  const sentAt = Date.now();
  const response = await fetch(`${url}/commands`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const result = (await response.json()) as Receipt;
  if (response.status !== 200) {
    const encodedClaims = authorization.split(".")[1];
    assert.ok(encodedClaims);
    const issued = JSON.parse(Buffer.from(encodedClaims, "base64url").toString()) as {
      iat: number;
    };
    throw new Error(
      JSON.stringify({
        failure: "save_http",
        status: response.status,
        issuedAtSeconds: issued.iat,
        localSentAt: sentAt,
        localReceivedAt: Date.now(),
        workerNow: response.headers.get("x-acceptance-worker-now-ms"),
        bookNow: response.headers.get("x-acceptance-book-now-ms"),
        reachedBook: response.headers.has("x-acceptance-book-wall-ms"),
      }),
    );
  }
  const sample = {
    index: samples.length,
    endToEndMs: performance.now() - start,
    workerWallMs: measuredDurationHeader(response.headers, "x-acceptance-worker-wall-ms"),
    bookWallMs: measuredDurationHeader(response.headers, "x-acceptance-book-wall-ms"),
    fresh: result.result.disposition === "committed",
    variant: response.headers.get("x-acceptance-variant"),
    sentAt,
    colo: response.headers.get("x-acceptance-colo"),
    bookProfile: JSON.parse(response.headers.get("x-acceptance-book-profile") ?? "null"),
    workerProfile: JSON.parse(response.headers.get("x-acceptance-worker-profile") ?? "null"),
  };
  samples.push(sample);
  return result;
};
let provisioned: { catalog: NativeCatalogSnapshot } | undefined;
let provisioningAttempts = 0;
for (; provisioningAttempts < 6 && !provisioned; provisioningAttempts++) {
  try {
    // Retry only deployment-induced resets, with identical accounting/request IDs.
    // Timed fresh saves below are never retried or filtered.
    provisioned = await rpc(
      "provision",
      await token(),
      encodeDurableBook(genesis()),
      encodeBookCommand(activation()),
      "provision",
    );
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "acceptance_deployment_restarted")
      throw error;
    await Bun.sleep(1000);
  }
}
assert.ok(provisioned, "Provisioning did not survive deployment convergence");
// Exercise the actual retained activation receipt over RPC. A fresh-only
// provisioning check misses strict-codec objects that cannot cross this boundary.
const provisioningReplay = await rpc(
  "provision",
  await token(),
  encodeDurableBook(genesis()),
  encodeBookCommand(activation()),
  "provision",
);
assert.deepEqual(provisioningReplay, provisioned);
let oracle = executeBookCommand(genesis().state, genesis().protocol, activation());
let firstReceipt: Receipt | undefined;
for (let index = 0; index < count; index++) {
  const command = posting(`save-${index}`, BigInt(index + 1));
  const result = await save(command);
  if (latencyLayers) {
    // Rotate order by round so one control is not always next to a fresh save.
    const modes = ["edge", "noop", "read", "write-1k", "write-1k-gated", "write-16k", "write-64k"];
    for (let step = 0; step < modes.length; step++) {
      const mode = modes[(index + step) % modes.length];
      assert.ok(mode);
      const started = performance.now();
      const probe: { mode: string; round: number; workerMs: number; bookMs: number; colo: string } =
        await rpc<{
          mode: string;
          round: number;
          workerMs: number;
          bookMs: number;
          colo: string;
        }>("latencyProbe", scope, mode, index);
      assert.equal(probe.mode, mode);
      assert.equal(probe.round, index);
      layerSamples.push({ ...probe, clientMs: performance.now() - started });
    }
  }
  if (process.argv.includes("--durability-control")) {
    const start = performance.now();
    const control: { milliseconds: number[] } = await rpc("durabilityProbe", scope, 1);
    const elapsed = performance.now() - start;
    assert.equal(control.milliseconds.length, 1);
    const bookMs = control.milliseconds[0];
    assert.ok(bookMs !== undefined && Number.isFinite(bookMs) && bookMs >= 0);
    singleWriteControls.push({ index, clientMs: elapsed, bookMs });
  }
  assert.equal(result.result.disposition, "committed");
  assert.equal(result.outcomeSequence, String(index + 2));
  // Full replay oracle is outside the measured path and deliberately bounded;
  // complete archived-prefix/projection verification follows during restoration.
  if (index < 32) {
    oracle = executeBookCommand(oracle.state, oracle.protocol, command);
    assert.deepEqual(result.result.resultHash, oracle.result.resultHash);
  }
  if (index === 0) firstReceipt = result;
  if ((index + 1) % 32 === 0)
    console.log(`Committed ${index + 1}/${count} genuine accounting commands.`);
}
assert.ok(firstReceipt);
const rejectionCommand = posting("retained-rejection", 0n);
const rejection = await save(rejectionCommand);
assert.equal(rejection.result.disposition, "rejected");
assert.equal(rejection.outcomeSequence, String(count + 2));
const before = await rpc<{ databaseBytes: number; outcomes: number }>("inspect", scope);
assert.equal(before.outcomes, count + 2);
writeFileSync(
  join(directory, "samples.json"),
  JSON.stringify(
    {
      sourceHash,
      runId,
      scope: "partial deployed measurement; recovery not yet verified",
      count,
      database: before,
      samples,
      singleWriteControls,
      layerSamples,
    },
    null,
    2,
  ),
);
console.log(`Raw measurement evidence: ${join(directory, "samples.json")}`);
const retried = await save(posting("save-0", 1n));
assert.equal(retried.result.disposition, "replayed");
assert.deepEqual(retried.result.resultHash, firstReceipt.result.resultHash);
if (process.argv.includes("--saves-only")) {
  const durabilityControl = await rpc("durabilityProbe", scope);
  assert.equal(fingerprint(), sourceHash, "Source changed during profiling");
  const warm = summarizeFreshSaves(samples, count);
  const report = {
    sourceHash,
    runId,
    measuredAt: new Date().toISOString(),
    count,
    scope: "Isolated fresh-save profiling only; no recovery or release certification",
    locationHint: locationHint ?? "default",
    installedAcceptanceSecret,
    cpuConfiguration: platformDefaultCpu
      ? "platform-default diagnostic; not production configuration"
      : limits,
    provisioningAttempts,
    provisioningReplayVerified: true,
    database: before,
    warm,
    bookLatency: observeSaveLatency(warm),
    clientLatency: observeClientLatency(warm),
    samples,
    durabilityControl,
    layerSamples,
    interleavedSingleWriteControl:
      singleWriteControls.length === 0
        ? null
        : {
            scope:
              "One UPDATE and durable acknowledgement through the same client/gateway/book; no accounting or user-token verification. RPC control route differs from the command HTTP route; not a universal latency floor.",
            warm: summarizeSingleWrites(singleWriteControls, count),
            samples: singleWriteControls,
          },
  };
  const reportPath = join(directory, "profile.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: reportPath, warm }));
  if (compareRef) {
    const baselineRoot = mkdtempSync(join(directory, "baseline-"));
    const archived = Bun.spawn(
      ["git", "archive", compareRef, "packages/ledger/src", "packages/kernel/src"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const contents = await new Response(archived.stdout).arrayBuffer();
    assert.equal(await archived.exited, 0, "Cannot read baseline revision");
    const extracted = Bun.spawn(["tar", "-x", "-C", baselineRoot], {
      stdin: new Blob([contents]),
      stdout: "pipe",
      stderr: "pipe",
    });
    assert.equal(await extracted.exited, 0, "Cannot extract baseline sources");
    const bundle = await Bun.build({
      entrypoints: [join(app, "scripts/acceptance-worker.ts")],
      target: "node",
      format: "esm",
      external: [
        "cloudflare:workers",
        "node:crypto",
        "node:zlib",
        "node:buffer",
        "node:async_hooks",
      ],
      plugins: [
        {
          name: "profile-baseline-sources",
          setup(build) {
            const aliases: Record<string, string> = {
              "@rastrata/ledger": join(baselineRoot, "packages/ledger/src/index.ts"),
              "@rastrata/kernel": join(baselineRoot, "packages/kernel/src/index.ts"),
              jose: fileURLToPath(import.meta.resolve("jose")),
            };
            build.onResolve({ filter: /^(@rastrata\/(ledger|kernel)|jose)$/ }, ({ path }) => {
              const resolved = aliases[path];
              assert.ok(resolved, "Unknown comparison dependency");
              return { path: resolved };
            });
          },
        },
      ],
    });
    assert.ok(bundle.success && bundle.outputs[0], "Cannot build baseline instrumentation");
    const baselineMain = join(directory, "baseline.mjs");
    writeFileSync(baselineMain, await bundle.outputs[0].text());
    let revision = BigInt(count + 1);
    const cohorts: {
      cohort: string;
      variant: string;
      warm: ReturnType<typeof summarizeFreshSaves>;
      bookLatency: ReturnType<typeof observeSaveLatency>;
      clientLatency: ReturnType<typeof observeClientLatency>;
      samples: SaveSample[];
      durabilityControl: unknown;
    }[] = [];
    for (const variant of ["baseline", "optimized", "baseline", "optimized"]) {
      const cohort = `${variant}-${cohorts.length}`;
      configuration.main =
        variant === "baseline" ? baselineMain : join(app, "scripts/acceptance-worker.ts");
      configuration.vars.ACCEPTANCE_VARIANT = variant;
      writeFileSync(configPath, JSON.stringify(configuration), { mode: 0o600 });
      await cli(["deploy"]);
      let ready = false;
      for (let attempt = 0; attempt < 60 && !ready; attempt++) {
        const observed: Record<string, { result: string; variant: string }> = await rpc(
          "tokenDiagnostic",
          scope,
          await token(),
        );
        ready = ["gateway", "book", "catalog"].every(
          (key) => observed[key]?.result === "verified" && observed[key]?.variant === variant,
        );
        if (!ready) await Bun.sleep(1000);
      }
      assert.ok(ready, "Comparison deployment did not converge");
      // Deployment resets can make an unmeasured warmup reply uncertain. Retry
      // its identical command; never retry/filter any of the measured cohort.
      for (let i = 0; i < 2; i++) {
        const command = posting(`${cohort}-warm-${i}`, revision);
        let settled = false;
        for (let attempt = 0; attempt < 6 && !settled; attempt++) {
          try {
            const result = await save(command);
            assert.ok(["committed", "replayed"].includes(result.result.disposition));
            settled = true;
          } catch (error) {
            if (attempt === 5) throw error;
            await Bun.sleep(1000);
          }
        }
        assert.ok(settled);
        revision++;
      }
      samples.length = 0;
      for (let i = 0; i < count; i++) {
        const result = await save(posting(`${cohort}-save-${i}`, revision++));
        assert.equal(result.result.disposition, "committed");
      }
      const observed = samples as (SaveSample & {
        variant: string;
        bookProfile: { verifications: number };
      })[];
      assert.ok(
        observed.every(
          (sample) =>
            sample.variant === variant &&
            sample.bookProfile.verifications === (variant === "baseline" ? 3 : 1),
        ),
        "Mixed code versions in measured cohort",
      );
      const cohortWarm = summarizeFreshSaves(samples, count);
      const bookLatency = observeSaveLatency(cohortWarm);
      const clientLatency = observeClientLatency(cohortWarm);
      cohorts.push({
        cohort,
        variant,
        warm: cohortWarm,
        bookLatency,
        clientLatency,
        samples: [...samples],
        durabilityControl: await rpc("durabilityProbe", scope),
      });
      writeFileSync(
        join(directory, "comparison.json"),
        JSON.stringify(
          {
            sourceHash,
            baselineRevision: compareRef,
            scope:
              "Sequential paired baseline/optimized cohorts on the SAME book/object; accounting and durability unchanged",
            count,
            cohorts,
          },
          null,
          2,
        ),
      );
      console.log(
        JSON.stringify({
          comparison: join(directory, "comparison.json"),
          cohort,
          warm: cohorts.at(-1)?.warm,
        }),
      );
    }
    assert.equal(fingerprint(), sourceHash, "Source changed during comparison");
  }
  // All measurement/accounting assertions above still fail closed. Latency is
  // reported, not an owner-mandated release threshold or a successful SLO claim.
  process.exit(0);
}
const staleAuthorization = await token();
const revoked = await fetch(`${url}/authorization`, {
  method: "POST",
  headers: { authorization: staleAuthorization, "content-type": "application/json" },
  body: JSON.stringify({ requestId: "revoke", expectedRevision: "0" }),
  redirect: "error",
  signal: AbortSignal.timeout(30_000),
});
assert.equal(revoked.status, 200);
await revoked.arrayBuffer();
authorizationRevision = "1";
const refusedOldAuthorization = await fetch(`${url}/commands`, {
  method: "POST",
  headers: { authorization: staleAuthorization, "content-type": "application/json" },
  body: encodeBookCommand(posting("save-0", 1n)),
  redirect: "error",
  signal: AbortSignal.timeout(30_000),
});
assert.equal(refusedOldAuthorization.status, 403);
await refusedOldAuthorization.arrayBuffer();
const unplanned = recoveryMode === "unplanned";
let maintenance: NativeCatalogSnapshot;
let pitrBefore: { bookmark: string; digest: string };
let pitrDamaged: { digest: string } | null = null;
const nativeRecoveryStarted = performance.now();
if (unplanned) {
  // Read-only surviving platform checkpoint, while ACTIVE. No retirement,
  // sealing, operator recovery grant or catalog maintenance precedes the fault.
  pitrBefore = await rpc("pitr", scope, "activeBookmark");
  try {
    await rpc("unexpectedLoss", scope);
  } catch {
    /* durable state below is decisive */
  }
  assert.equal((await rpc<{ ledgerTables: number }>("storageStatus", scope)).ledgerTables, 0);
  const incident = await recoverySigner.incident(
    scope,
    provisioned.catalog.contentHash,
    "unexpected-loss",
  );
  maintenance = await rpc("beginRecovery", incident, provisioned.catalog, "unexpected-loss");
} else {
  maintenance = await rpc<NativeCatalogSnapshot>(
    "control",
    await token(),
    "beginMaintenance",
    provisioned.catalog,
    "maintenance",
  );
  pitrBefore = await rpc<{ bookmark: string; digest: string }>("pitr", scope, "bookmark");
  pitrDamaged = await rpc<{ digest: string }>("pitr", scope, "damage");
  assert.notEqual(
    pitrDamaged.digest,
    pitrBefore.digest,
    "Fault injection did not change stored outcomes",
  );
}
const pitrScheduled = await rpc<{ undoBookmark: string }>(
  "pitr",
  scope,
  "restore",
  pitrBefore.bookmark,
);
try {
  await rpc("restart", scope);
} catch {
  // An aborted owner may lose its response. The following storage observation is decisive.
}
const pitrAfter = await rpc<{ digest: string }>("pitr", scope, "inspect");
assert.equal(
  pitrAfter.digest,
  pitrBefore.digest,
  "PITR did not exactly restore accounting and authorization records",
);
const pitrQuarantineStatuses: number[] = [];
for (const credential of [staleAuthorization, await token()]) {
  const response = await fetch(`${url}/commands`, {
    method: "POST",
    headers: { authorization: credential, "content-type": "application/json" },
    body: encodeBookCommand(posting("save-0", 1n)),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  pitrQuarantineStatuses.push(response.status);
  await response.arrayBuffer();
  assert.ok(
    response.status === 403 || response.status === 503,
    "Restored book escaped maintenance quarantine",
  );
}
const nativePitr = {
  elapsedMs: performance.now() - nativeRecoveryStarted,
  bookmark: pitrBefore.bookmark,
  undoBookmark: pitrScheduled.undoBookmark,
  beforeDigest: pitrBefore.digest,
  damagedDigest: pitrDamaged?.digest ?? null,
  restoredDigest: pitrAfter.digest,
  quarantineStatuses: pitrQuarantineStatuses,
  scope:
    "Native PITR exact accounting/access restoration under maintenance; direct native reactivation not certified",
};
writeFileSync(join(directory, "native-pitr.json"), JSON.stringify(nativePitr, null, 2));
console.log(`Native PITR evidence: ${join(directory, "native-pitr.json")}`);
let approved: NativeCatalogSnapshot | undefined;
let archiveDrainToSealMs: number;
if (unplanned) {
  const archiveStarted = performance.now();
  await rpc("scheduleAlarm", scope);
  let caughtUp = false;
  for (let attempt = 0; attempt < count + 32 && !caughtUp; attempt++) {
    try {
      const status = await rpc<{ status: string; observedSequence: string }>(
        "archiveStatus",
        await token(),
      );
      assert.equal(status.observedSequence, String(count + 2));
      caughtUp = status.status === "caughtUp";
    } catch (error) {
      // A publisher may advance the pointer across this read-only observation.
      // Keep it an unavailable sample; never infer zero backlog or swallow a
      // storage, integrity, authorization or fencing error. No write is retried.
      if (!(error instanceof Error) || error.message !== "native_archive_observation_changed")
        throw error;
    }
    if (!caughtUp) await Bun.sleep(2000);
  }
  assert.ok(caughtUp, "Recovered native source did not complete its archive");
  let evidence: NativeRecoveryEvidence | null = null;
  for (let step = 0; step < count + 64 && evidence === null; step++) {
    const incident = await recoverySigner.incident(
      scope,
      provisioned.catalog.contentHash,
      "unexpected-loss",
    );
    const observed: { complete: boolean; evidence: NativeRecoveryEvidence | null } = await rpc(
      "inspectRecoverySource",
      incident,
      provisioned.catalog,
      "unexpected-loss",
    );
    assert.equal(observed.complete, observed.evidence !== null);
    evidence = observed.evidence;
  }
  assert.ok(evidence, "Independent surviving-source scan did not complete");
  assert.equal(evidence.head.sequence, String(count + 2));
  assert.equal(evidence.head.bookRevision, String(count + 1));
  assert.equal(evidence.authorizationRevision, "1");
  approved = await rpc(
    "recoverUnavailableSource",
    await recoverySigner.recovery(evidence, maintenance.contentHash),
    provisioned.catalog,
    "unexpected-loss",
  );
  archiveDrainToSealMs = performance.now() - archiveStarted;
  console.log(
    "Unexpected active-book loss: native PITR source reconciled and signed recovery admitted.",
  );
} else {
  const retired = await rpc<NativeCatalogSnapshot>(
    "control",
    await token(),
    "retireWriter",
    maintenance,
    "retire",
  );
  console.log("Draining the retired book to R2 and verifying its independent recovery approval.");
  // Exercise the actual platform alarm, not concurrent manual invocations racing
  // its scheduled delivery. Only the independent exact-head seal ends the wait.
  const archiveDrainStarted = performance.now();
  await rpc("scheduleAlarm", scope);
  let sealed: NativeCatalogSnapshot | undefined;
  for (let step = 0; step < count + 32 && !sealed; step++) {
    try {
      sealed = await rpc<NativeCatalogSnapshot>(
        "control",
        await token(),
        "sealArchive",
        retired,
        "seal",
      );
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "native_archive_cutoff_incomplete")
        throw error;
      await Bun.sleep(2_000);
    }
  }
  assert.ok(sealed, "Archive never reached retired head");
  archiveDrainToSealMs = performance.now() - archiveDrainStarted;
  for (let step = 0; step < count + 64 && !approved; step++) {
    try {
      approved = await rpc<NativeCatalogSnapshot>(
        "control",
        await token(),
        "approveRestore",
        sealed,
        "approve",
      );
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "native_catalog_projection_pending")
        throw error;
    }
  }
}
assert.ok(approved, "Source projection did not finish");
if (recoveryMode === "archive") {
  let lossReplyFailed = false;
  try {
    await rpc("loss", scope, await token("1"));
  } catch {
    lossReplyFailed = true;
  }
  assert.ok(lossReplyFailed, "Loss injection must abort its owning object");
  const emptied = await rpc<{ ledgerTables: number }>("storageStatus", scope);
  assert.equal(emptied.ledgerTables, 0, "Loss injection did not durably empty its isolated source");
}
const recoveryStarted = performance.now();
let phase = "";
const recoverySteps: { previousPhase: string; resultingPhase: string; elapsedMs: number }[] = [];
for (let step = 0; step < count * 3 + 128 && phase !== "verified"; step++) {
  const started = performance.now(),
    previousPhase = phase || "uninitialized";
  phase = (
    await rpc<{ phase: string }>(
      recoveryMode !== "archive" ? "verifyRestoredSnapshot" : "restoreStep",
      await token("1"),
    )
  ).phase;
  recoverySteps.push({
    previousPhase,
    resultingPhase: phase,
    elapsedMs: performance.now() - started,
  });
  if (step % 32 === 0) console.log(`Recovery step ${step}: ${phase}.`);
}
assert.equal(phase, "verified");
await rpc("control", await token("1"), "finishRestore", approved, "resume");
await rpc("activateRestoredWriter", await token("1"));
const recovered = await save(posting("save-0", 1n), "1");
assert.equal(recovered.result.disposition, "replayed");
assert.deepEqual(recovered.result.resultHash, firstReceipt.result.resultHash);
const recoveredRejection = await save(rejectionCommand, "1");
assert.equal(recoveredRejection.result.disposition, "replayed");
assert.deepEqual(recoveredRejection.result.resultHash, rejection.result.resultHash);
const refusedOldFence = await fetch(`${url}/commands`, {
  method: "POST",
  headers: { authorization: await token(), "content-type": "application/json" },
  body: encodeBookCommand(posting("save-0", 1n)),
  redirect: "error",
  signal: AbortSignal.timeout(30_000),
});
assert.equal(refusedOldFence.status, 403);
await refusedOldFence.arrayBuffer();
const after = await rpc<{ databaseBytes: number; outcomes: number }>("inspect", scope);
assert.equal(after.outcomes, before.outcomes);
const next = await save(posting("after-restore", BigInt(count + 1)), "1");
assert.equal(next.result.disposition, "committed");
assert.equal(next.outcomeSequence, String(count + 3));
assert.equal(
  fingerprint(),
  sourceHash,
  "Source changed during acceptance; results are not certifiable",
);
const warm = summarizeFreshSaves(samples, count);
const bookLatency = observeSaveLatency(warm);
const clientLatency = observeClientLatency(warm);
const report = {
  format: "rastrata-deployed-acceptance-v1",
  sourceHash,
  runId,
  worker,
  bucket,
  measuredAt: new Date().toISOString(),
  count,
  scope: unplanned
    ? "Isolated real Cloudflare unexpected active-book loss, PITR surviving-source inspection, signed incident/recovery authorization and fenced reactivation; not production release or fleet capacity"
    : "Isolated real Cloudflare SQL/R2 controlled-loss drill; not production release, unplanned-loss proof, CPU capacity, or complete workload parity",
  database: { before, restored: after },
  recoveryMs: performance.now() - recoveryStarted,
  recoveryMode,
  provisioningAttempts,
  provisioningReplayVerified: true,
  recoverySteps,
  nativePitr: {
    ...nativePitr,
    directReactivationVerified: recoveryMode !== "archive",
    scope: unplanned
      ? "Unexpected active-book loss before recovery preparation, native PITR copy reconciled against pre-fault acknowledged state, production signed authority and fenced reactivation"
      : recoveryMode === "snapshot"
        ? "Native PITR exact accounting/access restoration, approved snapshot verification and fenced reactivation; controlled exact-head recovery only"
        : nativePitr.scope,
  },
  archiveDrainToSealMs,
  warm,
  bookLatency,
  clientLatency,
  samples,
};
const reportPath = join(directory, "report.json");
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    status: "verified-scoped-acceptance",
    report: reportPath,
    warm: report.warm,
    recoveredOutcomes: after.outcomes,
  }),
);
