export type PluginAccountKind = "asset" | "liability" | "equity" | "income" | "expense";

export interface PluginAccountOption {
  readonly value: string;
  readonly label: string;
  readonly kind: string;
  readonly closed?: boolean | undefined;
}

export interface PluginRoleRowView {
  readonly role: string;
  readonly label: string;
  readonly kind: PluginAccountKind;
  readonly required: boolean;
  readonly accountId: string | null;
  readonly source: "override" | "roleKey" | "unmapped";
  readonly problem: string | null;
}

export interface PluginAccountBindingView {
  readonly accountKey: string;
  readonly ledgerAccountId: string;
  readonly startOn?: string | undefined;
}

export interface PluginConfigEntryView {
  readonly key: string;
  readonly value: string;
}

export interface PluginCursorRowView {
  readonly sourceKey: string;
  readonly cursor: string | null;
  readonly lastSyncAt: string;
  readonly lastError: string | null;
}

export interface PluginClearingView {
  readonly role: string;
  readonly windowDays: number;
}

export interface PluginDetailItem {
  readonly pluginId: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly domains: readonly string[];
  readonly authKind: "api_key" | "oauth2" | "file" | "none";
  readonly authLabel: string | null;
  readonly authEnvVar: string | null;
  readonly config: readonly PluginConfigEntryView[];
  readonly roles: readonly PluginRoleRowView[];
  readonly accountMap: readonly PluginAccountBindingView[];
  readonly clearing: PluginClearingView | null;
  readonly cursors: readonly PluginCursorRowView[];
  readonly installedAt: string;
  readonly updatedAt: string;
}

export interface PluginTokenItem {
  readonly id: string;
  readonly pluginId: string;
  readonly label: string;
  readonly status: "active" | "revoked" | "expired";
  readonly createdAt: string;
  readonly createdBy: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
  readonly lastUsedAt: string | null;
}

export interface PluginConfigureValues {
  readonly pluginId: string;
  readonly roleMap: readonly { readonly role: string; readonly accountId: string }[];
  readonly accountMap: readonly PluginAccountBindingView[];
  readonly config: readonly PluginConfigEntryView[];
}

export interface PluginManifestPreview {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly domains: readonly string[];
  readonly authKind: "api_key" | "oauth2" | "file" | "none";
  readonly authLabel?: string | undefined;
  readonly authEnvVar?: string | undefined;
  readonly roles: readonly {
    readonly key: string;
    readonly label: string;
    readonly kind: PluginAccountKind;
    readonly required: boolean;
    readonly defaultRoleKey?: string | undefined;
  }[];
  readonly clearing?: PluginClearingView | undefined;
}

export interface PluginCatalogEntry {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly tier: "official" | "community";
  readonly manifest: PluginManifestPreview;
}
