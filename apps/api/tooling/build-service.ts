#!/usr/bin/env bun
/** Build the installed service: one self-contained executable that serves the API and the web app.
 *
 *   bun apps/api/tooling/build-service.ts [--out PATH] [--target bun-linux-x64] [--web DIR]
 *   bun run build:service        (from the repository root; writes dist/rastrata-service)
 *   --with-telemetry             keep the OpenTelemetry SDK in (only to measure what it adds)
 *
 * The web app is built into a temporary directory (or taken from --web) and embedded in the
 * executable beside it as `web/`; the two worker entry points that backups and verification run in
 * are listed as extra entries, flat, so the service finds them at the root of the executable; the
 * release is written in from the repository's package.json. `.env` and `bunfig.toml` files in the
 * directory the service happens to be started from are never read. */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const root = resolve(import.meta.dir, "../../..");

/** The web app's own build, loaded by path: its tooling has type declarations of its own that this
 * project does not carry, so it is not imported statically. */
async function buildWeb(outdir: string): Promise<void> {
  const tooling = join(root, "apps/web/tooling/build.ts");
  const module = (await import(tooling)) as { buildWeb(outdir: string): Promise<unknown> };
  await module.buildWeb(outdir);
}

/** The release: one number, in the repository's package.json. */
export function productVersion(): string {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version?: string;
  };
  if (!version || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("package.json needs a version like 0.1.0");
  return version;
}

export interface BuildServiceOptions {
  /** The executable to write. */
  readonly outfile: string;
  /** A Bun compile target such as bun-linux-x64; the machine this runs on when left out. */
  readonly target?: string;
  /** An existing build of the web app; built fresh when left out. */
  readonly webDirectory?: string;
  readonly version?: string;
  /** Keep the OpenTelemetry SDK in the executable, so that telemetry can be configured. Never for the
   * installed product (it sends nothing and carries none of the code that could); for measuring what
   * the SDK adds, which docs/reference/program/hosting/hostobs.md reports. */
  readonly telemetry?: boolean;
}

export async function buildService(options: BuildServiceOptions): Promise<void> {
  const version = options.version ?? productVersion();
  const stage = mkdtempSync(join(tmpdir(), "rastrata-service-build-"));
  try {
    const web = join(stage, "web");
    if (options.webDirectory) cpSync(options.webDirectory, web, { recursive: true });
    else {
      // The web build logs its asset table; the service build is quiet.
      const log = console.info;
      console.info = () => {};
      try {
        await buildWeb(web);
      } finally {
        console.info = log;
      }
    }
    mkdirSync(dirname(resolve(options.outfile)), { recursive: true });
    const run = Bun.spawnSync(
      [
        process.execPath,
        "build",
        "--compile",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        "--entry-naming=[name].[ext]",
        "--asset=web",
        "--define",
        `RASTRATA_VERSION=${JSON.stringify(version)}`,
        // The service people install never sends telemetry, so it carries none of the code that
        // would (the OpenTelemetry SDK is imported only from the branch this removes).
        // docs/reference/telemetry.md measures what it saves.
        "--define",
        `RASTRATA_TELEMETRY_SDK=${options.telemetry === true}`,
        ...(options.target ? [`--target=${options.target}`] : []),
        join(root, "apps/api/src/rastrata-service.ts"),
        join(root, "packages/application/src/local/snapshot-worker.ts"),
        join(root, "packages/application/src/local/verify-worker.ts"),
        `--outfile=${resolve(options.outfile)}`,
      ],
      { cwd: stage, stdout: "pipe", stderr: "pipe" },
    );
    if (run.exitCode !== 0)
      throw new Error(
        `bun build --compile failed (${run.exitCode}):\n${run.stdout.toString()}${run.stderr.toString()}`,
      );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const outfile = value("--out") ?? join(root, "dist", "rastrata-service");
  const target = value("--target");
  const web = value("--web");
  await buildService({
    outfile,
    ...(target ? { target } : {}),
    ...(web ? { webDirectory: resolve(web) } : {}),
    ...(args.includes("--with-telemetry") ? { telemetry: true } : {}),
  });
  console.info(`Built ${outfile}`);
}
