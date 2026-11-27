import { ApplicationError } from "../errors.ts";
import type { BusinessPermission } from "../schema-kit.ts";
import type { WorkspaceRole } from "./member.ts";

/** Who is calling the application, as the runtime that owns the book has decided. A request body
 * can never choose or change its principal; see ApplicationHttp. */
export type AccessPrincipal =
  | { readonly kind: "owner" }
  | {
      readonly kind: "token";
      /** The token's public identifier, the `<id>` of `rst_<id>_<secret>`. */
      readonly tokenId: string;
      readonly label: string;
      readonly expiresAt: string;
    }
  | {
      /** A person of the book's workspace, whom the control plane vouched for with a signed token that the
       * runtime checked. Their role is the one in this book's own member table. */
      readonly kind: "member";
      /** The control plane's identifier of the person. */
      readonly userId: string;
      readonly role: WorkspaceRole;
    }
  | {
      /** The control plane acting for itself (adding and removing members): never a person. */
      readonly kind: "service";
      readonly name: string;
    };

/** How the runtime recognises its owner.
 * - `open`: a request that carries no credentials is the owner (loopback development mode).
 * - `key`: the owner must present the owner key; header-less requests are refused. */
export type OwnerAccessMode = "open" | "key";

/** A short label for provenance fields: "owner" or "agent:<tokenId>". */
export function describePrincipal(principal: AccessPrincipal | undefined): string {
  switch (principal?.kind) {
    case "token":
      return `agent:${principal.tokenId}`;
    case "member":
      return `member:${principal.userId}`;
    case "service":
      return `service:${principal.name}`;
    default:
      return "owner";
  }
}

/** What one request may do. The runtime that owns the book supplies it; a request body cannot
 * select its actor or enlarge its permissions. */
export interface ApplicationAccess {
  readonly bookId: string;
  readonly permissions: readonly BusinessPermission[];
  /** Who is calling. Absent means the runtime's own operator, the owner. */
  readonly principal?: AccessPrincipal;
  /** How the runtime recognises its owner. Absent means `open`. */
  readonly ownerAccess?: OwnerAccessMode;
  /** When present, the only operations this caller may call, whatever its permissions allow (the control plane may change who
   * is in the book and nothing else). Absent means every operation the permissions allow. */
  readonly operations?: readonly string[];
  /** Present when the book is read-only (its workspace has no subscription): since when, and what the person would hold if it were not, so that a refusal can say the true reason.
   * `permissions` and `operations` are already cut; this only explains the cut. */
  readonly readOnly?: { readonly since: string; readonly held: readonly BusinessPermission[] };
}

/** An operation only the control plane may call (it moves state in from outside, or says how the workspace stands). A person, an owner and an agent hold `provision` too (to make agent
 * keys, say), so the permission alone does not say who is calling. */
export function requireControlPlane(access: ApplicationAccess, operation: string): void {
  if (access.principal?.kind !== "service")
    throw new ApplicationError(
      "service_only",
      `${operation} can only be called by the control plane's key.`,
      403,
    );
}
