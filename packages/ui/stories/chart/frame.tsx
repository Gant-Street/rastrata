import type { JSX } from "solid-js";
import { UiProvider } from "../../src";

/** The page the application puts these components on: the theme class and some air around them. */
export function Frame(props: { children: JSX.Element; locale?: string }): JSX.Element {
  return (
    <UiProvider locale={props.locale ?? "en-US"}>
      <div class="rt-theme" style={{ padding: "1.5rem", "min-height": "100vh" }}>
        {props.children}
      </div>
    </UiProvider>
  );
}
