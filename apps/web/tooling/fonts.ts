/** The font files the page registers as `/assets/fonts/v<version>/<name>.woff2` (packages/ui/src/fonts-lazy.ts, made by packages/ui/tooling/fonts.ts): where each is in the font packages,
 * which the build copies into its output and the development server serves. */
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

const ui = resolve(import.meta.dir, "../../../packages/ui");
const NAMED = /\/assets\/fonts\/(v[\d.]+)\/([\w.-]+\.woff2)/g;

export interface FontFile {
  /** The address the sheet names. */
  readonly url: string;
  /** Where the file is, in the package. */
  readonly from: string;
}

const packageOf = (file: string) =>
  file.startsWith("jetbrains-mono-") ? "jetbrains-mono" : "inter";
const location = (file: string) =>
  resolve(ui, "node_modules/@fontsource-variable", packageOf(file), "files", file);

/** Every file the sheet names. */
export function fontFiles(): FontFile[] {
  const source = readFileSync(resolve(ui, "src/fonts-lazy.ts"), "utf8");
  return [...source.matchAll(NAMED)].map((found) => ({
    url: found[0] as string,
    from: location(found[2] as string),
  }));
}

/** The file a request for `path` is for, or null when it is not one the sheet names. */
export function fontFor(path: string): string | null {
  const found = fontFiles().find((file) => file.url === path);
  return found ? found.from : null;
}

export const fontDirectory = (outdir: string, url: string) => resolve(outdir, `.${dirname(url)}`);
