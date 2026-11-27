import { describe, expect, test } from "bun:test";
import { EXPIRING_SOON_DAYS, summarizeTokens } from "../src/agent/summary";
import { permissionWords } from "../src/agent/words";

// What the Agents line on Home says is worked out here from the token list, with the clock passed in.
const now = new Date("2026-10-04T12:00:00Z");
const day = 86_400_000;
const at = (offset: number) => new Date(now.getTime() + offset).toISOString();

const token = (
  status: "active" | "revoked" | "expired",
  expiresInDays: number,
  lastUsed: string | null = null,
) => ({ status, expiresAt: at(expiresInDays * day), lastUsedAt: lastUsed });

describe("the Agents line on Home", () => {
  test("no tokens at all: nothing has access, and nothing was used", () => {
    expect(summarizeTokens([], "key", now)).toEqual({
      active: 0,
      lastUsed: null,
      expiringSoon: 0,
      ownerAccess: "key",
    });
  });

  test("only tokens that work are counted, and an ended token is never one of them", () => {
    const summary = summarizeTokens(
      [token("active", 60), token("revoked", 60), token("expired", -2), token("active", 30)],
      "open",
      now,
    );
    expect(summary.active).toBe(2);
    expect(summary.expiringSoon).toBe(0);
    expect(summary.ownerAccess).toBe("open");
  });

  test("a token that ends within two weeks is expiring; one that ends later, or already ended, is not", () => {
    const summary = summarizeTokens(
      [
        token("active", 3),
        token("active", EXPIRING_SOON_DAYS),
        token("active", EXPIRING_SOON_DAYS + 1),
        token("revoked", 3),
        token("expired", -1),
      ],
      "key",
      now,
    );
    expect(summary.active).toBe(3);
    expect(summary.expiringSoon).toBe(2);
  });

  test("the most recent use is the one that is reported, in words from the shared formatter", () => {
    const recent = summarizeTokens(
      [
        token("active", 60, at(-3 * 3_600_000)),
        token("active", 60, at(-30 * 60_000)),
        token("revoked", 60, at(-5 * day)),
        token("active", 60, null),
      ],
      "key",
      now,
    );
    expect(recent.lastUsed).toBe("30 minutes ago");
    // A revoked token that was used last still counts: it is when an agent last used the books.
    const revokedLast = summarizeTokens(
      [token("active", 60, at(-5 * day)), token("revoked", 60, at(-2 * 3_600_000))],
      "key",
      now,
    );
    expect(revokedLast.lastUsed).toBe("2 hours ago");
  });

  test("a clock that is behind the service does not make a use read as negative time", () => {
    expect(summarizeTokens([token("active", 60, at(5 * 60_000))], "key", now).lastUsed).toBe(
      "just now",
    );
  });
});

describe("the words in the token form", () => {
  test("every permission says what it lets an agent do, and which ones change the books", () => {
    for (const [name, entry] of Object.entries(permissionWords)) {
      expect(entry.name.toLowerCase(), name).toBe(name);
      expect(entry.effect.length, name).toBeGreaterThan(20);
    }
    expect(Object.values(permissionWords).filter((entry) => entry.changesBooks)).toHaveLength(4);
  });
});
