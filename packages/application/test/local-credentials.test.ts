// Where the Stripe key and the bank feed's access URL come from: the environment and private files in the book's folder (a person's computer, a process with one
// book), or nowhere (a process with many books, where a folder and an environment are every book's).
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBookService } from "../src/local.ts";
import { describeKey } from "../src/stripe/credentials.ts";
import { bankfeedRuntime } from "../src/slices/bankfeed/runtime.ts";
import { stripeRuntime } from "../src/slices/stripe/runtime.ts";

const KEY = `sk_test_${"b".repeat(24)}`;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0)) step();
});

function folderWithCredentials(): string {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-credentials-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "stripe.key"), `${KEY}\n`, { mode: 0o600 });
  writeFileSync(
    join(directory, "simplefin.access"),
    "https://user:secret@beta-bridge.simplefin.org/simplefin\n",
    {
      mode: 0o600,
    },
  );
  return directory;
}

async function open(credentials: "local" | "none" | undefined) {
  const directory = folderWithCredentials();
  const service = await LocalBookService.open(join(directory, "book.sqlite"), {
    safety: false,
    snapshots: false,
    ...(credentials ? { credentials } : {}),
  });
  cleanup.push(() => service.close());
  return service;
}

test("by default a book reads the Stripe key and the bank connection from its folder, as a person's computer does", async () => {
  for (const credentials of [undefined, "local" as const]) {
    const service = await open(credentials);
    expect(describeKey(stripeRuntime(service).keySource)).toMatchObject({
      present: true,
      source: "file",
    });
    expect(bankfeedRuntime(service).credentials.read()).not.toBeNull();
  }
});

test("with none, neither is found in the folder, the environment's Stripe key is not read, and a bank connection has nowhere to be kept", async () => {
  const saved = process.env.RASTRATA_STRIPE_KEY;
  process.env.RASTRATA_STRIPE_KEY = KEY;
  try {
    const service = await open("none");
    expect(describeKey(stripeRuntime(service).keySource)).toMatchObject({
      present: false,
      source: null,
    });
    const feed = bankfeedRuntime(service).credentials;
    expect(feed.read()).toBeNull();
    expect(feed.probe()).toContain("no private place");
    expect(() => feed.write("https://u:p@beta-bridge.simplefin.org/simplefin")).toThrow();
    // And the environment still works for a book that is not told otherwise.
    const local = await open("local");
    expect(describeKey(stripeRuntime(local).keySource)).toMatchObject({
      present: true,
      source: "environment",
    });
  } finally {
    if (saved === undefined) Reflect.deleteProperty(process.env, "RASTRATA_STRIPE_KEY");
    else process.env.RASTRATA_STRIPE_KEY = saved;
  }
});
