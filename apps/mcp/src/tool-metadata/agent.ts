import type { OperationMetadata } from "./types.ts";

const secrets =
  "Token management belongs to the owner. A token's secret would land in the conversation, and a model that could create or revoke tokens could widen or remove its own access.";

/** MCP tool metadata for the operations the agent slice adds, keyed by operation name. Token
 * management is never a tool: the owner uses the web app or the CLI. */
export const agentTools: Readonly<Record<string, OperationMetadata>> = {
  "tokens.create": { hidden: true, reason: secrets },
  "tokens.list": { hidden: true, reason: secrets },
  "tokens.revoke": { hidden: true, reason: secrets },
  "tokens.activity": { hidden: true, reason: secrets },
};
