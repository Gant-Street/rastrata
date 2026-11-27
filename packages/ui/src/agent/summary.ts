/** What Home says about agent access, worked out from the token list. Pure: the clock is passed in so
 * a test can fix it, and every date goes through the shared formatter. */
import { formatAge } from "../format";
import type { AgentTokenRow, OwnerAccess } from "./types";

/** A token that ends within this many days needs a person: an agent that loses access in the middle
 * of a weekly routine is a surprise nobody wants. */
export const EXPIRING_SOON_DAYS = 14;

export interface AgentHomeSummary {
  /** Tokens that work now. */
  readonly active: number;
  /** When a token was last used, in words ("3 hours ago"), or null if none ever was. */
  readonly lastUsed: string | null;
  /** Active tokens that end within `EXPIRING_SOON_DAYS`. */
  readonly expiringSoon: number;
  readonly ownerAccess: OwnerAccess;
}

const DAY = 86_400_000;

export function summarizeTokens(
  tokens: readonly Pick<AgentTokenRow, "status" | "expiresAt" | "lastUsedAt">[],
  ownerAccess: OwnerAccess,
  now: Date,
): AgentHomeSummary {
  const active = tokens.filter((token) => token.status === "active");
  let latest: string | null = null;
  for (const token of tokens) {
    if (token.lastUsedAt === null) continue;
    if (latest === null || Date.parse(token.lastUsedAt) > Date.parse(latest))
      latest = token.lastUsedAt;
  }
  return {
    active: active.length,
    lastUsed: latest === null ? null : formatAge(latest, now),
    expiringSoon: active.filter(
      (token) => Date.parse(token.expiresAt) - now.getTime() <= EXPIRING_SOON_DAYS * DAY,
    ).length,
    ownerAccess,
  };
}
