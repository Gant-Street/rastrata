// Made by packages/ui/tooling/fonts.ts from the font packages' style sheets; do not edit.
// The faces of the scripts that are not Latin, as files the browser fetches when a character in a face's range is shown (see tooling/fonts.ts for why they are registered here and
// not written in the style sheet). The build copies the files to `/assets/fonts/` (apps/web/tooling/build.ts) and the development server serves them.

export interface LazyFace {
  readonly family: string;
  readonly weight: string;
  readonly url: string;
  readonly unicodeRange: string;
}

export const LAZY_FACES: readonly LazyFace[] = [
  {
    family: "Inter Variable",
    weight: "100 900",
    url: "/assets/fonts/v5.3.0/inter-cyrillic-ext-standard-normal.woff2",
    unicodeRange: "U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F",
  },
  {
    family: "Inter Variable",
    weight: "100 900",
    url: "/assets/fonts/v5.3.0/inter-cyrillic-standard-normal.woff2",
    unicodeRange: "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116",
  },
  {
    family: "Inter Variable",
    weight: "100 900",
    url: "/assets/fonts/v5.3.0/inter-greek-ext-standard-normal.woff2",
    unicodeRange: "U+1F00-1FFF",
  },
  {
    family: "Inter Variable",
    weight: "100 900",
    url: "/assets/fonts/v5.3.0/inter-greek-standard-normal.woff2",
    unicodeRange: "U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF",
  },
  {
    family: "Inter Variable",
    weight: "100 900",
    url: "/assets/fonts/v5.3.0/inter-vietnamese-standard-normal.woff2",
    unicodeRange:
      "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB",
  },
  {
    family: "Inter Variable",
    weight: "100 900",
    url: "/assets/fonts/v5.3.0/inter-latin-ext-standard-normal.woff2",
    unicodeRange:
      "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
  },
  {
    family: "JetBrains Mono Variable",
    weight: "100 800",
    url: "/assets/fonts/v5.3.0/jetbrains-mono-cyrillic-ext-wght-normal.woff2",
    unicodeRange: "U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F",
  },
  {
    family: "JetBrains Mono Variable",
    weight: "100 800",
    url: "/assets/fonts/v5.3.0/jetbrains-mono-cyrillic-wght-normal.woff2",
    unicodeRange: "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116",
  },
  {
    family: "JetBrains Mono Variable",
    weight: "100 800",
    url: "/assets/fonts/v5.3.0/jetbrains-mono-greek-wght-normal.woff2",
    unicodeRange: "U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF",
  },
  {
    family: "JetBrains Mono Variable",
    weight: "100 800",
    url: "/assets/fonts/v5.3.0/jetbrains-mono-vietnamese-wght-normal.woff2",
    unicodeRange:
      "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB",
  },
  {
    family: "JetBrains Mono Variable",
    weight: "100 800",
    url: "/assets/fonts/v5.3.0/jetbrains-mono-latin-ext-wght-normal.woff2",
    unicodeRange:
      "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
  },
];

/** Make each face known to the browser, which fetches its file the first time a character in its range is shown. Safe to call where there are no fonts (a test, a server). */
export function registerFonts(): void {
  if (typeof FontFace === "undefined" || typeof document === "undefined") return;
  for (const face of LAZY_FACES)
    document.fonts.add(
      new FontFace(face.family, `url(${face.url}) format("woff2-variations")`, {
        weight: face.weight,
        style: "normal",
        unicodeRange: face.unicodeRange,
        display: "swap",
      }),
    );
}
