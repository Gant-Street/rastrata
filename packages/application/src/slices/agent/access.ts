/** Deciding who is calling. The runtime that owns the book supplies the base access; a request can
 * only ever get less than that, never more:
 *
 * - no Authorization header: the owner, unless the runtime locks its owner access, then 401;
 * - `Bearer rst_<id>_<secret>`: that token's permissions, never `provision`, never the owner;
 * - `Bearer rsp_<id>_<secret>`: plugin token scoped strictly to `plugins.status`, `plugins.push`, and plugin raw uploads for one installed plugin;
 * - `Bearer rso_...`: the owner, if it is the runtime's owner key;
 * - anything else that is present is 401. A bad credential never falls back to "no credential". */
import { ApplicationError } from "../../errors.ts";
import type { ApplicationAccess } from "../../agent/principal.ts";
import {
  constantTimeEqual,
  parseAuthorization,
  sha256Hex,
  type GrantablePermission,
} from "../../agent/token.ts";
import type { ApplicationService } from "../../service.ts";
import { memberState } from "../members/store.ts";
import { pluginState, pluginTokenStatus } from "../plugins/store.ts";
import { agentState, tokenStatus } from "./store.ts";

/** What authentication learned that the audit trail needs, filled in as it goes. */
export interface AuthenticationTrace {
  /** Set once a token's secret has matched: only a real holder is recorded in its activity. */
  tokenId?: string;
}

const NO_SUCH_HASH = "0".repeat(64);

const rejected = () =>
  new ApplicationError("token_invalid", "The credentials were not accepted", 401);

export async function authenticate(
  service: ApplicationService,
  base: ApplicationAccess,
  authorization: string | null,
  ownerKey: string | undefined,
  trace: AuthenticationTrace,
): Promise<ApplicationAccess> {
  const ownerAccess = ownerKey ? "key" : "open";
  const owner: ApplicationAccess = { ...base, principal: { kind: "owner" }, ownerAccess };
  const credential = parseAuthorization(authorization);
  switch (credential.kind) {
    case "none":
      if (ownerKey)
        throw new ApplicationError(
          "authentication_required",
          "This service requires credentials: send the owner key or an agent token as a Bearer token",
          401,
        );
      return owner;
    case "invalid":
      throw rejected();
    case "ownerKey": {
      // Compare digests, so the comparison is over equal-length values whatever was sent.
      if (ownerKey && constantTimeEqual(await sha256Hex(credential.key), await sha256Hex(ownerKey)))
        return owner;
      throw rejected();
    }
    case "token": {
      const state = agentState(service);
      const stored = state.getToken(credential.id);
      // Hash and compare even for an unknown id, so timing does not reveal which ids exist.
      const matches = constantTimeEqual(
        await sha256Hex(credential.secret),
        stored?.secretHash ?? NO_SUCH_HASH,
      );
      if (!stored || !matches) throw rejected();
      trace.tokenId = stored.id;
      const status = tokenStatus(stored, state.now());
      if (status === "revoked")
        throw new ApplicationError(
          "token_revoked",
          "This token was revoked. Ask the owner for a new one; do not try another route",
          401,
        );
      if (status === "expired")
        throw new ApplicationError(
          "token_expired",
          "This token has expired. Ask the owner for a new one",
          401,
        );
      state.touch(stored.id);
      return {
        ...base,
        permissions: base.permissions.filter((permission) =>
          (stored.permissions as readonly string[]).includes(permission as GrantablePermission),
        ),
        principal: {
          kind: "token",
          tokenId: stored.id,
          label: stored.label,
          expiresAt: stored.expiresAt,
        },
        ownerAccess,
      };
    }
    case "pluginToken": {
      const state = pluginState(service);
      const stored = state.getToken(credential.id);
      // Hash and compare even for an unknown id, so timing does not reveal which ids exist.
      const matches = constantTimeEqual(
        await sha256Hex(credential.secret),
        stored?.secretHash ?? NO_SUCH_HASH,
      );
      if (!stored || !matches) throw rejected();
      const status = pluginTokenStatus(stored, state.now());
      if (status === "revoked")
        throw new ApplicationError(
          "token_revoked",
          "This plugin token was revoked. Create a new one or reconnect the plugin.",
          401,
        );
      if (status === "expired")
        throw new ApplicationError(
          "token_expired",
          "This plugin token has expired. Create a new one to resume syncing.",
          401,
        );
      state.touchToken(stored.id);
      const principal = {
        kind: "plugin",
        pluginId: stored.pluginId,
        tokenId: stored.id,
        label: stored.label,
        expiresAt: stored.expiresAt,
      } as const;
      const held = base.permissions.filter((p) => p === "read" || p === "draft");
      const readOnlySince = memberState(service).readOnlySince();
      if (readOnlySince !== null) {
        return {
          ...base,
          permissions: held.filter((p) => p === "read"),
          operations: ["plugins.status"],
          readOnly: { since: readOnlySince, held: held.filter((p) => p === "draft") },
          principal,
          ownerAccess,
        };
      }
      return {
        ...base,
        permissions: held,
        operations: ["plugins.status", "plugins.push"],
        principal,
        ownerAccess,
      };
    }
  }
}
