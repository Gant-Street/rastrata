/** Put focus back where it was when the toast that had it goes away.
 *
 * A person who reaches a toast from the keyboard (Alt+T, then Tab to its action) presses Undo, and the
 * toast leaves. The focused button is removed from the page, and what happens to focus then depends on the
 * browser: Chromium reports the loss and the toast machine restores focus, but Firefox and Safari say
 * nothing, so focus falls to the top of the page and the person starts again from the first link.
 *
 * This remembers the element that had focus when it moved into the region, and after a toast is removed,
 * if focus was in the region and is now nowhere, puts it back there. It does nothing when focus was
 * somewhere else, so it never takes focus from a person who is typing. */
export interface FocusReturn {
  /** Watch a region. Returns the function that stops watching. */
  attach(region: HTMLElement): () => void;
  /** Call after a toast has been removed. */
  restore(): void;
}

export function trackFocusReturn(): FocusReturn {
  let region: HTMLElement | null = null;
  let returnTo: HTMLElement | null = null;
  let inside = false;

  const focusIn = (event: FocusEvent) => {
    const from = event.relatedTarget;
    if (from instanceof HTMLElement && region && !region.contains(from)) returnTo = from;
    inside = true;
  };
  const focusOut = (event: FocusEvent) => {
    const to = event.relatedTarget;
    if (!(to instanceof Node) || !region?.contains(to)) inside = false;
  };

  return {
    attach(element) {
      region = element;
      element.addEventListener("focusin", focusIn);
      element.addEventListener("focusout", focusOut);
      return () => {
        element.removeEventListener("focusin", focusIn);
        element.removeEventListener("focusout", focusOut);
        if (region === element) region = null;
      };
    },
    restore() {
      // After the frame, when the removed toast is out of the page and focus has settled.
      requestAnimationFrame(() => {
        if (!inside || !region) return;
        const active = document.activeElement;
        if (active && active !== document.body && region.contains(active)) return;
        inside = false;
        if (returnTo?.isConnected) returnTo.focus();
      });
    },
  };
}
