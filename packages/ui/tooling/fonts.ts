/** The application's font faces, made from the two font packages' own style sheets (`src/fonts.css` and `src/fonts-lazy.ts`). The page's style sheet is what its first paint waits for, and the
 * packages' sheets put every face of every script inside it as text (twelve faces, 385 KB of a 636 KB sheet, fetched by every device after every release whether or not a page used them). Here the
 * Latin face of each family stays in the sheet, so that the page's text is in its own typeface from its first paint; every other subset (Latin extended, Vietnamese, Cyrillic,
 * Greek) is a file at `/assets/fonts/v<the package's version>/<name>.woff2`, copied into the build by apps/web/tooling/build.ts, and a face the page registers when it starts (`registerFonts`, which
 * the browser answers by fetching the file the first time a character in its range is shown, as it does for a face in a style sheet). The version is in the path because the files are served
 * as immutable: a package that changes its files changes the path. (The bundler would not leave such an address alone in a style sheet, which is why they are registered and not written there.)
 *
 * `bun packages/ui/tooling/fonts.ts` writes both files; a test (unit/fonts.test.ts) holds them equal to what this makes from the installed packages, so an upgrade of a package that is not
 * followed by running this fails the gate. */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
export const FONTS_CSS = resolve(here, "../src/fonts.css");
export const FONTS_LAZY = resolve(here, "../src/fonts-lazy.ts");

const FAMILIES = [
  { name: "inter", stylesheet: "standard.css", family: "Inter Variable" },
  { name: "jetbrains-mono", stylesheet: "wght.css", family: "JetBrains Mono Variable" },
] as const;

const packageDirectory = (name: string) => join(here, "../node_modules/@fontsource-variable", name);

interface Face {
  readonly name: string;
  readonly family: string;
  readonly weight: string;
  readonly unicodeRange: string;
  readonly rule: string;
  readonly version: string;
  readonly latin: boolean;
}

/** The faces of both packages: the name of each (`inter-latin-standard-normal`), its range and weights. */
function faces(): Face[] {
  return FAMILIES.flatMap((family) => {
    const directory = packageDirectory(family.name);
    const version = (
      JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { version: string }
    ).version;
    const css = readFileSync(join(directory, family.stylesheet), "utf8");
    return [...css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g)].map((found) => {
      const rule = found[2] as string;
      const name = found[1] as string;
      return {
        name,
        family: family.family,
        weight: /font-weight:\s*([^;]+);/.exec(rule)?.[1]?.trim() ?? "100 900",
        unicodeRange: /unicode-range:\s*([^;]+);/.exec(rule)?.[1]?.trim() ?? "",
        rule,
        version,
        latin: name.includes("-latin-") && !name.includes("-latin-ext-"),
      };
    });
  });
}

export function fontsCss(): string {
  const lines = [
    "/* Made by packages/ui/tooling/fonts.ts from the font packages' style sheets; do not edit. The Latin face of each family is in the sheet, so that the page's text is in its typeface from its",
    "   first paint; the other scripts are files registered by fonts-lazy.ts. */",
  ];
  for (const face of faces().filter((one) => one.latin)) {
    const directory = face.name.startsWith("jetbrains-mono-") ? "jetbrains-mono" : "inter";
    lines.push(
      "",
      `/* ${face.name} */`,
      face.rule.replace(
        /url\(\.\/files\/[\w.-]+\.woff2\)/,
        `url(../node_modules/@fontsource-variable/${directory}/files/${face.name}.woff2)`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** The faces that are files, as data (what `fonts-lazy.ts` lists). */
export function lazyFaces() {
  return faces()
    .filter((face) => !face.latin)
    .map((face) => ({
      family: face.family,
      weight: face.weight,
      url: `/assets/fonts/v${face.version}/${face.name}.woff2`,
      unicodeRange: face.unicodeRange,
    }));
}

export function fontsLazy(): string {
  const entries = faces()
    .filter((face) => !face.latin)
    .map(
      (face) =>
        `  {\n    family: ${JSON.stringify(face.family)},\n    weight: ${JSON.stringify(face.weight)},\n    url: ${JSON.stringify(`/assets/fonts/v${face.version}/${face.name}.woff2`)},\n    unicodeRange: ${JSON.stringify(face.unicodeRange)},\n  },`,
    );
  return `// Made by packages/ui/tooling/fonts.ts from the font packages' style sheets; do not edit.
// The faces of the scripts that are not Latin, as files the browser fetches when a character in a face's range is shown (see tooling/fonts.ts for why they are registered here and
// not written in the style sheet). The build copies the files to \`/assets/fonts/\` (apps/web/tooling/build.ts) and the development server serves them.

export interface LazyFace {
  readonly family: string;
  readonly weight: string;
  readonly url: string;
  readonly unicodeRange: string;
}

export const LAZY_FACES: readonly LazyFace[] = [
${entries.join("\n")}
];

/** Make each face known to the browser, which fetches its file the first time a character in its range is shown. Safe to call where there are no fonts (a test, a server). */
export function registerFonts(): void {
  if (typeof FontFace === "undefined" || typeof document === "undefined") return;
  for (const face of LAZY_FACES)
    document.fonts.add(
      new FontFace(face.family, \`url(\${face.url}) format("woff2-variations")\`, {
        weight: face.weight,
        style: "normal",
        unicodeRange: face.unicodeRange,
        display: "swap",
      }),
    );
}
`;
}

if (import.meta.main) {
  writeFileSync(FONTS_CSS, fontsCss());
  writeFileSync(FONTS_LAZY, fontsLazy());
}
