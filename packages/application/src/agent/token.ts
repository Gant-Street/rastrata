/** Scoped agent tokens: their format, generation, hashing and parsing. Pure and portable: Web
 * Crypto and standard globals only, so the same code runs in Bun, a browser and a Worker.
 *
 * A token is `rst_<id>_<secret>`:
 * - `<id>` is 16 hex characters, public. It names the token in lists and in the audit trail and is
 *   how the server finds the stored row, so verification never searches by secret.
 * - `<secret>` is 43 base64url characters (256 random bits). It is shown once and never stored;
 *   only its SHA-256 is kept. A secret that long needs no salt or slow hash, and the digest is
 *   compared in constant time, so there is nothing to time. */
import { ApplicationError } from "../errors.ts";
import type { BusinessPermission } from "../schema-kit.ts";

export const TOKEN_PREFIX = "rst_";
/** The owner key (opt-in lock) has its own prefix so it can never be mistaken for a token. */
export const OWNER_KEY_PREFIX = "rso_";

/** What an agent token may carry. `provision` never: it creates books and manages tokens, so a
 * token that held it could mint more tokens. */
export const GRANTABLE_PERMISSIONS = [
  "read",
  "draft",
  "post",
  "configure",
  "correct",
  "close",
] as const satisfies readonly BusinessPermission[];
export type GrantablePermission = (typeof GRANTABLE_PERMISSIONS)[number];

/** Presets the owner is offered. The default for an agent is to read and draft; the owner posts. */
export const TOKEN_PRESETS: Readonly<Record<string, readonly GrantablePermission[]>> = {
  "read-only": ["read"],
  draft: ["read", "draft"],
  bookkeeper: ["read", "draft", "post"],
};

export const DEFAULT_TOKEN_DAYS = 90;
export const MAX_TOKEN_DAYS = 365;
export const MAX_LABEL_LENGTH = 80;

const tokenPattern = /^rst_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
const ownerKeyPattern = /^rso_[A-Za-z0-9_-]{43}$/;

const random = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length));
const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

export async function sha256Hex(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

/** Compare two strings without stopping at the first difference. Callers compare digests of equal
 * length; a length difference is not a secret. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++)
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

export interface IssuedToken {
  readonly id: string;
  /** The full bearer string. Show it once; never store or log it. */
  readonly token: string;
  /** SHA-256 of the secret part, hex. This is what is stored. */
  readonly secretHash: string;
}

export async function issueToken(): Promise<IssuedToken> {
  const id = hex(random(8));
  const secret = base64Url(random(32));
  return { id, token: `${TOKEN_PREFIX}${id}_${secret}`, secretHash: await sha256Hex(secret) };
}

/** The agent key of a hosted workspace (docs/reference/program/hosting/agents.md): `rsa_<id>_<secret>`. It is a person's credential for a program that acts for them, and unlike the
 * token above it is not kept in a book: the control plane keeps the id and the SHA-256 of the secret, and exchanges the key for a short-lived signed token that the pod checks from
 * the published keys alone. `<id>` is public (it names the key in lists and in the audit trail); `<secret>` is 256 random bits, shown once. */
export const AGENT_KEY_PREFIX = "rsa_";
const agentKeyPattern = /^rsa_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
/** The public identifier of an agent key. */
export const AGENT_KEY_ID = /^[0-9a-f]{16}$/;

export interface IssuedAgentKey {
  readonly id: string;
  /** The whole key. Show it once; never store or log it. */
  readonly key: string;
  /** SHA-256 of the secret part, hex. This is what is stored. */
  readonly secretHash: string;
}

export async function issueAgentKey(): Promise<IssuedAgentKey> {
  const id = hex(random(8));
  const secret = base64Url(random(32));
  return { id, key: `${AGENT_KEY_PREFIX}${id}_${secret}`, secretHash: await sha256Hex(secret) };
}

/** The id and the secret of an agent key, or null for anything that is not one. */
export function parseAgentKey(
  value: string,
): { readonly id: string; readonly secret: string } | null {
  const match = agentKeyPattern.exec(value);
  return match ? { id: match[1] as string, secret: match[2] as string } : null;
}

/** The code that connects an agent to a hosted workspace with one command (`rastrata connect <code>`): made on the workspace's Agents page by a person who has just signed in,
 * good once and for ten minutes, and exchanged by the command line for an agent key that it keeps. It is twelve characters of Crockford's alphabet (no I, L, O or U; sixty random
 * bits), written in three groups so that it can be read aloud; what is kept is a SHA-256 of its twelve characters. */
export const AGENT_CODE_TTL_SECONDS = 600;
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 12;

export interface IssuedAgentCode {
  /** The code as a person reads it, `XXXX-XXXX-XXXX`. Show it once; never store or log it. */
  readonly code: string;
  /** What is stored of it (see `agentCodeHash`). */
  readonly codeHash: string;
}

/** The twelve characters of a code however it was typed (lower case, with or without its hyphens, a letter O for a zero, an I or an L for a one), or null for anything else. */
export function normalizeAgentCode(value: string): string | null {
  const plain = value
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replaceAll("O", "0")
    .replace(/[IL]/g, "1");
  if (plain.length !== CODE_LENGTH) return null;
  for (const character of plain) if (!CODE_ALPHABET.includes(character)) return null;
  return plain;
}

export async function agentCodeHash(normalized: string): Promise<string> {
  return sha256Hex(`rastrata-agent-code:${normalized}`);
}

export async function issueAgentCode(): Promise<IssuedAgentCode> {
  // Five bits a character: 256 is a multiple of 32, so a byte's remainder is an even draw.
  const plain = Array.from(random(CODE_LENGTH), (byte) => CODE_ALPHABET[byte % 32]).join("");
  return {
    code: `${plain.slice(0, 4)}-${plain.slice(4, 8)}-${plain.slice(8)}`,
    codeHash: await agentCodeHash(plain),
  };
}

export function issueOwnerKey(): string {
  return `${OWNER_KEY_PREFIX}${base64Url(random(32))}`;
}

export function isOwnerKey(value: string): boolean {
  return ownerKeyPattern.test(value);
}

/** What an Authorization header presented. `none` means the header is absent. Anything present
 * that is not a well-formed credential is `invalid`: the server answers 401 and never treats it
 * as no credentials at all. */
export type PresentedCredential =
  | { readonly kind: "none" }
  | { readonly kind: "token"; readonly id: string; readonly secret: string }
  | { readonly kind: "ownerKey"; readonly key: string }
  | { readonly kind: "invalid" };

export function parseAuthorization(header: string | null): PresentedCredential {
  if (header === null) return { kind: "none" };
  const match = /^Bearer +(\S+)$/i.exec(header);
  const credential = match?.[1];
  if (!credential) return { kind: "invalid" };
  const token = tokenPattern.exec(credential);
  if (token) return { kind: "token", id: token[1] as string, secret: token[2] as string };
  if (ownerKeyPattern.test(credential)) return { kind: "ownerKey", key: credential };
  return { kind: "invalid" };
}

/** Labels are shown in the app and the CLI. Refuse control and direction-override characters so a
 * label cannot move or hide text around it. */
export function normalizeLabel(value: string): string {
  const label = value.trim();
  if (
    label.length < 1 ||
    label.length > MAX_LABEL_LENGTH ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects
    /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/.test(label)
  )
    throw new ApplicationError(
      "invalid_label",
      `Use a label of 1 to ${MAX_LABEL_LENGTH} characters with no control characters`,
    );
  return label;
}

/** The permissions a token may be created with, in canonical order. Never `provision`, and never
 * more than the creator holds, so creating a token can only hand out what the caller has. */
export function normalizePermissions(
  requested: readonly string[],
  creatorHolds: readonly BusinessPermission[],
): readonly GrantablePermission[] {
  const wanted = new Set(requested);
  for (const permission of wanted) {
    if (!(GRANTABLE_PERMISSIONS as readonly string[]).includes(permission))
      throw new ApplicationError(
        "permission_not_grantable",
        permission === "provision"
          ? "A token cannot hold provision: it would let the token create more tokens"
          : `${permission} is not a permission a token can hold`,
        400,
      );
    if (!creatorHolds.includes(permission as BusinessPermission))
      throw new ApplicationError(
        "permission_not_held",
        `A token cannot be given ${permission}: the caller does not hold it`,
        403,
      );
  }
  if (!wanted.has("read"))
    throw new ApplicationError(
      "invalid_input",
      "A token needs read permission; without it the agent cannot even see the book",
      400,
    );
  return GRANTABLE_PERMISSIONS.filter((permission) => wanted.has(permission));
}

export function expiryFrom(now: Date, days: number | undefined): string {
  const lifetime = days ?? DEFAULT_TOKEN_DAYS;
  if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > MAX_TOKEN_DAYS)
    throw new ApplicationError(
      "invalid_input",
      `Choose an expiry from 1 to ${MAX_TOKEN_DAYS} days`,
      400,
    );
  return new Date(now.getTime() + lifetime * 86_400_000).toISOString();
}
