import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localStripeApiUrl, localStripeKeySource } from "../../src/local/stripe-key.ts";
import {
  describeKey,
  environmentKeySource,
  firstKeySource,
  inspectKey,
  isKeyProblem,
} from "../../src/stripe/credentials.ts";
import { fakeKey } from "./fixtures.ts";

const KEY = fakeKey("FILEKEY");
const TEST_KEY = ["sk", "test", "ENVKEYisNotRealAtAll0000"].join("_");
const directories: string[] = [];
const folder = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-key-"));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});

const write = (directory: string, text: string, mode = 0o600): string => {
  const path = join(directory, "stripe.key");
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
  return path;
};

test("a key in the private file is found, described and never shown", () => {
  const dir = folder();
  write(dir, `${KEY}\n`);
  const source = localStripeKeySource(dir, {});
  const read = source.read();
  expect(read).toEqual({ key: KEY, source: "file" });
  const described = describeKey(source);
  expect(described).toEqual({
    present: true,
    source: "file",
    mode: "live",
    restricted: true,
    problem: null,
    warning: null,
  });
  expect(JSON.stringify(described)).not.toContain(KEY);
});

test("the environment wins over the file, and an unrestricted key carries a warning", () => {
  const dir = folder();
  write(dir, KEY);
  const source = localStripeKeySource(dir, { RASTRATA_STRIPE_KEY: TEST_KEY });
  expect(source.read()).toEqual({ key: TEST_KEY, source: "environment" });
  const described = describeKey(source);
  expect(described).toMatchObject({
    present: true,
    source: "environment",
    mode: "test",
    restricted: false,
  });
  expect(described.warning).toMatch(/restricted read-only key/);
  expect(JSON.stringify(described)).not.toContain(TEST_KEY);
  // An empty variable is as good as none.
  expect(localStripeKeySource(dir, { RASTRATA_STRIPE_KEY: "  " }).read()).toEqual({
    key: KEY,
    source: "file",
  });
});

test("nothing configured is not a problem, just absent", () => {
  const source = localStripeKeySource(folder(), {});
  expect(source.read()).toBeNull();
  expect(describeKey(source)).toEqual({
    present: false,
    source: null,
    mode: null,
    restricted: null,
    problem: null,
    warning: null,
  });
});

test("a key file other users can read is refused with the command that fixes it, and is never used", () => {
  const dir = folder();
  const path = write(dir, KEY, 0o644);
  const result = localStripeKeySource(dir, {}).read();
  expect(isKeyProblem(result)).toBe(true);
  const message = isKeyProblem(result) ? result.problem : "";
  expect(message).toContain(`chmod 600 ${path}`);
  expect(message).not.toContain(KEY);
  expect(describeKey(localStripeKeySource(dir, {})).present).toBe(false);
  chmodSync(path, 0o640);
  expect(isKeyProblem(localStripeKeySource(dir, {}).read())).toBe(true);
  chmodSync(path, 0o600);
  expect(localStripeKeySource(dir, {}).read()).toEqual({ key: KEY, source: "file" });
});

test("a link, a directory or an oversized file is not a key file", () => {
  const link = folder();
  const target = join(link, "elsewhere");
  writeFileSync(target, KEY, { mode: 0o600 });
  symlinkSync(target, join(link, "stripe.key"));
  expect(isKeyProblem(localStripeKeySource(link, {}).read())).toBe(true);
  const directory = folder();
  mkdirSync(join(directory, "stripe.key"));
  expect(isKeyProblem(localStripeKeySource(directory, {}).read())).toBe(true);
  const big = folder();
  write(big, "x".repeat(4000));
  expect(isKeyProblem(localStripeKeySource(big, {}).read())).toBe(true);
});

test("anything that is not a Stripe key is rejected without being repeated", () => {
  const dir = folder();
  const secret = "hunter2-this-is-not-a-stripe-key-but-private";
  write(dir, secret);
  const result = localStripeKeySource(dir, {}).read();
  expect(isKeyProblem(result)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(secret);
  for (const bad of [
    "",
    "   ",
    "sk_live_short",
    `${"pk_"}live_PUBLISHABLEkeyIsNotAllowed000`,
    `${"rk_"}prod_ABCDEFGHIJKLMNOPQRSTUV`,
  ]) {
    const inspected = inspectKey(bad, "environment");
    expect(isKeyProblem(inspected)).toBe(true);
    if (bad.length > 4) expect(JSON.stringify(inspected)).not.toContain(bad);
  }
});

test("a key source that throws is described as a problem, not a crash", () => {
  const described = describeKey({
    read() {
      throw new Error(`boom ${KEY}`);
    },
  });
  expect(described.present).toBe(false);
  expect(described.problem).toBe("The Stripe key could not be read.");
  expect(JSON.stringify(described)).not.toContain(KEY);
});

test("sources are tried in order, and a broken one is reported rather than skipped", () => {
  const dir = folder();
  write(dir, KEY, 0o644);
  const first = firstKeySource(
    localStripeKeySource(dir, {}),
    environmentKeySource({ RASTRATA_STRIPE_KEY: TEST_KEY }),
  );
  expect(isKeyProblem(first.read())).toBe(true);
  const empty = firstKeySource(
    environmentKeySource({}),
    environmentKeySource({ RASTRATA_STRIPE_KEY: TEST_KEY }),
  );
  expect(empty.read()).toEqual({ key: TEST_KEY, source: "environment" });
  expect(environmentKeySource(undefined).read()).toBeNull();
});

test("Stripe is reached at its own address unless a loopback stand-in is named, and the key can never be pointed elsewhere", () => {
  expect(localStripeApiUrl({})).toBeUndefined();
  expect(localStripeApiUrl({ RASTRATA_STRIPE_API_URL: "  " })).toBeUndefined();
  expect(localStripeApiUrl({ RASTRATA_STRIPE_API_URL: "http://127.0.0.1:5842" })).toBe(
    "http://127.0.0.1:5842",
  );
  expect(localStripeApiUrl({ RASTRATA_STRIPE_API_URL: "http://localhost:5842/" })).toBe(
    "http://localhost:5842",
  );
  expect(localStripeApiUrl({ RASTRATA_STRIPE_API_URL: "http://[::1]:5842" })).toBe(
    "http://[::1]:5842",
  );
  for (const bad of [
    "https://api.stripe.com",
    "https://127.0.0.1:5842",
    "http://example.com",
    "http://127.0.0.1.example.com",
    "http://user:secret@127.0.0.1:5842",
    "http://127.0.0.1:5842/v1",
    "http://127.0.0.1:5842/?x=1",
    "ftp://127.0.0.1",
    "not a url",
  ]) {
    let message = "";
    try {
      localStripeApiUrl({ RASTRATA_STRIPE_API_URL: bad });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message, bad).toContain("must be an http address on this machine");
    // The refusal never repeats what was given, which could carry a credential.
    expect(message).not.toContain("secret");
  }
});
