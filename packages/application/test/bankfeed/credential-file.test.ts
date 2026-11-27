import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCredentialProblem } from "../../src/bankfeed/credentials.ts";
import {
  localCredentialStore,
  localSimplefinStandIn,
} from "../../src/local/simplefin-credential.ts";
import { FIXTURE_PASSWORD, fakeBridge } from "./fake-bridge.ts";

const URL_TEXT = fakeBridge().accessUrl();
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

function folder(): string {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-credential-"));
  cleanup.push(() => {
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Already gone.
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

const modeOf = (path: string): number => statSync(path).mode & 0o777;

test("nothing there is nothing, not an error", () => {
  expect(localCredentialStore(folder()).read()).toBeNull();
});

test("the access URL is written private, replaced atomically, and read back", () => {
  const dir = folder();
  const store = localCredentialStore(dir);
  store.write(URL_TEXT);
  const path = join(dir, "simplefin.access");
  expect(modeOf(path)).toBe(0o600);
  expect(readFileSync(path, "utf8")).toBe(`${URL_TEXT}\n`);
  expect(store.read()).toEqual({ accessUrl: URL_TEXT });
  // Replacing it leaves no partial file behind and keeps the mode.
  store.write(`${URL_TEXT}x`);
  expect(store.read()).toEqual({ accessUrl: `${URL_TEXT}x` });
  expect(modeOf(path)).toBe(0o600);
  expect(readdirSync(dir)).toEqual(["simplefin.access"]);
});

test("a process umask cannot make the file readable by anyone else", () => {
  const dir = folder();
  const before = process.umask(0);
  try {
    localCredentialStore(dir).write(URL_TEXT);
  } finally {
    process.umask(before);
  }
  expect(modeOf(join(dir, "simplefin.access"))).toBe(0o600);
});

test("a file other users can read is refused with the command that fixes it, and its contents are not repeated", () => {
  for (const mode of [0o644, 0o640, 0o604, 0o660, 0o666]) {
    const dir = folder();
    const path = join(dir, "simplefin.access");
    writeFileSync(path, `${URL_TEXT}\n`);
    chmodSync(path, mode);
    const result = localCredentialStore(dir).read();
    expect(isCredentialProblem(result), mode.toString(8)).toBe(true);
    if (isCredentialProblem(result)) {
      expect(result.problem).toContain(`chmod 600 ${path}`);
      expect(result.problem).not.toContain(FIXTURE_PASSWORD);
    }
    // Fixing it makes it usable.
    chmodSync(path, 0o600);
    expect(localCredentialStore(dir).read()).toEqual({ accessUrl: URL_TEXT });
  }
});

test("a link, a directory, an empty file or a huge file is not an access URL", () => {
  const dir = folder();
  const path = join(dir, "simplefin.access");
  // A link, even to a perfectly good private file.
  const target = join(dir, "target.txt");
  writeFileSync(target, `${URL_TEXT}\n`, { mode: 0o600 });
  symlinkSync(target, path);
  let result = localCredentialStore(dir).read();
  expect(isCredentialProblem(result) && result.problem).toContain("not a link");
  rmSync(path);
  // A directory.
  mkdirSync(path);
  result = localCredentialStore(dir).read();
  expect(isCredentialProblem(result) && result.problem).toContain("regular file");
  rmSync(path, { recursive: true });
  // Empty.
  writeFileSync(path, "", { mode: 0o600 });
  result = localCredentialStore(dir).read();
  expect(isCredentialProblem(result) && result.problem).toContain("empty");
  // Too large to be one.
  writeFileSync(path, "x".repeat(3000), { mode: 0o600 });
  result = localCredentialStore(dir).read();
  expect(isCredentialProblem(result) && result.problem).toContain("too large");
});

test("the place is proven writable before a token that works once is spent, and a probe leaves nothing", () => {
  const dir = folder();
  const store = localCredentialStore(dir);
  expect(store.probe()).toBeNull();
  expect(readdirSync(dir)).toEqual([]);
  // A folder that cannot be written to is said so, in words, with no credential in the message.
  chmodSync(dir, 0o500);
  const problem = store.probe();
  expect(problem).toContain("cannot write");
  expect(problem).toContain("Nothing was claimed");
  chmodSync(dir, 0o700);
  expect(readdirSync(dir)).toEqual([]);
  // Not a folder at all.
  const file = join(dir, "plain-file");
  writeFileSync(file, "x");
  expect(localCredentialStore(file).probe()).toContain("not a folder");
});

test("removing is idempotent and only touches its own file", () => {
  const dir = folder();
  const store = localCredentialStore(dir);
  writeFileSync(join(dir, "other.txt"), "keep");
  store.write(URL_TEXT);
  store.remove();
  store.remove();
  expect(store.read()).toBeNull();
  expect(readdirSync(dir)).toEqual(["other.txt"]);
});

test("a stand-in Bridge is named by its one address, and the access URL can never be pointed elsewhere", () => {
  const name = (value: string) => ({ RASTRATA_SIMPLEFIN_STANDIN: value });
  expect(localSimplefinStandIn({})).toBeUndefined();
  expect(localSimplefinStandIn(name("  "))).toBeUndefined();
  expect(localSimplefinStandIn(name("http://127.0.0.1:20240"))).toBe("http://127.0.0.1:20240");
  expect(localSimplefinStandIn(name("http://localhost:20240/"))).toBe("http://localhost:20240");
  expect(localSimplefinStandIn(name("http://[::1]:20240"))).toBe("http://[::1]:20240");
  for (const bad of [
    "https://beta-bridge.simplefin.org",
    "https://127.0.0.1:20240",
    "http://example.com",
    "http://127.0.0.1.example.com",
    "http://user:secret@127.0.0.1:20240",
    "http://127.0.0.1:20240/simplefin",
    "http://127.0.0.1:20240/?x=1",
    "ftp://127.0.0.1",
    "not a url",
  ]) {
    let message = "";
    try {
      localSimplefinStandIn(name(bad));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message, bad).toContain("must be an http address on this machine");
    // The refusal never repeats what was given, which could carry a credential.
    expect(message).not.toContain("secret");
  }
});
