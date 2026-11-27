/** Where a person is taken once they have signed in again, when a page sent them to do it (something asks for a sign-in from the last few minutes): back to that page, and
 * not to Home. The page writes its own path before it signs them out; the sign-in page reads it once, as it opens the workspace. Kept for the tab only, and only ever a plain
 * path of this application: nothing that names another site, a query or a fragment is taken. */
const KEY = "rastrata:return-to";
const PLAIN_PATH = /^\/[a-z0-9]+(?:[/-][a-z0-9]+)*$/;

/** Remember the page to come back to. */
export function returnAfterSignIn(path: string, storage: Storage = window.sessionStorage): void {
  if (!PLAIN_PATH.test(path)) return;
  try {
    storage.setItem(KEY, path);
  } catch {
    // They land on Home, as before.
  }
}

/** The page to go back to, once; null when none was left, or what was left is not a path of ours. */
export function takeReturnPath(storage: Storage = window.sessionStorage): string | null {
  try {
    const kept = storage.getItem(KEY);
    storage.removeItem(KEY);
    return kept !== null && PLAIN_PATH.test(kept) ? kept : null;
  } catch {
    return null;
  }
}
