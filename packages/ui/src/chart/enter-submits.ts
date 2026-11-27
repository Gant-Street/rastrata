/** Enter in a text box submits a form whose button is not inside it. The account drawers keep Add account and
 * Save changes in their footer, which is not part of the form, so the browser would not submit on Enter by
 * itself. A box, a list or a checkbox never submits: Enter belongs to it there. */
export function enterSubmits(event: KeyboardEvent, submit: () => void): void {
  if (event.key !== "Enter" || event.isComposing || event.defaultPrevented) return;
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (["checkbox", "radio", "button", "submit", "reset", "file"].includes(target.type)) return;
  event.preventDefault();
  submit();
}
