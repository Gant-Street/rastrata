import { createUniqueId, type JSX } from "solid-js";
import { Search } from "../icons";

/** The search box of a list: a magnifier, the box, and room at its end for the one quiet button that opens
 * the list's other filters (`FilterFoldButton`, passed as children). It is what a list shows at rest, so
 * every list that has one looks the same. The label is for assistive technology: the magnifier and the
 * placeholder say it to the eye. */
export function ListSearch(props: {
  /** What the box is called: "Search transactions". */
  label: string;
  placeholder: string;
  /** What it searches, as the box's tooltip. */
  hint?: string | undefined;
  value: string;
  onInput: (value: string) => void;
  inputRef?: ((element: HTMLInputElement) => void) | undefined;
  disabled?: boolean | undefined;
  /** The key that brings the keyboard here, when the page has one ("/"). */
  keyshortcuts?: string | undefined;
  children?: JSX.Element;
}): JSX.Element {
  const id = createUniqueId();
  return (
    <div class="rt-list-search">
      <label class="rt-sr-only" for={id}>
        {props.label}
      </label>
      <Search aria-hidden="true" class="rt-list-search-icon" />
      <input
        id={id}
        type="search"
        class="rt-input"
        placeholder={props.placeholder}
        title={props.hint}
        autocomplete="off"
        spellcheck={false}
        aria-keyshortcuts={props.keyshortcuts}
        value={props.value}
        ref={(element) => props.inputRef?.(element)}
        disabled={props.disabled ?? false}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
      {props.children}
    </div>
  );
}
