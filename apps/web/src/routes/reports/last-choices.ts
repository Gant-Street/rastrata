/** The dates and the comparison a person last read a report with, for this visit of the browser: the list
 * of reports opens the next one with the same ones, as moving between statements always did. Which report
 * it was, which page of it and a pinned revision are not carried. A per-viewer convenience, so it may be
 * unavailable; a report then opens on its own default (the fiscal year to date, the latest tax year). */

export const STATEMENT_CHOICES = "rastrata:reports:last";
export const TAX_CHOICES = "rastrata:reports:last-tax";

export function lastChoices(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** Keep a report's address as the choices to carry, without the parts that belong to that report alone. */
export function keepChoices(key: string, query: string, drop: readonly string[]): void {
  try {
    const params = new URLSearchParams(query);
    for (const name of drop) params.delete(name);
    window.sessionStorage.setItem(key, params.toString());
  } catch {
    // The next report opens on its own default.
  }
}
