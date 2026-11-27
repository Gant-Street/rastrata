/** What a person is in a workspace, and the token the control plane gives them for it. Pure and portable (standard
 * globals only), so the same code runs in the pod that checks a token and in the Worker that makes one.
 *
 * The design is docs/reference/program/hosting/auth-design.md. The truth about who may do what is the member table
 * inside each book; the control plane's own table of memberships is only the way to a token. */
import type { BusinessPermission } from "../schema-kit.ts";
import {
  AGENT_KEY_ID,
  GRANTABLE_PERMISSIONS,
  type GrantablePermission,
  normalizeLabel,
} from "./token.ts";

/** What a person is in a workspace. */
export const WORKSPACE_ROLES = ["owner", "admin", "accountant", "member"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** What each role may do in the book, in the application's own permissions. `provision` (creating books, managing
 * tokens and members) is the owner's alone. Whether an accountant may `configure` is the founder's to change. */
export const ROLE_PERMISSIONS: Readonly<Record<WorkspaceRole, readonly BusinessPermission[]>> = {
  owner: ["read", "draft", "post", "configure", "correct", "close", "provision"],
  admin: ["read", "draft", "post", "configure", "correct", "close"],
  accountant: ["read", "draft", "post", "correct", "close"],
  member: ["read", "draft"],
};

export const isWorkspaceRole = (value: unknown): value is WorkspaceRole =>
  typeof value === "string" && (WORKSPACE_ROLES as readonly string[]).includes(value);

/** The signed token a signed-in person gets for one workspace: who they are (`sub`), which workspace (`wid`) and
 * which book it is (`bid`). It says nothing of the role: the pod finds that in the book's member table, so a role
 * change or a removal takes effect at the next request and not at the token's expiry. */
export const MEMBER_TOKEN = {
  /** The audience the pod accepts. */
  audience: "rastrata-app",
  /** How long a token lives, in seconds. The page asks for the next one a little before. */
  ttlSeconds: 600,
  /** The only algorithm the pod accepts: a key pair, so the pod holds no secret that could make a token. */
  algorithm: "EdDSA",
} as const;

/** Who issues tokens: the control plane's own address, `<origin>/auth`. */
export const memberTokenIssuer = (origin: string): string => `${origin.replace(/\/+$/, "")}/auth`;

/** Where the public keys that check tokens are published. */
export const memberTokenKeysUrl = (origin: string): string => `${memberTokenIssuer(origin)}/jwks`;

/** How long the token an agent key is exchanged for lives, in seconds: shorter than a person's, because revoking a key takes effect at the next exchange and a token already made
 * outlives it by up to this long. */
export const AGENT_TOKEN_TTL_SECONDS = 300;

/** What a token made for an agent key adds to the claims of a person's: which key it is (`agt`), what the key may do (`scp`, never more than the person may), what the person called it
 * (`knm`) and when the key ends (`kex`). The pod gives such a token the person's role in the book with only these permissions, and records the key and not the person as the actor,
 * under the name and with the end the person knows it by (the token's own five minutes are the front door's business and are not told to the book). A token that carries some of the
 * four and not all is not good. */
export interface AgentClaims {
  readonly keyId: string;
  readonly scopes: readonly GrantablePermission[];
  /** The key's name: one line of plain text, 1 to 80 characters. */
  readonly name: string;
  /** When the key ends, ISO 8601: the key's own, which a person can read in a list, and not the token's. */
  readonly expiresAt: string;
}

/** A key's name as a token carries it: what `normalizeLabel` would make of it and no different (one line, 1 to 80 characters, no control character, no direction override, nothing to trim). */
export function isKeyName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return normalizeLabel(value) === value;
  } catch {
    return false;
  }
}

export interface MemberTokenClaims {
  readonly sub: string;
  readonly wid: string;
  readonly bid: string;
  /** Present when the token was made for an agent key. */
  readonly agent?: AgentClaims;
}

/** An identifier of a user, a workspace or a book as the control plane makes them: letters, digits, `_` and `-`. */
const IDENTIFIER = /^[A-Za-z0-9_-]{8,64}$/;

/** Whether `value` is the name of a book as the control plane makes them. A pod holds any name a caller gives it to this shape before it uses it for
 * anything: it becomes a file name in the cache folder and a key in the object store, and this shape has no dot and no slash. */
export const isBookIdentifier = (value: string): boolean => IDENTIFIER.test(value);

/** What an agent key may be given, as a token carries it: the grantable permissions once each, `read` among them. Null for anything else. */
export function agentScopes(value: unknown): readonly GrantablePermission[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > GRANTABLE_PERMISSIONS.length)
    return null;
  const wanted = new Set<unknown>(value);
  if (wanted.size !== value.length || !wanted.has("read")) return null;
  for (const scope of wanted)
    if (!(GRANTABLE_PERMISSIONS as readonly unknown[]).includes(scope)) return null;
  // The order a person's permissions are listed in.
  return GRANTABLE_PERMISSIONS.filter((permission) => wanted.has(permission));
}

/** The claims of a verified token's payload, or null when one is missing or is not an identifier. */
export function memberClaims(payload: Readonly<Record<string, unknown>>): MemberTokenClaims | null {
  const { sub, wid, bid, agt, scp, knm, kex } = payload;
  for (const value of [sub, wid, bid]) {
    if (typeof value !== "string" || !IDENTIFIER.test(value)) return null;
  }
  const base = { sub: sub as string, wid: wid as string, bid: bid as string };
  if (agt === undefined && scp === undefined && knm === undefined && kex === undefined) return base;
  // A token for an agent key says which key, what it may do, what it is called and when it ends: all of it or none.
  const scopes = agentScopes(scp);
  if (typeof agt !== "string" || !AGENT_KEY_ID.test(agt) || scopes === null) return null;
  if (
    !isKeyName(knm) ||
    typeof kex !== "string" ||
    kex.length > 40 ||
    Number.isNaN(Date.parse(kex))
  )
    return null;
  return {
    ...base,
    agent: { keyId: agt, scopes, name: knm, expiresAt: new Date(Date.parse(kex)).toISOString() },
  };
}

/** The control plane's own credential to a pod: `rsv_` and 43 characters, 256 random bits. The pod keeps only the SHA-256 of the
 * keys it takes; the control plane holds the key as a secret. It names no person: what it may do is read who is in the book and
 * change it (a `service` principal with `read` and `provision`). */
export const SERVICE_KEY_PREFIX = "rsv_";
const serviceKeyPattern = /^rsv_[A-Za-z0-9_-]{43}$/;

export const isServiceKey = (value: string): boolean => serviceKeyPattern.test(value);

/** The cookie the control plane sets, beside the session, when a person has signed in: a hint that lets a pod send them the application and not the sign-in page.
 * A pod cannot check the session (it never calls the control plane on the request path), and a hint can be made by anyone, so it unlocks **nothing**: the page it
 * leads to is public code, and every request for data still needs a signed token. A person who forges it sees the application's shell with nothing in it and is asked
 * to sign in at the first request. Without it a stranger is sent the sign-in page and never the application, which is what the founder asked for. */
export const MEMBER_HINT_COOKIE = "__Host-rastrata_in";

/** Whether a `Cookie` header carries the hint. */
export const hasMemberHint = (cookieHeader: string | null): boolean =>
  (cookieHeader ?? "").split(";").some((part) => part.trim() === `${MEMBER_HINT_COOKIE}=1`);

/** How the control plane speaks to a pod with its key: the application's request envelope and the header that names the book. The values are the
 * application's own (`APPLICATION_API_VERSION` in schema.ts, which a test holds this to), kept here so that the Worker that makes the call does not carry the
 * application's schema in its bundle. */
export const SERVICE_CALL = {
  version: "rastrata-application-v1",
  /** Every book's application is `local-book` to its own requests; the book a pod serves is chosen by the header. */
  applicationBookId: "local-book",
  bookHeader: "x-rastrata-book",
} as const;

export function issueServiceKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const text = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `${SERVICE_KEY_PREFIX}${text}`;
}
