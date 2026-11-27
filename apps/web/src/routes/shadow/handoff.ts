/** Balances read from a Xero trial balance wait here, in the tab, for the opening balances screen,
 * which reviews them before anything is posted. Session storage, so nothing about the business
 * outlives the tab, and removed the moment it is read. What is read back is checked: it is data. */
export const OPENING_HANDOFF_KEY = "rastrata:opening-from-xero";

export interface OpeningHandoff {
  /** The date the trial balance is as at, when the file said. */
  readonly asOf: string | null;
  readonly balances: readonly { readonly accountId: string; readonly balance: string }[];
}

const MAX_BALANCES = 400;
const AMOUNT = /^-?\d{1,18}\.\d{2}$/;

export function isHandoff(value: unknown): value is OpeningHandoff {
  if (typeof value !== "object" || value === null) return false;
  const { asOf, balances } = value as { asOf?: unknown; balances?: unknown };
  if (asOf !== null && typeof asOf !== "string") return false;
  if (!Array.isArray(balances) || balances.length === 0 || balances.length > MAX_BALANCES)
    return false;
  return balances.every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { accountId?: unknown }).accountId === "string" &&
      (entry as { accountId: string }).accountId.length > 0 &&
      (entry as { accountId: string }).accountId.length <= 200 &&
      typeof (entry as { balance?: unknown }).balance === "string" &&
      AMOUNT.test((entry as { balance: string }).balance),
  );
}

/** Leave the balances for the opening balances screen. False when the browser would not keep them. */
export function leaveHandoff(handoff: OpeningHandoff): boolean {
  try {
    window.sessionStorage.setItem(OPENING_HANDOFF_KEY, JSON.stringify(handoff));
    return true;
  } catch {
    return false;
  }
}

/** Take what was left, once: it is removed as it is read, and anything that is not a hand-off is
 * ignored. */
export function takeHandoff(): OpeningHandoff | null {
  try {
    const raw = window.sessionStorage.getItem(OPENING_HANDOFF_KEY);
    if (raw === null) return null;
    window.sessionStorage.removeItem(OPENING_HANDOFF_KEY);
    const parsed: unknown = JSON.parse(raw);
    return isHandoff(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
