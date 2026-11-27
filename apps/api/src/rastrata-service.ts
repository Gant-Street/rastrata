// The entry point of the installed executable, `rastrata-service`. The development API
// (main.ts) is a different entry with development defaults; this one has the product's.
//
//   rastrata-service [serve]      run the service until it is stopped (what the login item runs)
//   rastrata-service version      print the release
//   rastrata-service paths        print where this user's data lives, as JSON
//   rastrata-service tool ...     the offline tool: restore, import-export, check-export
//
// The compiled executable carries the web app in `web/` beside it (see apps/api/tooling/build-service.ts);
// run from source it uses the build in apps/web/dist.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DataDirectoryError, resolveDataPaths } from "./data-directory.ts";
import { startInstalledService } from "./installed.ts";
import { createLogger } from "./log.ts";
import { runTool } from "./tool.ts";
import { VERSION } from "./version.ts";

const USAGE = `rastrata-service ${VERSION}: the Rastrata service, for one person on one computer.

  rastrata-service [serve]     run the service (the login item runs this)
  rastrata-service version     print the release
  rastrata-service paths       print where your data is kept, as JSON
  rastrata-service tool ...    offline tool: restore, import-export, check-export

Normally you do not run this yourself: 'rastrata start', 'rastrata stop' and 'rastrata status'
manage it. Settings: RASTRATA_DATA_DIR (where your data is kept), RASTRATA_API_PORT.`;

/** The EX_CONFIG exit status: the setup is wrong and running again will not fix it by itself. */
const CONFIGURATION_ERROR = 78;

async function serve(): Promise<void> {
  const embedded = resolve(import.meta.dir, "web");
  const webDirectory = existsSync(embedded) ? embedded : resolve(import.meta.dir, "../../web/dist");
  let service: Awaited<ReturnType<typeof startInstalledService>>;
  try {
    service = await startInstalledService({ webDirectory });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Rastrata could not start: ${message}`);
    try {
      createLogger({ file: resolveDataPaths().serviceLog, echo: false }).error(
        "Could not start",
        error,
      );
    } catch {
      // The data directory is what is wrong; the message above is all there is.
    }
    process.exit(error instanceof DataDirectoryError ? CONFIGURATION_ERROR : 1);
  }
  console.info(`Rastrata ${VERSION} is running at ${service.url}`);
  let ending = false;
  const end = (code: number) => {
    if (ending) return;
    ending = true;
    void service.stop().then(
      () => process.exit(code),
      () => process.exit(1),
    );
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => end(0));
  // Anything unexpected ends the process with a failure status, so that the login item restarts it.
  const fatal = (error: unknown) => {
    try {
      createLogger({ file: service.paths.serviceLog, echo: false }).error(
        "Unexpected failure",
        error,
      );
    } catch {
      // Nothing more can be done.
    }
    process.exit(1);
  };
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
}

const [command = "serve", ...rest] = process.argv.slice(2);
switch (command) {
  case "serve":
    await serve();
    break;
  case "version":
  case "--version":
  case "-v":
    console.info(VERSION);
    break;
  case "paths":
    try {
      console.info(JSON.stringify(resolveDataPaths(), null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(CONFIGURATION_ERROR);
    }
    break;
  case "tool":
    await runTool(rest);
    break;
  case "help":
  case "--help":
  case "-h":
    console.info(USAGE);
    break;
  default:
    console.error(`Unknown command "${command}".\n\n${USAGE}`);
    process.exit(2);
}
