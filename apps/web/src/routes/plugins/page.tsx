import {
  type PluginConfigureValues,
  type PluginDetailItem,
  type PluginManifestPreview,
  PluginsView,
  type PluginTokenItem,
} from "@rastrata/ui";
import { batch, createMemo, createSignal, onMount } from "solid-js";
import type { Role } from "../../account";
import { BrowserApplicationClient } from "../../application-client";
import { clear as forgetHeld } from "../../held";
import { createLoader } from "../../loader";
import { currentRole, may } from "../../role";
import { OFFICIAL_PLUGIN_CATALOG } from "./catalog";
import { pluginAccountOptions, toPluginDetailItem, toPluginTokenItem } from "./controller";

/** Settings -> Plugins: native schema-driven management screen for installed ingestion plugins,
 * role/account bindings, and plugin-scoped `rsp_` access tokens. */
export function PluginsPage() {
  const client = new BrowserApplicationClient(window.localStorage);
  let heading: HTMLHeadingElement | undefined;

  const [role, setRole] = createSignal<Role | null>(null);
  const canConfigure = () => may(role(), "configure");
  const canManageTokens = () => may(role(), "provision");

  const chart = createLoader(() => client.read("accounts.list", {}));
  const pluginsLoader = createLoader(async () => {
    const listed = await client.read("plugins.list", {});
    const details = await Promise.all(
      listed.plugins.map((summary) =>
        client.read("plugins.status", { pluginId: summary.pluginId }),
      ),
    );
    return details.map(toPluginDetailItem);
  });

  // Optimistic local overlay so toggles, saves, and removals respond in <100 ms.
  const [optimistic, setOptimistic] = createSignal<PluginDetailItem[] | null>(null);
  const plugins = createMemo<readonly PluginDetailItem[]>(
    () => optimistic() ?? pluginsLoader.value() ?? [],
  );
  const accounts = createMemo(() => pluginAccountOptions(chart.value()?.accounts));

  const [savingPluginId, setSavingPluginId] = createSignal<string | null>(null);
  const [savedPluginId, setSavedPluginId] = createSignal<string | null>(null);
  const [saveErrors, setSaveErrors] = createSignal<Record<string, string | undefined>>({});

  const [installOpen, setInstallOpen] = createSignal(false);
  const [installing, setInstalling] = createSignal(false);
  const [installError, setInstallError] = createSignal<string | null>(null);

  const [removingPlugin, setRemovingPlugin] = createSignal<PluginDetailItem | null>(null);
  const [removing, setRemoving] = createSignal(false);

  const [tokensPlugin, setTokensPlugin] = createSignal<PluginDetailItem | null>(null);
  const [tokens, setTokens] = createSignal<PluginTokenItem[]>([]);
  const [tokensLoading, setTokensLoading] = createSignal(false);
  const [tokenCreating, setTokenCreating] = createSignal(false);
  const [tokenRevokingId, setTokenRevokingId] = createSignal<string | null>(null);
  const [createdTokenSecret, setCreatedTokenSecret] = createSignal<string | null>(null);
  const [tokensError, setTokensError] = createSignal<string | null>(null);

  onMount(() => {
    heading?.focus();
    void currentRole().then(setRole);
  });

  const refreshPlugins = async () => {
    forgetHeld();
    await pluginsLoader.reload();
    setOptimistic(null);
  };

  const handleInstall = async (manifest: PluginManifestPreview) => {
    setInstallError(null);
    setInstalling(true);
    try {
      const saved = await client.write(
        "plugins.install",
        {
          manifest: {
            id: manifest.id,
            version: manifest.version,
            name: manifest.name,
            description: manifest.description,
            domains: [...manifest.domains],
            authKind: manifest.authKind,
            ...(manifest.authLabel ? { authLabel: manifest.authLabel } : {}),
            ...(manifest.authEnvVar ? { authEnvVar: manifest.authEnvVar } : {}),
            roles: manifest.roles.map((r) => ({
              key: r.key,
              label: r.label,
              kind: r.kind,
              required: r.required,
              ...(r.defaultRoleKey ? { defaultRoleKey: r.defaultRoleKey } : {}),
            })),
            ...(manifest.clearing ? { clearing: manifest.clearing } : {}),
          },
        },
        `plugins:install:${manifest.id}:${Date.now()}`,
      );
      const item = toPluginDetailItem(saved);
      setOptimistic((prev) => {
        const list = prev ?? [...plugins()];
        const exists = list.some((p) => p.pluginId === item.pluginId);
        return exists
          ? list.map((p) => (p.pluginId === item.pluginId ? item : p))
          : [...list, item].sort((a, b) => a.pluginId.localeCompare(b.pluginId));
      });
      setInstallOpen(false);
      void refreshPlugins();
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : "Could not install plugin.");
    } finally {
      setInstalling(false);
    }
  };

  const handleSavePlugin = async (values: PluginConfigureValues) => {
    setSaveErrors((prev) => ({ ...prev, [values.pluginId]: undefined }));
    setSavedPluginId(null);
    setSavingPluginId(values.pluginId);
    try {
      const updated = await client.write(
        "plugins.configure",
        {
          pluginId: values.pluginId,
          roleMap: [...values.roleMap],
          accountMap: values.accountMap.map((entry) => ({
            accountKey: entry.accountKey,
            ledgerAccountId: entry.ledgerAccountId,
            ...(entry.startOn ? { startOn: entry.startOn } : {}),
          })),
          config: [...values.config],
        },
        `plugins:configure:${values.pluginId}:${Date.now()}`,
      );
      const nextItem = toPluginDetailItem(updated);
      batch(() => {
        setSavedPluginId(values.pluginId);
        setOptimistic((prev) =>
          (prev ?? [...plugins()]).map((p) => (p.pluginId === nextItem.pluginId ? nextItem : p)),
        );
      });
      void refreshPlugins();
    } catch (error) {
      setSaveErrors((prev) => ({
        ...prev,
        [values.pluginId]: error instanceof Error ? error.message : "Could not save changes.",
      }));
    } finally {
      setSavingPluginId(null);
    }
  };

  const handleToggleEnabled = async (plugin: PluginDetailItem) => {
    const nextEnabled = !plugin.enabled;
    // Immediate optimistic toggle (<100 ms), then persist.
    setOptimistic((prev) =>
      (prev ?? [...plugins()]).map((p) =>
        p.pluginId === plugin.pluginId ? { ...p, enabled: nextEnabled } : p,
      ),
    );
    try {
      const updated = await client.write(
        "plugins.configure",
        { pluginId: plugin.pluginId, enabled: nextEnabled },
        `plugins:toggle:${plugin.pluginId}:${Date.now()}`,
      );
      const nextItem = toPluginDetailItem(updated);
      setOptimistic((prev) =>
        (prev ?? [...plugins()]).map((p) => (p.pluginId === nextItem.pluginId ? nextItem : p)),
      );
      void refreshPlugins();
    } catch (error) {
      setOptimistic(null);
      setSaveErrors((prev) => ({
        ...prev,
        [plugin.pluginId]: error instanceof Error ? error.message : "Could not update plugin.",
      }));
    }
  };

  const handleConfirmRemove = async (pluginId: string) => {
    setRemoving(true);
    try {
      await client.write(
        "plugins.remove",
        { pluginId },
        `plugins:remove:${pluginId}:${Date.now()}`,
      );
      setOptimistic((prev) => (prev ?? [...plugins()]).filter((p) => p.pluginId !== pluginId));
      setRemovingPlugin(null);
      void refreshPlugins();
    } catch (error) {
      setSaveErrors((prev) => ({
        ...prev,
        [pluginId]: error instanceof Error ? error.message : "Could not remove plugin.",
      }));
      setRemovingPlugin(null);
    } finally {
      setRemoving(false);
    }
  };

  const loadTokensFor = async (pluginId: string) => {
    setTokensLoading(true);
    setTokensError(null);
    try {
      const res = await client.read("plugins.listTokens", { pluginId });
      setTokens(res.tokens.map(toPluginTokenItem));
    } catch (error) {
      setTokensError(error instanceof Error ? error.message : "Could not load tokens.");
    } finally {
      setTokensLoading(false);
    }
  };

  const handleOpenTokens = (plugin: PluginDetailItem) => {
    setCreatedTokenSecret(null);
    setTokensError(null);
    setTokens([]);
    setTokensPlugin(plugin);
    void loadTokensFor(plugin.pluginId);
  };

  const handleCloseTokens = () => {
    setCreatedTokenSecret(null);
    setTokensPlugin(null);
  };

  const handleCreateToken = async (pluginId: string, label: string, expiresInDays: number) => {
    setTokenCreating(true);
    setTokensError(null);
    setCreatedTokenSecret(null);
    try {
      const created = await client.write(
        "plugins.createToken",
        { pluginId, label, expiresInDays },
        `plugins:token:create:${pluginId}:${Date.now()}`,
      );
      setCreatedTokenSecret(created.token);
      setTokens((prev) => [toPluginTokenItem(created.record), ...prev]);
    } catch (error) {
      setTokensError(error instanceof Error ? error.message : "Could not create token.");
    } finally {
      setTokenCreating(false);
    }
  };

  const handleRevokeToken = async (tokenId: string) => {
    setTokenRevokingId(tokenId);
    setTokensError(null);
    try {
      const revoked = await client.write(
        "plugins.revokeToken",
        { tokenId, reason: "Revoked in settings" },
        `plugins:token:revoke:${tokenId}:${Date.now()}`,
      );
      const updated = toPluginTokenItem(revoked.record);
      setTokens((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    } catch (error) {
      setTokensError(error instanceof Error ? error.message : "Could not revoke token.");
    } finally {
      setTokenRevokingId(null);
    }
  };

  return (
    <PluginsView
      titleId="plugins-title"
      titleRef={(el) => {
        heading = el;
      }}
      plugins={plugins()}
      catalog={OFFICIAL_PLUGIN_CATALOG}
      accounts={accounts()}
      loading={pluginsLoader.loading() && pluginsLoader.value() === undefined}
      error={pluginsLoader.error() ? "Plugins could not be read right now." : null}
      canConfigure={canConfigure()}
      canManageTokens={canManageTokens()}
      savingPluginId={savingPluginId()}
      savedPluginId={savedPluginId()}
      saveErrorByPlugin={saveErrors()}
      installOpen={installOpen()}
      installing={installing()}
      installError={installError()}
      removingPlugin={removingPlugin()}
      removing={removing()}
      tokensPlugin={tokensPlugin()}
      tokens={tokens()}
      tokensLoading={tokensLoading()}
      tokenCreating={tokenCreating()}
      tokenRevokingId={tokenRevokingId()}
      createdTokenSecret={createdTokenSecret()}
      tokensError={tokensError()}
      onRetry={() => void refreshPlugins()}
      onOpenInstall={() => {
        setInstallError(null);
        setInstallOpen(true);
      }}
      onCloseInstall={() => setInstallOpen(false)}
      onInstall={(manifest) => void handleInstall(manifest)}
      onSavePlugin={(values) => void handleSavePlugin(values)}
      onToggleEnabled={(plugin) => void handleToggleEnabled(plugin)}
      onAskRemove={setRemovingPlugin}
      onCancelRemove={() => setRemovingPlugin(null)}
      onConfirmRemove={(pluginId) => void handleConfirmRemove(pluginId)}
      onOpenTokens={handleOpenTokens}
      onCloseTokens={handleCloseTokens}
      onCreateToken={(pluginId, label, days) => void handleCreateToken(pluginId, label, days)}
      onRevokeToken={(tokenId) => void handleRevokeToken(tokenId)}
    />
  );
}
