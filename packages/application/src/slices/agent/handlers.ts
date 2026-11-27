import { describePrincipal } from "../../agent/principal.ts";
import {
  DEFAULT_TOKEN_DAYS,
  GRANTABLE_PERMISSIONS,
  MAX_TOKEN_DAYS,
  TOKEN_PREFIX,
  expiryFrom,
  issueToken,
  normalizeLabel,
  normalizePermissions,
} from "../../agent/token.ts";
import type { SliceHandlers } from "../types.ts";
import { ACTIVITY_PAGE_SIZE, agentState, tokenStatus, type StoredToken } from "./store.ts";

/** The wire shape of a token: everything the owner needs, never the secret or its hash. */
function present(token: StoredToken, now: Date) {
  return {
    id: token.id,
    prefix: `${TOKEN_PREFIX}${token.id}`,
    label: token.label,
    permissions: [...token.permissions],
    status: tokenStatus(token, now),
    createdAt: token.createdAt,
    createdBy: token.createdBy,
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
    revokedReason: token.revokedReason,
    lastUsedAt: token.lastUsedAt,
  };
}

export const agentHandlers: SliceHandlers = {
  "tokens.create": async (input, { service, access, operationId }) => {
    const state = agentState(service);
    const label = normalizeLabel(input.label as string);
    const permissions = normalizePermissions(input.permissions as string[], access.permissions);
    const now = state.now();
    const expiresAt = expiryFrom(now, input.expiresInDays as number | undefined);
    const issued = await issueToken();
    let secret: string | null = null;
    // The retained response holds the token's id only. The secret is handed back by the call that
    // made it and is stored nowhere, so a replay of this operation cannot reveal it.
    const created = service.retainRequest(operationId, "tokens.create", input, () => {
      secret = issued.token;
      return {
        id: state.insertToken({
          id: issued.id,
          label,
          permissions,
          secretHash: issued.secretHash,
          createdAt: now.toISOString(),
          createdBy: describePrincipal(access.principal),
          expiresAt,
          operationId,
        }).id,
      };
    });
    return { token: present(state.requireToken(created.id), state.now()), secret };
  },

  "tokens.list": (input, { service, access }) => {
    const state = agentState(service);
    const now = state.now();
    const tokens = state
      .listTokens()
      .filter((token) => input.active !== true || tokenStatus(token, now) === "active");
    return {
      tokens: tokens.map((token) => present(token, now)),
      grantable: [...GRANTABLE_PERMISSIONS],
      defaultExpiryDays: DEFAULT_TOKEN_DAYS,
      maxExpiryDays: MAX_TOKEN_DAYS,
      ownerAccess: access.ownerAccess ?? "open",
    };
  },

  "tokens.revoke": (input, { service, operationId }) => {
    const state = agentState(service);
    const reason =
      typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : null;
    const revoked = service.retainRequest(operationId, "tokens.revoke", input, () => ({
      id: state.revoke(input.tokenId as string, reason).id,
    }));
    return present(state.requireToken(revoked.id), state.now());
  },

  "tokens.activity": (input, { service }) => {
    const state = agentState(service);
    const page = (input.page as number | undefined) ?? 1;
    const { count, events } = state.activity(input.tokenId as string | undefined, page);
    return { count, page, pageSize: ACTIVITY_PAGE_SIZE, events };
  },
};
