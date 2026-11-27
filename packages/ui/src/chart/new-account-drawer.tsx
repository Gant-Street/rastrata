import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { chartWords } from "../accounting/chart-words";
import { Button } from "../button";
import { Dialog } from "../dialog";
import { Details } from "../kit/details";
import { Notice } from "../notice";
import { DateField } from "../date-field";
import { TextField } from "../text-field";
import { ACCOUNT_KINDS, type AccountKind, kindFacts } from "./account-kinds";
import {
  addSentence,
  hasAccountProblems,
  isBalanceSheetKind,
  newAccountProblems,
  type NewAccountValues,
} from "./account-form";
import { enterSubmits } from "./enter-submits";
import { SelectField } from "../select-field";

export interface NewAccountDrawerProps {
  open: boolean;
  values: NewAccountValues;
  /** One field changed. Changing the kind also offers the code of its range, unless the code was typed. */
  onChange: (patch: Partial<NewAccountValues>) => void;
  /** The accounts the book has: for the parent list and for a code that is already used. */
  accounts: readonly { id: string; code: string; name: string }[];
  /** The tax lines an account of this type (`income` or `expense`) may carry, by form (see `taxLineOptions`). */
  taxLines: (role: string) => readonly { value: string; label: string }[];
  /** The code the form offers for the kind chosen (said in the hint). */
  suggestedCode: string;
  stage: "compose" | "working" | "review";
  /** What the service says to read before the account is added; it waits for a decision. */
  warnings: readonly string[];
  /** Why the service refused it. */
  problems: readonly string[];
  /** A failure with no plan to read (the request could not be made). */
  error?: string | undefined;
  /** A request was sent and not answered: it is resumed, never replaced. */
  uncertain?: boolean | undefined;
  onResume?: (() => void) | undefined;
  onSubmit: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  /** Where focus goes when the drawer closes (the button that opened it). */
  returnFocus?: (() => HTMLElement | null) | undefined;
  /** What the host offers beside the form (extending the calendar for a date outside it). */
  extra?: JSX.Element | undefined;
}

const CLASSES = ["cash", "operating", "investing", "financing", "noncash"] as const;
const CLASS_NAMES: Readonly<Record<string, string>> = {
  cash: "Cash",
  operating: "Operating",
  investing: "Investing",
  financing: "Financing",
  noncash: "Non-cash",
};

/** "New account": a drawer that asks for a name, a type in plain English and a code (offered), and holds the
 * rest under Advanced. The form is the review: its footer says what adding will do ("This adds 6300 Software
 * as an Expense, starting Mar 21, 2026") and its button does it. The ledger may still have something to say
 * (an account already used, a date it cannot take); that is read here, and the person decides. */
export function NewAccountDrawer(props: NewAccountDrawerProps): JSX.Element {
  const w = chartWords.add;
  const v = () => props.values;
  const working = () => props.stage === "working";
  const review = () => props.stage === "review";
  const locked = () => working() || review();
  const problems = createMemo(() => newAccountProblems(v(), props.accounts));
  // Said after the first try, then kept up to date as the fields are fixed.
  const [asked, setAsked] = createSignal(false);
  let nameInput: HTMLInputElement | undefined;
  const submit = () => {
    const found = problems();
    if (hasAccountProblems(found)) {
      setAsked(true);
      const target = found.name
        ? "new-account-name"
        : found.code
          ? "new-account-code"
          : found.roleKey
            ? "new-account-role-key"
            : "new-account-date";
      queueMicrotask(() => document.getElementById(target)?.focus());
      return;
    }
    props.onSubmit();
  };
  const said = (field: "name" | "code" | "roleKey" | "effectiveOn") =>
    asked() ? problems()[field] : undefined;
  return (
    <Dialog
      open={props.open}
      placement="end"
      title={w.title}
      description={w.description}
      closeLabel={w.close}
      onOpenChange={(open) => {
        if (!open && !working()) props.onCancel();
      }}
      initialFocusEl={() => nameInput ?? null}
      {...(props.returnFocus ? { finalFocusEl: props.returnFocus } : {})}
      footer={
        <div class="rt-account-drawer-foot">
          <p class="rt-account-summary">{addSentence(v(), problems())}</p>
          <div class="rt-account-drawer-actions">
            <Button
              variant="quiet"
              label={w.cancel}
              disabled={working()}
              onClick={props.onCancel}
            />
            <Show
              when={review()}
              fallback={
                <Button
                  label={w.submit}
                  pending={working()}
                  pendingLabel={w.working}
                  disabled={props.uncertain === true}
                  onClick={submit}
                />
              }
            >
              <Button
                label={w.confirm}
                disabled={props.problems.length > 0 || props.uncertain === true}
                onClick={props.onConfirm}
              />
            </Show>
          </div>
        </div>
      }
    >
      <form
        class="rt-account-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!locked()) submit();
        }}
        onKeyDown={(event) =>
          enterSubmits(event, () => {
            if (!locked()) submit();
          })
        }
      >
        <TextField
          id="new-account-name"
          ref={nameInput}
          label={w.name}
          required
          maxLength={120}
          autocomplete="off"
          disabled={locked()}
          value={v().name}
          onInput={(event) => props.onChange({ name: event.currentTarget.value })}
          {...(said("name") ? { error: said("name") as string } : {})}
        />
        <SelectField
          id="new-account-type"
          label={w.type}
          hint={chartWords.kindHints[v().kind] ?? ""}
          value={v().kind}
          disabled={locked()}
          items={ACCOUNT_KINDS.map((kind) => ({
            value: kind,
            label: chartWords.kinds[kind] ?? kind,
          }))}
          onChange={(kind) => props.onChange({ kind: kind as AccountKind })}
        />
        <TextField
          id="new-account-code"
          label={w.code}
          required
          maxLength={20}
          autocomplete="off"
          spellcheck={false}
          disabled={locked()}
          hint={w.codeHint(props.suggestedCode)}
          value={v().code}
          onInput={(event) => props.onChange({ code: event.currentTarget.value })}
          {...(said("code") ? { error: said("code") as string } : {})}
        />
        <Show when={!isBalanceSheetKind(v().kind)}>
          <SelectField
            id="new-account-tax-line"
            label={w.taxLine}
            hint={w.taxLineHint}
            value={v().taxLine}
            disabled={locked()}
            items={[{ value: "", label: w.noTaxLine }, ...props.taxLines(kindFacts(v().kind).role)]}
            onChange={(taxLine) => props.onChange({ taxLine })}
          />
        </Show>
        <Details summary={w.advanced}>
          <div class="rt-account-advanced">
            <SelectField
              id="new-account-parent"
              label={w.parent}
              value={v().parentId}
              disabled={locked()}
              items={[
                { value: "", label: w.parentNone },
                ...props.accounts.map((account) => ({
                  value: account.id,
                  label: `${account.name} · ${account.code}`,
                })),
              ]}
              onChange={(parentId) => props.onChange({ parentId })}
            />
            <Show when={isBalanceSheetKind(v().kind)}>
              <SelectField
                id="new-account-cash-flow"
                label={w.cashFlow}
                hint={w.cashFlowHint}
                value={v().cashFlowClass || (kindFacts(v().kind).cashFlowClass ?? "")}
                disabled={locked()}
                items={[
                  { value: "", label: w.notSet },
                  ...CLASSES.filter(
                    (item) => kindFacts(v().kind).role === "asset" || item !== "cash",
                  ).map((item) => ({ value: item, label: CLASS_NAMES[item] ?? item })),
                ]}
                onChange={(cashFlowClass) => props.onChange({ cashFlowClass })}
              />
            </Show>
            <TextField
              id="new-account-role-key"
              label={w.roleKey}
              autocomplete="off"
              spellcheck={false}
              maxLength={60}
              disabled={locked()}
              hint={w.roleKeyHint}
              value={v().roleKey}
              onInput={(event) => props.onChange({ roleKey: event.currentTarget.value })}
              {...(said("roleKey") ? { error: said("roleKey") as string } : {})}
            />
            <DateField
              id="new-account-date"
              label={w.effective}
              required
              disabled={locked()}
              hint={w.effectiveHint}
              value={v().effectiveOn}
              onChange={(value) => props.onChange({ effectiveOn: value })}
              {...(said("effectiveOn") ? { error: said("effectiveOn") as string } : {})}
            />
          </div>
        </Details>
      </form>
      <Show when={props.warnings.length > 0}>
        <Notice title={w.checkTitle} tone="attention" role="status">
          <ul>
            <For each={props.warnings}>{(warning) => <li>{warning}</li>}</For>
          </ul>
        </Notice>
      </Show>
      <Show when={props.problems.length > 0}>
        <Notice title={w.problemTitle} tone="problem" role="alert">
          <ul>
            <For each={props.problems}>{(problem) => <li>{problem}</li>}</For>
          </ul>
        </Notice>
      </Show>
      <Show when={props.error}>
        {(message) => (
          <Notice title={w.problemTitle} tone="problem" role="alert">
            <p>{message()}</p>
          </Notice>
        )}
      </Show>
      <Show when={props.uncertain}>
        <Notice title={w.waitingTitle} tone="attention" role="status">
          <p>{w.retained}</p>
          <Show when={props.onResume}>
            <Button
              variant="secondary"
              label={chartWords.resume}
              disabled={working()}
              onClick={() => props.onResume?.()}
            />
          </Show>
        </Notice>
      </Show>
      {props.extra}
    </Dialog>
  );
}
