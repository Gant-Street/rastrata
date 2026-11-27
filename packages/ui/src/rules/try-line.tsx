import { For, Show } from "solid-js";
import { Button } from "../button";
import { Status } from "../notice";
import { RuleInput, RuleSelect } from "./fields";
import type { RuleOption, RuleTryResult, RuleTryValues } from "./types";
import { words } from "./words";
import { formatMoney } from "../format";
import { Details } from "../kit/details";

/** Try a rule on one line of text without saving anything: a memo from an email, a line from a
 * statement. It says whether the rule applies, which conditions held and which did not, and the
 * entry it would suggest. What is typed is only compared; it is never run, never put into a
 * pattern and never shown as markup. This is a panel, not a form of its own (it sits inside the
 * rule form), so Enter here tries the line and does not save the rule. */
export function RuleTryLine(props: {
  values: RuleTryValues;
  onChange: (next: RuleTryValues) => void;
  /** The accounts a bank line can be on. */
  accounts: readonly RuleOption[];
  onRun: () => void;
  pending?: boolean | undefined;
  /** Why it cannot be tried yet (the rule is incomplete), or why the last try failed. */
  problem?: string | undefined;
  errors?: Readonly<{ description?: string; amount?: string }> | undefined;
  result: RuleTryResult | null;
  /** Open the panel at first. */
  open?: boolean | undefined;
}) {
  const enter = () => {
    if (!props.pending) props.onRun();
  };
  const sentence = (result: RuleTryResult) =>
    result.outcome === "applies"
      ? words.tryApplies
      : result.outcome === "shadowed"
        ? words.tryShadowed(result.detail ?? "")
        : result.outcome === "unusable"
          ? words.tryUnusable(result.detail)
          : words.tryNoMatch;
  return (
    <Details class="rt-rules-try" flush defaultOpen={props.open ?? false} summary={words.tryTitle}>
      <div class="rt-rules-try-body">
        <p class="rt-hint">{words.tryIntro}</p>
        <div class="rt-rules-try-fields">
          <RuleInput
            label={words.tryDescription}
            value={props.values.description}
            maxLength={500}
            error={props.errors?.description}
            onEnter={enter}
            onInput={(description) => props.onChange({ ...props.values, description })}
          />
          <RuleInput
            label={words.tryCounterparty}
            value={props.values.counterparty}
            maxLength={200}
            onEnter={enter}
            onInput={(counterparty) => props.onChange({ ...props.values, counterparty })}
          />
          <RuleInput
            label={words.tryAmount}
            hint={words.tryAmountHint}
            value={props.values.amount}
            inputMode="decimal"
            maxLength={20}
            placeholder="-12.40"
            error={props.errors?.amount}
            onEnter={enter}
            onInput={(amount) => props.onChange({ ...props.values, amount })}
          />
          <RuleSelect
            label={words.tryAccount}
            value={props.values.accountId}
            placeholder={words.tryAccountDefault}
            options={props.accounts}
            onChange={(accountId) => props.onChange({ ...props.values, accountId })}
          />
        </div>
        <Button
          variant="secondary"
          label={words.tryRun}
          pendingLabel={words.tryRunning}
          pending={props.pending ?? false}
          onClick={() => props.onRun()}
        />
        <div class="rt-rules-try-result" role="status" aria-live="polite">
          <Show when={props.problem}>{(message) => <p class="rt-error">{message()}</p>}</Show>
          <Show when={props.result}>
            {(result) => (
              <>
                <p class="rt-rules-try-outcome">
                  <Status tone={result().outcome === "applies" ? "neutral" : "review"}>
                    {words.outcomeWord[result().outcome]}
                  </Status>{" "}
                  <bdi>{sentence(result())}</bdi>
                </p>
                <Show when={result().held.length > 0}>
                  <div>
                    <h4>{words.tryHeld}</h4>
                    <ul>
                      <For each={result().held}>
                        {(item) => (
                          <li>
                            <bdi>{item}</bdi>
                          </li>
                        )}
                      </For>
                    </ul>
                  </div>
                </Show>
                <Show when={result().missed.length > 0}>
                  <div>
                    <h4>{words.tryMissed}</h4>
                    <ul>
                      <For each={result().missed}>
                        {(item) => (
                          <li>
                            <bdi>{item}</bdi>
                          </li>
                        )}
                      </For>
                    </ul>
                  </div>
                </Show>
                <Show when={result().kind}>{(kind) => <p>{words.tryWouldDo(kind())}</p>}</Show>
                <Show when={result().wouldBook.length > 0}>
                  <ul class="rt-rules-legs">
                    <For each={result().wouldBook}>
                      {(leg) => (
                        <li>
                          <bdi>{leg.account}</bdi>{" "}
                          <span class="rt-rules-amount">{formatMoney(leg.amount)}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <Show when={result().narration}>
                  {(narration) => (
                    <p>
                      {words.tryNarration} <q>{narration()}</q>
                    </p>
                  )}
                </Show>
              </>
            )}
          </Show>
        </div>
      </div>
    </Details>
  );
}
