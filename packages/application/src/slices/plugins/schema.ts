import {
  array,
  date,
  hash,
  nullable,
  object,
  operation,
  ref,
  signedMoney,
  text,
  type Schema,
} from "../../schema-kit.ts";
import type { SliceSchema } from "../types.ts";

/** Contract schemas for `plugins.*` — strictly named $ref definitions so both TypeScript and Go
 * client bindings generate clean, idiomatic types. */

const pluginSlug: Schema = {
  type: "string",
  minLength: 3,
  maxLength: 32,
  pattern: "^[a-z][a-z0-9-]{1,30}[a-z0-9]$",
};
const semver: Schema = {
  type: "string",
  minLength: 5,
  maxLength: 40,
  pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$",
};
const roleKey: Schema = {
  type: "string",
  minLength: 3,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9.-]{1,62}[a-z0-9]$",
};
const currency: Schema = { type: "string", pattern: "^[A-Z]{3}$" };
const tokenId: Schema = { type: "string", pattern: "^[0-9a-f]{16}$" };

const definitions: Record<string, Schema> = {
  PluginRoleSpec: object(
    {
      key: roleKey,
      label: text(80),
      kind: { type: "string", enum: ["asset", "liability", "equity", "income", "expense"] },
      required: { type: "boolean" },
      defaultRoleKey: roleKey,
    },
    ["key", "label", "kind", "required"],
  ),
  PluginClearingSpec: object(
    {
      role: roleKey,
      windowDays: { type: "integer", minimum: 1, maximum: 30 },
    },
    ["role"],
  ),
  PluginManifestInput: object(
    {
      id: pluginSlug,
      version: semver,
      name: text(60),
      description: text(160),
      domains: array(text(253), 20),
      authKind: { type: "string", enum: ["api_key", "oauth2", "file", "none"] },
      authLabel: text(80),
      authEnvVar: text(64),
      roles: array(ref("PluginRoleSpec"), 40),
      clearing: ref("PluginClearingSpec"),
    },
    ["id", "version", "name", "description", "domains", "authKind"],
  ),
  PluginConfigEntry: object({
    key: text(64),
    value: text(500),
  }),
  PluginRoleBinding: object({
    role: roleKey,
    accountId: text(128),
  }),
  PluginAccountBinding: object(
    {
      accountKey: text(200),
      ledgerAccountId: text(128),
      startOn: date,
    },
    ["accountKey", "ledgerAccountId"],
  ),
  PluginResolvedRole: object(
    {
      role: roleKey,
      label: text(80),
      kind: { type: "string", enum: ["asset", "liability", "equity", "income", "expense"] },
      required: { type: "boolean" },
      accountId: nullable(text(128)),
      source: { type: "string", enum: ["override", "roleKey", "unmapped"] },
      problem: nullable(text(300)),
    },
    ["role", "label", "kind", "required", "accountId", "source", "problem"],
  ),
  PluginCursorView: object({
    sourceKey: text(200),
    cursor: nullable(text(500)),
    lastSyncAt: text(40),
    lastError: nullable(text(500)),
  }),
  PluginSummaryView: object({
    pluginId: pluginSlug,
    version: semver,
    name: text(60),
    description: text(160),
    enabled: { type: "boolean" },
    ready: { type: "boolean" },
    domains: array(text(253), 20),
    authKind: { type: "string", enum: ["api_key", "oauth2", "file", "none"] },
    missingRoles: array(roleKey, 40),
    lastSyncAt: nullable(text(40)),
    installedAt: text(40),
    updatedAt: text(40),
  }),
  PluginDetailView: object({
    pluginId: pluginSlug,
    version: semver,
    name: text(60),
    description: text(160),
    enabled: { type: "boolean" },
    ready: { type: "boolean" },
    domains: array(text(253), 20),
    authKind: { type: "string", enum: ["api_key", "oauth2", "file", "none"] },
    authLabel: nullable(text(80)),
    authEnvVar: nullable(text(64)),
    config: array(ref("PluginConfigEntry"), 50),
    roles: array(ref("PluginResolvedRole"), 40),
    accountMap: array(ref("PluginAccountBinding"), 100),
    clearing: nullable(ref("PluginClearingSpec")),
    cursors: array(ref("PluginCursorView"), 100),
    installedAt: text(40),
    updatedAt: text(40),
  }),
  PluginEventLegInput: object(
    {
      role: roleKey,
      amount: signedMoney,
      memo: text(300),
    },
    ["role", "amount"],
  ),
  PluginKeyValue: object({
    key: text(64),
    value: text(200),
  }),
  PluginBankLineInput: object(
    {
      accountKey: text(200),
      providerId: text(200),
      rawIndex: { type: "integer", minimum: 0, maximum: 1000000 },
      postedOn: date,
      amount: signedMoney,
      currency,
      description: text(1000),
      counterparty: text(200),
      reference: text(200),
      runningBalance: signedMoney,
      excerpt: text(4096),
    },
    ["accountKey", "rawIndex", "postedOn", "amount", "currency", "description"],
  ),
  PluginLedgerEventInput: object(
    {
      accountKey: text(200),
      providerId: text(200),
      rawIndex: { type: "integer", minimum: 0, maximum: 1000000 },
      eventOn: date,
      summary: text(500),
      currency,
      amount: signedMoney,
      legs: { ...array(ref("PluginEventLegInput"), 50), minItems: 2 },
      links: array(ref("PluginKeyValue"), 20),
      coveredBy: text(200),
      evidence: text(300),
      sourceId: text(128),
      excerpt: text(4096),
    },
    ["accountKey", "providerId", "rawIndex", "eventOn", "summary", "currency", "legs"],
  ),
  PluginBalanceCheckInput: object({
    accountKey: text(200),
    asOf: date,
    balance: signedMoney,
  }),
  PluginListInput: object({}, []),
  PluginListOutput: object({
    plugins: array(ref("PluginSummaryView"), 200),
  }),
  PluginInstallInput: object(
    {
      manifest: ref("PluginManifestInput"),
      config: array(ref("PluginConfigEntry"), 50),
      roleMap: array(ref("PluginRoleBinding"), 40),
      accountMap: array(ref("PluginAccountBinding"), 100),
      enabled: { type: "boolean" },
    },
    ["manifest"],
  ),
  PluginConfigureInput: object(
    {
      pluginId: pluginSlug,
      enabled: { type: "boolean" },
      config: array(ref("PluginConfigEntry"), 50),
      roleMap: array(ref("PluginRoleBinding"), 40),
      accountMap: array(ref("PluginAccountBinding"), 100),
    },
    ["pluginId"],
  ),
  PluginStatusInput: object({
    pluginId: pluginSlug,
  }),
  PluginPushInput: object(
    {
      pluginId: pluginSlug,
      sourceKey: text(200),
      rawSha256: hash,
      fetchedAt: text(40),
      bankLines: array(ref("PluginBankLineInput"), 500),
      events: array(ref("PluginLedgerEventInput"), 500),
      balances: array(ref("PluginBalanceCheckInput"), 50),
      cursor: text(500),
      ledgerAccountId: text(128),
      startOn: date,
      catchUp: { type: "boolean" },
    },
    ["pluginId", "sourceKey", "rawSha256"],
  ),
  PluginBalanceCheckResult: object({
    accountKey: text(200),
    asOf: date,
    reported: signedMoney,
    ledger: nullable(signedMoney),
    waiting: nullable(signedMoney),
    excluded: nullable(signedMoney),
    difference: nullable(signedMoney),
  }),
  PluginPushOutput: object({
    pluginId: pluginSlug,
    sourceKey: text(200),
    batchId: text(128),
    newCount: { type: "integer", minimum: 0 },
    duplicateCount: { type: "integer", minimum: 0 },
    overlapCount: { type: "integer", minimum: 0 },
    excludedCount: { type: "integer", minimum: 0 },
    cursor: nullable(text(500)),
    balances: array(ref("PluginBalanceCheckResult"), 50),
  }),
  PluginRemoveInput: object({
    pluginId: pluginSlug,
  }),
  PluginRemoveOutput: object({
    pluginId: pluginSlug,
    removed: { type: "boolean" },
  }),
  PluginTokenSummary: object({
    id: tokenId,
    pluginId: pluginSlug,
    label: text(80),
    status: { type: "string", enum: ["active", "revoked", "expired"] },
    createdAt: text(40),
    createdBy: text(80),
    expiresAt: text(40),
    revokedAt: nullable(text(40)),
    revokedReason: nullable(text(200)),
    lastUsedAt: nullable(text(40)),
  }),
  PluginCreateTokenInput: object(
    {
      pluginId: pluginSlug,
      label: text(80),
      expiresInDays: { type: "integer", minimum: 1, maximum: 365 },
    },
    ["pluginId", "label"],
  ),
  PluginCreateTokenOutput: object({
    token: nullable(text(120)),
    record: ref("PluginTokenSummary"),
  }),
  PluginListTokensInput: object(
    {
      pluginId: pluginSlug,
    },
    [],
  ),
  PluginListTokensOutput: object({
    tokens: array(ref("PluginTokenSummary"), 200),
  }),
  PluginRevokeTokenInput: object(
    {
      tokenId,
      reason: text(200),
    },
    ["tokenId"],
  ),
  PluginRevokeTokenOutput: object({
    record: ref("PluginTokenSummary"),
  }),
};

export const pluginsSchema: SliceSchema = {
  name: "plugins",
  definitions,
  operations: [
    operation(
      "plugins.list",
      "List installed ingestion plugins, their readiness, missing account roles, and last sync time.",
      "read",
      "PluginListInput",
      false,
      "PluginListOutput",
    ),
    operation(
      "plugins.install",
      "Install or upgrade an ingestion plugin manifest in this book and auto-bind matching chart role keys.",
      "configure",
      "PluginInstallInput",
      true,
      "PluginDetailView",
    ),
    operation(
      "plugins.configure",
      "Update non-secret plugin settings, role-to-account mappings, account cutover dates, or enabled state.",
      "configure",
      "PluginConfigureInput",
      true,
      "PluginDetailView",
    ),
    operation(
      "plugins.status",
      "Inspect an installed plugin's resolved account roles, cursors, and readiness.",
      "read",
      "PluginStatusInput",
      false,
      "PluginDetailView",
    ),
    operation(
      "plugins.push",
      "Submit a verified batch of BankLine and/or LedgerEvent items backed by an archived raw upload (POST /v1/uploads with X-Upload-For: plugin), advancing the plugin cursor atomically.",
      "draft",
      "PluginPushInput",
      true,
      "PluginPushOutput",
    ),
    operation(
      "plugins.remove",
      "Remove an installed plugin and revoke its plugin tokens while keeping archived payloads and posted journals intact.",
      "configure",
      "PluginRemoveInput",
      true,
      "PluginRemoveOutput",
    ),
    operation(
      "plugins.createToken",
      "Issue a least-privilege plugin token (rsp_...) scoped strictly to plugins.status, plugins.push, and plugin raw uploads for one installed plugin.",
      "provision",
      "PluginCreateTokenInput",
      true,
      "PluginCreateTokenOutput",
    ),
    operation(
      "plugins.listTokens",
      "List plugin ingestion tokens and their active, revoked, or expired status without revealing secrets.",
      "provision",
      "PluginListTokensInput",
      false,
      "PluginListTokensOutput",
    ),
    operation(
      "plugins.revokeToken",
      "Revoke a plugin ingestion token immediately.",
      "provision",
      "PluginRevokeTokenInput",
      true,
      "PluginRevokeTokenOutput",
    ),
  ],
};
