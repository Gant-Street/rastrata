import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// The release is one number, in the repository's package.json. The service and the package take it
// from there when they are built; the two places that also carry it as source text are checked here,
// so raising the number in one place and forgetting the others cannot go unnoticed.

const repository = resolve(import.meta.dir, "../../..");
const read = (path: string) => readFileSync(join(repository, path), "utf8");
const release = JSON.parse(read("package.json")).version as string;

test("the release looks like one", () => {
  expect(release).toMatch(/^\d+\.\d+\.\d+$/);
});

test("the stamp the backups carry is the release", () => {
  const stamp = /APPLICATION_RELEASE = "([^"]+)"/.exec(
    read("packages/application/src/safety/types.ts"),
  );
  expect(stamp?.[1]).toBe(release);
});

test("the command line's own default is the release", () => {
  const stamp = /var Version = "([^"]+)"/.exec(
    read("apps/terminal/internal/buildinfo/buildinfo.go"),
  );
  expect(stamp?.[1]).toBe(release);
});
