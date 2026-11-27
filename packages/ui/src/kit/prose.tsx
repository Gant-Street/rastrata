import { onCleanup, onMount, type JSX } from "solid-js";
import { CopyValue } from "./details";

/** A click the browser keeps for itself: a new tab or window, a download, or one another handler used. */
const browserKeeps = (event: MouseEvent): boolean =>
  event.defaultPrevented ||
  event.button !== 0 ||
  event.metaKey ||
  event.ctrlKey ||
  event.shiftKey ||
  event.altKey;

/**
 * Running text to read: a how-to's paragraphs, headings, lists and tables, set in the product's type at a
 * width a line can be read at (about 65 characters). It is given as HTML made where the application is
 * built, from documents the application's own authors wrote; it is never given a person's text.
 *
 * A link to another page of the application (an address that starts with "/") is handed to `onNavigate`
 * when it is simply clicked, so the application opens it the way it opens every page; any other click, and
 * any other link, is the browser's. A table wider than the column scrolls inside its own region.
 */
export function Prose(props: {
  html: string;
  /** Opens a page of the application. Without it a link loads its page. */
  onNavigate?: ((href: string) => void) | undefined;
}): JSX.Element {
  let root: HTMLDivElement | undefined;
  onMount(() => {
    const onClick = (event: MouseEvent) => {
      if (!props.onNavigate || browserKeeps(event)) return;
      const link = (event.target as Element | null)?.closest?.("a[href]");
      const href = link?.getAttribute("href") ?? "";
      if (!link || !root?.contains(link) || !href.startsWith("/") || link.hasAttribute("target"))
        return;
      event.preventDefault();
      props.onNavigate(href);
    };
    root?.addEventListener("click", onClick);
    onCleanup(() => root?.removeEventListener("click", onClick));
  });
  return (
    <div
      class="rt-prose"
      ref={(element) => {
        root = element;
      }}
      innerHTML={props.html}
    />
  );
}

/** A command or an example set apart from the text, as it is typed, with a button that copies it. A line
 * longer than the column scrolls inside the block, and the block takes focus so the keyboard can scroll it. */
export function ProseCode(props: { text: string }): JSX.Element {
  return (
    <div class="rt-prose-code">
      {/* A block that scrolls sideways takes focus, or a person at a keyboard cannot read the end of a long line. */}
      <pre tabindex="0">
        <code>{props.text}</code>
      </pre>
      <span class="rt-prose-copy">
        <CopyValue value={props.text} />
      </span>
    </div>
  );
}
