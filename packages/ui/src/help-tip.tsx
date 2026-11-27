import { Popover } from "@ark-ui/solid/popover";
import { Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { buttonAttrs } from "./button";
import { Info } from "./icons";
import { useUi } from "./locale";

/**
 * Help in context. A small button opens a popover with the explanation, so the form stays
 * quiet for people who know it and answers the question for people who do not. Unlike a
 * tooltip it works on touch and with a keyboard, and it may hold real instructions.
 */
export function HelpTip(props: {
  topic: string;
  title?: string;
  /** A visible button label ("What does posted mean?"). Omit for a compact info icon. */
  label?: string;
  children: JSX.Element;
}) {
  const ui = useUi();
  return (
    <Popover.Root positioning={{ placement: "bottom-start" }}>
      <Show
        when={props.label}
        fallback={
          <Popover.Trigger
            {...buttonAttrs({ variant: "quiet", size: "sm", iconOnly: true })}
            aria-label={ui.messages.field.help(props.topic)}
          >
            <Info aria-hidden="true" />
          </Popover.Trigger>
        }
      >
        <Popover.Trigger {...buttonAttrs({ variant: "secondary" })}>{props.label}</Popover.Trigger>
      </Show>
      <Portal>
        <Popover.Positioner>
          <Popover.Content class="rt-popup rt-help rt-theme">
            <Show when={props.title}>
              <Popover.Title class="rt-help-title">{props.title}</Popover.Title>
            </Show>
            <Popover.Description class="rt-help-body">{props.children}</Popover.Description>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}
