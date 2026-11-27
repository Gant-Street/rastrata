import type { JSX } from "solid-js";
import { UiProvider } from "../../src";

/** The page every reports story sits in: the product's own base styles, a readable column, and the
 * locale it should speak. The theme comes from the toolbar (or `?globals=theme:dark`). */
export function Frame(props: { children: JSX.Element; locale?: string }) {
  return (
    <UiProvider locale={props.locale ?? "en-US"}>
      <main class="rt-theme" style={{ padding: "1.5rem", "max-width": "64rem" }}>
        {props.children}
      </main>
    </UiProvider>
  );
}
