import { Collapsible } from "@ark-ui/solid/collapsible";
import { type JSX, Show } from "solid-js";
import { formatCount } from "../format";
import { ListFilter } from "../icons";
import { useUi } from "../locale";

/** A list's less common filters, folded into its search box: at rest the list shows the box, with one
 * quiet button at its end, and nothing else. Three parts, because the button sits in the search box and
 * the filters open under the list's tools: wrap both in `FilterFold`, put `FilterFoldButton` in the search
 * box and the fields in `FilterFoldPanel`. It is a disclosure (Ark's Collapsible): Tab, Enter and Space do
 * what they do everywhere and a screen reader says "collapsed" or "expanded". The fields are made the
 * first time the fold opens, and kept after that. */
export function FilterFold(props: {
  open?: boolean | undefined;
  /** Open when it is first drawn: a list that arrives already narrowed (by a link, by its address) shows
   * what narrows it, so nobody is looking at a part of the list without being told. */
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  class?: string | undefined;
  children: JSX.Element;
}): JSX.Element {
  return (
    <Collapsible.Root
      class={`rt-filter-fold ${props.class ?? ""}`.trim()}
      lazyMount
      {...(props.open !== undefined ? { open: props.open } : {})}
      {...(props.defaultOpen !== undefined ? { defaultOpen: props.defaultOpen } : {})}
      onOpenChange={(detail) => props.onOpenChange?.(detail.open)}
    >
      {props.children}
    </Collapsible.Root>
  );
}

/** The button that opens the fold: an icon at the end of the search box, named "Filter". `count` is how
 * many filters are narrowing the list: shown on the button (and said with its name) while it is above
 * zero, so a list that is narrowed says so with the fold shut. */
export function FilterFoldButton(props: {
  /** Rewords "Filter". */
  label?: string | undefined;
  count?: number | undefined;
  disabled?: boolean | undefined;
}): JSX.Element {
  const ui = useUi();
  const label = () => props.label ?? ui.messages.kit.filter;
  const on = () => (props.count ?? 0) > 0;
  return (
    <Collapsible.Trigger
      class="rt-button rt-icon-button rt-filter-button"
      data-variant="quiet"
      data-size="sm"
      title={label()}
      aria-label={on() ? ui.messages.kit.filterOn(label(), props.count ?? 0) : label()}
      disabled={props.disabled ?? false}
    >
      <ListFilter aria-hidden="true" />
      <Show when={on()}>
        <span class="rt-filter-count" aria-hidden="true">
          {formatCount(props.count ?? 0)}
        </span>
      </Show>
    </Collapsible.Trigger>
  );
}

/** What the fold holds: the filters, in the list's own layout (`class`). */
export function FilterFoldPanel(props: {
  class?: string | undefined;
  children: JSX.Element;
}): JSX.Element {
  return (
    <Collapsible.Content class={`rt-filter-panel ${props.class ?? ""}`.trim()}>
      {props.children}
    </Collapsible.Content>
  );
}
