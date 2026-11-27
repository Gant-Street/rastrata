import type { BookSettings, BookUpdateResult } from "@rastrata/application/client-contracts";
import { setShowsAccountNumbers } from "@rastrata/ui/entries/display";
import { setDateFormat } from "@rastrata/ui/format";
import { createSignal } from "solid-js";
import { BrowserApplicationClient } from "./application-client";
import { clear as forgetHeld, onChanged } from "./held";

/** What the book's owner chose for how the app shows things and what Accept does (`book.update`). Held in
 * plain signals so every screen that reads it follows a change at once, and read from the service once,
 * the first time anything asks. Until it has been read the defaults apply, and a screen that is about to
 * act on a setting asks the service with `bookSettingsNow()` instead of acting on a guess, or on what the page was told some time ago. */
export const DEFAULT_BOOK_SETTINGS: BookSettings = {
  dateFormat: "medium",
  showAccountNumbers: false,
  acceptMode: "post",
};

export interface HeldBook {
  /** The business name, as `book.get` reports it. */
  readonly name: string | undefined;
  readonly settings: BookSettings;
}

const [held, setHeld] = createSignal<HeldBook | undefined>(undefined);
const [unreadable, setUnreadable] = createSignal(false);
let reading: Promise<HeldBook | undefined> | null = null;
/** What tells it that the book has been found to be other than it held: set once, for the life of the page. */
let listening = false;
/** The client a test handed in, which the read that follows a change uses too. */
let client: BrowserApplicationClient | undefined;
/** How many reads have been started, so a read that failed knows whether a newer one has taken over. */
let asked = 0;

/** The book as the application says it. */
const bookOf = (context: {
  readonly setup?: { readonly name?: string } | null;
  readonly settings?: BookSettings;
}): HeldBook => ({
  name: context.setup?.name,
  settings: context.settings ?? DEFAULT_BOOK_SETTINGS,
});

/** Take a book as the new truth: the signals, and the preferences the shared components read. */
function remember(next: HeldBook): void {
  setHeld(next);
  setUnreadable(false);
  setShowsAccountNumbers(next.settings.showAccountNumbers);
  // Every date the app writes follows the owner's choice at once (the screens that show dates listen).
  setDateFormat(next.settings.dateFormat);
}

/** Read the book's name and settings, once, or again when the book has changed. Never throws: a read that
 * fails leaves the defaults in place and `bookSettingsUnreadable()` true. */
export function readBookSettings(
  options: { again?: boolean; held?: boolean; client?: BrowserApplicationClient } = {},
): Promise<HeldBook | undefined> {
  if (reading && !options.again) return reading;
  // Asked to read again, it wants what the service says now and not what the page holds of it (held.ts); `held`: what the page holds has just been found to be what the service says.
  if (options.again && !options.held) forgetHeld();
  if (options.client) client = options.client;
  if (!listening) {
    listening = true;
    onChanged(() => {
      if (reading)
        void readBookSettings({ again: true, held: true, ...(client ? { client } : {}) });
    });
  }
  const mine = ++asked;
  const attempt = (async (): Promise<HeldBook | undefined> => {
    try {
      const client = options.client ?? new BrowserApplicationClient(window.localStorage);
      const next = bookOf(await client.read("book.get", {}));
      remember(next);
      return next;
    } catch {
      setUnreadable(true);
      // The next ask tries again, unless a newer read has already been started.
      if (asked === mine) reading = null;
      return undefined;
    }
  })();
  reading = attempt;
  return attempt;
}

const ensure = (): void => {
  // Only a page asks by itself; a test hands the client in.
  if (!reading && typeof window !== "undefined") void readBookSettings();
};

/** The settings now, reactive. The defaults until the first read finishes. */
export function bookSettings(): BookSettings {
  ensure();
  return held()?.settings ?? DEFAULT_BOOK_SETTINGS;
}

/** The business name, reactive; undefined until it has been read. */
export function businessName(): string | undefined {
  ensure();
  return held()?.name;
}

/** Whether lists show an account's number beside its name (the Business setting). */
export const showAccountNumbers = (): boolean => bookSettings().showAccountNumbers;

/** What Accept does in For review: post the entry at once (with Undo) or save a draft. */
export const acceptMode = (): BookSettings["acceptMode"] => bookSettings().acceptMode;

/** Resolves with the book's settings once they have been read, or undefined when they cannot be: what a
 * screen waits for before it shows a setting. An action that a setting decides (Accept) asks the service
 * itself (`bookSettingsNow`): what was read when the page opened may be what the owner has since changed. */
export function bookSettingsReady(): Promise<HeldBook | undefined> {
  const now = held();
  return now ? Promise.resolve(now) : readBookSettings();
}

/** The settings as the service says them now, for deciding what an action does (Accept): asked of the service and not answered from what the page holds, which may be what it said when the page
 * opened or earlier, and taken as the new truth. It never throws: where the service cannot be asked, what the page holds is what there is (the action's own request fails as well). */
export async function bookSettingsNow(): Promise<HeldBook | undefined> {
  try {
    const asking = client ?? new BrowserApplicationClient(window.localStorage);
    const next = bookOf(await asking.read("book.get", {}, { fresh: true }));
    remember(next);
    return next;
  } catch {
    return held();
  }
}

/** True when the settings could not be read the last time they were asked for. */
export const bookSettingsUnreadable = (): boolean => unreadable();

/** Take the reply to `book.update` as the new truth, without another read. */
export function rememberBookUpdate(result: BookUpdateResult): void {
  remember({ name: result.name, settings: result.settings });
}

/** Forget what was read (a test starts from nothing). */
export function resetBookSettings(): void {
  reading = null;
  listening = false;
  client = undefined;
  setHeld(undefined);
  setUnreadable(false);
  setShowsAccountNumbers(DEFAULT_BOOK_SETTINGS.showAccountNumbers);
  setDateFormat(DEFAULT_BOOK_SETTINGS.dateFormat);
}
