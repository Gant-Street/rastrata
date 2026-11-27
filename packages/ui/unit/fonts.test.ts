// The application's font faces (tooling/fonts.ts): the two files are what the generator makes from the installed font packages, every file they name is in the packages, and the faces
// cover what the packages' own style sheets cover, so that an upgrade of a package that is not followed by running the generator fails here.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FONTS_CSS, fontsCss, lazyFaces } from "../tooling/fonts";
import { LAZY_FACES } from "../src/fonts-lazy";

const packages = join(import.meta.dir, "../node_modules/@fontsource-variable");

/** The text without what the formatter changes: spaces, line breaks, comments and the case of letters. */
const bare = (css: string) =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, "")
    .replace(/["']/g, "")
    .toLowerCase();

test("the font files are what the generator makes from the installed packages", () => {
  expect(bare(readFileSync(FONTS_CSS, "utf8"))).toBe(bare(fontsCss()));
  // The faces that are files are listed as the generator makes them, the formatter's changes aside (it is data, so it is compared as data).
  expect(LAZY_FACES.map((face) => ({ ...face }))).toEqual(lazyFaces());
});

test("only the Latin face of each family is in the style sheet, and every other subset is a file that is in the package at the version the address names", () => {
  const css = readFileSync(FONTS_CSS, "utf8");
  expect(css.match(/@font-face/g)).toHaveLength(2);
  expect(css).not.toContain("/assets/fonts/");
  expect(css).toContain("inter-latin-standard-normal.woff2");
  expect(css).toContain("jetbrains-mono-latin-wght-normal.woff2");
  expect(LAZY_FACES).toHaveLength(11);
  for (const face of LAZY_FACES) {
    const found = /^\/assets\/fonts\/v([\d.]+)\/([\w.-]+\.woff2)$/.exec(face.url);
    expect(found, face.url).not.toBeNull();
    const [, version, file] = found as unknown as [string, string, string];
    const family = file.startsWith("jetbrains-mono-") ? "jetbrains-mono" : "inter";
    const directory = join(packages, family);
    expect(
      (JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { version: string })
        .version,
    ).toBe(version);
    expect(existsSync(join(directory, "files", file)), file).toBe(true);
    expect(face.unicodeRange).toMatch(/^U\+/);
  }
});

test("between them the faces cover every range the packages' own style sheets declare, and no other", () => {
  const declared = (stylesheet: string) =>
    [...readFileSync(stylesheet, "utf8").matchAll(/unicode-range:\s*([^;]+);/g)].map((found) =>
      (found[1] as string).trim(),
    );
  const fromPackages = [
    ...declared(join(packages, "inter/standard.css")),
    ...declared(join(packages, "jetbrains-mono/wght.css")),
  ]
    .map((range) => range.replace(/\s+/g, "").toLowerCase())
    .sort();
  const ours = [
    ...[...readFileSync(FONTS_CSS, "utf8").matchAll(/unicode-range:\s*([^;]+);/g)].map((found) =>
      (found[1] as string).trim(),
    ),
    ...LAZY_FACES.map((face) => face.unicodeRange),
  ]
    .map((range) => range.replace(/\s+/g, "").toLowerCase())
    .sort();
  expect(ours).toEqual(fromPackages);
});
