/** The chord that moves focus to the toasts, and where it must not fire.
 *
 * The chord is Alt+T (Option+T on a Mac). On a Mac that chord also types a character ("†"), so it must
 * never take focus away from a field while the person is typing: the key goes down, and if focus has moved
 * by the time the character is inserted, the character is lost and the person is somewhere else. Ark's own
 * hotkey fires from any element and with any other modifier held, so the kit turns it off and owns this. */

/** What the hotkey needs to know about a key press. A `KeyboardEvent` is one. */
export interface KeyPress {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  /** The physical key: "KeyT" is the T of a US keyboard wherever the letters have been moved. */
  readonly code: string;
  /** The character the press makes: "t" on most keyboards, "†" for Option+T on a Mac. */
  readonly key: string;
  readonly repeat: boolean;
  readonly isComposing: boolean;
}

/** Exactly Alt+T, and no other modifier: Ctrl+Alt+T opens a terminal on some systems, Alt+Shift+T and
 * Cmd+Option+T belong to the browser or the system, and Ctrl with Alt is how Windows writes AltGr, which types
 * letters. A held key does not repeat it, and a press that is part of composing text (an input method) is
 * not it. The key is matched by position (a Mac's Option changes the letter it makes) or by the letter
 * (a layout that has moved it). */
export function isToastHotkey(press: KeyPress): boolean {
  if (!press.altKey || press.ctrlKey || press.metaKey || press.shiftKey) return false;
  if (press.repeat || press.isComposing) return false;
  return press.code === "KeyT" || press.key === "t" || press.key === "T";
}

/** The part of an element this needs, so it can be tested without a page. A DOM element is one. */
export interface ElementLike {
  readonly tagName: string;
  readonly isContentEditable?: boolean | undefined;
  readonly type?: string | undefined;
  getAttribute(name: string): string | null;
}

/** An input that is not typed into: pressing keys in one does not make text. */
const NOT_TEXT = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** The roles of a custom widget that is typed into (an element that is not an input but behaves as one). */
const TYPED_ROLES = new Set(["textbox", "searchbox", "spinbutton"]);

/** Whether keys typed here make text, or a choice by letters: a text box of any kind (also a search box, a
 * number, a date, an account picker's box), a text area, a list (typing a letter picks the entry that
 * starts with it) and anything editable. A checkbox, a radio button, a button and a link are not: pressing
 * keys on them types nothing, so the hotkey may fire there. */
export function isTextEntry(element: ElementLike | null | undefined): boolean {
  if (!element) return false;
  const tag = element.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input")
    return !NOT_TEXT.has((element.type ?? element.getAttribute("type") ?? "text").toLowerCase());
  if (element.isContentEditable === true) return true;
  const role = element.getAttribute("role");
  return role !== null && TYPED_ROLES.has(role.toLowerCase());
}
