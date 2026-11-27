/** `@gantstreet/rastrata-plugin-sdk` — MIT-licensed SDK for Rastrata ingestion plugins.
 * Zero runtime dependencies; works in Bun, Node 22+, and Cloudflare Workers. */

export { createEmit, definePlugin } from "./builders.ts";
export {
  isPluginError,
  PluginError,
  type PluginErrorCode,
  type PluginErrorOptions,
} from "./errors.ts";
export { createGuardedHttp, type GuardedHttpOptions } from "./http.ts";
export {
  abs,
  add,
  fromCents,
  fromMinorUnits,
  isMoney,
  money,
  negate,
  subtract,
  sumCents,
  toCents,
} from "./money.ts";
export { formatPreviewTable } from "./preview.ts";
export { redact, sanitizeText } from "./redact.ts";
export type {
  AccountRoleKind,
  AuthSpec,
  BalanceCheck,
  BankLine,
  BankLineInput,
  ClearingSpec,
  ConfigField,
  EmitHelpers,
  EventLeg,
  GuardedHttp,
  InferAuth,
  InferConfig,
  InferRoleKeys,
  IngestLine,
  IngestPlugin,
  JsonResponse,
  LedgerEvent,
  LedgerEventInput,
  LineOrigin,
  NormalizeContext,
  NormalizeResult,
  OfferedAccount,
  PluginCapability,
  PluginManifest,
  PullBatch,
  PullContext,
  RawPayload,
  RoleSpec,
} from "./types.ts";
export {
  assertValidIssues,
  isAllowedDomainEntry,
  isCalendarDate,
  type ValidationIssue,
  validateBalanceCheck,
  validateLine,
  validateManifest,
} from "./validate.ts";
