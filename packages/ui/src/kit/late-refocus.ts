/** Ark's combobox gives its box focus from a requestAnimationFrame: one when the list opens (so what is typed
 * next goes in the box) and one when it closes (after a choice, after Escape). When something else took focus
 * in the meantime (a person who tabbed on at once, a test that typed into the next field), that late call takes
 * focus away from it and what is typed next lands in the box instead.
 *
 * `guardLateRefocus(box, within)` returns `listChanged()`, to be called whenever the list opens or closes, and
 * `heldElsewhere()`. Until the frame that follows has run, a focus call the way Ark makes it
 * (`focus({ preventScroll: true })`) is dropped when focus is on something outside the picker (`within` is its
 * root). A call made any other way (a link to the field, a screen's handler, a test's `focus()` or `fill()`) is
 * never dropped, and neither is Ark's when nothing holds focus (it was on the list, which has gone) or when it
 * is on the picker's own button.
 *
 * It runs inside Ark's own transitions, so it must never throw: a failure here would stop the rest of the
 * transition (the dismiss layer that closes the list on Escape is set up after it). The method is shadowed with
 * `defineProperty`, because plain assignment throws wherever the page has made `focus` read-only on the
 * prototype (Storybook does). */
export function guardLateRefocus(
  box: HTMLElement,
  within: () => Element | null | undefined,
): { listChanged(): void; heldElsewhere(): boolean; dispose(): void } {
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lift = () => {
    Reflect.deleteProperty(box, "focus");
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
  /** Whether focus is on something outside the picker: a field a person has moved on to. */
  const heldElsewhere = (): boolean => {
    const active = box.ownerDocument.activeElement;
    if (active === null || active === box.ownerDocument.body) return false;
    return !within()?.contains(active);
  };
  const hold = (options?: FocusOptions) => {
    if (options?.preventScroll === true && heldElsewhere()) return;
    HTMLElement.prototype.focus.call(box, options);
  };
  return {
    heldElsewhere,
    listChanged() {
      stop();
      // An own property shadows the method for now. It is lifted once the next frame's callbacks have all run
      // (the timer runs after them), so Ark's late call meets it whichever order they run in.
      if (
        !Reflect.defineProperty(box, "focus", { value: hold, configurable: true, writable: true })
      )
        return;
      frame = requestAnimationFrame(() => {
        timer = setTimeout(lift, 0);
      });
    },
    dispose() {
      stop();
      lift();
    },
  };
}
