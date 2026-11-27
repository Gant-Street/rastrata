import { createMemo, For, Show } from "solid-js";
import { AccountPicker } from "../kit/account-picker";
import { Button } from "../button";
import { Plus, X } from "../icons";
import { TextField } from "../text-field";
import { parseAmount } from "./cents";
import type { AccountOption } from "./types";
import { words } from "./words";
import { centsToMoney, formatMoney, moneyToCents } from "../format";

export interface SplitPart {
  readonly accountId: string;
  /** As typed. Read with `parseAmount`: never converted to a number. */
  readonly amount: string;
}

export type SplitCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly problem: "amount" | "account" | "over" | "under";
      readonly message: string;
    };

/** Whether the parts add up to the line exactly. Every amount is read as whole cents; a third
 * decimal is refused, not rounded. `left` is what is still to assign (negative when over). */
export function checkSplit(
  total: string,
  parts: readonly SplitPart[],
): SplitCheck & { readonly left: string } {
  const whole = moneyToCents(total);
  let sum = 0n;
  let bad = false;
  let missing = false;
  for (const part of parts) {
    const cents = parseAmount(part.amount);
    if (cents === null || cents <= 0n) bad = true;
    else sum += cents;
    if (part.accountId === "") missing = true;
  }
  const left = whole - sum;
  const shown = centsToMoney(left);
  if (bad) return { ok: false, problem: "amount", message: words.splitBad, left: shown };
  if (missing)
    return { ok: false, problem: "account", message: words.splitNeedAccount, left: shown };
  if (left < 0n)
    return {
      ok: false,
      problem: "over",
      message: words.splitOver(formatMoney(centsToMoney(-left))),
      left: shown,
    };
  if (left > 0n)
    return {
      ok: false,
      problem: "under",
      message: words.splitUnder(formatMoney(shown)),
      left: shown,
    };
  return { ok: true, left: shown };
}

/** Divide one line between accounts. The remaining amount is shown to the cent as the parts change,
 * and "Create draft entry" is possible only when it is exactly 0.00. */
export function SplitEditor(props: {
  /** The line's amount without a sign, "100.00". */
  total: string;
  accounts: readonly AccountOption[];
  parts: readonly SplitPart[];
  onChange: (parts: readonly SplitPart[]) => void;
  disabled?: boolean;
}) {
  const check = createMemo(() => checkSplit(props.total, props.parts));
  const set = (index: number, patch: Partial<SplitPart>) =>
    props.onChange(props.parts.map((part, at) => (at === index ? { ...part, ...patch } : part)));
  return (
    <fieldset class="rt-inbox-split" disabled={props.disabled ?? false}>
      <legend>{words.splitTitle}</legend>
      <p class="rt-inbox-split-total">
        <span>{words.lineTotal}</span>
        <strong class="rt-inbox-amount">{formatMoney(props.total)}</strong>
      </p>
      <ol class="rt-inbox-split-parts">
        <For each={props.parts}>
          {(part, index) => (
            <li class="rt-inbox-split-part">
              <AccountPicker
                label={words.splitAccount(index() + 1)}
                accounts={props.accounts}
                value={part.accountId}
                onChange={(id) => set(index(), { accountId: id })}
              />
              <TextField
                label={words.splitAmount(index() + 1)}
                inputmode="decimal"
                autocomplete="off"
                placeholder="0.00"
                class="rt-inbox-split-amount"
                value={part.amount}
                onInput={(event) => set(index(), { amount: event.currentTarget.value })}
              />
              <Show when={props.parts.length > 2}>
                <Button
                  variant="quiet"
                  size="sm"
                  iconOnly
                  label={words.removePart(index() + 1)}
                  icon={<X aria-hidden="true" />}
                  onClick={() => props.onChange(props.parts.filter((_, at) => at !== index()))}
                />
              </Show>
            </li>
          )}
        </For>
      </ol>
      <div class="rt-inbox-split-foot">
        <Button
          variant="secondary"
          size="sm"
          label={words.addPart}
          icon={<Plus aria-hidden="true" />}
          disabled={props.parts.length >= 20}
          onClick={() => props.onChange([...props.parts, { accountId: "", amount: "" }])}
        />
        <p class="rt-inbox-split-left" role="status" data-balanced={check().ok ? "" : undefined}>
          <span>{words.leftToAssign}</span>{" "}
          <strong class="rt-inbox-amount">{formatMoney(check().left)}</strong>
          <span class="rt-sr-only">
            {check().ok ? words.splitBalanced : (check() as { message: string }).message}
          </span>
        </p>
      </div>
      <Show when={!check().ok}>
        <p class="rt-hint rt-inbox-split-message">{(check() as { message: string }).message}</p>
      </Show>
    </fieldset>
  );
}
