import { createSignal, createUniqueId, For, type JSX, Show } from "solid-js";
import { CopyButton } from "../agent/copy";
import { Button, buttonAttrs } from "../button";
import { Dialog, DialogClose } from "../dialog";
import { formatInstant } from "../format";
import { Notice } from "../notice";
import { SelectField } from "../select-field";
import { TextField } from "../text-field";
import type { PluginDetailItem, PluginTokenItem } from "./types";
import { words } from "./words";

/** Ark Dialog for issuing and revoking plugin-scoped `rsp_` tokens.
 * The newly created token is shown once with a Copy button and cleared when closed. */
export function PluginTokensDialog(props: {
  plugin: PluginDetailItem | null;
  tokens: readonly PluginTokenItem[];
  loading?: boolean | undefined;
  creating?: boolean | undefined;
  revokingId?: string | null | undefined;
  createdSecret?: string | null | undefined;
  error?: string | null | undefined;
  onClose: () => void;
  onCreate: (pluginId: string, label: string, expiresInDays: number) => void;
  onRevoke: (tokenId: string) => void;
}): JSX.Element {
  const uid = createUniqueId();
  const [label, setLabel] = createSignal("");
  const [days, setDays] = createSignal("90");

  const handleCreate = (event: SubmitEvent) => {
    event.preventDefault();
    const current = props.plugin;
    const trimmed = label().trim();
    if (!current || !trimmed || props.creating) return;
    props.onCreate(current.pluginId, trimmed, Number(days()));
    setLabel("");
  };

  return (
    <Dialog
      open={props.plugin !== null}
      title={props.plugin ? words.tokensTitle(props.plugin.name) : ""}
      description={words.tokensDescription}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      footer={<DialogClose {...buttonAttrs({ variant: "secondary" })}>{words.close}</DialogClose>}
    >
      <div class="rt-plugin-dialog-body">
        <Show when={props.error}>
          {(err) => (
            <Notice title={words.saveFailed} tone="error" role="alert">
              {err()}
            </Notice>
          )}
        </Show>

        <form class="rt-plugin-token-form" onSubmit={handleCreate}>
          <TextField
            id={`${uid}-tok-label`}
            label={words.tokenLabel}
            placeholder={words.tokenLabelPlaceholder}
            value={label()}
            onInput={(event) => setLabel(event.currentTarget.value)}
          />
          <SelectField
            id={`${uid}-tok-days`}
            label={words.tokenExpiry}
            value={days()}
            items={[...words.expiryChoices]}
            onChange={setDays}
          />
          <Button
            type="submit"
            label={words.createToken}
            pendingLabel={words.creatingToken}
            pending={props.creating ?? false}
            disabled={!label().trim() || (props.creating ?? false)}
          />
        </form>

        <Show when={props.createdSecret}>
          {(secret) => (
            <div class="rt-plugin-token-reveal" role="status">
              <p>{words.tokenRevealNotice}</p>
              <div class="rt-plugins-code-row">
                <code class="rt-plugins-code" tabindex="0">
                  {secret()}
                </code>
                <CopyButton
                  text={secret()}
                  label={words.copyCommand}
                  copiedLabel={words.commandCopied}
                />
              </div>
            </div>
          )}
        </Show>

        <Show when={!props.loading} fallback={<p class="rt-plugin-quiet">{words.tokensLoading}</p>}>
          <Show
            when={props.tokens.length > 0}
            fallback={<p class="rt-plugin-quiet">{words.tokensEmpty}</p>}
          >
            <ul class="rt-plugin-tokens-list">
              <For each={props.tokens}>
                {(token) => (
                  <li>
                    <div class="rt-plugin-token-info">
                      <strong>{token.label}</strong>
                      <span class="rt-plugin-token-meta">
                        {words.tokenCreated(formatInstant(token.createdAt))}
                        {" · "}
                        {token.status === "revoked"
                          ? words.tokenRevoked
                          : token.status === "expired"
                            ? words.tokenExpired
                            : words.tokenExpires(formatInstant(token.expiresAt))}
                        {token.lastUsedAt
                          ? ` · ${words.tokenLastUsed(formatInstant(token.lastUsedAt))}`
                          : ""}
                      </span>
                    </div>
                    <Show when={token.status === "active"}>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        label={words.revokeToken}
                        pendingLabel={words.revokingToken}
                        pending={props.revokingId === token.id}
                        onClick={() => props.onRevoke(token.id)}
                      />
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </div>
    </Dialog>
  );
}
