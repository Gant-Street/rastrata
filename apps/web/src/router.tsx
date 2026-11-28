import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  useLocation,
  useRouter,
} from "@tanstack/solid-router";
import {
  AppHeader,
  AppNav,
  Logo,
  SectionTabs,
  useToast,
  WorkspaceSwitcher,
  type WorkspaceOption,
} from "@rastrata/ui";
import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
  Suspense,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { footerNote, type Who } from "./access-note";
import type { WorkspaceSummary } from "./account";
import { openWorkspace, setupPending } from "./new-book";
import { AppLink, goTo, onIntent } from "./app-link";
import { BrowserApplicationClient, WRITE_EVENT } from "./application-client";
import { BillingBanner } from "./billing-banner";
import { bannerFor } from "./billing-controller";
import { currentAccount } from "./boot";
import { capabilities } from "./capabilities";
import { clear as forgetHeld } from "./held";
import { createLoader } from "./loader";
import { endOpening, fromOpening } from "./opening";
import { availableRoutes, buildHeader, buildNewActions, pageNameOf, sectionLabel } from "./nav";
import { createNavCounts } from "./nav-counts";
import { preloadAddress } from "./preload";
import { allDialogs, allNewActions, navRoutes, searchSourcesFor } from "./routes/all";
import { Home } from "./routes/home";
import { helpAudience } from "./routes/help/audience";
import { helpHref } from "./routes/help/pages";
import { lanes, type SearchSource } from "./routes/registry";
import {
  AccountsPage,
  JournalDetailPage,
  JournalPage,
  LedgerPage,
  NewJournal,
  PeriodsPage,
  ReportsPage,
} from "./routes/screens";
import { matchScore } from "./search/builtin";
import { SearchHost } from "./search/host";
import { readService } from "./service-state";
import {
  SESSION_KEPT_WITHIN_MS,
  SESSION_NOT_KEPT_MESSAGE,
  SIGN_IN_REQUIRED_EVENT,
  signOut,
  wantsSignIn,
} from "./session";
import { SignInScreen } from "./signin";
import {
  BILLING_UPDATED_EVENT,
  setWorkspaceReadOnly,
  WORKSPACE_RENAMED_EVENT,
  workspaceReadOnly,
} from "./standing";
import { ThemeSwitch } from "./theme-switch";
import { CreateWorkspaceDialog } from "./workspace-create-dialog";

/** "⌘K" on a Mac, "Ctrl K" elsewhere: the keys that open Search, as the platform writes them. */
const searchShortcut = (): string =>
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘K" : "Ctrl K";

function Shell() {
  const location = useLocation();
  const router = useRouter();
  const client = new BrowserApplicationClient(window.localStorage);
  const toast = useToast();
  // What the page read before it drew itself (opening.ts) is what each of these starts from, so the header and the footer are whole in the first draw.
  const bookOpening = fromOpening("book", () => client.read("book.get", {}));
  const book = createLoader(bookOpening.fetcher, bookOpening.initial);
  // A service with accounts has people who sign in with their own addresses: the owner's key is not how anyone gets in, so the dialog that asks for it is never shown,
  // and signing out ends the account's session. What the service can back is also known from the start: the navigation and Search leave out the pages it cannot.
  const account = currentAccount();
  const routes = availableRoutes(navRoutes, capabilities());
  // Where the workspace stands as to its trial and subscription, for the banner under the header: asked once when the page opens, and only on a service that charges for workspaces.
  const standingOpening = fromOpening("standing", async () => {
    if (!account || !capabilities().billing) return null;
    const id = account.scope();
    if (id === null) return null;
    const answer = await account.workspace(id);
    return answer.ok ? answer.value.workspace : null;
  });
  const standing = createLoader(standingOpening.fetcher, standingOpening.initial);
  createEffect(() => {
    setWorkspaceReadOnly(standing.value()?.billing?.readOnly === true);
  });
  const [workspaces, setWorkspaces] = createSignal<readonly WorkspaceSummary[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = createSignal(false);
  const [creatingWorkspace, setCreatingWorkspace] = createSignal(false);
  const loadWorkspaces = async () => {
    if (!account) return;
    setWorkspacesLoading(true);
    try {
      const listed = await account.workspaces();
      if (listed.ok) setWorkspaces(listed.value);
    } finally {
      setWorkspacesLoading(false);
    }
  };
  const switchWorkspace = (workspaceId: string) => {
    if (!account || workspaceId === account.scope()) return;
    account.select(workspaceId);
    forgetHeld();
    window.location.assign("/");
  };
  const workspaceOptions = createMemo<readonly WorkspaceOption[]>(() => {
    const listed = workspaces();
    if (listed.length > 0) {
      return listed.map((item) => ({
        id: item.id,
        name: item.name,
        slug: item.slug,
        role: item.role,
        state: item.state,
        readOnly: item.billing?.readOnly === true,
      }));
    }
    const current = standing.value();
    if (current) {
      return [
        {
          id: current.id,
          name: current.name,
          slug: current.slug,
          role: current.role,
          state: current.state,
          readOnly: current.billing?.readOnly === true,
        },
      ];
    }
    return [];
  });
  const currentWorkspaceName = () => {
    const id = account?.scope();
    if (!id) return undefined;
    return workspaces().find((item) => item.id === id)?.name ?? standing.value()?.name;
  };
  const workspaceSearchSource = (): SearchSource | null => {
    if (!account) return null;
    return {
      id: "workspaces",
      label: "Workspaces",
      order: 15,
      instant: true,
      search: async (query) => {
        const activeId = account.scope();
        const items = workspaces().filter((item) => item.state === "ready" && item.id !== activeId);
        const hits = items
          .map((item) => ({
            item,
            score: matchScore(
              query,
              item.name,
              item.slug ? [item.slug, "workspace", "switch"] : ["workspace", "switch"],
            ),
          }))
          .filter((entry) => entry.score > 0)
          .sort(
            (left, right) =>
              right.score - left.score || left.item.name.localeCompare(right.item.name),
          )
          .map(({ item }) => ({
            id: `workspace:${item.id}`,
            label: item.name,
            detail: item.billing?.readOnly ? "Switch workspace (read-only)" : "Switch workspace",
            kind: "action" as const,
          }));
        const createScore = matchScore(query, "New workspace", [
          "create",
          "business",
          "llc",
          "entity",
        ]);
        if (createScore > 0) {
          hits.push({
            id: "workspace:create",
            label: "New workspace",
            detail: "Create another business",
            kind: "action" as const,
          });
        }
        return hits;
      },
    };
  };
  const sources = (() => {
    const base = searchSourcesFor(routes);
    const extra = workspaceSearchSource();
    return extra ? [...base, extra] : base;
  })();
  // A hosted service asks the owner to sign in (a 401 from any request, see `announceSignInRequired`): the
  // sign-in screen is shown over whatever the person was doing, and the page reads again once they are in.
  const [signedOut, setSignedOut] = createSignal(false);
  // A sign-in the service accepted and the next request refused again: the browser did not keep the cookie.
  const [notKept, setNotKept] = createSignal(false);
  let signedInAt = 0;
  createEffect(() => {
    if (account || !wantsSignIn(book.error())) return;
    setSignedOut(true);
    if (Date.now() - signedInAt < SESSION_KEPT_WITHIN_MS) setNotKept(true);
  });
  async function leave() {
    // The page is read again from nothing, so that no book stays in a browser the person has left.
    if (account) {
      if (await account.signOut()) {
        // The next person to sign in on this browser chooses their own workspace.
        account.select(null);
        window.location.assign("/");
        return;
      }
    } else if (await signOut()) {
      window.location.assign("/");
      return;
    }
    toast.show({ message: "Could not sign out. Try again in a moment." });
  }
  // The installed service reads the book once each time it starts. While it does, the footer says so,
  // and asks again every two seconds so that the time counts down and the note goes when it is done. The
  // same answer says whether this is a hosted service, which is what lets the owner sign out of it.
  const serviceOpening = fromOpening("service", () => readService());
  const service = createLoader(serviceOpening.fetcher, serviceOpening.initial);
  const warmup = () => service.value()?.warmup;
  createEffect(() => {
    if (!warmup()?.reading) return;
    const timer = setTimeout(() => void service.reload(), 2000);
    onCleanup(() => clearTimeout(timer));
  });
  // Signed in to a hosted service: it answered a read of the book, and the session has not ended since.
  const signedIn = () =>
    service.value()?.hosted === true && book.value() !== undefined && !signedOut();
  // On a service with accounts the footer says who: the address, and the role in the workspace that is open (the book says it, in `member`).
  const personOpening = fromOpening("person", async () => {
    if (!account) return null;
    const session = await account.session();
    return session.ok ? session.value : null;
  });
  const person = createLoader(personOpening.fetcher, personOpening.initial);
  const who = (): Who | undefined => {
    const email = person.value()?.email;
    return email ? { email, role: book.value()?.member?.role } : undefined;
  };

  // A service that has a book mode and no book yet is a first run: the setup is the whole page, so the
  // header is only the wordmark. Until the service has answered the full header shows (most visits are to a
  // book that exists, and a header that comes and goes would jump), unless this browser last saw the
  // workspace's books still to be set up: then Home shows the setup at once, and the header agrees with it.
  const pendingAtOpen = setupPending(openWorkspace());
  const firstRun = () =>
    book.value() === undefined
      ? pendingAtOpen && book.error() === undefined
      : book.value()?.enabled === true && book.value()?.setup === null;
  const hasBook = () => book.value()?.enabled === true && !!book.value()?.setup;
  const bookName = () => book.value()?.setup?.name;

  const counts = createNavCounts({
    client,
    routes,
    ready: hasBook,
    page: () => location().pathname,
  });
  const header = createMemo(() => buildHeader(routes, location().pathname, counts()));
  const newActions = buildNewActions(allNewActions);

  // Where the person is, in words: the page's name ("For review", "Move from Xero"), or for a page with
  // no name of its own the tab it sits under ("All transactions" on one of its entries). It is the title
  // of the browser tab (so a tab and the history say where each is) and, when the page changes, it is said
  // to a screen reader, which otherwise hears nothing when a link only swaps the page.
  const pageName = () => {
    const here = header().here;
    if (!here.route) return "Page not found";
    return here.route.nav.title?.(location().pathname) ?? pageNameOf(routes, here) ?? "Rastrata";
  };
  createEffect(() => {
    document.title = `${pageName()} · ${bookName() ?? "Rastrata"}`;
  });
  const [announced, setAnnounced] = createSignal("");
  createEffect(
    on(
      () => location().pathname,
      () => {
        // The page has changed: what was read before the first draw is no longer what a page starts from.
        endOpening();
        setAnnounced(pageName());
      },
      { defer: true },
    ),
  );

  // Search opens from the keyboard anywhere (Cmd-K or Ctrl-K) and from the button.
  const [searching, setSearching] = createSignal(false);
  const [dialog, setDialog] = createSignal<string | null>(null);
  // Every page reads what it shows once, when it opens. A dialog that writes (Spend money posts an entry)
  // leaves the page behind it showing what was true before, so when a dialog that wrote closes, the page is
  // opened again and reads what is true now. A dialog that only cancelled changes nothing and does not.
  const [pageVersion, setPageVersion] = createSignal(1);
  let wroteWhileOpen = false;
  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      // Search does not open over a lane's modal dialog (Spend money...): the dialog has the keyboard. And
      // nothing opens over the sign-in: until the person is back in, it is the only thing to answer.
      if (firstRun() || dialog() !== null || signedOut()) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearching(true);
      }
    };
    // The setup wizard creates the book from Home, and the business can be renamed in Settings: the
    // header (which shows the name, and is only the wordmark before there is a book) reads it again.
    const reread = () => void book.reload();
    const onWrite = (event: Event) => {
      const name = (event as CustomEvent<{ name?: string }>).detail?.name;
      endOpening();
      if (name === "book.setup" || name === "book.update") reread();
      if (dialog() !== null) wroteWhileOpen = true;
    };
    const needSignIn = () => {
      if (!account) setSignedOut(true);
    };
    const onBillingUpdated = () => {
      void standing.reload();
      void book.reload();
      void loadWorkspaces();
    };
    const onWorkspaceRenamed = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; name?: string }>).detail;
      if (detail?.id && detail?.name) {
        setWorkspaces((prev) =>
          prev.map((item) =>
            item.id === detail.id ? { ...item, name: detail.name as string } : item,
          ),
        );
      }
      void standing.reload();
    };
    if (account) void loadWorkspaces();
    window.addEventListener("keydown", onKey);
    window.addEventListener("rastrata:book-created", reread);
    window.addEventListener(WRITE_EVENT, onWrite);
    window.addEventListener(SIGN_IN_REQUIRED_EVENT, needSignIn);
    window.addEventListener(BILLING_UPDATED_EVENT, onBillingUpdated);
    window.addEventListener(WORKSPACE_RENAMED_EVENT, onWorkspaceRenamed);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("rastrata:book-created", reread);
      window.removeEventListener(WRITE_EVENT, onWrite);
      window.removeEventListener(SIGN_IN_REQUIRED_EVENT, needSignIn);
      window.removeEventListener(BILLING_UPDATED_EVENT, onBillingUpdated);
      window.removeEventListener(WORKSPACE_RENAMED_EVENT, onWorkspaceRenamed);
    });
  });
  // The dialogs the lanes offer (Spend money, Receive money, Transfer) open over any page, so the one that
  // is open is one id at the root. They start from "+ New", from Search, or from `?new=<action id>` in the
  // address (which is taken out of the address as it is used). When one closes, focus goes back to where
  // it started: the "+ New" button, or on a phone the Menu button that holds it.
  let opener: HTMLElement | null = null;
  const showing = (element: Element) => (element as HTMLElement).offsetParent !== null;
  const showDialog = (dialogId: string, from: "new" | "elsewhere") => {
    if (signedOut() || workspaceReadOnly()) return;
    if (!allDialogs.some((candidate) => candidate.id === dialogId)) return;
    opener =
      from === "new"
        ? (([...document.querySelectorAll(".rt-appnav-new, .rt-appnav-toggle")].find(showing) as
            | HTMLElement
            | undefined) ?? null)
        : (document.activeElement as HTMLElement | null);
    setDialog(dialogId);
  };
  const startAction = (actionId: string, from: "new" | "elsewhere") => {
    const dialogId = allNewActions.find((candidate) => candidate.id === actionId)?.dialog;
    if (dialogId) showDialog(dialogId, from);
  };
  const closeDialog = () => {
    const back = opener;
    opener = null;
    setDialog(null);
    if (wroteWhileOpen) {
      wroteWhileOpen = false;
      setPageVersion((version) => version + 1);
    }
    // After the dialog has let go of focus (and after the page behind it has opened again, whose title may
    // take focus), so the last word is ours.
    setTimeout(() => {
      if (back?.isConnected) back.focus();
    }, 0);
  };
  const dialogEntry = () => allDialogs.find((candidate) => candidate.id === dialog());
  createEffect(
    on(
      () => location().href,
      () => {
        if (firstRun()) return;
        const url = new URL(window.location.href);
        const wanted = url.searchParams.get("new");
        if (
          wanted === null ||
          !allNewActions.some((action) => action.id === wanted && action.dialog)
        )
          return;
        url.searchParams.delete("new");
        window.history.replaceState(
          window.history.state,
          "",
          `${url.pathname}${url.search}${url.hash}`,
        );
        startAction(wanted, "elsewhere");
      },
    ),
  );

  return (
    <div class="app-shell rt-theme">
      <a class="skip-link" href="#main">
        Skip to content
      </a>
      {/* A live region without the status role: a page's own messages ("Draft saved") are role=status, and
          a reader or a test that looks for the status of the page must find that one, not this. */}
      <p class="rt-sr-only" aria-live="polite" aria-atomic="true">
        {announced()}
      </p>
      <AppHeader
        name={bookName()}
        book={
          account ? (
            <WorkspaceSwitcher
              currentName={bookName() ?? currentWorkspaceName() ?? "Workspace"}
              currentId={account.scope()}
              workspaces={workspaceOptions()}
              loading={workspacesLoading()}
              onOpen={() => void loadWorkspaces()}
              onSelect={switchWorkspace}
              onCreate={() => setCreatingWorkspace(true)}
              manageHref="/start?choose=1"
            />
          ) : undefined
        }
        wordmark={
          <Link to="/" class="wordmark">
            <Logo />
          </Link>
        }
      >
        <Show when={!firstRun()}>
          <AppNav
            sections={header().sections}
            settings={header().settings}
            newActions={workspaceReadOnly() ? [] : newActions}
            location={location().pathname}
            shortcut={searchShortcut()}
            onSearch={() => setSearching(true)}
            onAction={(id) => startAction(id, "new")}
            renderLink={(entry, extras) => (
              <AppLink
                href={entry.path}
                {...extras.attrs}
                class={extras.class}
                current={entry.current}
                onClick={extras.onClick}
              >
                {extras.children}
              </AppLink>
            )}
          />
        </Show>
      </AppHeader>
      <Show when={!firstRun() && header().tabs.length > 0 && header().tabsOf}>
        {(section) => (
          <SectionTabs
            label={`${sectionLabel(section())} pages`}
            tabs={header().tabs}
            renderLink={(entry, extras) => (
              <AppLink href={entry.path} class={extras.class} current={entry.current}>
                {extras.children}
              </AppLink>
            )}
          />
        )}
      </Show>
      <Show when={!firstRun()}>
        <BillingBanner banner={bannerFor(standing.value())} />
      </Show>
      <div class="app-body" data-layout={header().settingsList.length > 0 ? "settings" : undefined}>
        <Show when={header().settingsList.length > 0}>
          <SectionTabs
            label="Settings"
            orientation="vertical"
            tabs={header().settingsList}
            renderLink={(entry, extras) => (
              <AppLink href={entry.path} class={extras.class} current={entry.current}>
                {extras.children}
              </AppLink>
            )}
          />
        </Show>
        <main id="main" class="app-main" tabIndex={-1}>
          <Show when={pageVersion()} keyed>
            {(_version) => <Outlet />}
          </Show>
        </main>
      </div>
      <footer class="app-footer">
        <span>{footerNote(book.value()?.ownerAccess, warmup(), signedIn(), who())}</span>
        <span class="footer-actions">
          {/* The one way to Help, on every page: the how-to for the page a person is on, or the list. */}
          <Show when={!firstRun()}>
            <AppLink
              class="footer-action"
              href={helpHref(location().pathname, location().searchStr, helpAudience())}
            >
              Help
            </AppLink>
          </Show>
          <Show when={account}>
            {/* The page that lists the person's workspaces, to open another or to make one (it is the sign-in page, so it is a page load and not a route). */}
            <a class="footer-action" href="/start?choose=1">
              Workspaces
            </a>
          </Show>
          {/* On a service with accounts a person who cannot read the book just now can still leave. */}
          <Show when={signedIn() || account}>
            <button type="button" class="footer-action" onClick={() => void leave()}>
              Sign out
            </button>
          </Show>
          <ThemeSwitch />
        </span>
      </footer>
      <Show when={!firstRun()}>
        <SearchHost
          open={searching}
          setOpen={setSearching}
          sources={sources}
          client={client}
          onChoose={(hit) => {
            if (hit.id === "workspace:create") setCreatingWorkspace(true);
            else if (hit.id.startsWith("workspace:"))
              switchWorkspace(hit.id.slice("workspace:".length));
            else if (hit.dialog) showDialog(hit.dialog, "elsewhere");
            else if (hit.href) goTo(router, hit.href);
          }}
        />
      </Show>
      <Show when={account && creatingWorkspace()}>
        <CreateWorkspaceDialog
          open={true}
          account={account as NonNullable<typeof account>}
          onClose={() => setCreatingWorkspace(false)}
          onOpened={() => window.location.assign("/")}
        />
      </Show>
      <Show when={dialogEntry()}>
        {(entry) => (
          // The dialog's file is fetched when it is first wanted (routes/screen.ts), usually long before: until it is here nothing shows, and the page behind stays as it is.
          <Suspense fallback={null}>
            <Dynamic component={entry().component} open={true} onClose={closeDialog} />
          </Suspense>
        )}
      </Show>
      <Show when={signedOut()}>
        <SignInScreen
          notice={notKept() ? SESSION_NOT_KEPT_MESSAGE : undefined}
          onSignedIn={() => {
            signedInAt = Date.now();
            setNotKept(false);
            setSignedOut(false);
            void book.reload();
            setPageVersion((version) => version + 1);
          }}
        />
      </Show>
    </div>
  );
}

const rootRoute = createRootRoute({
  component: Shell,
  notFoundComponent: () => (
    <section>
      <h1>Page not found</h1>
      <p>Check the address.</p>
      <Link to="/">Go home</Link>
    </section>
  ),
  errorComponent: () => (
    <section role="alert">
      <h1>Unable to open this page</h1>
      <p>Reload the page to try again.</p>
      <a href="/">Go home</a>
    </section>
  ),
});
// The application's own screens are written out one by one, so the router knows their paths and
// parameters and a `navigate({ to: "/journal" })` or a `useParams` on one is checked. Where each of them
// sits in the navigation is declared in routes/core.ts (a test keeps the two lists the same). The lanes'
// routes come from the registry.
const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Home });
const journalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/journal",
  component: JournalPage,
});
const newJournalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/journal/new",
  component: NewJournal,
});
const journalDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/journal/$entryId",
  component: JournalDetailPage,
});
const ledgerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ledger",
  component: LedgerPage,
});
const reportsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reports",
  component: ReportsPage,
});
const accountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/accounts",
  component: AccountsPage,
});
const periodsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/periods",
  component: PeriodsPage,
});
// A screen that is a tab for one service and a page under a tab for another is registered twice (the navigation reads each); the router makes the one route.
const routedPaths = new Set<string>();
const laneRoutes = lanes
  .flatMap((lane) => lane.routes)
  .filter((route) => !routedPaths.has(route.path) && routedPaths.add(route.path))
  .map((route) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: route.path,
      component: route.component,
    }),
  );
// A link that is pointed at, pressed or focused has its screen's file fetched ahead of the click (preload.ts).
onIntent(preloadAddress);
export const router = createRouter({
  routeTree: rootRoute.addChildren([
    homeRoute,
    journalRoute,
    newJournalRoute,
    journalDetailRoute,
    ledgerRoute,
    reportsRoute,
    accountsRoute,
    periodsRoute,
    ...laneRoutes,
  ]),
});

declare module "@tanstack/solid-router" {
  interface Register {
    router: typeof router;
  }
}
