import type { JSX } from "solid-js";
import { UiProvider } from "../../src";

/** Every story sits on the themed page surface, with the page's own layout. */
export const Frame = (props: { children: JSX.Element; dir?: "rtl" | "ltr" }) => (
  <UiProvider>
    <div class="rt-theme rt-bankfeed-story rt-bankfeed-page" dir={props.dir ?? "ltr"}>
      {props.children}
    </div>
  </UiProvider>
);
