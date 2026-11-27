import { createEffect, createSignal, createUniqueId, on, Show } from "solid-js";
import { Button } from "../button";
import { Dialog, DialogClose } from "../dialog";
import { ErrorSummary, type FormError } from "../error-summary";
import { formatMoney } from "../format";
import { type AccountOption, AccountPicker } from "../kit/account-picker";
import { Notice } from "../notice";
import { DateField } from "../date-field";
import { TextField } from "../text-field";
import { words } from "./words";

export type StartFormValues = { account: string; date: string; balance: string };
export type StartFormErrors = {
  account?: string;
  date?: string;
  balance?: string;
  /** A problem with the request as a whole, for example a failed connection. */
  form?: string;
};

/** Start a reconciliation: which account, the date the statement ends, and the balance it ends with
 * exactly as printed. It is a small form over the page, opened from an account's row (the account is
 * chosen already), from "Reconcile an account" or from "+ New". The parent validates (it owns the date and
 * amount rules) and passes the messages back; this lists them in an error summary that links to each field.
 * An imported statement's own balance fills the empty date and balance and says so; typed values are never
 * overwritten. */
export function ReconcileStartDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The accounts that can be reconciled, as the kit's picker takes them. */
  accounts: readonly AccountOption[];
  /** The account the form opens on (the row it was opened from), or none. */
  account?: string | undefined;
  errors?: StartFormErrors;
  pending?: boolean;
  /** The balance an imported statement file reported for the chosen account. */
  hint?: { date: string; balance: string } | undefined;
  /** The chosen account changed, so the parent can look up a hint for it. */
  onAccountChange?: (accountId: string) => void;
  /** An earlier start whose reply was lost is waiting: it is resumed, never replaced. */
  retained?: boolean;
  onResume?: () => void;
  onSubmit: (values: StartFormValues) => void;
}) {
  const uid = createUniqueId();
  const ids = { account: `${uid}-account`, date: `${uid}-date`, balance: `${uid}-balance` };
  const [account, setAccount] = createSignal(props.account ?? "");
  const [date, setDate] = createSignal("");
  const [balance, setBalance] = createSignal("");
  const [attempt, setAttempt] = createSignal(0);
  const [filled, setFilled] = createSignal(false);
  const [local, setLocal] = createSignal<StartFormErrors>({});
  const shown = (): StartFormErrors => ({ ...local(), ...(props.errors ?? {}) });
  const nameOf = (id: string) => props.accounts.find((item) => item.value === id)?.label;
  // Opening it starts from nothing typed, on the account it was opened for.
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setAccount(props.account ?? "");
        setDate("");
        setBalance("");
        setFilled(false);
        setLocal({});
        setAttempt(0);
        if (props.account) props.onAccountChange?.(props.account);
        // A statement balance already known for this account fills the form as it opens.
        const known = props.hint;
        if (known) {
          setDate(known.date);
          setBalance(known.balance);
          setFilled(true);
        }
      },
    ),
  );
  createEffect(
    on(
      () => props.hint,
      (hint) => {
        if (hint && !date().trim() && !balance().trim()) {
          setDate(hint.date);
          setBalance(hint.balance);
          setFilled(true);
        } else if (!hint) setFilled(false);
      },
    ),
  );
  const list = (): FormError[] => {
    const errors = shown();
    return [
      ...(errors.account ? [{ id: ids.account, message: errors.account }] : []),
      ...(errors.date ? [{ id: ids.date, message: errors.date }] : []),
      ...(errors.balance ? [{ id: ids.balance, message: errors.balance }] : []),
    ];
  };
  const submit = () => {
    if (props.pending || props.retained) return;
    const problems: StartFormErrors = {
      ...(account() ? {} : { account: words.needAccount }),
      ...(/^\d{4}-\d{2}-\d{2}$/.test(date().trim()) ? {} : { date: words.needDate }),
      ...(balance().trim() ? {} : { balance: words.needBalance }),
    };
    setLocal(problems);
    if (Object.keys(problems).length > 0) {
      setAttempt((value) => value + 1);
      return;
    }
    props.onSubmit({ account: account(), date: date().trim(), balance: balance().trim() });
  };
  const onEnter = (event: KeyboardEvent) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    submit();
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={
        props.account && nameOf(props.account)
          ? words.startTitleFor(nameOf(props.account) ?? "")
          : words.startTitle
      }
      description={words.startIntro}
      initialFocusEl={() => document.getElementById(account() ? ids.date : ids.account)}
      footer={
        <>
          <DialogClose class="rt-button" data-variant="secondary" data-size="md">
            {words.cancel}
          </DialogClose>
          <Button
            label={words.start}
            pendingLabel={words.starting}
            pending={props.pending ?? false}
            disabled={props.retained ?? false}
            onClick={submit}
          />
        </>
      }
    >
      <Show when={props.retained}>
        <Notice title={words.retainedTitle} tone="review" role="status">
          <p>{words.retainedBody}</p>
          <Button
            label={words.resume}
            disabled={props.pending ?? false}
            onClick={() => props.onResume?.()}
          />
        </Notice>
      </Show>
      <Show when={list().length > 0}>
        <ErrorSummary errors={list()} title={words.startErrors} attempt={attempt()} />
      </Show>
      <Show when={shown().form}>
        <Notice title={words.dialogError} tone="error" role="alert">
          {shown().form}
        </Notice>
      </Show>
      <AccountPicker
        id={ids.account}
        label={words.account}
        required
        accounts={props.accounts}
        value={account()}
        {...(shown().account ? { error: shown().account as string } : {})}
        onChange={(id) => {
          setAccount(id);
          props.onAccountChange?.(id);
        }}
      />
      <DateField
        id={ids.date}
        label={words.statementDate}
        required
        hint={words.statementDateHint}
        value={date()}
        onChange={(value) => setDate(value)}
        onEnter={submit}
        {...(shown().date ? { error: shown().date as string } : {})}
      />
      <TextField
        id={ids.balance}
        label={words.statementBalanceField}
        required
        inputmode="decimal"
        autocomplete="off"
        hint={words.statementBalanceHint}
        value={balance()}
        onInput={(event) => setBalance(event.currentTarget.value)}
        onKeyDown={onEnter}
        {...(shown().balance ? { error: shown().balance as string } : {})}
      />
      <Show when={props.hint}>
        {(hint) => (
          <p class="rt-hint rt-recon-import-hint" role="status">
            <Show
              when={date() === hint().date && balance() === hint().balance}
              fallback={
                <>
                  {words.hintFromImport(formatMoney(hint().balance), hint().date)}{" "}
                  <button
                    type="button"
                    class="rt-text-button"
                    onClick={() => {
                      setDate(hint().date);
                      setBalance(hint().balance);
                    }}
                  >
                    {words.useHint}
                  </button>
                </>
              }
            >
              {filled()
                ? words.filledFromImport(formatMoney(hint().balance), hint().date)
                : words.hintFromImport(formatMoney(hint().balance), hint().date)}
            </Show>
          </p>
        )}
      </Show>
    </Dialog>
  );
}
