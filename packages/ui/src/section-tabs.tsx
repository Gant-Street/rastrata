import { type Accessor, createEffect, createMemo, Index, type JSX, on, Show } from "solid-js";
import { formatCount } from "./format";
import type { NavLinkEntry, NavTab } from "./nav-types";

export interface TabLinkExtras {
  readonly class: string;
  /** What goes inside the link: the label, and the live count when there is one. */
  readonly children: JSX.Element;
}

/**
 * The pages of a section as a row of tabs under the header: the tab you are on is underlined, and a
 * detail page keeps the tab it belongs to underlined. They are links between pages, not ARIA tabs: each
 * goes to its own address, so the keyboard model is Tab and Enter as everywhere else.
 *
 * `orientation="vertical"` is the Settings list: the same entries in a column beside the page. On a phone
 * either one is a row that scrolls sideways.
 */
export function SectionTabs(props: {
  /** Names the navigation for assistive technology ("Banking pages"). */
  label: string;
  tabs: readonly NavTab[];
  orientation?: "horizontal" | "vertical";
  /** Draws a link the way the application navigates (the router's link). */
  renderLink?: (entry: NavLinkEntry, extras: TabLinkExtras) => JSX.Element;
}): JSX.Element {
  // A tab is drawn once and reads its entry as the page changes (which tab is current, the count), so
  // going from one page to another does not draw the links again and a link keeps focus when it is used.
  const link = (tab: Accessor<NavTab>): JSX.Element => {
    const children = (
      <>
        {tab().label}
        <Show when={(tab().count ?? 0) > 0}>
          {/* A space, so a screen reader says "For review 8" and not "For review8". */}{" "}
          <span class="rt-sectiontab-count">{formatCount(tab().count ?? 0)}</span>
        </Show>
      </>
    );
    const extras: TabLinkExtras = { class: "rt-sectiontab", children };
    return props.renderLink ? (
      props.renderLink(
        {
          get path() {
            return tab().path;
          },
          get label() {
            return tab().label;
          },
          get count() {
            return tab().count;
          },
          get current() {
            return tab().current;
          },
        },
        extras,
      )
    ) : (
      <a class={extras.class} href={tab().path} aria-current={tab().current}>
        {children}
      </a>
    );
  };
  // On a phone the row scrolls sideways, and a page whose tab is far along it would open with that tab out of sight: when the page (and so the current tab) changes, the row is scrolled
  // until that tab is in it, in the middle. The row only: the page does not move. A count that changes, or a person who scrolls the row to look at the others, does not bring it back.
  let row: HTMLUListElement | undefined;
  const here = createMemo(() => props.tabs.findIndex((tab) => tab.current !== undefined));
  const bringIntoView = (index: number) => {
    const item = index >= 0 ? row?.children[index] : undefined;
    if (!row?.isConnected || !item || row.scrollWidth <= row.clientWidth) return;
    const box = row.getBoundingClientRect();
    const mine = item.getBoundingClientRect();
    if (mine.left >= box.left && mine.right <= box.right) return;
    row.scrollLeft += mine.left - box.left - (box.width - mine.width) / 2;
  };
  createEffect(
    on(here, (index) => {
      bringIntoView(index);
      // The row grows when the page's own font arrives, which would leave the tab short of the middle: once more when it has.
      void document.fonts?.ready.then(() => requestAnimationFrame(() => bringIntoView(here())));
    }),
  );
  return (
    <nav
      class="rt-sectiontabs"
      data-orientation={props.orientation ?? "horizontal"}
      aria-label={props.label}
    >
      <ul ref={row}>
        <Index each={props.tabs}>{(tab) => <li>{link(tab)}</li>}</Index>
      </ul>
    </nav>
  );
}
