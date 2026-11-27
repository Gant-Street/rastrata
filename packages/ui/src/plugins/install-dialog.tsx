import { createEffect, createMemo, createSignal, createUniqueId, type JSX, Show } from "solid-js";
import { CopyButton } from "../agent/copy";
import { Button, buttonAttrs } from "../button";
import { Dialog, DialogClose } from "../dialog";
import { Notice } from "../notice";
import { TextArea } from "../text-field";
import type { PluginManifestPreview } from "./types";
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

/** Ark Dialog to inspect a plugin manifest's outbound domains & accounts before installing. */
export function InstallPluginDialog(props: {
  open: boolean;
  pending?: boolean | undefined;
  error?: string | null | undefined;
  onClose: () => void;
  onInstall: (manifest: PluginManifestPreview) => void;
}): JSX.Element {
  const uid = createUniqueId();
  const [rawJson, setRawJson] = createSignal("");
  const parsed = createMemo(() => parseManifestJson(rawJson()));

  createEffect(() => {
    if (!props.open) setRawJson("");
  });

  const submit = () => {
    const manifest = parsed().preview;
    if (!manifest || props.pending) return;
    props.onInstall(manifest);
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
          <DialogClose {...buttonAttrs({ variant: "secondary" })}>{words.cancel}</DialogClose>
          <Button
            label={words.installSubmit}
            pendingLabel={words.installing}
            pending={props.pending ?? false}
            disabled={!parsed().preview || (props.pending ?? false)}
            onClick={submit}
          />
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

        <TextArea
          id={`${uid}-manifest`}
          class="rt-plugin-manifest-input"
          label={words.manifestLabel}
          hint={words.manifestHint}
          {...(parsed().error !== null ? { error: parsed().error as string } : {})}
          rows={7}
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
    </Dialog>
  );
}
