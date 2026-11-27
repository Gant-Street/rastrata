import { createSignal, type JSX, Show } from "solid-js";
import {
  AppHeader,
  AppNav,
  Logo,
  type NavActionEntry,
  type NavCurrent,
  type NavLinkEntry,
  type NavSectionEntry,
  type NavTab,
  SectionTabs,
  UiProvider,
} from "../../src";

/** A small map of fictional destinations, the way the application's registry reads: each page is in a
 * section, and is a tab or sits under one. The real map is `apps/web/src/routes/`. */
interface Place {
  readonly section: string;
  /** The tab it is, or sits under. */
  readonly tab?: string;
}
const places: Record<string, Place> = {
  "/": { section: "home" },
  "/inbox": { section: "transactions", tab: "/inbox" },
  "/journal": { section: "transactions", tab: "/journal" },
  "/rules": { section: "transactions", tab: "/rules" },
  "/rules/new": { section: "transactions", tab: "/rules" },
  "/accounts": { section: "accounts", tab: "/accounts" },
  "/reconcile": { section: "accounts", tab: "/reconcile" },
  "/reports": { section: "reports" },
  "/settings": { section: "settings" },
};
const sectionPaths: Record<string, string> = {
  home: "/",
  transactions: "/inbox",
  accounts: "/accounts",
  reports: "/reports",
  settings: "/settings",
};
const sectionNames: Record<string, string> = {
  home: "Home",
  transactions: "Transactions",
  accounts: "Accounts",
  reports: "Reports",
  settings: "Settings",
};
const tabNames: Record<string, readonly (readonly [string, string])[]> = {
  transactions: [
    ["/inbox", "For review"],
    ["/journal", "All transactions"],
    ["/rules", "Rules"],
  ],
  accounts: [
    ["/accounts", "Chart of accounts"],
    ["/reconcile", "Reconcile"],
  ],
};

export const newActions: readonly NavActionEntry[] = [
  { id: "transaction", label: "Transaction" },
  { id: "journal-entry", label: "Journal entry", href: "/journal/new" },
  { id: "account", label: "Account", href: "/accounts?new=1" },
];

/** The header as the application draws it, with the section's tab row under it and a line of "page" under
 * that. Choosing a link moves the current page. */
export function Frame(props: {
  current: string;
  name?: string;
  reviewCount?: number;
  defaultOpen?: "new" | "menu";
  actions?: readonly NavActionEntry[];
  withoutNav?: boolean;
  children?: JSX.Element;
}) {
  const [current, setCurrent] = createSignal(props.current);
  const place = () => places[current()];
  const currentOf = (path: string, section: string): NavCurrent | undefined =>
    place()?.section !== section ? undefined : current() === path ? "page" : "true";
  const sections = (): NavSectionEntry[] =>
    ["home", "transactions", "accounts", "reports"].map((id) => {
      const path = sectionPaths[id] as string;
      const current_ = currentOf(path, id);
      return {
        id,
        label: sectionNames[id] as string,
        path,
        // What waits for review is said beside the place's name.
        ...(id === "transactions" && props.reviewCount ? { count: props.reviewCount } : {}),
        ...(current_ ? { current: current_ } : {}),
      };
    });
  const settings = (): NavSectionEntry => {
    const current_ = currentOf("/settings", "settings");
    return {
      id: "settings",
      label: "Settings",
      path: "/settings",
      ...(current_ ? { current: current_ } : {}),
    };
  };
  const tabs = (): NavTab[] => {
    const section = place()?.section ?? "";
    return (tabNames[section] ?? []).map(([path, label]) => {
      const here = place()?.tab === path;
      return {
        path,
        label,
        ...(here ? { current: current() === path ? ("page" as const) : ("true" as const) } : {}),
      };
    });
  };
  // A link reads its entry where it draws it, so it follows the page as the current page moves.
  const renderLink = (
    entry: NavLinkEntry,
    extras: {
      class: string;
      children: JSX.Element;
      onClick?: (event: MouseEvent) => void;
      attrs?: JSX.HTMLAttributes<HTMLAnchorElement> | undefined;
    },
  ) => (
    <a
      {...extras.attrs}
      class={extras.class}
      href={`#${entry.path}`}
      aria-current={entry.current}
      onClick={(event) => {
        extras.onClick?.(event);
        event.preventDefault();
        const path = entry.path.split("?")[0] as string;
        if (places[path]) setCurrent(path);
      }}
    >
      {extras.children}
    </a>
  );
  return (
    <UiProvider locale="en-US">
      <div
        class="rt-theme"
        style={{
          "max-width": "82rem",
          margin: "0 auto",
          padding: "0 clamp(1.25rem, 4vw, 3rem) 3rem",
        }}
      >
        <AppHeader
          name={props.name}
          wordmark={
            <a class="wordmark" href="#/">
              <Logo />
            </a>
          }
        >
          <Show when={!props.withoutNav}>
            <AppNav
              sections={sections()}
              settings={settings()}
              newActions={props.actions ?? newActions}
              location={current()}
              shortcut="⌘K"
              onSearch={() => undefined}
              {...(props.defaultOpen ? { defaultOpen: props.defaultOpen } : {})}
              renderLink={renderLink}
            />
          </Show>
        </AppHeader>
        <Show when={tabs().length > 1}>
          <SectionTabs
            label={`${sectionNames[place()?.section ?? ""] ?? ""} pages`}
            tabs={tabs()}
            renderLink={renderLink}
          />
        </Show>
        <main style={{ "padding-top": "1.5rem", "min-height": "10rem" }}>
          {props.children ?? <p>The page. Choosing a link above moves the current page.</p>}
        </main>
      </div>
    </UiProvider>
  );
}
