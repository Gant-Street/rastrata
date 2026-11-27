import type { AgentConnectedRow } from "../../src";

/** The moment the stories are told at, so that "Used 2 hours ago" does not move. */
export const now = new Date("2026-11-17T17:00:00.000Z");

export const connected: AgentConnectedRow[] = [
  {
    id: "a1b2c3d4e5f60718",
    name: "Agent on studio-mac",
    permissions: ["read", "draft"],
    status: "active",
    expiresAt: "2027-02-15T17:00:00.000Z",
    lastUsedAt: "2026-11-17T15:00:00.000Z",
  },
  {
    id: "0f1e2d3c4b5a6978",
    name: "Codex weekly routine",
    permissions: ["read", "draft", "post"],
    status: "active",
    expiresAt: "2026-11-27T09:00:00.000Z",
    lastUsedAt: null,
  },
];

/** What an owner sees: everyone's, with whose each is, one made on the command line with permissions of
 * its own, and one that ran out last week. */
export const everyones: AgentConnectedRow[] = [
  ...connected,
  {
    id: "1122334455667788",
    name: "Month-end close",
    permissions: ["read", "draft", "post", "close"],
    status: "active",
    expiresAt: "2027-01-20T09:00:00.000Z",
    lastUsedAt: "2026-11-03T09:00:00.000Z",
    owner: "ana@larimerstudio.test",
  },
  {
    id: "8877665544332211",
    name: "opencode trial",
    permissions: ["read"],
    status: "expired",
    expiresAt: "2026-11-10T09:00:00.000Z",
    lastUsedAt: "2026-10-30T09:00:00.000Z",
  },
];

/** Names that are long, have no spaces, or run right to left: nothing overflows. */
export const awkward: AgentConnectedRow[] = [
  {
    id: "aaaaaaaaaaaaaaaa",
    name: "Agent on a-very-long-hostname-that-somebody-gave-their-build-machine-in-2019",
    permissions: ["read", "draft", "post", "configure", "correct", "close"],
    status: "active",
    expiresAt: "2027-02-15T17:00:00.000Z",
    lastUsedAt: "2026-11-17T16:59:30.000Z",
    owner: "a.person.with.a.long.address@a-long-company-name.example",
  },
  {
    id: "bbbbbbbbbbbbbbbb",
    name: "سجل الوكيل",
    permissions: ["read"],
    status: "active",
    expiresAt: "2027-02-15T17:00:00.000Z",
    lastUsedAt: null,
  },
];
