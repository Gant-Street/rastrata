import { Progress as ArkProgress } from "@ark-ui/solid/progress";
import { Show } from "solid-js";

/**
 * Determinate progress only when the amount of work is known. Pass `null` for "working, no
 * estimate"; never invent a percentage.
 */
export function Progress(props: { label: string; value: number | null; showValue?: boolean }) {
  return (
    <ArkProgress.Root class="rt-progress" value={props.value}>
      <ArkProgress.Label>{props.label}</ArkProgress.Label>
      <Show when={props.showValue && props.value !== null}>
        {" · "}
        <ArkProgress.ValueText />
      </Show>
      <ArkProgress.Track>
        <ArkProgress.Range />
      </ArkProgress.Track>
    </ArkProgress.Root>
  );
}
