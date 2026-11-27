import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, oneLine } from "../src/log.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});
const folder = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-log-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};

test("a line per event, with the time and the level, private to the user", () => {
  const file = join(folder(), "service.log");
  const log = createLogger({ file, echo: false, now: () => new Date("2026-10-04T12:00:00.000Z") });
  log.info("Starting");
  log.warn("Careful");
  log.error("Broke", new Error("disk full"));
  const lines = readFileSync(file, "utf8").split("\n");
  expect(lines[0]).toBe("2026-10-04T12:00:00.000Z info Starting");
  expect(lines[1]).toBe("2026-10-04T12:00:00.000Z warn Careful");
  expect(lines[2]).toBe("2026-10-04T12:00:00.000Z error Broke: disk full");
  expect(lines[3]).toMatch(/^ {2}at /);
  expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
});

test("text that came from outside cannot start a new line or move a terminal", () => {
  const file = join(folder(), "service.log");
  const log = createLogger({ file, echo: false });
  const separator = String.fromCharCode(0x2028);
  const hostile = `memo\n2026-10-04T00:00:00.000Z error forged\u001b[2J\u001b]0;title\u0007\r${separator}end`;
  log.info(`Imported ${hostile}`);
  log.error("Failed", new Error(hostile));
  const text = readFileSync(file, "utf8");
  // Two events, two lines (the second has its stack frames after it), and no control character.
  const events = text
    .split("\n")
    .filter((line) => /^\d{4}-\d\d-\d\dT[\d:.]+Z (info|warn|error) /.test(line));
  expect(events).toHaveLength(2);
  expect(events[0]).toContain("memo 2026-10-04T00:00:00.000Z error forged");
  expect(text).not.toMatch(/forged\n/);
  const controls = [...text.replaceAll("\n", "")].filter((character) => {
    const code = character.codePointAt(0) as number;
    return code < 32 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
  });
  expect(controls).toEqual([]);
  expect(oneLine("a\tb\r\nc")).toBe("a b c");
});

test("the log rotates by size and keeps a few files", () => {
  const directory = folder();
  const file = join(directory, "service.log");
  const log = createLogger({ file, echo: false, maxBytes: 200, keep: 2 });
  for (let index = 0; index < 40; index++) log.info(`event number ${index} with some padding text`);
  expect(existsSync(file)).toBe(true);
  expect(existsSync(`${file}.1`)).toBe(true);
  expect(existsSync(`${file}.2`)).toBe(true);
  expect(existsSync(`${file}.3`)).toBe(false);
  // The newest events are in the live file; the oldest are gone.
  expect(readFileSync(file, "utf8")).toContain("event number 39");
  const everything = [file, `${file}.1`, `${file}.2`]
    .map((path) => readFileSync(path, "utf8"))
    .join("");
  expect(everything).not.toContain("event number 0 ");
});

test("a log that cannot be written never stops the service", () => {
  const log = createLogger({
    file: join(tmpdir(), "rastrata-no-such-folder", "x", "service.log"),
    echo: false,
  });
  expect(() => log.info("still running")).not.toThrow();
  expect(() => log.error("still running", new Error("boom"))).not.toThrow();
});
