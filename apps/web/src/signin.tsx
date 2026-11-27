// Each from its own module, not from the package's index: the page of a browser with no session (see
// signin-main.tsx) is built from this file alone, and the index would bring all of the library with it.
import { Button } from "@rastrata/ui/button";
import { Dialog } from "@rastrata/ui/dialog";
import { Notice } from "@rastrata/ui/notice";
import { PasswordField } from "@rastrata/ui/password-field";
import { createSignal, Show } from "solid-js";
import { signIn } from "./session";

/** The sign-in screen of a hosted service: the owner gives the key, the service answers with a session.
 *
 * It is the kit's dialog (Ark's), told it must be answered: Escape and a press outside do not close it, and
 * its backdrop covers the page whole. It is shown when the service answers a request with 401 (see
 * `announceSignInRequired`), and the page reads again once it is closed. It opens after anything already on
 * the screen, so it sits above a dialog the person had open when the session ended (their half-written entry
 * stays where it was, and is posted once they are back), and Ark puts everything behind it out of reach of
 * the keyboard and a screen reader. Nothing opens over it: the application opens no dialog and no search
 * while the person is signed out (router.tsx). `tests/browser/smoke.spec.ts` holds it to each of these.
 *
 * The key is typed into a password field with the usual reveal button and is sent in the body of one
 * request; it is read from the form when it is sent, so a password manager's fill counts, and it is not
 * kept in the page afterwards. */
export function SignInScreen(props: {
  readonly onSignedIn: () => void;
  /** Said above the key field: the service took the key and the browser did not keep the session. */
  readonly notice?: string | undefined;
  readonly ask?: typeof fetch;
}) {
  const [pending, setPending] = createSignal(false);
  const [problem, setProblem] = createSignal("");
  let form: HTMLFormElement | undefined;

  const field = (within: HTMLFormElement) =>
    within.querySelector<HTMLInputElement>('input[name="key"]');

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (pending()) return;
    const sent = event.currentTarget as HTMLFormElement;
    const key = String(new FormData(sent).get("key") ?? "");
    if (key.trim() === "") {
      setProblem("Enter the owner key.");
      field(sent)?.focus();
      return;
    }
    setPending(true);
    setProblem("");
    const result = await signIn(key, props.ask);
    setPending(false);
    if (result.ok) {
      sent.reset();
      props.onSignedIn();
      return;
    }
    setProblem(result.message);
    field(sent)?.focus();
  }

  return (
    <Dialog
      open
      role="alertdialog"
      class="signin"
      opaque
      closeOnEscape={false}
      closeOnInteractOutside={false}
      lead={<span aria-hidden="true">Rastrata</span>}
      title="Sign in"
      description="Enter the owner key to open this book."
      initialFocusEl={() => (form ? field(form) : null)}
    >
      <form
        ref={(element) => {
          form = element;
        }}
        class="signin-form"
        onSubmit={submit}
        noValidate
      >
        <Show when={problem()}>
          <Notice tone="problem" role="alert" title={problem()} />
        </Show>
        <Show when={!problem() && props.notice}>
          <Notice tone="attention" role="status" title={props.notice ?? ""} />
        </Show>
        <PasswordField label="Owner key" name="key" autocomplete="current-password" />
        <Button type="submit" label="Sign in" pending={pending()} pendingLabel="Signing in…" />
      </form>
    </Dialog>
  );
}
