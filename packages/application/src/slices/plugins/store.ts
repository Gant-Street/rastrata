/** Product state for installed ingestion plugins: manifests, non-secret config, role/account maps,
 * incremental cursors, clearing payouts, and plugin-scoped `rsp_` tokens.
 *
 * Third-party API keys and OAuth secrets are NEVER stored here: local installs keep secrets in
 * env / 0600 files outside SQLite; Cloud keeps them in the encrypted control plane. */
import { ApplicationError } from "../../errors.ts";
import type { ApplicationService } from "../../service.ts";
import type { ApplicationStore } from "../../storage.ts";
import { migrate, sliceState } from "../state.ts";

const MIGRATIONS = [
  `CREATE TABLE plugin_installs (
     plugin_id TEXT PRIMARY KEY,
     version TEXT NOT NULL,
     manifest_json TEXT NOT NULL,
     config_json TEXT NOT NULL,
     role_map_json TEXT NOT NULL,
     account_map_json TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     installed_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     installed_by TEXT NOT NULL
   )`,
  `CREATE TABLE plugin_cursors (
     plugin_id TEXT NOT NULL,
     source_key TEXT NOT NULL,
     cursor TEXT,
     last_sync_at TEXT NOT NULL,
     last_error TEXT,
     PRIMARY KEY (plugin_id, source_key)
   )`,
  `CREATE TABLE plugin_tokens (
     id TEXT PRIMARY KEY,
     plugin_id TEXT NOT NULL,
     label TEXT NOT NULL,
     secret_hash TEXT NOT NULL,
     created_at TEXT NOT NULL,
     created_by TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     revoked_at TEXT,
     revoked_reason TEXT,
     last_used_at TEXT,
     create_operation_id TEXT NOT NULL UNIQUE
   );
   CREATE INDEX plugin_tokens_by_plugin ON plugin_tokens (plugin_id, created_at DESC)`,
  `CREATE TABLE plugin_payouts (
     plugin_id TEXT NOT NULL,
     provider_id TEXT NOT NULL,
     account_key TEXT NOT NULL,
     event_on TEXT NOT NULL,
     amount_cents INTEGER NOT NULL,
     currency TEXT NOT NULL,
     clearing_role TEXT NOT NULL,
     PRIMARY KEY (plugin_id, provider_id)
   );
   CREATE INDEX plugin_payouts_by_plugin ON plugin_payouts (plugin_id, event_on)`,
];

const TOUCH_INTERVAL_MS = 60_000;

export interface StoredRoleSpec {
  readonly key: string;
  readonly label: string;
  readonly kind: "asset" | "liability" | "equity" | "income" | "expense";
  readonly required: boolean;
  readonly defaultRoleKey?: string;
}

export interface StoredClearingSpec {
  readonly role: string;
  readonly windowDays: number;
}

export interface StoredPluginManifest {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly domains: readonly string[];
  readonly authKind: "api_key" | "oauth2" | "file" | "none";
  readonly authLabel?: string;
  readonly authEnvVar?: string;
  readonly roles: readonly StoredRoleSpec[];
  readonly clearing?: StoredClearingSpec;
}

export interface PluginConfigEntry {
  readonly key: string;
  readonly value: string;
}

export interface PluginRoleBinding {
  readonly role: string;
  readonly accountId: string;
}

export interface PluginAccountBinding {
  readonly accountKey: string;
  readonly ledgerAccountId: string;
  readonly startOn?: string;
}

export interface PluginInstallRecord {
  readonly pluginId: string;
  readonly version: string;
  readonly manifest: StoredPluginManifest;
  readonly config: readonly PluginConfigEntry[];
  readonly roleMap: readonly PluginRoleBinding[];
  readonly accountMap: readonly PluginAccountBinding[];
  readonly enabled: boolean;
  readonly installedAt: string;
  readonly updatedAt: string;
  readonly installedBy: string;
}

export interface PluginCursorRecord {
  readonly pluginId: string;
  readonly sourceKey: string;
  readonly cursor: string | null;
  readonly lastSyncAt: string;
  readonly lastError: string | null;
}

export interface PluginPayoutRecord {
  readonly pluginId: string;
  readonly providerId: string;
  readonly accountKey: string;
  readonly eventOn: string;
  readonly amountCents: bigint;
  readonly currency: string;
  readonly clearingRole: string;
}

export type PluginTokenStatus = "active" | "revoked" | "expired";

export interface PluginTokenRecord {
  readonly id: string;
  readonly pluginId: string;
  readonly label: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
  readonly lastUsedAt: string | null;
}

export interface StoredPluginToken extends PluginTokenRecord {
  readonly secretHash: string;
}

export function pluginTokenStatus(token: PluginTokenRecord, now: Date): PluginTokenStatus {
  if (token.revokedAt) return "revoked";
  return Date.parse(token.expiresAt) <= now.getTime() ? "expired" : "active";
}

type InstallRow = {
  plugin_id: string;
  version: string;
  manifest_json: string;
  config_json: string;
  role_map_json: string;
  account_map_json: string;
  enabled: number;
  installed_at: string;
  updated_at: string;
  installed_by: string;
};

type CursorRow = {
  plugin_id: string;
  source_key: string;
  cursor: string | null;
  last_sync_at: string;
  last_error: string | null;
};

type TokenRow = {
  id: string;
  plugin_id: string;
  label: string;
  secret_hash: string;
  created_at: string;
  created_by: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  last_used_at: string | null;
};

type PayoutRow = {
  plugin_id: string;
  provider_id: string;
  account_key: string;
  event_on: string;
  amount_cents: number;
  currency: string;
  clearing_role: string;
};

const toInstall = (row: InstallRow): PluginInstallRecord => ({
  pluginId: row.plugin_id,
  version: row.version,
  manifest: JSON.parse(row.manifest_json) as StoredPluginManifest,
  config: JSON.parse(row.config_json) as PluginConfigEntry[],
  roleMap: JSON.parse(row.role_map_json) as PluginRoleBinding[],
  accountMap: JSON.parse(row.account_map_json) as PluginAccountBinding[],
  enabled: row.enabled !== 0,
  installedAt: row.installed_at,
  updatedAt: row.updated_at,
  installedBy: row.installed_by,
});

const toCursor = (row: CursorRow): PluginCursorRecord => ({
  pluginId: row.plugin_id,
  sourceKey: row.source_key,
  cursor: row.cursor,
  lastSyncAt: row.last_sync_at,
  lastError: row.last_error,
});

const toToken = (row: TokenRow): StoredPluginToken => ({
  id: row.id,
  pluginId: row.plugin_id,
  label: row.label,
  secretHash: row.secret_hash,
  createdAt: row.created_at,
  createdBy: row.created_by,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  revokedReason: row.revoked_reason,
  lastUsedAt: row.last_used_at,
});

const toPayout = (row: PayoutRow): PluginPayoutRecord => ({
  pluginId: row.plugin_id,
  providerId: row.provider_id,
  accountKey: row.account_key,
  eventOn: row.event_on,
  amountCents: BigInt(row.amount_cents),
  currency: row.currency,
  clearingRole: row.clearing_role,
});

export class PluginState {
  clock: () => Date = () => new Date();
  private readonly touched = new Map<string, number>();

  constructor(readonly store: ApplicationStore) {
    migrate(store, "plugins", MIGRATIONS);
  }

  now(): Date {
    return this.clock();
  }

  /** Cheap stamp that changes whenever plugin installs, mappings, or payouts change. */
  proposerRevision(): string {
    const installStamp = this.store
      .query("SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), '') AS latest FROM plugin_installs")
      .get() as { n: number; latest: string };
    const payoutStamp = this.store
      .query("SELECT COUNT(*) AS n, COALESCE(MAX(event_on), '') AS latest FROM plugin_payouts")
      .get() as { n: number; latest: string };
    return `i:${installStamp.n}:${installStamp.latest}|p:${payoutStamp.n}:${payoutStamp.latest}`;
  }

  listInstalls(): PluginInstallRecord[] {
    return (
      this.store.query("SELECT * FROM plugin_installs ORDER BY plugin_id").all() as InstallRow[]
    ).map(toInstall);
  }

  getInstall(pluginId: string): PluginInstallRecord | null {
    const row = this.store
      .query("SELECT * FROM plugin_installs WHERE plugin_id=?")
      .get(pluginId) as InstallRow | null;
    return row ? toInstall(row) : null;
  }

  requireInstall(pluginId: string): PluginInstallRecord {
    const install = this.getInstall(pluginId);
    if (!install) {
      throw new ApplicationError(
        "plugin_not_installed",
        `Plugin "${pluginId}" is not installed in this book. Install it first with plugins.install.`,
        404,
      );
    }
    return install;
  }

  upsertInstall(record: {
    readonly pluginId: string;
    readonly manifest: StoredPluginManifest;
    readonly config: readonly PluginConfigEntry[];
    readonly roleMap: readonly PluginRoleBinding[];
    readonly accountMap: readonly PluginAccountBinding[];
    readonly enabled: boolean;
    readonly at: string;
    readonly by: string;
  }): PluginInstallRecord {
    const existing = this.getInstall(record.pluginId);
    if (existing) {
      this.store
        .query(
          `UPDATE plugin_installs
           SET version=?, manifest_json=?, config_json=?, role_map_json=?, account_map_json=?, enabled=?, updated_at=?
           WHERE plugin_id=?`,
        )
        .run(
          record.manifest.version,
          JSON.stringify(record.manifest),
          JSON.stringify(record.config),
          JSON.stringify(record.roleMap),
          JSON.stringify(record.accountMap),
          record.enabled ? 1 : 0,
          record.at,
          record.pluginId,
        );
    } else {
      this.store
        .query(
          `INSERT INTO plugin_installs
           (plugin_id, version, manifest_json, config_json, role_map_json, account_map_json, enabled, installed_at, updated_at, installed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.pluginId,
          record.manifest.version,
          JSON.stringify(record.manifest),
          JSON.stringify(record.config),
          JSON.stringify(record.roleMap),
          JSON.stringify(record.accountMap),
          record.enabled ? 1 : 0,
          record.at,
          record.at,
          record.by,
        );
    }
    return this.requireInstall(record.pluginId);
  }

  removeInstall(pluginId: string, now: string): void {
    this.store.transaction(() => {
      this.store
        .query(
          "UPDATE plugin_tokens SET revoked_at=?, revoked_reason=? WHERE plugin_id=? AND revoked_at IS NULL",
        )
        .run(now, "Plugin removed", pluginId);
      this.store.query("DELETE FROM plugin_cursors WHERE plugin_id=?").run(pluginId);
      this.store.query("DELETE FROM plugin_payouts WHERE plugin_id=?").run(pluginId);
      this.store.query("DELETE FROM plugin_installs WHERE plugin_id=?").run(pluginId);
    });
  }

  listCursors(pluginId: string): PluginCursorRecord[] {
    return (
      this.store
        .query("SELECT * FROM plugin_cursors WHERE plugin_id=? ORDER BY source_key")
        .all(pluginId) as CursorRow[]
    ).map(toCursor);
  }

  saveCursor(entry: {
    readonly pluginId: string;
    readonly sourceKey: string;
    readonly cursor: string | null;
    readonly syncedAt: string;
    readonly error?: string | null;
  }): void {
    this.store
      .query(
        `INSERT INTO plugin_cursors (plugin_id, source_key, cursor, last_sync_at, last_error)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(plugin_id, source_key) DO UPDATE SET
           cursor = COALESCE(excluded.cursor, plugin_cursors.cursor),
           last_sync_at = excluded.last_sync_at,
           last_error = excluded.last_error`,
      )
      .run(entry.pluginId, entry.sourceKey, entry.cursor, entry.syncedAt, entry.error ?? null);
  }

  recordPayout(payout: PluginPayoutRecord): void {
    this.store
      .query(
        `INSERT OR IGNORE INTO plugin_payouts
         (plugin_id, provider_id, account_key, event_on, amount_cents, currency, clearing_role)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        payout.pluginId,
        payout.providerId,
        payout.accountKey,
        payout.eventOn,
        Number(payout.amountCents),
        payout.currency,
        payout.clearingRole,
      );
  }

  listPayouts(pluginId: string): PluginPayoutRecord[] {
    return (
      this.store
        .query("SELECT * FROM plugin_payouts WHERE plugin_id=? ORDER BY event_on, provider_id")
        .all(pluginId) as PayoutRow[]
    ).map(toPayout);
  }

  insertToken(token: {
    readonly id: string;
    readonly pluginId: string;
    readonly label: string;
    readonly secretHash: string;
    readonly createdAt: string;
    readonly createdBy: string;
    readonly expiresAt: string;
    readonly operationId: string;
  }): StoredPluginToken {
    this.store
      .query(
        `INSERT INTO plugin_tokens
         (id, plugin_id, label, secret_hash, created_at, created_by, expires_at, create_operation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        token.id,
        token.pluginId,
        token.label,
        token.secretHash,
        token.createdAt,
        token.createdBy,
        token.expiresAt,
        token.operationId,
      );
    return this.requireToken(token.id);
  }

  getToken(id: string): StoredPluginToken | null {
    const row = this.store
      .query("SELECT * FROM plugin_tokens WHERE id=?")
      .get(id) as TokenRow | null;
    return row ? toToken(row) : null;
  }

  requireToken(id: string): StoredPluginToken {
    const token = this.getToken(id);
    if (!token) {
      throw new ApplicationError(
        "plugin_token_not_found",
        "No plugin token has that identifier",
        404,
      );
    }
    return token;
  }

  listTokens(pluginId?: string): StoredPluginToken[] {
    if (pluginId !== undefined) {
      return (
        this.store
          .query("SELECT * FROM plugin_tokens WHERE plugin_id=? ORDER BY created_at DESC, id")
          .all(pluginId) as TokenRow[]
      ).map(toToken);
    }
    return (
      this.store
        .query("SELECT * FROM plugin_tokens ORDER BY created_at DESC, id")
        .all() as TokenRow[]
    ).map(toToken);
  }

  revokeToken(id: string, reason: string | null): StoredPluginToken {
    const existing = this.requireToken(id);
    if (existing.revokedAt) return existing;
    this.store
      .query(
        "UPDATE plugin_tokens SET revoked_at=?, revoked_reason=? WHERE id=? AND revoked_at IS NULL",
      )
      .run(this.now().toISOString(), reason, id);
    return this.requireToken(id);
  }

  touchToken(id: string): void {
    const now = this.now();
    const last = this.touched.get(id);
    if (last !== undefined && now.getTime() - last < TOUCH_INTERVAL_MS) return;
    this.touched.set(id, now.getTime());
    this.store
      .query("UPDATE plugin_tokens SET last_used_at=? WHERE id=?")
      .run(now.toISOString(), id);
  }
}

export function pluginState(service: ApplicationService): PluginState {
  return sliceState(service, "plugins", (store) => new PluginState(store));
}
