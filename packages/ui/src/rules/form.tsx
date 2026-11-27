import { createUniqueId, For, Show, type JSX } from "solid-js";
import { CheckField } from "../accounting-controls";
import { Button } from "../button";
import { ErrorSummary, type FormError } from "../error-summary";
import { TextArea, TextField } from "../text-field";
import { RuleAction } from "./action";
import { RuleConditions } from "./conditions";
import { fieldId, setScopeAccount } from "./draft";
import type { RuleDraft, RuleOption, RuleSplitPreview } from "./types";
import { words } from "./words";
import { PageHeader } from "../page-header";

type Errors = Readonly<Record<string, string>>;

function Scope(props: {
  draft: RuleDraft;
  onChange: (next: RuleDraft) => void;
  accounts: readonly RuleOption[];
  errors: Errors;
  disabled?: boolean | undefined;
}) {
  const headingId = createUniqueId();
  const some = () => props.draft.scope === "some";
  return (
    <section class="rt-rules-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{words.scopeTitle}</h2>
      <CheckField
        label={words.scopeSome}
        checked={some()}
        disabled={props.disabled ?? false}
        onChange={(on) =>
          props.onChange({
            ...props.draft,
            scope: on ? "some" : "all",
            accountIds: on ? props.draft.accountIds : [],
          })
        }
      />
      <Show when={some()}>
        <fieldset
          class="rt-rules-scope"
          id={fieldId("accountIds")}
          tabindex="-1"
          aria-describedby={props.errors.accountIds ? `${fieldId("accountIds")}-error` : undefined}
        >
          <legend>{words.scopeChoose}</legend>
          <Show when={props.errors.accountIds}>
            {(message) => (
              <p class="rt-error" id={`${fieldId("accountIds")}-error`}>
                {message()}
              </p>
            )}
          </Show>
          <Show
            when={props.accounts.length > 0}
            fallback={<p class="rt-hint">{words.scopeNone}</p>}
          >
            <For each={props.accounts}>
              {(account) => (
                <CheckField
                  label={account.label}
                  checked={props.draft.accountIds.includes(account.value)}
                  disabled={props.disabled ?? false}
                  onChange={(on) => props.onChange(setScopeAccount(props.draft, account.value, on))}
                />
              )}
            </For>
          </Show>
        </fieldset>
      </Show>
    </section>
  );
}

/** The rule editor: a name, the conditions, the accounts it applies to, what it suggests, and a
 * place beside it (`aside`) for the live check of what the rule would do to the lines already
 * there. It is controlled: the draft and its problems come in, changes go out, and nothing here
 * talks to the service. A failed save lists every problem in a summary that takes focus and links
 * to the control each is about; every answer that was valid stays where it was typed. */
export function RuleForm(props: {
  mode: "new" | "edit";
  draft: RuleDraft;
  onChange: (next: RuleDraft) => void;
  /** Problems by where they sit in the rule ("conditions[0].value", "action.accountId"). */
  errors: Errors;
  /** The same problems as a list for the summary, and which attempt to save they belong to. */
  summary: readonly FormError[];
  attempt: number;
  /** Accounts a line can be booked to, grouped by kind. */
  accounts: readonly RuleOption[];
  transferAccounts: readonly RuleOption[];
  /** The accounts bank lines are on: where a rule can be limited, and what the "account" test
   * chooses from. */
  lineAccounts: readonly RuleOption[];
  split: { amount: string; onAmount: (value: string) => void; preview: RuleSplitPreview | null };
  narrationExample?: string | undefined;
  /** Notices that belong above the form: started from an Inbox line, a lost reply, a conflict. */
  banner?: JSX.Element;
  /** The live check of the rule. */
  aside?: JSX.Element;
  saving?: boolean | undefined;
  /** Nothing can be edited: the rule was retired, or a request is still unresolved. */
  locked?: boolean | undefined;
  cancelHref: string;
  onSubmit: () => void;
  onDelete?: (() => void) | undefined;
}) {
  const titleId = createUniqueId();
  const busy = () => (props.saving ?? false) || (props.locked ?? false);
  return (
    <form
      class="rt-rules-form"
      novalidate
      aria-labelledby={titleId}
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy()) props.onSubmit();
      }}
    >
      <PageHeader
        titleId={titleId}
        title={props.mode === "new" ? words.editorNewTitle : words.editorEditTitle}
      />
      {props.banner}
      <Show when={props.summary.length > 0}>
        <ErrorSummary errors={props.summary} attempt={props.attempt} title={words.summaryTitle} />
      </Show>
      <div class="rt-rules-editor">
        <div class="rt-rules-editor-main">
          <section class="rt-rules-section" aria-label={words.nameTitle}>
            <TextField
              id={fieldId("name")}
              label={words.name}
              required
              maxlength={120}
              autocomplete="off"
              value={props.draft.name}
              disabled={busy()}
              {...(props.errors.name ? { error: props.errors.name } : {})}
              onInput={(event) =>
                props.onChange({ ...props.draft, name: event.currentTarget.value })
              }
            />
            <TextArea
              id={fieldId("note")}
              label={words.note}
              maxlength={500}
              value={props.draft.note}
              disabled={busy()}
              {...(props.errors.note ? { error: props.errors.note } : {})}
              onInput={(event) =>
                props.onChange({ ...props.draft, note: event.currentTarget.value })
              }
            />
            <CheckField
              label={words.enabled}
              checked={props.draft.enabled}
              disabled={busy()}
              onChange={(enabled) => props.onChange({ ...props.draft, enabled })}
            />
          </section>
          <RuleConditions
            draft={props.draft}
            onChange={props.onChange}
            lineAccounts={props.lineAccounts}
            errors={props.errors}
            disabled={busy()}
          />
          <Scope
            draft={props.draft}
            onChange={props.onChange}
            accounts={props.lineAccounts}
            errors={props.errors}
            disabled={busy()}
          />
          <RuleAction
            draft={props.draft}
            onChange={props.onChange}
            accounts={props.accounts}
            transferAccounts={props.transferAccounts}
            errors={props.errors}
            disabled={busy()}
            split={props.split}
            narrationExample={props.narrationExample}
          />
        </div>
        <Show when={props.aside}>
          <aside class="rt-rules-editor-aside" aria-label={words.previewTitle}>
            {props.aside}
          </aside>
        </Show>
      </div>
      <div class="rt-rules-actions">
        <Button
          type="submit"
          label={props.mode === "new" ? words.create : words.save}
          pending={props.saving ?? false}
          pendingLabel={words.saving}
          disabled={props.locked ?? false}
        />
        <a class="rt-button" data-variant="secondary" data-size="md" href={props.cancelHref}>
          {words.cancel}
        </a>
        <Show when={props.onDelete}>
          <Button
            variant="danger"
            label={words.deleteRule}
            disabled={busy()}
            onClick={() => props.onDelete?.()}
          />
        </Show>
      </div>
    </form>
  );
}
