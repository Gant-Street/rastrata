import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { remoteTransport } from "./smoke.ts";
import { verifySmoke, type Transport } from "./verify-smoke.ts";
import { verifyNativeSmoke, verifyNativeSave } from "./verify-native-smoke.ts";

// Credentials are generated runtime artifacts, never command-line arguments or log output.
const root = resolve(import.meta.dir, "../../..");
const app = resolve(import.meta.dir, "..");
const credentialPath = resolve(root, ".env.ledger-dev");
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const workerName = "rastrata-ledger-dev";
const wrangler = resolve(app, "node_modules/wrangler/bin/wrangler.js");

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    headers: { authorization: `Bearer ${apiToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json()) as { success: boolean; result: T };
  if (!response.ok || body.success !== true)
    throw new Error(`Cloudflare preflight failed (${response.status})`);
  return body.result;
}

async function cli(args: string[], input?: string) {
  const child = Bun.spawn([process.execPath, "--bun", wrangler, ...args], {
    cwd: app,
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    stdin: input ? new Blob([input]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Drain without echoing potentially sensitive CLI diagnostics.
  const [code] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0)
    throw new Error(`Wrangler ${args[0]} failed (exit ${code}); no credentials printed`);
}

async function waitForRoute(call: Transport) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    // Only routing/readiness is retried. Accounting assertion failures are never retried away.
    const authorized = await call("/health");
    const anonymous = await call("/health", "GET", false);
    if (authorized.status === 200 && anonymous.status === 401) return;
    await Bun.sleep(1000);
  }
  throw new Error("Development route did not become ready; inspect access configuration");
}

async function main() {
  assert.ok(
    account && /^[a-f0-9]{32}$/i.test(account) && apiToken,
    "Cloudflare credentials required",
  );
  const ignored = Bun.spawnSync(["git", "check-ignore", "--quiet", ".env.ledger-dev"], {
    cwd: root,
  });
  assert.equal(ignored.exitCode, 0, "Generated credentials must be gitignored");
  const subdomain = await api<{ subdomain: string }>("/workers/subdomain");
  assert.match(
    subdomain.subdomain,
    /^[a-z0-9-]+$/,
    "A workers.dev subdomain must already be configured",
  );
  const url = `https://${workerName}.${subdomain.subdomain}.workers.dev`;
  const scripts = await api<{ id: string }[]>("/workers/scripts");
  // Do not overwrite an unrelated Worker sharing this name. Reruns require our local marker.
  assert.ok(
    !scripts.some((s: { id: string }) => s.id === workerName) || existsSync(credentialPath),
    "Worker exists without local deployment credentials; inspect before adopting",
  );
  let token: string;
  if (existsSync(credentialPath)) {
    const existing = readFileSync(credentialPath, "utf8");
    const savedUrl = /^LEDGER_DEV_URL=(.+)$/m.exec(existing)?.[1];
    const savedToken = /^DEV_ACCESS_TOKEN=([a-f0-9]{64})$/m.exec(existing)?.[1];
    assert.equal(savedUrl, url, "Local deployment belongs to a different origin");
    assert.ok(savedToken, "Malformed local development credentials");
    token = savedToken;
    chmodSync(credentialPath, 0o600);
  } else {
    token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    writeFileSync(
      credentialPath,
      `# Generated development credentials; never commit.\nLEDGER_DEV_URL=${url}\nDEV_ACCESS_TOKEN=${token}\n`,
      { flag: "wx", mode: 0o600 },
    );
  }
  const expiry = String(Date.now() + 24 * 60 * 60 * 1000);
  const deployArgs = ["deploy", "--var", `DEV_EXPIRES_AT:${expiry}`];
  console.log("Deploying synthetic-only Worker and SQLite Durable Object namespace...");
  await cli(deployArgs);
  await cli(["secret", "put", "DEV_ACCESS_TOKEN"], `${token}\n`);
  const call = remoteTransport(url, token);
  await waitForRoute(call);
  const before = await verifySmoke(call);
  const nativeObservations: {
    readonly httpRoundTripMs: number;
    readonly dispositions: readonly string[];
  }[] = [];
  const initialNative = await verifyNativeSmoke(call, (sample) => nativeObservations.push(sample));
  const firstSave = await verifyNativeSave(call);
  const nativeBefore = firstSave.snapshot;
  assert.deepEqual(
    nativeBefore.outcomes.slice(0, 3),
    initialNative.outcomes.slice(0, 3),
    "The single-save exercise must preserve the original native prefix",
  );
  console.log("Remote commands and retries verified; deploying a replacement Worker version...");
  await cli(deployArgs);
  await waitForRoute(call);
  const after = await verifySmoke(call);
  const nativeAfter = await verifyNativeSmoke(call, (sample) => nativeObservations.push(sample));
  const retrySave = await verifyNativeSave(call);
  assert.equal(retrySave.disposition, "replayed");
  assert.deepEqual(retrySave.snapshot, nativeAfter);
  assert.deepEqual(after, before, "Durable head and aggregate must survive redeployment unchanged");
  assert.deepEqual(
    nativeAfter,
    nativeBefore,
    "Native durable outcomes and head must survive redeployment unchanged",
  );
  console.log(
    JSON.stringify(
      {
        url,
        expiresAt: new Date(Number(expiry)).toISOString(),
        verified: true,
        nativeHead: nativeAfter.head,
        nativeObservations,
        singleSaveObservations: [firstSave, retrySave].map((sample) => ({
          httpRoundTripMs: sample.httpRoundTripMs,
          disposition: sample.disposition,
        })),
        measurementScope:
          "nativeObservations are whole scenarios; singleSaveObservations are one fixed genuine command and its retry after redeployment. Two samples on a tiny book are not a production SLO or load test.",
        verification:
          "synthetic commits, retained rejection, retries, and redeployment persistence",
        ...after,
      },
      null,
      2,
    ),
  );
}

try {
  await main();
} catch (error) {
  // Only our own fixed diagnostic messages are safe. Do not print HTTP or CLI bodies.
  const message = error instanceof Error ? error.message : "Unknown failure";
  const safe = message.replaceAll(apiToken ?? "[missing-api-token]", "[redacted]");
  console.error(`Development deployment stopped: ${safe}`);
  process.exitCode = 1;
}
