/** A screen that is fetched when it is first wanted, not sent with the page: every screen but Home is its own file of the build, so that the script the first draw waits for holds the shell, Home
 * and what they share, and a person who opens Reports does not first wait for the code of Rules, Tax and the import of a year of books (docs/reference/program/performance.md, "The critical
 * script").
 *
 * The router asks for a screen's file before it shows the page (`preload`, which `lazyRouteComponent` makes), so the page never draws half a screen and the screen the person is on stays until
 * the next is whole. Nothing waits on the click: a link that is pointed at or focused (app-link.tsx) and every screen, a few at a time once the page is drawn (preload.ts), are asked for ahead
 * of it. A file that cannot be had because a release has replaced it is not an error: the page is read again from the service, which is how it gets the new build. */
import { lazyRouteComponent } from "@tanstack/solid-router";
import type { JSX } from "solid-js";

/** A screen as the registry holds it: a component that may say how to have its file fetched ahead. */
export interface Screen<P = unknown> {
  (props: P): JSX.Element;
  /** Fetch the screen's file now (once); resolves when it is there, whether it was or not. */
  preload?: () => Promise<void>;
}

type PropsOf<C> = C extends (props: infer P) => JSX.Element ? P : never;

/** The screen `name` of the module `load` imports. */
export function screen<M extends Record<string, unknown>, K extends keyof M & string>(
  load: () => Promise<M>,
  name: K,
): Screen<PropsOf<M[K]>> {
  return lazyRouteComponent(load as never, name as never) as unknown as Screen<PropsOf<M[K]>>;
}
