/** Where an installed Rastrata keeps everything that belongs to one person: the book, its backups,
 * the owner key and the logs. One function decides, from the environment and the platform, so the
 * service, the offline tool and the command line (which has the same function in Go, checked against
 * the same test vectors) always agree.
 *
 *   macOS   ~/Library/Application Support/Rastrata
 *   Linux   $XDG_DATA_HOME/rastrata, else ~/.local/share/rastrata
 *
 * Every part can be moved with an environment variable, and the whole directory with
 * RASTRATA_DATA_DIR. An override must be an absolute path: a service started at login does not run in
 * a directory a relative path could mean anything in. The code in this file touches no file; see
 * `prepareDataDirectory` for the part that does. */
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

/** The port the installed service listens on unless told otherwise. It is not 4010, the development
 * API's port, so a developer's checkout and a real book can run side by side and a command line
 * built for one never talks to the other by accident. On a phone keypad it spells RAST. */
export const DEFAULT_PORT = 7278;

type Environment = Readonly<Record<string, string | undefined>>;

/** A problem with the configuration that a person can fix: it says what to change. */
export class DataDirectoryError extends Error {}

export interface DataPaths {
  /** The per-user data directory. */
  readonly directory: string;
  /** The book: one SQLite file (and its write-ahead files). RASTRATA_LOCAL_DB. */
  readonly database: string;
  /** Where automatic and manual backups are kept. RASTRATA_BACKUP_DIR. */
  readonly backups: string;
  /** Where open exports are written. RASTRATA_EXPORT_DIR. */
  readonly exports: string;
  /** The owner key: a file only its owner can read. RASTRATA_OWNER_KEY_FILE. */
  readonly ownerKey: string;
  /** The folder of log files. RASTRATA_LOG_DIR. */
  readonly logs: string;
  /** The service's own log. */
  readonly serviceLog: string;
  /** What the process wrote to its standard output and error, before or outside its own log. */
  readonly stdioLog: string;
  /** The service's settings (the port). */
  readonly config: string;
}

export interface ResolveOptions {
  readonly env?: Environment;
  /** The settings file's contents, when it has been read. */
  readonly settings?: ServiceSettings;
  /** `process.platform` unless a test says otherwise. */
  readonly platform?: string;
  /** The home directory; taken from HOME, then the operating system, when not given. */
  readonly home?: string;
}

/** The value of an environment variable, or undefined when it is missing or blank. */
const given = (env: Environment, name: string): string | undefined => {
  const value = env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
};

function absolutePath(name: string, value: string): string {
  if (!isAbsolute(value))
    throw new DataDirectoryError(
      `${name} must be an absolute path, and "${value}" is not. Write the whole path, for example /Users/you/Books.`,
    );
  return resolve(value);
}

const override = (env: Environment, name: string): string | undefined => {
  const value = given(env, name);
  return value === undefined ? undefined : absolutePath(name, value);
};

function homeDirectory(env: Environment, explicit: string | undefined): string {
  const candidate = explicit ?? given(env, "HOME") ?? homedir();
  if (!candidate || !isAbsolute(candidate))
    throw new DataDirectoryError(
      "Cannot tell where your home directory is. Set HOME, or set RASTRATA_DATA_DIR to an absolute path.",
    );
  return resolve(candidate);
}

function dataDirectory(env: Environment, platform: string, explicitHome: string | undefined) {
  const chosen = override(env, "RASTRATA_DATA_DIR");
  if (chosen !== undefined) return chosen;
  const home = homeDirectory(env, explicitHome);
  if (platform === "darwin") return join(home, "Library", "Application Support", "Rastrata");
  // The XDG rule: a relative XDG_DATA_HOME is invalid and is ignored.
  const xdg = given(env, "XDG_DATA_HOME");
  return join(
    xdg !== undefined && isAbsolute(xdg) ? resolve(xdg) : join(home, ".local", "share"),
    "rastrata",
  );
}

/** Every path the installed service uses. Pure: it reads no file and creates nothing. `settings` is
 * the service's settings file when there is one (see `readSettings`): its backup folder is used
 * unless the environment names one. */
export function resolveDataPaths(options: ResolveOptions = {}): DataPaths {
  const env = options.env ?? process.env;
  const directory = dataDirectory(env, options.platform ?? process.platform, options.home);
  const database = override(env, "RASTRATA_LOCAL_DB") ?? join(directory, "book.sqlite");
  // The safety code names its default folders after the database file, so a book kept somewhere
  // else brings its backups along (backups/<name>/ beside it).
  const book = basename(database, extname(database)) || "book";
  const logs = override(env, "RASTRATA_LOG_DIR") ?? join(directory, "logs");
  return {
    directory,
    database,
    backups:
      override(env, "RASTRATA_BACKUP_DIR") ??
      options.settings?.backupDir ??
      join(dirname(database), "backups", book),
    exports: override(env, "RASTRATA_EXPORT_DIR") ?? join(dirname(database), "exports", book),
    ownerKey: override(env, "RASTRATA_OWNER_KEY_FILE") ?? join(directory, "owner.key"),
    logs,
    serviceLog: join(logs, "service.log"),
    stdioLog: join(logs, "service-stdio.log"),
    config: join(directory, "config.json"),
  };
}

/** What `prepareDataDirectory` found worth telling the person. */
export interface PreparedDirectory {
  readonly created: boolean;
  readonly warnings: readonly string[];
}

const mode = (path: string): number => statSync(path).mode & 0o777;

/** Make sure the data directory and the log folder exist, private to the user (mode 0700, as the XDG
 * rules ask). An existing directory is never changed: if other users can read it, that is reported
 * and left for its owner to decide. */
export function prepareDataDirectory(paths: DataPaths): PreparedDirectory {
  const warnings: string[] = [];
  let created = false;
  for (const folder of [paths.directory, paths.logs]) {
    let existed = true;
    try {
      statSync(folder);
    } catch {
      existed = false;
    }
    try {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new DataDirectoryError(
        `Cannot create ${folder}: ${(error as NodeJS.ErrnoException).code ?? "an error"}. Choose another place with RASTRATA_DATA_DIR.`,
      );
    }
    if (!statSync(folder).isDirectory())
      throw new DataDirectoryError(
        `${folder} is not a directory. Move it aside, or choose another place with RASTRATA_DATA_DIR.`,
      );
    if (folder === paths.directory && !existed) created = true;
    const bits = mode(folder);
    if ((bits & 0o077) !== 0)
      warnings.push(
        `${folder} can be read by other users (mode ${bits.toString(8).padStart(4, "0")}). Your books are in it; make it private with: chmod 700 '${folder}'`,
      );
  }
  return { created, warnings };
}

/** The settings file, config.json in the data directory: the port, and a backup folder somewhere
 * else (`rastrata install --port`, `rastrata backup folder` write them). A missing file means the
 * defaults; a key this version does not know is ignored, so a newer file can still be read. */
export interface ServiceSettings {
  readonly port?: number;
  readonly backupDir?: string;
}

export function parsePort(value: string, source: string): number {
  if (!/^[0-9]{1,5}$/.test(value) || Number(value) > 65535)
    throw new DataDirectoryError(
      `${source} must be a port number from 1 to 65535 (or 0 to let the system choose).`,
    );
  return Number(value);
}

/** The port the service listens on: RASTRATA_API_PORT, else the settings file, else the default. */
export function resolvePort(env: Environment, settings: ServiceSettings = {}): number {
  const fromEnvironment = env.RASTRATA_API_PORT?.trim();
  if (fromEnvironment) return parsePort(fromEnvironment, "RASTRATA_API_PORT");
  return settings.port ?? DEFAULT_PORT;
}

export function parseSettings(text: string, path: string): ServiceSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DataDirectoryError(
      `${path} is not valid JSON. Delete it to use the defaults, or write {"port": ${DEFAULT_PORT}}.`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new DataDirectoryError(
      `${path} must hold one JSON object, for example {"port": ${DEFAULT_PORT}}.`,
    );
  const { port, backupDir } = raw as { port?: unknown; backupDir?: unknown };
  const settings: { port?: number; backupDir?: string } = {};
  if (port !== undefined) {
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new DataDirectoryError(`The port in ${path} must be a whole number from 1 to 65535.`);
    settings.port = port;
  }
  if (backupDir !== undefined) {
    if (typeof backupDir !== "string" || !isAbsolute(backupDir))
      throw new DataDirectoryError(`backupDir in ${path} must be an absolute path.`);
    settings.backupDir = resolve(backupDir);
  }
  return settings;
}

/** Read the settings file; no file is no settings. */
export function readSettings(path: string): ServiceSettings {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new DataDirectoryError(
      `Cannot read ${path}: ${(error as NodeJS.ErrnoException).code ?? "an error"}.`,
    );
  }
  return parseSettings(text, path);
}
