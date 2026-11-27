import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";

// The web app builds CSS through Tailwind (Lightning CSS), which collapses a color-mix() that takes
// a custom property to its first color (so a 64% gray becomes plain black), and does the same to
// light-dark(color-mix(...)). Storybook's bundler does not, so the shared tokens must be compiled
// to real constants *here*. This reads the emitted CSS directly: no browser needed.

type Rgb = [number, number, number];
const hex = (value: string): Rgb => {
  let digits = value.replace("#", "").toLowerCase();
  if (digits.length === 3 || digits.length === 4) digits = [...digits].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => Number.parseInt(digits.slice(i, i + 2), 16)) as Rgb;
};
/** srgb mix of `a` at `percent` with `b` for the remainder, like color-mix(in srgb, a p%, b). */
const mix = (a: string, percent: number, b: string): Rgb => {
  const [x, y] = [hex(a), hex(b)];
  return [0, 1, 2].map((i) =>
    Math.round(((x[i] ?? 0) * percent + (y[i] ?? 0) * (100 - percent)) / 100),
  ) as Rgb;
};

const tints: Record<string, { light: Rgb; dark: Rgb }> = {
  muted: { light: mix("#000", 64, "#fff"), dark: mix("#fff", 66, "#000") },
  border: { light: mix("#000", 88, "#fff"), dark: mix("#fff", 88, "#000") },
  "border-subtle": { light: mix("#000", 20, "#fff"), dark: mix("#fff", 24, "#000") },
  divider: { light: mix("#000", 11, "#fff"), dark: mix("#fff", 16, "#000") },
  hover: { light: mix("#000", 4, "#fff"), dark: mix("#fff", 8, "#000") },
  pressed: { light: mix("#000", 8, "#fff"), dark: mix("#fff", 14, "#000") },
  "disabled-surface": { light: mix("#000", 6, "#fff"), dark: mix("#fff", 11, "#000") },
  "surface-subtle": { light: mix("#000", 2, "#fff"), dark: mix("#fff", 10, "#000") },
  "accent-hover": { light: mix("#0b3d91", 80, "#000"), dark: mix("#0b3d91", 30, "#fff") },
  selection: { light: mix("#000", 8, "#fff"), dark: mix("#fff", 14, "#0f0f0f") },
  "danger-hover": { light: mix("#eb0000", 6, "#fff"), dark: mix("#eb0000", 16, "#0f0f0f") },
};

async function compile(minify: boolean) {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../src/styles.css")],
    plugins: [tailwind],
    minify,
  });
  expect(result.success).toBe(true);
  const output = result.outputs.find((file) => file.path.endsWith(".css"));
  if (!output) throw new Error("No CSS was emitted");
  return await output.text();
}

/** Every value a custom property is declared with anywhere in the bundle. */
function declarations(css: string, token: string) {
  return [...css.matchAll(new RegExp(`--rt-${token}\\s*:\\s*([^;}]+)`, "g"))].map((match) =>
    (match[1] ?? "").trim(),
  );
}
const close = (a: Rgb, b: Rgb) => a.every((channel, i) => Math.abs(channel - (b[i] ?? 0)) <= 1);

describe.each([
  ["development (unminified)", false],
  ["production (minified)", true],
] as const)("shared color tints through the Tailwind pipeline: %s", (_label, minify) => {
  for (const [token, expected] of Object.entries(tints)) {
    test(`--rt-${token} compiles to its light and dark mixtures`, async () => {
      const values = declarations(await compile(minify), token);
      expect(values.length).toBeGreaterThan(0);
      // The collapse signature: a tint reduced to one of its inputs.
      for (const value of values) expect(value).not.toMatch(/^var\(--rt-(black|white)\)$/);
      const colors = values.filter((value) => /^#[0-9a-f]{3,8}$/i.test(value)).map(hex);
      expect(colors.some((color) => close(color, expected.light))).toBe(true);
      expect(colors.some((color) => close(color, expected.dark))).toBe(true);
    });
  }
});
