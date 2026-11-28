/** Starting the page on a service with accounts. The service says it has them in `GET /health`; if it does, the page makes the account layer (account.ts),
 * checks that a workspace is open, and installs it so that every request of the application carries that workspace's token (ambient.ts). If it does not
 * (the installed application, the development server, a service that takes only the owner's key), nothing happens and the page is what it always was.
 *
 * A page that is started without a workspace open, or that finds its session or its place in the workspace gone, does not draw the application: it goes to
 * `/start`, the page that signs people in and lets them choose or make a workspace (the sign-in page, see signin-main.tsx), and is read again from there. */
import { Account } from "./account.ts";
import { installAuthorizer } from "./ambient.ts";
import { learnCapabilities } from "./capabilities.ts";
import { clear as forgetHeld, expectCopy, forgetCopy, giveUpCopy, unlockCopy } from "./held.ts";
import { beginOpening } from "./opening.ts";
import { readService } from "./service-state.ts";

/** The address of the page that signs people in and lets them choose a workspace: always the sign-in page, whoever asks. */
export const START_PATH = "/start";

let account: Account | null = null;

/** The account layer of this page, or null on a service without accounts. */
export const currentAccount = (): Account | null => account;

export interface Boot {
  /** The page is on its way to `/start` and must not draw the application. */
  readonly redirecting: boolean;
  readonly account: Account | null;
}

export interface BootOptions {
  readonly ask?: typeof fetch;
  /** Where the page goes; the browser's `location.replace`. */
  readonly go?: (path: string) => void;
  readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  readonly tabStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  /** Query string (for `?workspace=<slug|id>` deep links); defaults to `window.location.search`. */
  readonly search?: string;
  /** Begin the reads the first screen is drawn from (opening.ts), with this read of the book. The page passes it; a caller that draws nothing leaves it out. */
  readonly readBook?: () => Promise<unknown>;
}

export async function bootAccounts(options: BootOptions = {}): Promise<Boot> {
  const go = options.go ?? ((path: string) => window.location.replace(path));
  const service = await readService(options.ask);
  const learned = {
    accounts: service.accounts,
    connections: service.connections,
    // Whether banks can be connected, and whether workspaces are charged for, are the control plane's to say (it holds Stripe's keys); asked below, once the account layer exists.
    banks: false,
    billing: false,
    stripeApp: false,
    agents: service.agents,
    backups: service.backups,
  };
  learnCapabilities(learned);
  // What the first screen is drawn from is asked for now, beside whatever else the start needs, and the page waits for it before it draws (opening.ts).
  const begin: typeof beginOpening = (name, fetcher) => {
    if (options.readBook) beginOpening(name, fetcher);
  };
  begin("service", async () => service);
  const readBook = () => begin("book", () => options.readBook?.() ?? Promise.resolve(undefined));
  if (!service.accounts) {
    account = null;
    readBook();
    return { redirecting: false, account: null };
  }
  let leaving = false;
  const made = new Account({
    // What the page keeps on the device of the book is locked with the key that comes with the token (held.ts).
    copy: {
      unlock: (key, workspace) => void unlockCopy(key, workspace),
      giveUp: giveUpCopy,
      forget: forgetCopy,
    },
    // A bank or Stripe read or stopped by the control plane changed the book behind the page's own requests: what the page holds of it is let go.
    bookChanged: forgetHeld,
    ...(options.ask ? { ask: options.ask } : {}),
    ...(options.storage !== undefined ? { storage: options.storage } : {}),
    ...(options.tabStorage !== undefined ? { tabStorage: options.tabStorage } : {}),
    onEnded: (why) => {
      if (leaving) return;
      leaving = true;
      // The session is over: end it properly (which clears the hint a service reads) and go to the page that signs in. The person is no longer in the
      // workspace: forget it and go to the page that lets them choose another.
      if (why === "session_ended") void made.signOut().finally(() => go(START_PATH));
      else {
        made.select(null);
        // The person is no longer in the workspace: nothing of its book stays on this device.
        void forgetCopy();
        go(START_PATH);
      }
    },
  });
  account = made;
  // Deep link to a specific LLC (`?workspace=<slug|id>`): pin this tab to it without disturbing other open tabs.
  const search = options.search ?? (typeof window !== "undefined" ? window.location.search : "");
  const query = new URLSearchParams(search);
  const requested = query.get("workspace")?.trim() ?? "";
  if (requested !== "") {
    if (/^wsp_[A-Za-z0-9_-]+$/.test(requested)) {
      made.select(requested);
    } else {
      const listed = await made.workspaces();
      if (listed.ok) {
        const lower = requested.toLowerCase();
        const match = listed.value.find(
          (item) =>
            item.state === "ready" && (item.id === requested || item.slug?.toLowerCase() === lower),
        );
        if (match) made.select(match.id);
      }
    }
    if (options.search === undefined && typeof window !== "undefined") {
      const clean = new URL(window.location.href);
      clean.searchParams.delete("workspace");
      window.history.replaceState(
        window.history.state,
        "",
        `${clean.pathname}${clean.search}${clean.hash}`,
      );
    }
  }
  if (made.scope() === null) {
    leaving = true;
    go(START_PATH);
    return { redirecting: true, account: made };
  }
  installAuthorizer(made);
  // What the page kept on the device of this workspace is read back when the token comes with its key, which is asked for now so that the first reads find it (held.ts).
  expectCopy();
  void made.authorization();
  readBook();
  begin("person", async () => {
    const session = await made.session();
    return session.ok ? session.value : null;
  });
  // A service that cannot be asked offers no bank connection; the rest of the page does not wait on it for long.
  const asked = made.config();
  // Where the workspace stands with its subscription, for the banner under the header: only on a service that charges for workspaces, which the config says. The workspace is asked
  // for beside the config and not after it: each is a round trip to the control plane and the first draw waits for both, so one after the other cost the page the first one's whole
  // time (a third of a second of a blank page on the live service). On a service that does not charge, the answer is not used.
  const id = made.scope();
  const detail = id === null ? null : made.workspace(id);
  begin("standing", async () => {
    const config = await asked;
    if (!config.ok || config.value.billing !== true || detail === null) return null;
    const answer = await detail;
    return answer.ok ? answer.value.workspace : null;
  });
  const config = await asked;
  if (config.ok)
    learnCapabilities({
      ...learned,
      banks: config.value.banks === true,
      billing: config.value.billing === true,
      stripeApp: config.value.stripeApp === true,
    });
  return { redirecting: false, account: made };
}
