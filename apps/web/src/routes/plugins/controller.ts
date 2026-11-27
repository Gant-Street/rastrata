import type {
  AccountRow,
  PluginDetailView,
  PluginTokenSummary,
} from "@rastrata/application/client-contracts";
import type { PluginAccountOption, PluginDetailItem, PluginTokenItem } from "@rastrata/ui";

/** Map chart accounts from `accounts.list` into options for plugin role & bank pickers. */
export function pluginAccountOptions(
  accounts: readonly AccountRow[] | undefined,
): PluginAccountOption[] {
  return (accounts ?? [])
    .slice()
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((account) => ({
      value: account.id,
      label: account.name,
      kind: account.role,
      closed: account.closedOn !== null && account.closedOn !== undefined,
    }));
}

/** Map a `plugins.status` / `plugins.install` / `plugins.configure` wire payload to the UI view model. */
export function toPluginDetailItem(detail: PluginDetailView): PluginDetailItem {
  return {
    pluginId: detail.pluginId,
    version: detail.version,
    name: detail.name,
    description: detail.description,
    enabled: detail.enabled,
    ready: detail.ready,
    domains: detail.domains,
    authKind: detail.authKind,
    authLabel: detail.authLabel,
    authEnvVar: detail.authEnvVar,
    config: detail.config,
    roles: detail.roles,
    accountMap: detail.accountMap,
    clearing: detail.clearing
      ? { role: detail.clearing.role, windowDays: detail.clearing.windowDays ?? 7 }
      : null,
    cursors: detail.cursors,
    installedAt: detail.installedAt,
    updatedAt: detail.updatedAt,
  };
}

/** Map a `plugins.listTokens` / `plugins.createToken` record into the UI token row model. */
export function toPluginTokenItem(token: PluginTokenSummary): PluginTokenItem {
  return {
    id: token.id,
    pluginId: token.pluginId,
    label: token.label,
    status: token.status,
    createdAt: token.createdAt,
    createdBy: token.createdBy,
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
    revokedReason: token.revokedReason,
    lastUsedAt: token.lastUsedAt,
  };
}
