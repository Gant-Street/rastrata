import { Tooltip as ArkTooltip } from "@ark-ui/solid/tooltip";
import type { JSX } from "solid-js";
import { Portal } from "solid-js/web";

type TriggerProps = (
  userProps?: JSX.ButtonHTMLAttributes<HTMLButtonElement>,
) => JSX.ButtonHTMLAttributes<HTMLButtonElement>;

/**
 * A short clarification on hover or focus. It never holds essential instructions (touch users
 * cannot hover); use HelpTip for anything a person must be able to read.
 *
 * The trigger is yours, so any button can have one:
 * `<Tooltip content="About posting">{(attrs) => <Button {...attrs()} iconOnly … />}</Tooltip>`
 */
export function Tooltip(props: {
  content: JSX.Element;
  openDelay?: number;
  children: (attrs: TriggerProps) => JSX.Element;
}) {
  return (
    <ArkTooltip.Root openDelay={props.openDelay ?? 150}>
      <ArkTooltip.Trigger asChild={(attrs) => props.children(attrs as unknown as TriggerProps)} />
      <Portal>
        <ArkTooltip.Positioner>
          <ArkTooltip.Content class="rt-tooltip">{props.content}</ArkTooltip.Content>
        </ArkTooltip.Positioner>
      </Portal>
    </ArkTooltip.Root>
  );
}
