import type { JSX } from "solid-js";
import { UiProvider } from "../../src";

/** Every statements story sits in the provider and the theme class the application's shell gives. */
export const Frame = (props: { children: JSX.Element; locale?: string; width?: string }) => (
  <UiProvider locale={props.locale ?? "en-US"}>
    <div class="rt-theme rt-imp-page" style={{ "max-width": props.width ?? "64rem" }}>
      {props.children}
    </div>
  </UiProvider>
);
