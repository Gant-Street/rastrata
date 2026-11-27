import { afterEach, expect, test } from "bun:test";
import { fontsFor } from "../src/fonts-ready";

// The typeface files that a business's name needs are asked for, and waited for, before the page draws it (src/fonts-ready.ts): a name in Basic Latin or Latin-1 needs no file and no wait.
const original = (globalThis as { document?: unknown }).document;
afterEach(() => {
  (globalThis as { document?: unknown }).document = original;
});
const withLoad = (load: (font: string, text: string) => Promise<unknown[]>) => {
  (globalThis as { document?: unknown }).document = { fonts: { load } };
};

test("text that is in the style sheet asks for nothing and waits for nothing", async () => {
  const asked: string[] = [];
  withLoad(async (font, text) => {
    asked.push(`${font} ${text}`);
    return [];
  });
  await fontsFor("Acme Books, Café Ünal (ñ) – 1,000.00");
  expect(asked).toEqual([]);
});

test("text in another script asks for the files of both typefaces and waits for them", async () => {
  const asked: string[] = [];
  const releases: (() => void)[] = [];
  withLoad(
    (font, text) =>
      new Promise((resolve) => {
        asked.push(`${font} ${text}`);
        releases.push(() => resolve([]));
      }),
  );
  let done = false;
  const waiting = fontsFor("Dvořák Interiors", 5_000).then(() => {
    done = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(asked).toEqual([
    '1em "Inter Variable" Dvořák Interiors',
    '1em "JetBrains Mono Variable" Dvořák Interiors',
  ]);
  // Not over while one of them is still on its way.
  releases[0]?.();
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(done).toBe(false);
  releases[1]?.();
  await waiting;
  expect(done).toBe(true);
});

test("a file that does not come, or cannot be had, holds the page back for the moment given and no longer", async () => {
  withLoad(() => new Promise(() => {}));
  const started = performance.now();
  await fontsFor("Phở", 30);
  const waited = performance.now() - started;
  expect(waited).toBeGreaterThanOrEqual(25);
  expect(waited).toBeLessThan(1_000);
  withLoad(() => Promise.reject(new Error("blocked")));
  await fontsFor("Phở", 5_000);
});

test("a page that cannot say what is loaded is not held back", async () => {
  (globalThis as { document?: unknown }).document = {};
  await fontsFor("Dvořák", 5_000);
  (globalThis as { document?: unknown }).document = undefined;
  await fontsFor("Dvořák", 5_000);
});
