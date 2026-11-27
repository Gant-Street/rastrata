import { useRouter } from "@tanstack/solid-router";
import { type JSX, splitProps } from "solid-js";

/** A click the browser keeps for itself: a new tab or window, a download, a selection, or one another
 * handler already used. */
const browserKeeps = (event: MouseEvent): boolean =>
  event.defaultPrevented ||
  event.button !== 0 ||
  event.metaKey ||
  event.ctrlKey ||
  event.shiftKey ||
  event.altKey;

type Router = ReturnType<typeof useRouter>;

/** Goes to an address the way a link does: inside the application when it can, with the page the router
 * opens. An address with a different query for the page that is already open reloads that page instead,
 * because the screens read their query when they open (a Search result for `/inbox?item=…` while the Inbox
 * is open has to open the Inbox again, or the item is never selected). */
export function goTo(router: Router, address: string): void {
  const target = new URL(address, window.location.origin);
  if (target.origin !== window.location.origin) {
    window.location.assign(address);
    return;
  }
  const next = `${target.pathname}${target.search}${target.hash}`;
  if (target.pathname === window.location.pathname && target.search !== window.location.search) {
    window.location.assign(next);
    return;
  }
  router.history.push(next);
}

/** `goTo` for the router the component is in. */
export function useGoTo(): (address: string) => void {
  const router = useRouter();
  return (address) => goTo(router, address);
}

let intent: ((address: string) => void) | null = null;
/** What to do when a link is pointed at, pressed or focused: the router's page has the file of the screen it opens fetched (router.tsx). */
export function onIntent(wanted: (address: string) => void): void {
  intent = wanted;
}

/** A link between pages of the application. It is an ordinary anchor (so a new tab, a copied address and
 * a screen reader's list of links all work) that goes through the router when it is simply clicked. */
export function AppLink(
  props: Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "onClick" | "href"> & {
    href: string;
    current?: "page" | "true" | undefined;
    /** Runs first, whatever the click turns out to be (the navigation puts its open list away). */
    onClick?: ((event: MouseEvent) => void) | undefined;
  },
): JSX.Element {
  const go = useGoTo();
  const [own, rest] = splitProps(props, ["href", "current", "onClick", "children"]);
  return (
    <a
      {...rest}
      href={own.href}
      aria-current={own.current}
      onPointerEnter={() => intent?.(own.href)}
      onPointerDown={() => intent?.(own.href)}
      onFocus={() => intent?.(own.href)}
      onClick={(event) => {
        own.onClick?.(event);
        if (browserKeeps(event)) return;
        event.preventDefault();
        go(own.href);
      }}
    >
      {own.children}
    </a>
  );
}
