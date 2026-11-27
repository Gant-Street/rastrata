// Components for Settings, Agents: connecting an agent with one command, and the list of what is connected.
// Export them here; the package index re-exports this file.
export { AgentConnect } from "./connect";
export { AgentConnectedList, agentDisconnectId } from "./connected";
export { AgentDisconnectDialog } from "./disconnect-dialog";
export { type AgentHomeSummary, summarizeTokens } from "./summary";
export { CopyButton, copyText } from "./copy";
export {
  AGENT_CHOICES,
  accessName,
  askFor,
  choicesFor,
  connectCommand,
  connectedLine,
  connectedRows,
  localConnectCommand,
  permissionList,
} from "./text";
export { permissionWords, words as agentWords } from "./words";
export type {
  AgentChoice,
  AgentChoiceId,
  AgentConnectedRow,
  AgentTokenRow,
  OwnerAccess,
  TokenPermission,
  TokenStatus,
} from "./types";
