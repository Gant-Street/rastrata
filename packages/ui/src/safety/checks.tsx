import { For, Show } from "solid-js";
import { Check, Minus, X } from "../icons";
import { checkLabel, words } from "./words";
import type { CheckView } from "./types";

/** What was checked and what each check found. A status is a word and an icon, never colour alone;
 * the service's own message sits under the label because it carries the numbers and the reason. */
export function CheckList(props: { checks: readonly CheckView[]; label?: string }) {
  return (
    <ul class="rt-safe-checks" aria-label={props.label ?? words.checksTitle}>
      <For each={props.checks}>
        {(check) => (
          <li data-status={check.status}>
            <span class="rt-safe-check-mark" aria-hidden="true">
              <Show when={check.status === "passed"}>
                <Check />
              </Show>
              <Show when={check.status === "failed"}>
                <X />
              </Show>
              <Show when={check.status === "skipped"}>
                <Minus />
              </Show>
            </span>
            <span class="rt-safe-check-body">
              <strong>
                {checkLabel(check)}
                <span class="rt-sr-only">
                  {": "}
                  {check.status === "passed"
                    ? words.checkPassed
                    : check.status === "failed"
                      ? words.checkFailed
                      : words.checkSkipped}
                </span>
              </strong>
              <span class="rt-safe-check-word" aria-hidden="true">
                {check.status === "passed"
                  ? words.checkPassed
                  : check.status === "failed"
                    ? words.checkFailed
                    : words.checkSkipped}
              </span>
              <small>{check.message}</small>
            </span>
          </li>
        )}
      </For>
    </ul>
  );
}
