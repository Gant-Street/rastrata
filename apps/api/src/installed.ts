/** The installed service: what runs when someone installs Rastrata instead of cloning the repository.
 * One process, for one person on one computer, that serves
 *
 *   /v1 and /api   the application (the same ApplicationHttp the development API uses),
 *   /health        whether it is up, which release, and whether it is still reading the book,
 *   everything else  the web app (see web.ts),
 *
 * on 127.0.0.1 only, with the book, its backups, the owner key and the log in the per-user data
 * directory (see data-directory.ts). It differs from the development API (main.ts) in its defaults,
 * which are the safe ones: the owner lock is ON (the key is made on first run), automatic backups
 * are ON, and nothing listens beyond this computer. */
import { loadOrCreateOwnerKey } from "@rastrata/application/agent/local";
import { chmodSync, statSync } from "node:fs";
import {
  type DataPaths,
  DataDirectoryError,
  prepareDataDirectory,
  readSettings,
  resolveDataPaths,
  resolvePort,
  type ResolveOptions,
} from "./data-directory.ts";
import { createLogger, type Logger } from "./log.ts";
import { startLocalApplicationServer } from "./server.ts";
import { VERSION } from "./version.ts";
import { loadWebApp } from "./web.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export interface InstalledOptions {
  readonly env?: Environment;
  readonly platform?: string;
  readonly home?: string;
  /** The built web app. */
  readonly webDirectory: string;
  /** Replaces the log file, for tests. */
  readonly logger?: Logger;
}

export interface InstalledService {
  readonly url: string;
  readonly port: number;
  readonly paths: DataPaths;
  stop(): Promise<void>;
}

/** The owner key, made on the first run. A key file other users can read is refused, and the
 * message says how to fix it; the key itself is never in a message. */
function ownerKeyFor(path: string): string {
  try {
    return loadOrCreateOwnerKey(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("must be private")) {
      const bits = (statSync(path).mode & 0o777).toString(8).padStart(4, "0");
      throw new DataDirectoryError(
        `The owner key file ${path} can be read by other users (mode ${bits}), so the lock would protect nothing. Make it private with: chmod 600 '${path}'`,
      );
    }
    throw new DataDirectoryError(
      `${message}. If you do not recognise ${path}, move it aside and the service will make a new owner key.`,
    );
  }
}

/** Refuse before touching the book if something already listens on the port: a second copy of the
 * service, or another program. Opening the database of a service that is running would be the
 * worse way to find out. */
async function requireFreePort(port: number): Promise<void> {
  if (port === 0) return;
  try {
    Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
  } catch {
    throw new DataDirectoryError(
      `Port ${port} is already in use: another copy of Rastrata or another program is listening there. Run 'rastrata status' to see whether Rastrata is already running, or choose another port with 'rastrata install --port N' (or RASTRATA_API_PORT).`,
    );
  }
}

/** The book, its write-ahead files and the file the process's own output goes to are private to the
 * user even where the directory around them is not: SQLite makes the book readable by everyone
 * unless told otherwise, and the login item opens the output file with its own permissions. */
function keepPrivate(paths: DataPaths): void {
  const { database, stdioLog } = paths;
  for (const file of [database, `${database}-wal`, `${database}-shm`, stdioLog])
    try {
      if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
    } catch {
      // Not there yet: the umask below makes it private when it is created.
    }
}

/** Start the service. Everything this process creates (the book, its backups, exports and logs) is
 * for its user only, so the umask is 077 from here until the service stops. */
export async function startInstalledService(options: InstalledOptions): Promise<InstalledService> {
  const previousUmask = process.umask(0o077);
  try {
    return await begin(options, () => process.umask(previousUmask));
  } catch (error) {
    process.umask(previousUmask);
    throw error;
  }
}

async function begin(options: InstalledOptions, restore: () => void): Promise<InstalledService> {
  const env = options.env ?? process.env;
  const place: ResolveOptions = {
    env,
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.home ? { home: options.home } : {}),
  };
  // The settings file lives in the data directory, so the directory is found first, then the file
  // read, then every path worked out again with it (a backup folder moved elsewhere).
  const settings = readSettings(resolveDataPaths(place).config);
  const paths = resolveDataPaths({ ...place, settings });
  const prepared = prepareDataDirectory(paths);
  keepPrivate(paths);
  const log = options.logger ?? createLogger({ file: paths.serviceLog });
  log.info(`Starting Rastrata ${VERSION}`);
  for (const warning of prepared.warnings) log.warn(warning);

  const ownerKey = ownerKeyFor(paths.ownerKey);
  const port = resolvePort(env, settings);
  await requireFreePort(port);
  const web = await loadWebApp(options.webDirectory);
  if (!web)
    log.warn(
      `There is no web app in ${options.webDirectory}: only the API is served. Build it with: bun run --cwd apps/web build`,
    );
  const backups = env.RASTRATA_BACKUPS !== "off";
  if (!backups) log.warn("Automatic backups are turned off by RASTRATA_BACKUPS=off.");

  const application = await startLocalApplicationServer({
    path: paths.database,
    port,
    ownerKey,
    backups,
    // The daily bank feed sync stays off until the owner turns it on (bankfeed.settings).
    bankfeed: env.RASTRATA_BANKFEED !== "off",
    web,
    health: { service: "rastrata", version: VERSION },
    safety: { backupDirectory: paths.backups, exportDirectory: paths.exports },
    // The first read of a big book takes a while: do it now, while nobody is waiting (see warmup.ts).
    warmUp: { logger: log },
  });
  const url = `http://127.0.0.1:${application.server.port}/`;
  log.info(`Listening on ${url} (this computer only)`);
  log.info(`Data directory ${paths.directory}; the book is ${paths.database}`);
  log.info(`Owner lock: on. The owner key is in ${paths.ownerKey}`);
  log.info(
    backups ? `Backups: automatic, kept in ${paths.backups}` : "Backups: automatic backups are off",
  );
  if (web) log.info(`Web app: ${web.files} files from ${options.webDirectory}`);

  let stopping: Promise<void> | null = null;
  return {
    url,
    port: application.server.port as number,
    paths,
    stop() {
      stopping ??= (async () => {
        log.info("Stopping: taking a last backup and closing the book");
        try {
          await application.stop();
          log.info("Stopped");
        } catch (error) {
          log.error("Stopping failed", error);
          throw error;
        } finally {
          restore();
        }
      })();
      return stopping;
    },
  };
}
