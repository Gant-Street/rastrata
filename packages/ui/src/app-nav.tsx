import { Menu as ArkMenu } from "@ark-ui/solid/menu";
import { Popover } from "@ark-ui/solid/popover";
import {
  type Accessor,
  createEffect,
  createSignal,
  For,
  Index,
  type JSX,
  on,
  Show,
  splitProps,
} from "solid-js";
import { formatCount } from "./format";
import { ChevronDown, Menu, Plus, Search, X } from "./icons";
import type { NavActionEntry, NavLinkEntry, NavSectionEntry } from "./nav-types";
import { shellWords } from "./shell-words";

export interface NavLinkExtras {
  readonly class: string;
  /** Put the open list away (a link was chosen). It is given the click, which a link in a menu needs. */
  readonly onClick: (event: MouseEvent) => void;
  /** What goes inside the link: its label, and the live count when there is one. */
  readonly children: JSX.Element;
  /** What a link in the "+ New" menu carries besides (its role as an item, whether it is highlighted): spread
   * them on the link. A link anywhere else has none. */
  readonly attrs?: JSX.HTMLAttributes<HTMLAnchorElement> | undefined;
}

/** The props Ark gives the element that stands for one of its parts, merged with ours. */
type PartProps = (
  own?: JSX.HTMLAttributes<HTMLAnchorElement>,
) => JSX.HTMLAttributes<HTMLAnchorElement>;

type Open = "new" | "menu" | null;

/** The words the header owns; an application may reword any of them. */
export type AppNavWords = {
  readonly [K in keyof typeof shellWords.header]: (typeof shellWords.header)[K];
};

/**
 * The main navigation: the four places of the product, then Search, "+ New" and Settings. On a phone the
 * bar is replaced by one Menu button that opens the same things in one list. A place says how much waits
 * there (the transactions for review) beside its name. A section with several pages has a row of tabs
 * under the header (`SectionTabs`).
 *
 * "+ New" is Ark's menu, as a report's Export is: the Down arrow or Enter opens it, the arrow keys, Home and
 * End move between the items, Enter chooses one, Escape closes it and puts focus back on the button, and
 * pressing anywhere else closes it. An item that goes to a page is still a link (it opens in a new tab when
 * asked to); one that opens a dialog tells the application. The phone's Menu is Ark's popover: a button
 * that says whether its list is open, and ordinary links in it; Escape, pressing elsewhere and focus that
 * leaves put it away.
 *
 * It does not know about the router: `renderLink` draws a link the way the application navigates, and each
 * entry says whether it is the page the person is on or the place that holds it.
 */
export function AppNav(props: {
  /** The bar: Home, Transactions, Accounts, Reports. */
  sections: readonly NavSectionEntry[];
  /** The Settings link, last. */
  settings?: NavSectionEntry | undefined;
  /** What "+ New" starts, in order: one short list. With none there is no button. */
  newActions: readonly NavActionEntry[];
  /** Search was asked for (the button here, or the keyboard shortcut the application listens for). */
  onSearch: () => void;
  /** An action without a destination (one that opens a dialog) was chosen. */
  onAction?: ((id: string) => void) | undefined;
  renderLink?: (entry: NavLinkEntry, extras: NavLinkExtras) => JSX.Element;
  /** The address of the page the person is on. When it changes the open list is put away. */
  location?: string | undefined;
  /** The keys for Search as the platform writes them ("⌘K", "Ctrl K"). Shown beside the button. */
  shortcut?: string | undefined;
  words?: Partial<AppNavWords> | undefined;
  /** Start with a list open (stories and tests). */
  defaultOpen?: Exclude<Open, null>;
}): JSX.Element {
  const words = (): AppNavWords => ({ ...shellWords.header, ...props.words });
  const [open, setOpen] = createSignal<Open>(props.defaultOpen ?? null);
  /** One list is open at a time; Ark says when either opens or closes. */
  const changed = (which: Exclude<Open, null>, isOpen: boolean) => {
    if (isOpen) setOpen(which);
    else if (open() === which) setOpen(null);
  };
  // Going to another page puts the lists away.
  createEffect(
    on(
      () => props.location,
      () => setOpen(null),
      { defer: true },
    ),
  );

  /** An entry that reads its accessor each time it is asked, so a link drawn once follows the page as it
   * changes (which section is current) instead of being drawn again, and keeps focus when it is used. */
  const live = (entry: Accessor<NavLinkEntry>): NavLinkEntry => ({
    get path() {
      return entry().path;
    },
    get label() {
      return entry().label;
    },
    get count() {
      return entry().count;
    },
    get current() {
      return entry().current;
    },
  });

  const link = (entry: NavLinkEntry, extra = "", part?: PartProps): JSX.Element => {
    // Drawn once; the label and the count read the entry as the page changes.
    const children = (
      <>
        {entry.label}
        <Show when={(entry.count ?? 0) > 0}>
          {/* A space, so a screen reader says "Transactions 8" and not "Transactions8". */}{" "}
          <span class="rt-appnav-count">{formatCount(entry.count ?? 0)}</span>
        </Show>
      </>
    );
    const name = `rt-appnav-link${extra ? ` ${extra}` : ""}`;
    // An item of the menu: Ark's own attributes go on the link, and its click is run with ours.
    const [click, attrs] = splitProps(part?.({ class: name }) ?? {}, ["onClick", "class"]);
    const extras: NavLinkExtras = {
      class: name,
      onClick: (event) => {
        if (typeof click.onClick === "function")
          (click.onClick as (event: MouseEvent) => void)(event);
        setOpen(null);
      },
      children,
      ...(part ? { attrs } : {}),
    };
    return props.renderLink ? (
      props.renderLink(entry, extras)
    ) : (
      <a
        {...extras.attrs}
        class={extras.class}
        href={entry.path}
        aria-current={entry.current}
        onClick={extras.onClick}
      >
        {extras.children}
      </a>
    );
  };

  /** One thing "+ New" starts, in the phone's list: a link to where it happens, or a button that opens
   * its dialog. */
  const action = (entry: NavActionEntry): JSX.Element =>
    entry.href !== undefined ? (
      link({ path: entry.href, label: entry.label }, "rt-appnav-action")
    ) : (
      <button
        type="button"
        class="rt-appnav-link rt-appnav-action"
        onClick={() => {
          setOpen(null);
          props.onAction?.(entry.id);
        }}
      >
        {entry.label}
      </button>
    );

  /** The same thing as an item of the menu. */
  const menuItem = (entry: NavActionEntry): JSX.Element => {
    const href = entry.href;
    return href !== undefined ? (
      <ArkMenu.Item
        value={entry.id}
        asChild={(part) =>
          link({ path: href, label: entry.label }, "rt-appnav-action", part as unknown as PartProps)
        }
      />
    ) : (
      <ArkMenu.Item class="rt-appnav-link rt-appnav-action" value={entry.id}>
        {entry.label}
      </ArkMenu.Item>
    );
  };

  const searchButton = (extra: string, afterClick?: () => void): JSX.Element => (
    <button
      type="button"
      class={`rt-appnav-search ${extra}`.trim()}
      aria-haspopup="dialog"
      aria-keyshortcuts="Control+K Meta+K"
      onClick={() => {
        afterClick?.();
        props.onSearch();
      }}
    >
      <Search aria-hidden="true" />
      <span class="rt-appnav-search-label">{words().search}</span>
      <Show when={props.shortcut}>
        <span class="rt-appnav-kbd" aria-hidden="true">
          {props.shortcut}
        </span>
      </Show>
    </button>
  );

  return (
    <nav class="rt-appnav" aria-label={words().navigation}>
      <ul class="rt-appnav-bar">
        <Index each={props.sections}>{(entry) => <li>{link(live(entry))}</li>}</Index>
      </ul>
      <div class="rt-appnav-tools">
        {searchButton("rt-appnav-tool")}
        <Show when={props.newActions.length > 0}>
          <div class="rt-appnav-group">
            <ArkMenu.Root
              loopFocus
              open={open() === "new"}
              onOpenChange={(detail) => changed("new", detail.open)}
              // Enter on an item that is a link: the link is clicked the way a pointer clicks it, so the
              // application's own navigation takes it. Ark's own click does not bubble, and the handlers
              // of the application listen from the document.
              navigate={(detail) =>
                detail.node.dispatchEvent(
                  new MouseEvent("click", { bubbles: true, cancelable: true, ...detail.modifiers }),
                )
              }
              onSelect={(detail) => {
                const entry = props.newActions.find((item) => item.id === detail.value);
                // After the menu has closed and given focus back to its button: a dialog the action opens
                // would otherwise see focus leave it for the button, and close.
                if (entry && entry.href === undefined)
                  setTimeout(() => props.onAction?.(entry.id), 0);
              }}
            >
              <ArkMenu.Trigger class="rt-appnav-new">
                <Plus aria-hidden="true" />
                {words().new}
                <ChevronDown class="rt-appnav-chevron" aria-hidden="true" />
              </ArkMenu.Trigger>
              {/* No positioner and no portal: the list hangs from its button in the bar, where the bar's
                  own styles place it. */}
              <ArkMenu.Content class="rt-appnav-panel rt-appnav-actions">
                <For each={props.newActions}>{menuItem}</For>
              </ArkMenu.Content>
            </ArkMenu.Root>
          </div>
        </Show>
        <Show when={props.settings}>
          {(settings) => link(live(settings), "rt-appnav-settings")}
        </Show>
      </div>
      <div class="rt-appnav-phone">
        <Popover.Root
          open={open() === "menu"}
          onOpenChange={(detail) => changed("menu", detail.open)}
        >
          <Popover.Trigger class="rt-appnav-toggle">
            <Show when={open() === "menu"} fallback={<Menu aria-hidden="true" />}>
              <X aria-hidden="true" />
            </Show>
            {words().menu}
          </Popover.Trigger>
          <Popover.Content class="rt-appnav-sheet rt-appnav-panel" aria-label={words().menu}>
            {searchButton("rt-appnav-sheet-search", () => setOpen(null))}
            <ul>
              <Index each={props.sections}>{(entry) => <li>{link(live(entry))}</li>}</Index>
              <Show when={props.settings}>{(settings) => <li>{link(live(settings))}</li>}</Show>
            </ul>
            <Show when={props.newActions.length > 0}>
              <p class="rt-appnav-label">{words().new}</p>
              <ul aria-label={words().newList}>
                <For each={props.newActions}>{(entry) => <li>{action(entry)}</li>}</For>
              </ul>
            </Show>
          </Popover.Content>
        </Popover.Root>
      </div>
    </nav>
  );
}
