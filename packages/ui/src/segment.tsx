import { SegmentGroup } from "@ark-ui/solid/segment-group";
import { For, type JSX } from "solid-js";

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

/**
 * One choice out of a few that changes what is under it (the kind of a transaction): a row of segments,
 * the chosen one filled. It is a radio group, so the arrow keys move the choice and Tab leaves it; use it
 * for two to four short choices that are all worth seeing, and a select for more.
 */
export function Segment<T extends string>(props: {
  /** Names the group for assistive technology ("Kind of transaction"). */
  label: string;
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean | undefined;
}): JSX.Element {
  return (
    <SegmentGroup.Root
      class="rt-segment"
      orientation="horizontal"
      aria-label={props.label}
      value={props.value}
      disabled={props.disabled ?? false}
      onValueChange={(detail) => {
        if (detail.value !== null && detail.value !== props.value)
          props.onChange(detail.value as T);
      }}
    >
      <For each={props.options}>
        {(option) => (
          <SegmentGroup.Item value={option.value}>
            <SegmentGroup.ItemText>{option.label}</SegmentGroup.ItemText>
            <SegmentGroup.ItemControl />
            <SegmentGroup.ItemHiddenInput />
          </SegmentGroup.Item>
        )}
      </For>
    </SegmentGroup.Root>
  );
}
