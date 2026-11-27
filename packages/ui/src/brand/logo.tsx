import type { JSX } from "solid-js";
import { LOGO, type LogoVariant } from "./logo-geometry";

export type { LogoVariant };

/**
 * The Rastrata logo, drawn in the text color: ink on paper in the light theme, paper on ink in the
 * dark one, with no other color. Set its height with CSS (or `height`); the width follows the shape.
 *
 * - `wordmark`: the name, 80 × 17 cells. The default.
 * - `plate`: the name between the ledger's rules, for places that sign a page (a statement, a card).
 * - `stacked`: "rast" over "rata", a block for places that are square.
 * - `mark`: the corner, for places too small for the word.
 *
 * The accessible name is "Rastrata". Pass `label=""` when the logo sits beside text that already says
 * it, so it is not read twice. In a link, name the link, not the picture.
 */
export function Logo(props: {
  variant?: LogoVariant;
  /** A CSS length; a number is pixels. Whole multiples of 17 (17, 34, 51) put every cell on a pixel. */
  height?: number | string;
  label?: string;
  class?: string;
}): JSX.Element {
  const shape = () => LOGO[props.variant ?? "wordmark"];
  const label = () => props.label ?? "Rastrata";
  const height = () => (typeof props.height === "number" ? `${props.height}px` : props.height);
  return (
    <svg
      class={props.class ? `rt-logo ${props.class}` : "rt-logo"}
      viewBox={shape().viewBox}
      style={height() ? { height: height() } : undefined}
      role={label() ? "img" : undefined}
      aria-label={label() || undefined}
      aria-hidden={label() ? undefined : "true"}
    >
      <path fill="currentColor" d={shape().d} />
    </svg>
  );
}
