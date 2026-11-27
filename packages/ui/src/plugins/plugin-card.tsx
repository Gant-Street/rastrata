import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  Show,
} from "solid-js";
import { RowMenu } from "../accounting/row-menu";
import type { RowAction } from "../accounting-types";
import { CopyButton } from "../agent/copy";
import { Button } from "../button";
import { DateField } from "../date-field";
import { formatInstant } from "../format";
import { Details } from "../kit/details";
import { Notice } from "../notice";
import { SelectField } from "../select-field";
import { TextField } from "../text-field";
import type {
  PluginAccountBindingView,
  PluginAccountOption,
  PluginConfigEntryView,
  PluginConfigureValues,
  PluginDetailItem,
  PluginRoleRowView,
} from "./types";
import { words } from "./words";

function kindMatches(accountKind: string, roleKind: PluginRoleRowView["kind"]): boolean {
  if (roleKind === "income") return accountKind === "income" || accountKind === "gain";
  return accountKind === roleKind;
}

function formatRoleProblem(role: PluginRoleRowView): string | null {
  if (!role.problem) return null;
  if (role.source === "unmapped") return words.roleNeedsAccount;
  return role.problem.replace(/\s*\([a-z0-9._-]+\)(?=\.?$)/i, "");
}

/** One installed plugin block in the ledger language:
 * 2px ink rule (turns orange only when a required account is unmapped or a sync errored),
 * square ink mark, name, subtle version/host, dateline, Ark RowMenu, compact summary rows,
 * and a collapsible Options fold (open by default only when something needs you). */
export function PluginCard(props: {
  plugin: PluginDetailItem;
  accounts: readonly PluginAccountOption[];
  canConfigure: boolean;
  canManageTokens: boolean;
  saving?: boolean | undefined;
  saved?: boolean | undefined;
  saveError?: string | null | undefined;
  busy?: boolean | undefined;
  onSave: (values: PluginConfigureValues) => void;
  onToggleEnabled: (plugin: PluginDetailItem) => void;
  onOpenTokens: (plugin: PluginDetailItem) => void;
  onAskRemove: (plugin: PluginDetailItem) => void;
}): JSX.Element {
  const uid = createUniqueId();
  const plugin = () => props.plugin;

  const missingRequired = createMemo(() =>
    plugin().roles.filter((r) => r.required && r.accountId === null),
  );
  const cursorErrors = createMemo(() => plugin().cursors.filter((c) => c.lastError !== null));
  const needsAttention = createMemo(
    () => plugin().enabled && (missingRequired().length > 0 || cursorErrors().length > 0),
  );

  const [optionsOpen, setOptionsOpen] = createSignal(needsAttention() || Boolean(props.saved));

  // Local editable state for role overrides, account bindings, and non-secret config entries.
  const [roleOverrides, setRoleOverrides] = createSignal<Record<string, string>>({});
  const [bindings, setBindings] = createSignal<PluginAccountBindingView[]>([]);
  const [configEntries, setConfigEntries] = createSignal<PluginConfigEntryView[]>([]);

  // Resync editable form state whenever the persisted plugin snapshot advances.
  let lastSyncedStamp = "";
  createEffect(() => {
    const current = plugin();
    const stamp = [
      current.updatedAt,
      current.roles.map((r) => `${r.role}:${r.source}:${r.accountId ?? ""}`).join(","),
      String(current.accountMap.length),
      String(current.config.length),
    ].join("|");
    if (stamp === lastSyncedStamp) return;
    lastSyncedStamp = stamp;
    setRoleOverrides(
      Object.fromEntries(
        current.roles
          .filter((r) => r.source === "override" && r.accountId)
          .map((r) => [r.role, r.accountId as string]),
      ),
    );
    setBindings(current.accountMap.map((entry) => ({ ...entry })));
    setConfigEntries(current.config.map((entry) => ({ ...entry })));
  });

  const accountLabelById = createMemo(() => new Map(props.accounts.map((a) => [a.value, a.label])));

  const lastSyncAt = createMemo(() => {
    const stamps = plugin()
      .cursors.map((c) => c.lastSyncAt)
      .sort();
    return stamps.at(-1) ?? null;
  });

  const dateline = createMemo(() => {
    const at = lastSyncAt();
    return at ? words.updated(formatInstant(at)) : null;
  });

  const metaLine = createMemo(() => {
    const host = plugin().domains[0];
    const extra = plugin().domains.length > 1 ? ` +${plugin().domains.length - 1}` : "";
    return host ? `v${plugin().version} · ${host}${extra}` : `v${plugin().version}`;
  });

  const clearingLabel = createMemo(() => {
    const clearing = plugin().clearing;
    if (!clearing) return null;
    const resolved = plugin().roles.find((r) => r.role === clearing.role);
    if (!resolved?.accountId) return null;
    const label = accountLabelById().get(resolved.accountId);
    return label ? words.clearingNote(label, clearing.windowDays) : null;
  });

  const bankAccountChoices = createMemo(() =>
    props.accounts.filter((a) => (a.kind === "asset" || a.kind === "liability") && !a.closed),
  );

  const sourceRows = createMemo(() => {
    const byKey = new Map<
      string,
      { sourceKey: string; ledgerAccountId: string | null; lastSyncAt: string | null }
    >();
    for (const binding of plugin().accountMap) {
      byKey.set(binding.accountKey, {
        sourceKey: binding.accountKey,
        ledgerAccountId: binding.ledgerAccountId,
        lastSyncAt: null,
      });
    }
    for (const cursor of plugin().cursors) {
      const existing = byKey.get(cursor.sourceKey);
      byKey.set(cursor.sourceKey, {
        sourceKey: cursor.sourceKey,
        ledgerAccountId: existing?.ledgerAccountId ?? null,
        lastSyncAt: cursor.lastSyncAt,
      });
    }
    return [...byKey.values()];
  });

  const menuActions = createMemo<RowAction[]>(() => {
    const actions: RowAction[] = [];
    if (props.canConfigure) {
      actions.push({
        id: "configure",
        label: words.actionConfigure,
        onSelect: () => setOptionsOpen(true),
      });
    }
    if (props.canManageTokens) {
      actions.push({
        id: "tokens",
        label: words.actionTokens,
        onSelect: () => props.onOpenTokens(plugin()),
      });
    }
    if (props.canConfigure) {
      actions.push({
        id: "toggle",
        label: plugin().enabled ? words.actionPause : words.actionResume,
        onSelect: () => props.onToggleEnabled(plugin()),
      });
      actions.push({
        id: "remove",
        label: words.actionRemove,
        onSelect: () => props.onAskRemove(plugin()),
      });
    }
    return actions;
  });

  const chartDefaultLabel = (role: PluginRoleRowView): string => {
    if (role.source === "roleKey" && role.accountId) {
      return words.fromChart(accountLabelById().get(role.accountId) ?? role.accountId);
    }
    return words.noAccount;
  };

  const optionsForRole = (role: PluginRoleRowView) =>
    props.accounts.filter(
      (a) =>
        kindMatches(a.kind, role.kind) && (!a.closed || roleOverrides()[role.role] === a.value),
    );

  const handleSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    if (props.saving) return;
    const roleMap = Object.entries(roleOverrides()).flatMap(([role, accountId]) =>
      accountId ? [{ role, accountId }] : [],
    );
    const cleanBindings = bindings()
      .filter((b) => b.accountKey.trim() !== "" && b.ledgerAccountId.trim() !== "")
      .map((b) => ({
        accountKey: b.accountKey.trim(),
        ledgerAccountId: b.ledgerAccountId.trim(),
        ...(b.startOn?.trim() ? { startOn: b.startOn.trim() } : {}),
      }));
    const cleanConfig = configEntries()
      .filter((c) => c.key.trim() !== "")
      .map((c) => ({ key: c.key.trim(), value: c.value.trim() }));
    props.onSave({
      pluginId: plugin().pluginId,
      roleMap,
      accountMap: cleanBindings,
      config: cleanConfig,
    });
  };

  return (
    <section
      class="rt-plugin"
      aria-labelledby={`${uid}-title`}
      data-attention={needsAttention() ? "" : undefined}
    >
      <header class="rt-plugin-head">
        <span class="rt-plugin-mark" aria-hidden="true">
          {plugin().name.trim().charAt(0).toUpperCase()}
        </span>
        <div class="rt-plugin-title">
          <h2 id={`${uid}-title`}>{plugin().name}</h2>
          <bdi class="rt-plugin-meta">{metaLine()}</bdi>
          <Show when={!plugin().enabled}>
            <span class="rt-plugin-note">{words.paused}</span>
          </Show>
        </div>
        <Show when={dateline()}>
          {(stamp) => <span class="rt-plugin-dateline">{stamp()}</span>}
        </Show>
        <Show when={menuActions().length > 0}>
          <div class="rt-plugin-menu">
            <RowMenu
              id={`rt-plugin-menu-${plugin().pluginId}`}
              label={words.actionsFor(plugin().name)}
              actions={menuActions()}
            />
          </div>
        </Show>
      </header>

      <Show when={plugin().enabled && missingRequired().length > 0}>
        <div class="rt-plugin-attention" role="status">
          <span class="rt-cell" data-tone="attention" aria-hidden="true" />
          <p>
            {words.needAccounts(
              missingRequired()
                .map((r) => r.label)
                .join(", "),
            )}
          </p>
          <Show when={!optionsOpen() && props.canConfigure}>
            <Button size="sm" label={words.chooseAccounts} onClick={() => setOptionsOpen(true)} />
          </Show>
        </div>
      </Show>

      <For each={cursorErrors()}>
        {(cursor) => (
          <div class="rt-plugin-attention" role="alert">
            <span class="rt-cell" data-tone="attention" aria-hidden="true" />
            <p>{words.syncProblem(cursor.sourceKey, cursor.lastError ?? "")}</p>
          </div>
        )}
      </For>

      <Show
        when={sourceRows().length > 0}
        fallback={
          <Show
            when={clearingLabel()}
            fallback={
              <div class="rt-plugin-summary-line">
                <p>{words.waitingFirstSync}</p>
                <div class="rt-plugins-code-row">
                  <code class="rt-plugins-code" tabindex="0">
                    {words.cliSyncCommand(plugin().pluginId)}
                  </code>
                  <CopyButton
                    text={words.cliSyncCommand(plugin().pluginId)}
                    label={words.copyCommand}
                    copiedLabel={words.commandCopied}
                  />
                </div>
              </div>
            }
          >
            {(note) => (
              <div class="rt-plugin-summary-line">
                <p>{note()}</p>
              </div>
            )}
          </Show>
        }
      >
        <div class="rt-plugin-labels" aria-hidden="true">
          <span>{words.columns.source}</span>
          <span>{words.columns.account}</span>
          <span>{words.columns.updated}</span>
        </div>
        <ul class="rt-plugin-rows" aria-label={`${plugin().name} sources`}>
          <For each={sourceRows()}>
            {(row) => (
              <li>
                <span class="rt-plugin-source">
                  <bdi>{row.sourceKey}</bdi>
                </span>
                <span class={row.ledgerAccountId ? "" : "rt-plugin-quiet"}>
                  {row.ledgerAccountId
                    ? (accountLabelById().get(row.ledgerAccountId) ?? row.ledgerAccountId)
                    : (clearingLabel() ?? words.unassignedAccount)}
                </span>
                <span class="rt-plugin-row-updated">
                  {row.lastSyncAt ? formatInstant(row.lastSyncAt) : "—"}
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={props.canConfigure}>
        <Details
          flush
          open={optionsOpen()}
          onOpenChange={setOptionsOpen}
          summary={words.optionsTitle}
        >
          <form class="rt-plugin-form" onSubmit={handleSubmit} noValidate>
            <Show when={props.saveError}>
              {(err) => (
                <Notice title={words.saveFailed} tone="error" role="alert">
                  {err()}
                </Notice>
              )}
            </Show>

            <Show when={plugin().roles.length > 0}>
              <div>
                <h3 class="rt-plugin-section-title">{words.rolesHeading}</h3>
                <div class="rt-plugin-roles">
                  <For each={plugin().roles}>
                    {(role) => (
                      <div>
                        <SelectField
                          id={`${uid}-role-${role.role}`}
                          label={role.label}
                          aside={
                            <Show when={!role.required}>
                              <span class="rt-plugin-tag">{words.optional}</span>
                            </Show>
                          }
                          value={roleOverrides()[role.role] ?? ""}
                          items={[
                            { value: "", label: chartDefaultLabel(role) },
                            ...optionsForRole(role),
                          ]}
                          onChange={(value) =>
                            setRoleOverrides((prev) => {
                              const next = { ...prev };
                              if (value) next[role.role] = value;
                              else delete next[role.role];
                              return next;
                            })
                          }
                        />
                        <Show when={formatRoleProblem(role) && !roleOverrides()[role.role]}>
                          <p class="rt-plugin-role-problem">
                            <span class="rt-cell" data-tone="attention" aria-hidden="true" />
                            <span>{formatRoleProblem(role)}</span>
                          </p>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            <Show when={plugin().roles.length === 0 || bindings().length > 0}>
              <div>
                <h3 class="rt-plugin-section-title">{words.accountsHeading}</h3>
                <div class="rt-plugin-bindings">
                  <For each={bindings()}>
                    {(binding, idx) => (
                      <div class="rt-plugin-binding-row">
                        <TextField
                          id={`${uid}-src-${idx()}`}
                          label={words.sourceKeyLabel}
                          placeholder={words.sourceKeyPlaceholder}
                          value={binding.accountKey}
                          onInput={(event) => {
                            const next = event.currentTarget.value;
                            setBindings((list) =>
                              list.map((item, i) =>
                                i === idx() ? { ...item, accountKey: next } : item,
                              ),
                            );
                          }}
                        />
                        <SelectField
                          id={`${uid}-acct-${idx()}`}
                          label={words.ledgerAccountLabel}
                          value={binding.ledgerAccountId}
                          items={[{ value: "", label: words.noAccount }, ...bankAccountChoices()]}
                          onChange={(value) =>
                            setBindings((list) =>
                              list.map((item, i) =>
                                i === idx() ? { ...item, ledgerAccountId: value } : item,
                              ),
                            )
                          }
                        />
                        <DateField
                          id={`${uid}-start-${idx()}`}
                          label={words.startDateLabel}
                          value={binding.startOn ?? ""}
                          onChange={(value) =>
                            setBindings((list) =>
                              list.map((item, i) =>
                                i === idx() ? { ...item, startOn: value || undefined } : item,
                              ),
                            )
                          }
                        />
                        <Button
                          type="button"
                          variant="quiet"
                          size="sm"
                          label={words.removeRow}
                          onClick={() => setBindings((list) => list.filter((_, i) => i !== idx()))}
                        />
                      </div>
                    )}
                  </For>
                  <div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      label={words.addAccount}
                      onClick={() =>
                        setBindings((list) => [...list, { accountKey: "", ledgerAccountId: "" }])
                      }
                    />
                  </div>
                </div>
              </div>
            </Show>

            <Show when={configEntries().length > 0}>
              <div>
                <h3 class="rt-plugin-section-title">{words.settingsHeading}</h3>
                <div class="rt-plugin-config-grid">
                  <For each={configEntries()}>
                    {(entry, idx) => (
                      <TextField
                        id={`${uid}-cfg-${idx()}`}
                        label={entry.key}
                        value={entry.value}
                        onInput={(event) => {
                          const next = event.currentTarget.value;
                          setConfigEntries((list) =>
                            list.map((item, i) => (i === idx() ? { ...item, value: next } : item)),
                          );
                        }}
                      />
                    )}
                  </For>
                </div>
              </div>
            </Show>

            <p class="rt-plugin-domains-line">
              {words.domainsLabel}:{" "}
              {plugin().domains.length > 0 ? plugin().domains.join(", ") : words.domainsNone}
            </p>

            <div class="rt-plugin-actions">
              <Button
                type="submit"
                label={words.save}
                pendingLabel={words.saving}
                pending={props.saving ?? false}
                disabled={props.busy ?? false}
              />
              <Show when={props.saved}>
                <p role="status" class="rt-plugin-saved">
                  {words.saved}
                </p>
              </Show>
            </div>
          </form>
        </Details>
      </Show>
    </section>
  );
}
