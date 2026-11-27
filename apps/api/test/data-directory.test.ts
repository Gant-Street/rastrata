import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DataDirectoryError,
  DEFAULT_PORT,
  parsePort,
  parseSettings,
  prepareDataDirectory,
  readSettings,
  resolveDataPaths,
  resolvePort,
} from "../src/data-directory.ts";
import { LocalBookService } from "@rastrata/application/local";

const vectors = JSON.parse(
  readFileSync(join(import.meta.dir, "data-directory.vectors.json"), "utf8"),
) as { cases: VectorCase[] };

interface VectorCase {
  name: string;
  platform: string;
  home: string;
  env: Record<string, string>;
  settings?: { port?: number; backupDir?: string };
  expect?: Record<string, string>;
  error?: string;
  expectPort?: number;
  portError?: string;
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});
const scratch = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-data-directory-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const modeOf = (path: string): string => (statSync(path).mode & 0o777).toString(8);

for (const item of vectors.cases) {
  test(`data directory: ${item.name}`, () => {
    const resolve = () =>
      resolveDataPaths({
        env: item.env,
        platform: item.platform,
        home: item.home,
        ...(item.settings ? { settings: item.settings } : {}),
      });
    if (item.error) {
      expect(resolve).toThrow(DataDirectoryError);
      expect(resolve).toThrow(item.error);
      return;
    }
    const paths = resolve() as unknown as Record<string, string>;
    for (const [field, value] of Object.entries(item.expect ?? {}))
      expect(paths[field]).toBe(value);
    if (item.portError) {
      expect(() => resolvePort(item.env, item.settings)).toThrow(DataDirectoryError);
      expect(() => resolvePort(item.env, item.settings)).toThrow(item.portError);
    } else if (item.expectPort !== undefined) {
      expect(resolvePort(item.env, item.settings)).toBe(item.expectPort);
    }
  });
}

test("the real environment decides when none is given: HOME and the platform", () => {
  const home = scratch();
  const paths = resolveDataPaths({ env: { HOME: home } });
  expect(paths.directory).toBe(
    process.platform === "darwin"
      ? join(home, "Library", "Application Support", "Rastrata")
      : join(home, ".local", "share", "rastrata"),
  );
});

test("the safety code's own default backup folder is the one reported here", async () => {
  // The service names its backup folder after the database file; this function must say the same, or
  // `doctor` would look in the wrong place.
  const directory = scratch();
  const paths = resolveDataPaths({
    env: { RASTRATA_DATA_DIR: directory },
    platform: "linux",
    home: "/home/ada",
  });
  const service = await LocalBookService.open(paths.database);
  try {
    const folders = service.host.safety?.directories;
    expect(folders?.backups).toBe(paths.backups);
    expect(folders?.exports).toBe(paths.exports);
  } finally {
    service.close();
  }
});

test("preparing the directory makes it private, with a log folder, and changes nothing that exists", () => {
  const home = scratch();
  const paths = resolveDataPaths({ env: { HOME: home }, platform: "linux" });
  const first = prepareDataDirectory(paths);
  expect(first).toEqual({ created: true, warnings: [] });
  expect(modeOf(paths.directory)).toBe("700");
  expect(modeOf(paths.logs)).toBe("700");

  // A second start finds it and says nothing.
  expect(prepareDataDirectory(paths)).toEqual({ created: false, warnings: [] });

  // A directory the person made readable is reported, with the command, and left alone.
  chmodSync(paths.directory, 0o755);
  const open = prepareDataDirectory(paths);
  expect(open.created).toBe(false);
  expect(open.warnings).toHaveLength(1);
  expect(open.warnings[0]).toContain("can be read by other users");
  expect(open.warnings[0]).toContain(`chmod 700 '${paths.directory}'`);
  expect(modeOf(paths.directory)).toBe("755");
});

test("a file where the directory should be is refused with a way out", () => {
  const home = scratch();
  const file = join(home, "in-the-way");
  writeFileSync(file, "x");
  const paths = resolveDataPaths({ env: { RASTRATA_DATA_DIR: file }, platform: "linux", home });
  expect(() => prepareDataDirectory(paths)).toThrow(DataDirectoryError);
  expect(() => prepareDataDirectory(paths)).toThrow("RASTRATA_DATA_DIR");
});

test("a directory that cannot be made says where to choose another", () => {
  const home = scratch();
  const locked = join(home, "locked");
  mkdirSync(locked, { mode: 0o500 });
  const paths = resolveDataPaths({
    env: { RASTRATA_DATA_DIR: join(locked, "inside") },
    platform: "linux",
    home,
  });
  // Running as root can write anywhere; the check only means something for everyone else.
  if (process.getuid?.() === 0) return;
  expect(() => prepareDataDirectory(paths)).toThrow("Choose another place with RASTRATA_DATA_DIR");
  chmodSync(locked, 0o700);
});

test("the port: a number from 1 to 65535, or 0 for the system to choose", () => {
  expect(parsePort("7278", "RASTRATA_API_PORT")).toBe(7278);
  expect(parsePort("0", "RASTRATA_API_PORT")).toBe(0);
  expect(parsePort("65535", "RASTRATA_API_PORT")).toBe(65535);
  for (const bad of ["", "-1", "65536", "70000", "72x8", "7278.5", " 7278", "1e3", "0x10"])
    expect(() => parsePort(bad, "RASTRATA_API_PORT")).toThrow("RASTRATA_API_PORT");
  expect(DEFAULT_PORT).toBe(7278);
});

test("the settings file is read from disk: no file is no settings, and a bad one names itself", () => {
  const directory = scratch();
  const path = join(directory, "config.json");
  expect(readSettings(path)).toEqual({});
  writeFileSync(path, JSON.stringify({ port: 7301, backupDir: "/Volumes/Backup//rastrata/" }));
  expect(readSettings(path)).toEqual({ port: 7301, backupDir: "/Volumes/Backup/rastrata" });
  writeFileSync(path, "port = 7301");
  expect(() => readSettings(path)).toThrow(path);
  // A directory where the file should be cannot be read as settings either.
  const folder = join(directory, "folder");
  mkdirSync(folder);
  expect(() => readSettings(folder)).toThrow("Cannot read");
});

test("the settings file holds the port and the backup folder, and nothing else matters to the service", () => {
  expect(parseSettings("{}", "c.json")).toEqual({});
  expect(parseSettings('{"port": 7300, "future": true}', "c.json")).toEqual({ port: 7300 });
  expect(parseSettings('{"backupDir": "/b//c/"}', "c.json")).toEqual({ backupDir: "/b/c" });
  for (const bad of [
    "not json",
    "[]",
    "null",
    '{"port": "7300"}',
    '{"port": 0}',
    '{"port": 70000}',
    '{"port": 1.5}',
    '{"backupDir": "relative"}',
    '{"backupDir": 5}',
  ])
    expect(() => parseSettings(bad, "/data/config.json")).toThrow("/data/config.json");
});
