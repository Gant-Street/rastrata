import { Collapsible } from "@ark-ui/solid/collapsible";
import Copy from "lucide-solid/icons/copy";
import { createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { buttonAttrs } from "../button";
import { Check, ChevronRight } from "../icons";
import { useUi } from "../locale";
import { writeToClipboard } from "./copy";

/** What a copy button copies, and what to call it ("fingerprint"), so its name says which button it is
 * when a page has several. */
export interface CopyTarget {
  readonly value: string;
  readonly label?: string;
}

/** A button that puts one value on the clipboard, and says whether it got there. The value is never
 * shown by the button; whoever offers it shows it somewhere a person can read and select it, because
 * the clipboard can refuse and then selecting it by hand is the only way left. */
export function CopyValue(props: {
  value: string;
  /** What is being copied, for the button's name: "fingerprint" makes "Copy fingerprint". */
  label?: string | undefined;
  /** Called when the clipboard refused, so a caller can show the value. */
  onFailed?: (() => void) | undefined;
}): JSX.Element {
  const ui = useUi();
  const m = () => ui.messages.kit.details;
  const [state, setState] = createSignal<"idle" | "copied" | "failed">("idle");
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const copy = async () => {
    const result = await writeToClipboard(props.value);
    clearTimeout(timer);
    setState(result);
    if (result === "failed") props.onFailed?.();
    else timer = setTimeout(() => setState("idle"), 2500);
  };
  const name = () =>
    state() === "copied"
      ? props.label
        ? m().copiedOf(props.label)
        : m().copied
      : props.label
        ? m().copyOf(props.label)
        : m().copy;
  return (
    <span class="rt-copy">
      <button
        {...buttonAttrs({ variant: "quiet", size: "sm" })}
        type="button"
        aria-label={name()}
        data-copied={state() === "copied" ? "" : undefined}
        onClick={copy}
      >
        <span class="rt-button-icon" aria-hidden="true">
          {state() === "copied" ? <Check /> : <Copy />}
        </span>
        {state() === "copied" ? m().copied : m().copy}
      </button>
      <span class="rt-sr-only" role="status">
        {state() === "copied" ? name() : ""}
      </span>
      <Show when={state() === "failed"}>
        <span class="rt-copy-failed" role="alert">
          {m().copyFailed}
        </span>
      </Show>
    </span>
  );
}

export interface DetailsProps {
  /** What the disclosure is called: "Details", "Report details", "Advanced". Usually words; a row of a table
   * may put a part for assistive technology in front of them. */
  summary: JSX.Element;
  /** What opens: the facts, usually a `DetailsList`. */
  children: JSX.Element;
  /** A value a person may need to take away (a fingerprint), copied from a button beside the summary. It
   * should be readable in `children` too, so it can be selected by hand if the clipboard refuses. */
  copy?: string | CopyTarget | undefined;
  /** A short line beside the summary while it is closed ("revision 24 · fingerprint 61e985…"), so the one
   * fact people look for needs no click. It goes away when the disclosure is open. */
  preview?: JSX.Element | undefined;
  defaultOpen?: boolean | undefined;
  /** Controlled state, for a screen that opens it itself (a link to "the fingerprint"). */
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  /** The id of the whole disclosure, for a link on the page that points at it. */
  id?: string | undefined;
  /** A name of the caller's own beside the kit's, where a screen spaces or colours its fold. */
  class?: string | undefined;
  /** Inside a row of a table or a line of a list: no hairline above it, and the text of the row. */
  plain?: boolean | undefined;
  /** What opens starts at the edge, under the chevron: for a table, which needs the width. */
  flush?: boolean | undefined;
}

/** The one place machine detail lives: hashes, revisions, source ids, fingerprints. The surface of a page
 * shows what a person works with; the exact detail stays one click away, readable and copyable, here.
 *
 * It is a disclosure (a button that says whether its content is open) and not a menu: Tab, Enter and
 * Space do what they do everywhere, and a screen reader says "collapsed" or "expanded". */
export function Details(props: DetailsProps): JSX.Element {
  const [open, setOpen] = createSignal(props.open ?? props.defaultOpen ?? false);
  const target = (): CopyTarget | undefined =>
    props.copy === undefined
      ? undefined
      : typeof props.copy === "string"
        ? {
            value: props.copy,
            ...(typeof props.summary === "string" ? { label: props.summary.toLowerCase() } : {}),
          }
        : props.copy;
  const shown = () => props.open ?? open();
  const change = (next: boolean) => {
    setOpen(next);
    props.onOpenChange?.(next);
  };
  return (
    <Collapsible.Root
      class={props.class ? `rt-details ${props.class}` : "rt-details"}
      {...(props.id ? { ids: { root: props.id } } : {})}
      data-plain={props.plain ? "" : undefined}
      data-flush={props.flush ? "" : undefined}
      open={shown()}
      onOpenChange={(detail) => change(detail.open)}
    >
      <div class="rt-details-head">
        <Collapsible.Trigger class="rt-details-toggle">
          <ChevronRight class="rt-details-chevron rt-dir-icon" aria-hidden="true" />
          {props.summary}
        </Collapsible.Trigger>
        <Show when={props.preview}>
          <span class="rt-details-preview" data-facts>
            {props.preview}
          </span>
        </Show>
        <Show when={target()}>
          {(copy) => (
            <CopyValue value={copy().value} label={copy().label} onFailed={() => change(true)} />
          )}
        </Show>
      </div>
      <Collapsible.Content class="rt-details-body">{props.children}</Collapsible.Content>
    </Collapsible.Root>
  );
}

export interface DetailsItem {
  readonly label: string;
  readonly value: string;
  /** Set it in the monospaced face and let it break anywhere: a hash, a key, an id. */
  readonly mono?: boolean;
  /** Offer a Copy button for this value. */
  readonly copy?: boolean;
  /** What to call it in the button's name, when the label alone would not say ("Source event"). */
  readonly copyLabel?: string;
}

/** The facts under a `Details`, as a list of label and value: "Book revision 24", "Fingerprint 61e985…".
 * A long value wraps instead of widening the page, and one click on it selects all of it. */
export function DetailsList(props: { items: readonly DetailsItem[] }): JSX.Element {
  return (
    <dl class="rt-details-list">
      <For each={props.items}>
        {(item) => (
          <div class="rt-details-row">
            <dt>{item.label}</dt>
            <dd>
              <span class="rt-details-value" data-mono={item.mono ? "" : undefined}>
                {item.value}
              </span>
              <Show when={item.copy}>
                <CopyValue value={item.value} label={item.copyLabel ?? item.label.toLowerCase()} />
              </Show>
            </dd>
          </div>
        )}
      </For>
    </dl>
  );
}
