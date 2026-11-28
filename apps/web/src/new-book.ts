/** Which workspace's books are still to be set up, as this browser last saw: the sign-in card notes a workspace it has
 * just made, and Home notes what the book says each time it is read. Home then shows the setup at once, instead of a
 * skeleton of itself while the workspace's token and its book are asked for (about a second); the book still decides
 * when it answers. A per-viewer convenience, so it may be unavailable (a private window, blocked storage): Home then
 * waits for the book. */

const SETUP_PENDING = "rastrata:setup-pending";
type Notes = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const browserNotes = (): Notes | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/** Note whether the books of workspace `id` are still to be set up. */
export function noteSetupPending(
  id: string,
  pending: boolean,
  notes: Notes | null = browserNotes(),
): void {
  try {
    if (pending) notes?.setItem(SETUP_PENDING, id);
    else if (notes?.getItem(SETUP_PENDING) === id) notes.removeItem(SETUP_PENDING);
  } catch {
    // Storage that cannot be written only means Home reads the book before it shows the setup.
  }
}

/** Whether the books of the workspace being opened (`current`) were last seen still to be set up. */
export function setupPending(
  current: string | null,
  notes: Notes | null = browserNotes(),
): boolean {
  try {
    return current !== null && notes?.getItem(SETUP_PENDING) === current;
  } catch {
    return false;
  }
}

const TAB_WORKSPACE_KEY = "rastrata:tab-workspace";

/** The workspace the page acts in (account.ts pins it per tab in sessionStorage, falling back to localStorage), or none. */
export function openWorkspace(notes: Notes | null = browserNotes()): string | null {
  try {
    if (notes === browserNotes()) {
      const pinned = window.sessionStorage.getItem(TAB_WORKSPACE_KEY);
      if (pinned) return pinned;
    }
  } catch {
    // Blocked sessionStorage falls back to localStorage.
  }
  try {
    return notes?.getItem("rastrata:workspace") || null;
  } catch {
    return null;
  }
}
