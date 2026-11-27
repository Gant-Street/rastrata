import { Accordion } from "@ark-ui/solid/accordion";
import { Index, type JSX, Show } from "solid-js";
import { Check } from "../icons";

/** One step of a task that is done a step at a time. */
export interface StepItem {
  readonly id: string;
  readonly title: string;
  /** The step has been done: it is one line that says what came of it. */
  readonly done?: boolean | undefined;
  /** What came of it, in a few words made of the book's own figures ("42 accounts, all matched"). */
  readonly said?: string | undefined;
}

/**
 * A task done a step at a time: the steps are numbered in order, one is open and asks for one thing, a step that
 * is done is one line that says what came of it (and opens again to change it), and a step still to come is only
 * named. It is Ark's accordion, so the keyboard moves between the steps with the arrow keys and opens one with
 * Enter or Space, and a screen reader hears which is open.
 *
 * The page says which step is open (usually the first that is not done) and draws each step's body; every body
 * stays on the page, so what a person has typed into a step is there when they open it again.
 */
export function Steps(props: {
  /** Names the list for assistive technology ("Files from Xero"). */
  label: string;
  steps: readonly StepItem[];
  /** The step that is open, or null when none is. */
  open: string | null;
  onOpen: (id: string | null) => void;
  /** What a finished step offers at its end: "Change". */
  changeLabel: string;
  /** Draws a step's body. */
  children: (id: string) => JSX.Element;
}): JSX.Element {
  return (
    <Accordion.Root
      class="rt-steps"
      aria-label={props.label}
      collapsible
      value={props.open === null ? [] : [props.open]}
      onValueChange={(detail) => props.onOpen(detail.value[0] ?? null)}
    >
      <Index each={props.steps}>
        {(step, index) => (
          <Accordion.Item
            class="rt-step"
            value={step().id}
            data-done={step().done ? "" : undefined}
          >
            <h2 class="rt-step-head">
              <Accordion.ItemTrigger class="rt-step-trigger">
                <span class="rt-step-number">{index + 1}</span>
                <span class="rt-step-title">{step().title}</span>
                <Show when={step().done && step().said}>
                  <span class="rt-step-said" data-facts>
                    <Check class="rt-step-tick" aria-hidden="true" />
                    {step().said}
                  </span>
                </Show>
                <Show when={step().done && props.open !== step().id}>
                  <span class="rt-step-change">{props.changeLabel}</span>
                </Show>
              </Accordion.ItemTrigger>
            </h2>
            <Accordion.ItemContent class="rt-step-body">
              {props.children(step().id)}
            </Accordion.ItemContent>
          </Accordion.Item>
        )}
      </Index>
    </Accordion.Root>
  );
}
