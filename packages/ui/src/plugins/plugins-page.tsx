import { createMemo, For, type JSX, Show } from "solid-js";
import { CopyButton } from "../agent/copy";
import { Button, buttonAttrs } from "../button";
import { Dialog, DialogClose } from "../dialog";
import { Notice } from "../notice";
import { PageHeader } from "../page-header";
import { PageSkeleton } from "../skeleton";
import { InstallPluginDialog } from "./install-dialog";
import { PluginCard } from "./plugin-card";
import { PluginTokensDialog } from "./tokens-dialog";
import type {
  PluginAccountOption,
  PluginConfigureValues,
  PluginDetailItem,
  PluginManifestPreview,
  PluginTokenItem,
} from "./types";
import { words } from "./words";

/** Settings -> Plugins screen, in the ledger language (docs/reference/design-language.md). */
export function PluginsView(props: {
  titleId?: string | undefined;
  titleRef?: ((element: HTMLHeadingElement) => void) | undefined;
  plugins: readonly PluginDetailItem[];
  accounts: readonly PluginAccountOption[];
  loading: boolean;
  error?: string | null | undefined;
  canConfigure: boolean;
  canManageTokens: boolean;
  savingPluginId?: string | null | undefined;
  savedPluginId?: string | null | undefined;
  saveErrorByPlugin?: Readonly<Record<string, string | undefined>> | undefined;
  installOpen: boolean;
  installing?: boolean | undefined;
  installError?: string | null | undefined;
  removingPlugin: PluginDetailItem | null;
  removing?: boolean | undefined;
  tokensPlugin: PluginDetailItem | null;
  tokens: readonly PluginTokenItem[];
  tokensLoading?: boolean | undefined;
  tokenCreating?: boolean | undefined;
  tokenRevokingId?: string | null | undefined;
  createdTokenSecret?: string | null | undefined;
  tokensError?: string | null | undefined;
  onRetry: () => void;
  onOpenInstall: () => void;
  onCloseInstall: () => void;
  onInstall: (manifest: PluginManifestPreview) => void;
  onSavePlugin: (values: PluginConfigureValues) => void;
  onToggleEnabled: (plugin: PluginDetailItem) => void;
  onAskRemove: (plugin: PluginDetailItem) => void;
  onCancelRemove: () => void;
  onConfirmRemove: (pluginId: string) => void;
  onOpenTokens: (plugin: PluginDetailItem) => void;
  onCloseTokens: () => void;
  onCreateToken: (pluginId: string, label: string, expiresInDays: number) => void;
  onRevokeToken: (tokenId: string) => void;
}): JSX.Element {
  const empty = () => !props.loading && props.plugins.length === 0;
  // Key installed blocks by stable pluginId so optimistic updates never remount an open card.
  const pluginIds = createMemo(() => props.plugins.map((p) => p.pluginId));
  const pluginById = createMemo(() => new Map(props.plugins.map((p) => [p.pluginId, p])));

  return (
    <section class="rt-plugins-page" aria-labelledby={props.titleId ?? "plugins-title"}>
      <PageHeader
        titleId={props.titleId ?? "plugins-title"}
        {...(props.titleRef ? { titleRef: props.titleRef } : {})}
        title={words.title}
        {...(!empty() ? { description: words.lead } : {})}
        actions={
          <Show when={!empty() && props.canConfigure}>
            <Button label={words.installButton} onClick={props.onOpenInstall} />
          </Show>
        }
      />

      <Show
        when={!props.error}
        fallback={
          <Notice title={words.unavailableTitle} tone="error" role="alert">
            <p>{props.error ?? words.unavailableBody}</p>
            <Button variant="secondary" label={words.tryAgain} onClick={props.onRetry} />
          </Notice>
        }
      >
        <Show when={!props.loading} fallback={<PageSkeleton shape="table" label={words.loading} />}>
          <Show
            when={props.plugins.length > 0}
            fallback={
              <div class="rt-plugins-empty">
                <p class="rt-plugins-empty-lead">
                  {props.canConfigure ? words.empty : words.emptyMember}
                </p>
                <Show when={props.canConfigure}>
                  <Button label={words.installButton} onClick={props.onOpenInstall} />
                  <div class="rt-plugins-cli">
                    <p class="rt-plugins-cli-label">{words.cliInstallLabel}</p>
                    <div class="rt-plugins-code-row">
                      <code class="rt-plugins-code" tabindex="0">
                        {words.cliInstallCommand}
                      </code>
                      <CopyButton
                        text={words.cliInstallCommand}
                        label={words.copyCommand}
                        copiedLabel={words.commandCopied}
                      />
                    </div>
                  </div>
                </Show>
              </div>
            }
          >
            <div class="rt-plugins-list">
              <For each={pluginIds()}>
                {(pluginId) => (
                  <Show when={pluginById().get(pluginId)}>
                    {(plugin) => (
                      <PluginCard
                        plugin={plugin()}
                        accounts={props.accounts}
                        canConfigure={props.canConfigure}
                        canManageTokens={props.canManageTokens}
                        saving={props.savingPluginId === pluginId}
                        saved={props.savedPluginId === pluginId}
                        saveError={props.saveErrorByPlugin?.[pluginId] ?? null}
                        onSave={props.onSavePlugin}
                        onToggleEnabled={props.onToggleEnabled}
                        onOpenTokens={props.onOpenTokens}
                        onAskRemove={props.onAskRemove}
                      />
                    )}
                  </Show>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>

      <InstallPluginDialog
        open={props.installOpen}
        pending={props.installing}
        error={props.installError}
        onClose={props.onCloseInstall}
        onInstall={props.onInstall}
      />

      <PluginTokensDialog
        plugin={props.tokensPlugin}
        tokens={props.tokens}
        loading={props.tokensLoading}
        creating={props.tokenCreating}
        revokingId={props.tokenRevokingId}
        createdSecret={props.createdTokenSecret}
        error={props.tokensError}
        onClose={props.onCloseTokens}
        onCreate={props.onCreateToken}
        onRevoke={props.onRevokeToken}
      />

      <Show when={props.removingPlugin}>
        {(plugin) => (
          <Dialog
            open={true}
            role="alertdialog"
            title={words.removeTitle(plugin().name)}
            description={words.removeBody}
            onOpenChange={(open) => {
              if (!open) props.onCancelRemove();
            }}
            footer={
              <>
                <DialogClose {...buttonAttrs({ variant: "secondary" })}>
                  {words.keepPlugin}
                </DialogClose>
                <Button
                  label={words.confirmRemove}
                  pendingLabel={words.removing}
                  pending={props.removing ?? false}
                  onClick={() => props.onConfirmRemove(plugin().pluginId)}
                />
              </>
            }
          />
        )}
      </Show>
    </section>
  );
}
