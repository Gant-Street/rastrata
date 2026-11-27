import { createSignal } from "solid-js";

/** How the owner asked for accounts to be shown in lists (Settings, Business, "Show account numbers").
 * It is one preference for the whole app, held in a signal so a list that reads it follows a change at
 * once. The web app sets it from `book.get` and after the owner saves; a story or a test sets it itself.
 * The chart, the pickers and the reports always show an account's number (muted); this is about lists. */
const [numbers, setNumbers] = createSignal(false);

/** Whether lists show an account's number beside its name. Reactive. */
export const showsAccountNumbers = (): boolean => numbers();

/** Set the preference (the web app does, from the book's settings). */
export const setShowsAccountNumbers = (show: boolean): void => {
  setNumbers(show);
};

/** An account as a list shows it: its name, and its number before the name when the owner asked for
 * numbers ("1000 · Business checking"). An account without a number is just its name. */
export function listAccountLabel(name: string, code?: string | undefined): string {
  return numbers() && code ? `${code} · ${name}` : name;
}
