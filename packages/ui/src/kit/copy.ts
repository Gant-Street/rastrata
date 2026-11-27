/** Put text on the clipboard, and say whether it got there.
 *
 * The clipboard can say no: an insecure page, a denied permission, a window that is not focused. Ark's
 * clipboard machine reports "copied" before the write has finished, so a refusal would still read as a
 * success. This waits for the write, tries the older selection-and-copy way when the new one is not
 * there or refuses, and returns `"failed"` when neither worked, so the screen can tell the person. */
export type CopyResult = "copied" | "failed";

export async function writeToClipboard(text: string): Promise<CopyResult> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return "copied";
    }
  } catch {
    // Fall through to the older way: it needs no permission, only a user gesture.
  }
  return copyBySelection(text) ? "copied" : "failed";
}

/** The older way: select the text in a hidden field and ask the browser to copy the selection. It takes
 * focus for a moment, so focus is put back where it was. */
function copyBySelection(text: string): boolean {
  if (typeof document === "undefined" || !document.body) return false;
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.setAttribute("aria-hidden", "true");
  field.tabIndex = -1;
  Object.assign(field.style, {
    position: "fixed",
    top: "0",
    insetInlineStart: "0",
    width: "1px",
    height: "1px",
    opacity: "0",
    pointerEvents: "none",
  });
  document.body.append(field);
  let copied = false;
  try {
    field.focus();
    field.select();
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    field.remove();
    before?.focus();
  }
  return copied;
}
