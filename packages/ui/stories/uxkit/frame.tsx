import type { JSX } from "solid-js";
import { createDecorator } from "storybook-solidjs-vite";
import { UiProvider } from "../../src";

/** For a story named Dark: open it in the dark theme, unless the address asks for a theme. The lane sweep
 * opens every story with `?globals=theme:light` and then `theme:dark` and checks the page is in the one it
 * asked for, so a story that pinned the theme for good would fail the light pass. */
export const darkUnlessAsked = createDecorator((Story) => {
  const asked = new URLSearchParams(window.location.search).get("globals") ?? "";
  if (!/(^|;)theme:/.test(asked)) document.documentElement.dataset.theme = "dark";
  return Story();
});

/** The page the UX kit's stories sit on: the application's own theme class and a measure like a screen's
 * content column, in `UiProvider` so copy and direction come from the same place they do in the app. */
export function Frame(props: { children: JSX.Element; width?: string; label?: string }) {
  return (
    <UiProvider locale="en-US">
      <div
        class="rt-theme"
        style={{
          "max-width": props.width ?? "48rem",
          margin: "0 auto",
          padding: "1.5rem 1rem 6rem",
        }}
      >
        {props.label ? (
          <p class="rt-hint" style={{ margin: "0 0 1rem" }}>
            {props.label}
          </p>
        ) : null}
        {props.children}
      </div>
    </UiProvider>
  );
}

/** A 64-character hex string, the shape of a fingerprint or a population hash. */
export const FINGERPRINT = "61e985c0f2b94d3a7e18a5c46d09b3f7a2e4cc1d8b50e7f9a3d62c8b1f04e7a9";
