import {
  DEFAULT_TOKEN_DAYS,
  GRANTABLE_PERMISSIONS,
  MAX_LABEL_LENGTH,
  MAX_TOKEN_DAYS,
} from "../../agent/token.ts";
import {
  array,
  id,
  nullable,
  object,
  operation,
  page,
  ref,
  revision,
  text,
  type Schema,
} from "../../schema-kit.ts";
import type { SliceSchema } from "../types.ts";

const grantable: Schema = { type: "string", enum: [...GRANTABLE_PERMISSIONS] };
const instant = text(40);

/** Scoped agent tokens. The owner creates them; an agent presents one as a Bearer token. These
 * operations all need `provision`, which no token can hold, so an agent can never create, widen
 * or revoke a token (its own included). */
export const agentSchema: SliceSchema = {
  name: "agent",
  definitions: {
    AgentToken: object({
      id,
      /** The leading part of the bearer string, `rst_<id>`, so the owner can match a token in a
       * list to the one in an environment variable. The secret is never part of it. */
      prefix: text(24),
      label: { ...text(MAX_LABEL_LENGTH), minLength: 1 },
      permissions: { ...array(grantable, GRANTABLE_PERMISSIONS.length), minItems: 1 },
      status: { type: "string", enum: ["active", "revoked", "expired"] },
      createdAt: instant,
      createdBy: text(40),
      expiresAt: instant,
      revokedAt: nullable(instant),
      revokedReason: nullable(text(200)),
      lastUsedAt: nullable(instant),
    }),
    AgentTokenCreateInput: object(
      {
        label: { ...text(MAX_LABEL_LENGTH), minLength: 1 },
        permissions: { ...array(grantable, GRANTABLE_PERMISSIONS.length), minItems: 1 },
        expiresInDays: { type: "integer", minimum: 1, maximum: MAX_TOKEN_DAYS },
      },
      ["label", "permissions"],
    ),
    AgentTokenCreated: object({
      token: ref("AgentToken"),
      /** The bearer string. Present only on the call that created the token and never stored: a
       * retry of the same operation returns null. Lost it? Revoke the token and create another. */
      secret: nullable(text(80)),
    }),
    AgentTokenListInput: object({ active: { type: "boolean" } }, []),
    AgentTokenList: object({
      tokens: array(ref("AgentToken"), 1000),
      /** What a token may be given. `provision` is never among them. */
      grantable: array(grantable, GRANTABLE_PERMISSIONS.length),
      defaultExpiryDays: { type: "integer", minimum: 1 },
      maxExpiryDays: { type: "integer", minimum: 1 },
      /** `open`: any program on this computer can act as the owner without a token, so a token
       * bounds only an agent that uses it. `key`: the owner must present the owner key. */
      ownerAccess: { type: "string", enum: ["open", "key"] },
    }),
    AgentTokenRevokeInput: object({ tokenId: id, reason: text(200) }, ["tokenId"]),
    AgentTokenActivityInput: object({ tokenId: id, page }, []),
    AgentTokenEvent: object({
      seq: revision,
      at: instant,
      tokenId: id,
      label: nullable(text(MAX_LABEL_LENGTH)),
      operation: text(100),
      operationId: nullable(id),
      outcome: { type: "string", enum: ["ok", "denied", "failed"] },
      code: nullable(text(60)),
      status: { type: "integer", minimum: 100, maximum: 599 },
    }),
    AgentTokenActivity: object({
      count: { type: "integer", minimum: 0 },
      page,
      pageSize: { type: "integer", minimum: 1 },
      events: array(ref("AgentTokenEvent"), 25),
    }),
  },
  operations: [
    operation(
      "tokens.create",
      `Create a scoped agent token. The secret is returned once and never stored (only its hash is kept); a retry of the same operation returns the token without it. A token holds a subset of read, draft, post, configure, correct and close, never provision, and expires in ${DEFAULT_TOKEN_DAYS} days unless you choose up to ${MAX_TOKEN_DAYS}. Needs provision, so only the owner can do this.`,
      "provision",
      "AgentTokenCreateInput",
      true,
      "AgentTokenCreated",
    ),
    operation(
      "tokens.list",
      "List agent tokens with their access, expiry, last use and status, and whether this service requires the owner key. Never returns a secret. Needs provision.",
      "provision",
      "AgentTokenListInput",
      false,
      "AgentTokenList",
    ),
    operation(
      "tokens.revoke",
      "Revoke an agent token. It stops working on its next request and cannot be restored; create a new token instead. Revoking twice changes nothing. Needs provision.",
      "provision",
      "AgentTokenRevokeInput",
      true,
      "AgentToken",
    ),
    operation(
      "tokens.activity",
      "Page recent requests made with agent tokens, newest first: when, which token, which operation and whether it was allowed. Only requests made with a token appear; the owner's own are not recorded. Needs provision.",
      "provision",
      "AgentTokenActivityInput",
      false,
      "AgentTokenActivity",
    ),
  ],
};
