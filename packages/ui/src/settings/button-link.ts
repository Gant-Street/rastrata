import type { JSX } from "solid-js";
import type { buttonAttrs } from "../button";

/** What a link that looks like a button is drawn from: where it goes, what it says and the attributes
 * `buttonAttrs` gives it (its class and its variant and size). The application draws it with its router. */
export type ButtonLinkProps = ReturnType<typeof buttonAttrs> & {
  readonly href: string;
  readonly children: JSX.Element;
};
