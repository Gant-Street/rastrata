import { For, Show, type JSX } from "solid-js";

/**
 * Where a person is in a short sequence. A list of the steps, with the current one marked for
 * assistive technology (`aria-current="step"`) and in text, so position never depends on color.
 * On a narrow screen the numbers stay in one row and the current step's name sits under them.
 */
export function StepIndicator(props: {
  steps: readonly string[];
  /** Zero-based index of the current step. */
  current: number;
  label: string;
  /** Said to a screen reader for a step already done. */
  doneLabel?: string;
}): JSX.Element {
  return (
    <nav aria-label={props.label} class="rt-wizard-steps-nav">
      <ol class="rt-wizard-steps">
        <For each={props.steps}>
          {(title, index) => (
            <li
              aria-current={index() === props.current ? "step" : undefined}
              data-state={
                index() < props.current ? "done" : index() === props.current ? "current" : "todo"
              }
            >
              <span class="rt-wizard-step-number" aria-hidden="true">
                {index() + 1}
              </span>
              <span class="rt-wizard-step-title">{title}</span>
              <Show when={index() < props.current && props.doneLabel}>
                <span class="rt-sr-only"> ({props.doneLabel})</span>
              </Show>
            </li>
          )}
        </For>
      </ol>
      <p class="rt-wizard-step-now" aria-hidden="true">
        {props.steps[props.current]}
      </p>
    </nav>
  );
}
