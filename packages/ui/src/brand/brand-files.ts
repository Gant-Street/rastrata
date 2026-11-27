/**
 * Every file the logo is written to, with its exact contents. `scripts/generate-brand-assets.ts`
 * writes them and `unit/logo.test.ts` fails when one has drifted, so nothing here is edited by hand.
 *
 * The logo files live with the design system. The public site and the web application cannot import
 * `@rastrata/ui` the way a component would, so each carries its own copy of what it needs.
 */
import { logoSvg, MASTER, type LogoVariant, tileSvg, type TileTone } from "./logo-geometry";
import { tilePng, wordmarkPng } from "./png";

export type BrandFile = { path: string; content: string | Uint8Array };

const VARIANTS: LogoVariant[] = ["wordmark", "plate", "stacked", "mark"];
const TONES: TileTone[] = ["orange", "ink", "paper"];

export function brandFiles(): BrandFile[] {
  const files: BrandFile[] = [];
  // The master files: black for a light page, white for a dark one, and the tiles.
  for (const variant of VARIANTS) {
    files.push({
      path: `packages/ui/brand/rastrata-${variant}.svg`,
      content: logoSvg(variant, MASTER.black),
    });
    files.push({
      path: `packages/ui/brand/rastrata-${variant}-white.svg`,
      content: logoSvg(variant, MASTER.white),
    });
  }
  for (const tone of TONES)
    files.push({ path: `packages/ui/brand/rastrata-tile-${tone}.svg`, content: tileSvg(tone) });
  // The public site's copies: the wordmark as a component its header and footer inline (it follows the
  // page's text colour; the site's import rules allow no raw HTML), the favicon, and the icon iOS puts
  // on a home screen.
  files.push({
    path: "apps/marketing/src/components/Logo.astro",
    content: logoSvg("wordmark", "currentColor", "inline"),
  });
  files.push({ path: "apps/marketing/public/favicon.svg", content: tileSvg("orange") });
  files.push({
    path: "apps/marketing/public/apple-touch-icon.png",
    content: tilePng("orange", 180),
  });
  // The wordmark for mail (mail clients do not show an SVG): four pixels to a cell, shown at one, so it is sharp on
  // any screen. The sign-in service's mail links it from the public site.
  files.push({
    path: "apps/marketing/public/email/rastrata-wordmark.png",
    content: wordmarkPng(4),
  });
  // The web application's tab icon.
  files.push({ path: "apps/web/favicon.svg", content: tileSvg("orange") });
  return files;
}
