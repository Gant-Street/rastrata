import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  Show,
} from "solid-js";
import { CopyButton } from "../agent/copy";
import { Button, buttonAttrs } from "../button";
import { Dialog, DialogClose } from "../dialog";
import { Details } from "../kit/details";
import { Notice } from "../notice";
import { TextArea, TextField } from "../text-field";
import type { PluginCatalogEntry, PluginManifestPreview } from "./types";
import { words } from "./words";

const SLUG = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const AUTH_KINDS = new Set(["api_key", "oauth2", "file", "none"]);

function parseManifestJson(raw: string): {
  readonly preview: PluginManifestPreview | null;
  readonly error: string | null;
} {
  const trimmed = raw.trim();
  if (!trimmed) return { preview: null, error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { preview: null, error: "Manifest must be valid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { preview: null, error: "Manifest must be a JSON object." };
  }
  const obj = parsed as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const version = typeof obj.version === "string" ? obj.version.trim() : "";
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  const description = typeof obj.description === "string" ? obj.description.trim() : "";
  const authKind = typeof obj.authKind === "string" ? obj.authKind : "";
  if (!SLUG.test(id)) {
    return { preview: null, error: "Plugin id must use lowercase letters, digits, or hyphens." };
  }
  if (!version || !name || !description || !AUTH_KINDS.has(authKind)) {
    return {
      preview: null,
      error: "Manifest needs id, version, name, description, domains, and authKind.",
    };
  }
  const domains = Array.isArray(obj.domains)
    ? obj.domains.filter((d): d is string => typeof d === "string")
    : [];
  const roles = Array.isArray(obj.roles) ? (obj.roles as PluginManifestPreview["roles"]) : [];
  const clearing =
    obj.clearing && typeof obj.clearing === "object"
      ? (obj.clearing as PluginManifestPreview["clearing"])
      : undefined;
  return {
    preview: {
      id,
      version,
      name,
      description,
      domains,
      authKind: authKind as PluginManifestPreview["authKind"],
      ...(typeof obj.authLabel === "string" ? { authLabel: obj.authLabel } : {}),
      ...(typeof obj.authEnvVar === "string" ? { authEnvVar: obj.authEnvVar } : {}),
      roles,
      ...(clearing ? { clearing } : {}),
    },
    error: null,
  };
}

/** Ark Dialog with 1-click verified catalog install plus a collapsible manifest JSON fold
 * for local, custom, and agent-built plugins. */
export function InstallPluginDialog(props: {
  open: boolean;
  catalog?: readonly PluginCatalogEntry[] | undefined;
  installedIds?: readonly string[] | undefined;
  pending?: boolean | undefined;
  error?: string | null | undefined;
  onClose: () => void;
  onInstall: (manifest: PluginManifestPreview) => void;
}): JSX.Element {
  const uid = createUniqueId();
  const [query, setQuery] = createSignal("");
  const [rawJson, setRawJson] = createSignal("");
  const [installingId, setInstallingId] = createSignal<string | null>(null);
  const parsed = createMemo(() => parseManifestJson(rawJson()));
  const catalog = () => props.catalog ?? [];
  const installedSet = createMemo(() => new Set(props.installedIds ?? []));
  const [customOpen, setCustomOpen] = createSignal(catalog().length === 0);

  const filteredCatalog = createMemo(() => {
    const q = query().trim().toLowerCase();
    if (!q) return catalog();
    return catalog().filter(
      (entry) =>
        entry.id.toLowerCase().includes(q) ||
        entry.name.toLowerCase().includes(q) ||
        entry.description.toLowerCase().includes(q),
    );
  });

  createEffect(() => {
    if (!props.open) {
      setRawJson("");
      setQuery("");
      setInstallingId(null);
      setCustomOpen(catalog().length === 0);
    }
  });

  createEffect(() => {
    if (!props.pending) setInstallingId(null);
  });

  const installManifest = (manifest: PluginManifestPreview) => {
    if (props.pending) return;
    setInstallingId(manifest.id);
    props.onInstall(manifest);
  };

  const submitCustom = () => {
    const manifest = parsed().preview;
    if (!manifest) return;
    installManifest(manifest);
  };

  return (
    <Dialog
      open={props.open}
      title={words.installTitle}
      description={words.installDescription}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      footer={
        <>
          <DialogClose {...buttonAttrs({ variant: "secondary" })}>{words.close}</DialogClose>
          <Show when={parsed().preview}>
            <Button
              label={words.installSubmit}
              pendingLabel={words.installing}
              pending={props.pending ?? false}
              disabled={props.pending ?? false}
              onClick={submitCustom}
            />
          </Show>
        </>
      }
    >
      <div class="rt-plugin-dialog-body">
        <Show when={props.error}>
          {(err) => (
            <Notice title={words.installFailed} tone="error" role="alert">
              {err()}
            </Notice>
          )}
        </Show>

        <Show when={catalog().length > 0}>
          <div class="rt-plugin-catalog">
            <Show when={catalog().length > 1}>
              <TextField
                id={`${uid}-search`}
                label={words.catalogSearchLabel}
                placeholder={words.catalogSearchPlaceholder}
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
            </Show>
            <Show
              when={filteredCatalog().length > 0}
              fallback={<p class="rt-plugin-quiet">{words.catalogEmpty}</p>}
            >
              <ul class="rt-plugin-catalog-list">
                <For each={filteredCatalog()}>
                  {(entry) => {
                    const installed = () => installedSet().has(entry.id);
                    const hosts = () =>
                      entry.manifest.domains.length > 0
                        ? entry.manifest.domains.join(", ")
                        : words.domainsNone;
                    return (
                      <li>
                        <span class="rt-plugin-mark rt-plugin-mark-sm" aria-hidden="true">
                          {entry.name.trim().charAt(0).toUpperCase()}
                        </span>
                        <div class="rt-plugin-catalog-info">
                          <div class="rt-plugin-catalog-head">
                            <strong>{entry.name}</strong>
                            <span class="rt-plugin-meta">v{entry.version}</span>
                          </div>
                          <p class="rt-plugin-catalog-desc">{entry.description}</p>
                          <p class="rt-plugin-catalog-hosts">
                            {words.previewHosts}: {hosts()}
                          </p>
                        </div>
                        <div class="rt-plugin-catalog-action">
                          <Show
                            when={!installed()}
                            fallback={<span class="rt-plugin-quiet">{words.catalogInstalled}</span>}
                          >
                            <Button
                              size="sm"
                              label={words.installSubmit}
                              pendingLabel={words.installing}
                              pending={(props.pending ?? false) && installingId() === entry.id}
                              disabled={props.pending ?? false}
                              onClick={() => installManifest(entry.manifest)}
                            />
                          </Show>
                        </div>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </Show>
          </div>
        </Show>

        <Details
          flush
          open={customOpen()}
          onOpenChange={setCustomOpen}
          summary={words.catalogCustomTitle}
        >
          <div class="rt-plugin-custom-body">
            <TextArea
              id={`${uid}-manifest`}
              class="rt-plugin-manifest-input"
              label={words.manifestLabel}
              hint={words.manifestHint}
              {...(parsed().error !== null ? { error: parsed().error as string } : {})}
              rows={6}
              value={rawJson()}
              onInput={(event) => setRawJson(event.currentTarget.value)}
            />

            <Show when={parsed().preview}>
              {(manifest) => (
                <dl class="rt-plugin-preview">
                  <div class="rt-plugin-preview-row">
                    <dt>{words.previewName}</dt>
                    <dd>
                      <strong>{manifest().name}</strong> ({manifest().id} v{manifest().version})
                    </dd>
                  </div>
                  <div class="rt-plugin-preview-row">
                    <dt>{words.previewHosts}</dt>
                    <dd>
                      {manifest().domains.length > 0
                        ? manifest().domains.join(", ")
                        : words.domainsNone}
                    </dd>
                  </div>
                  <Show when={manifest().roles.length > 0}>
                    <div class="rt-plugin-preview-row">
                      <dt>{words.previewRoles}</dt>
                      <dd>
                        {manifest()
                          .roles.map((r) => r.label)
                          .join(", ")}
                      </dd>
                    </div>
                  </Show>
                </dl>
              )}
            </Show>

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
          </div>
        </Details>
      </div>
    </Dialog>
  );
}
