import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

// A screen reads the service with the shared plain-signal loader (`src/loader.ts`), never with
// `createResource`. A resource that is read while it loads suspends the router's boundary, which
// detaches the page and drops focus, and one that failed throws when it is read. This test fails when
// a file under src/ uses one, so the problem cannot come back one screen at a time.
const root = join(import.meta.dir, "..", "..", "src");

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("no screen reads with createResource", () => {
  const found: string[] = [];
  for (const path of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: root, absolute: true })) {
    const name = relative(root, path);
    stripComments(readFileSync(path, "utf8"))
      .split("\n")
      .forEach((line, index) => {
        if (/\bcreateResource\b/.test(line)) found.push(`${name}:${index + 1}`);
      });
  }
  expect(
    found,
    `\nRead with createLoader or createKeyedLoader from src/loader.ts instead:\n${found.join("\n")}\n`,
  ).toEqual([]);
});

test("the guard can fail: it recognises a resource and ignores a comment about one", () => {
  expect(/\bcreateResource\b/.test(stripComments("const [a] = createResource(load);"))).toBe(true);
  expect(/\bcreateResource\b/.test(stripComments("// not createResource"))).toBe(false);
  expect(/\bcreateResource\b/.test(stripComments("/** instead of `createResource` */"))).toBe(
    false,
  );
});
