import { Button, buttonAttrs } from "@rastrata/ui/button";
import { Dialog, DialogClose } from "@rastrata/ui/dialog";
import { formatDate } from "@rastrata/ui/format";
import { Logo } from "@rastrata/ui/logo";
import { Notice } from "@rastrata/ui/notice";
import { PinField } from "@rastrata/ui/pin-field";
import { TextField } from "@rastrata/ui/text-field";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { CaptchaConfig, Role, WorkspaceSummary } from "./account";
import { type Captcha, mountCaptcha } from "./captcha";
import { SITE } from "./links";
import {
  type DeleteAccountController,
  type DeleteAccountState,
  sameAddress,
} from "./delete-account-controller";
import type { GateController, GateState } from "./gate-controller";
import type { PasskeysController, PasskeysState } from "./passkeys-controller";

/** A role in a person's words. */

export const ROLE_WORDS: Readonly<Record<Role, string>> = {
  owner: "owner",
  admin: "administrator",
  accountant: "accountant",
  member: "member",
};

/** A role in a sentence: "as an administrator". */
const ROLE_PHRASE: Readonly<Record<Role, string>> = {
  owner: "an owner",
  admin: "an administrator",
  accountant: "an accountant",
  member: "a member",
};

const CODE_COOLDOWN_SECONDS = 30;

/** A day as the rest of the application writes it ("Nov 14, 2026"), from the instant the service gives. */
const dayOf = (instant: string | undefined): string =>
  instant === undefined ? "later" : formatDate(instant);

/** The sign-in page of a service with accounts: draws the state of the controller (gate-controller.ts) and passes what the person does to it. It is the whole page:
 * the application's code is not sent to someone who is not in. */
export function GateScreen(props: {
  readonly controller: GateController;
  /** How the bot check is shown; a test replaces it. */
  readonly mount?: typeof mountCaptcha;
}) {
  const [state, setState] = createSignal<GateState>(props.controller.state);
  const [pending, setPending] = createSignal(false);
  const [heading, setHeading] = createSignal<HTMLElement | undefined>();
  const unsubscribe = props.controller.subscribe(setState);
  onCleanup(unsubscribe);
  onMount(() => void props.controller.start());

  // Each step of the page begins by saying where it is: focus goes to its heading, which a screen reader reads.
  createEffect(
    on(
      () => state().step,
      () => queueMicrotask(() => heading()?.focus()),
    ),
  );

  // A workspace that is being prepared: look again every two seconds.
  createEffect(() => {
    const current = state();
    if (current.step !== "workspaces" || !current.waiting) return;
    const timer = setTimeout(() => void props.controller.refresh(), 2000);
    onCleanup(() => clearTimeout(timer));
  });

  async function act(work: () => Promise<void>) {
    if (pending()) return;
    setPending(true);
    try {
      await work();
    } finally {
      setPending(false);
    }
  }

  return (
    <main class="gate rt-theme" aria-live="polite">
      <div class="gate-card">
        <Logo class="gate-logo" height={17} />
        <Show when={state().step === "loading"}>
          <p role="status">One moment…</p>
        </Show>
        <Show when={state().step === "done"}>
          <p role="status">Opening your workspace…</p>
        </Show>
        <Show when={state()} keyed>
          {(current) => (
            <>
              <Show when={current.step === "email" ? current : null} keyed>
                {(email) => (
                  <EmailStep
                    state={email}
                    pending={pending()}
                    heading={setHeading}
                    mount={props.mount ?? mountCaptcha}
                    onSubmit={(address, token) =>
                      void act(() => props.controller.submitEmail(address, token))
                    }
                    onPasskey={() => void act(() => props.controller.signInWithPasskey())}
                  />
                )}
              </Show>
              <Show when={current.step === "code" ? current : null} keyed>
                {(code) => (
                  <CodeStep
                    state={code}
                    pending={pending()}
                    heading={setHeading}
                    mount={props.mount ?? mountCaptcha}
                    onSubmit={(value) => void act(() => props.controller.submitCode(value))}
                    onResend={(token) => void act(() => props.controller.resend(token))}
                    onOther={() => void act(() => props.controller.useAnotherAddress())}
                  />
                )}
              </Show>
              <Show when={current.step === "passkey" ? current : null} keyed>
                {(offer) => (
                  <PasskeyOffer
                    state={offer}
                    pending={pending()}
                    heading={setHeading}
                    onMake={() => void act(() => props.controller.makePasskey())}
                    onSkip={() => void act(() => props.controller.skipPasskey())}
                  />
                )}
              </Show>
              <Show when={current.step === "workspaces" ? current : null} keyed>
                {(workspaces) => {
                  // Made once for this list (a prop written as an expression is read each time it is used).
                  const deletion = props.controller.accountDeletion(workspaces.person.email);
                  const passkeys = props.controller.accountPasskeys();
                  return (
                    <WorkspacesStep
                      state={workspaces}
                      pending={pending()}
                      heading={setHeading}
                      deletion={deletion}
                      passkeys={passkeys}
                      onOpen={(id) => props.controller.open(id)}
                      onRestore={(id) => void act(() => props.controller.restore(id))}
                      onCreate={(name) => void act(() => props.controller.createWorkspace(name))}
                      onOther={() => void act(() => props.controller.useAnotherAddress())}
                      onEverywhere={() => void act(() => props.controller.signOutEverywhere())}
                    />
                  );
                }}
              </Show>
              <Show when={current.step === "invitation" ? current : null} keyed>
                {(invitation) => (
                  <section aria-labelledby="gate-title" class="gate-form">
                    <h1 id="gate-title" tabindex="-1" ref={setHeading}>
                      Join {invitation.invitation.workspace}
                    </h1>
                    <p>
                      You were asked to join <strong>{invitation.invitation.workspace}</strong> as{" "}
                      {ROLE_PHRASE[invitation.invitation.role]}. You are signed in as{" "}
                      <strong>{invitation.person.email}</strong>.
                    </p>
                    <Show when={invitation.error}>
                      <Notice tone="problem" role="alert" title={invitation.error ?? ""} />
                    </Show>
                    <div class="gate-actions">
                      <Button
                        label="Accept and open the workspace"
                        pending={pending()}
                        pendingLabel="Opening…"
                        onClick={() => void act(() => props.controller.acceptInvitation())}
                      />
                      <Button
                        variant="secondary"
                        label="Use a different email"
                        onClick={() => void act(() => props.controller.useAnotherAddress())}
                      />
                    </div>
                  </section>
                )}
              </Show>
              <Show when={current.step === "problem" ? current : null} keyed>
                {(problem) => (
                  <section aria-labelledby="gate-title" class="gate-form">
                    <h1 id="gate-title" tabindex="-1" ref={setHeading}>
                      We could not go on
                    </h1>
                    <Notice tone="problem" role="alert" title={problem.message} />
                    <Show when={problem.retry}>
                      <Button label="Try again" onClick={() => window.location.reload()} />
                    </Show>
                    <Show when={!problem.retry}>
                      <a class="gate-link" href="/">
                        Go to the sign-in page
                      </a>
                    </Show>
                  </section>
                )}
              </Show>
            </>
          )}
        </Show>
        <Show when={state().step === "email"}>
          <p class="gate-fine">
            By continuing, you agree to the{" "}
            <a
              href={`${SITE}/terms/`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Terms (opens in a new tab)"
            >
              Terms
            </a>{" "}
            and{" "}
            <a
              href={`${SITE}/privacy/`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Privacy Policy (opens in a new tab)"
            >
              Privacy Policy
            </a>
            .
          </p>
        </Show>
      </div>
    </main>
  );
}

/** The bot check's box, when the control plane names a key. The token is read when the form is sent. */
function CaptchaBox(props: {
  readonly config: CaptchaConfig | null;
  readonly nonce: number;
  readonly mount: typeof mountCaptcha;
  readonly set: (captcha: Captcha | null) => void;
}) {
  let box: HTMLDivElement | undefined;
  const [failed, setFailed] = createSignal(false);
  let widget: Captcha | undefined;
  onMount(() => {
    const config = props.config;
    if (!config || !box) return;
    props
      .mount(box, config.siteKey, () => {}, undefined)
      .then((made) => {
        widget = made;
        props.set(made);
      })
      .catch(() => setFailed(true));
    onCleanup(() => {
      widget?.remove();
      props.set(null);
    });
  });
  createEffect(
    on(
      () => props.nonce,
      () => widget?.reset(),
      { defer: true },
    ),
  );
  return (
    <Show when={props.config}>
      <div class="gate-captcha" ref={box} />
      <Show when={failed()}>
        <Notice
          tone="problem"
          role="alert"
          title="The check that you are a person could not load. Allow challenges.cloudflare.com, or try again."
        />
      </Show>
    </Show>
  );
}

function EmailStep(props: {
  readonly state: Extract<GateState, { step: "email" }>;
  readonly pending: boolean;
  readonly heading: (element: HTMLElement) => void;
  readonly mount: typeof mountCaptcha;
  readonly onSubmit: (email: string, token: string | null) => void;
  readonly onPasskey: () => void;
}) {
  const [captcha, setCaptcha] = createSignal<Captcha | null>(null);
  // Which of the two buttons is waiting, for its own words: the page holds one flag for whatever is under way.
  const [using, setUsing] = createSignal<"code" | "passkey">("code");
  return (
    <form
      class="gate-form"
      aria-labelledby="gate-title"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const email = String(new FormData(event.currentTarget).get("email") ?? "");
        setUsing("code");
        props.onSubmit(email, captcha()?.token() ?? null);
      }}
    >
      <h1 id="gate-title" tabindex="-1" ref={props.heading}>
        {props.state.invitation
          ? `Join ${props.state.invitation.workspace}`
          : "Sign in or create an account"}
      </h1>
      <Show when={props.state.invitation}>
        {(invitation) => (
          <p>
            You were asked to join <strong>{invitation().workspace}</strong> as{" "}
            {ROLE_PHRASE[invitation().role]}. Sign in with the address the invitation went to (
            {invitation().email}) to accept it.
          </p>
        )}
      </Show>
      <Show when={props.state.error}>
        <Notice tone="problem" role="alert" title={props.state.error ?? ""} />
      </Show>
      <Show when={!props.state.error && props.state.notice}>
        <Notice tone="attention" role="status" title={props.state.notice ?? ""} />
      </Show>
      <TextField
        label="Email address"
        name="email"
        type="email"
        // "webauthn": the browser may offer a passkey among the field's suggestions (gate-controller.ts waits for one).
        autocomplete="email webauthn"
        inputmode="email"
        value={props.state.email ?? ""}
        // Told to assistive technology only: the one field of its form needs no "(required)" beside its name.
        aria-required="true"
      />
      <CaptchaBox
        config={props.state.captcha}
        nonce={props.state.captchaNonce}
        mount={props.mount}
        set={setCaptcha}
      />
      <Button
        type="submit"
        label="Continue"
        pending={props.pending && using() === "code"}
        pendingLabel="Continuing…"
        disabled={props.pending && using() === "passkey"}
      />
      <Show when={props.state.passkeys}>
        <Button
          type="button"
          variant="secondary"
          label="Sign in with a passkey"
          pending={props.pending && using() === "passkey"}
          pendingLabel="Waiting for your passkey…"
          disabled={props.pending && using() === "code"}
          onClick={() => {
            setUsing("passkey");
            props.onPasskey();
          }}
        />
      </Show>
    </form>
  );
}

/** Offered once, after the first code: the device's own check (Touch ID, Face ID, a phone's lock) makes the passkey, and the next sign-in needs no code. */
function PasskeyOffer(props: {
  readonly state: Extract<GateState, { step: "passkey" }>;
  readonly pending: boolean;
  readonly heading: (element: HTMLElement) => void;
  readonly onMake: () => void;
  readonly onSkip: () => void;
}) {
  const [using, setUsing] = createSignal<"make" | "skip">("make");
  return (
    <section aria-labelledby="gate-title" class="gate-form">
      <h1 id="gate-title" tabindex="-1" ref={props.heading}>
        Sign in faster next time
      </h1>
      <p>Make a passkey, and next time sign in with your face, your finger or your screen lock.</p>
      <Show when={props.state.error}>
        <Notice tone="problem" role="alert" title={props.state.error ?? ""} />
      </Show>
      <Show when={!props.state.error && props.state.notice}>
        <Notice tone="attention" role="status" title={props.state.notice ?? ""} />
      </Show>
      <Button
        label="Make a passkey"
        pending={props.pending && using() === "make"}
        pendingLabel="Waiting for your device…"
        disabled={props.pending && using() === "skip"}
        onClick={() => {
          setUsing("make");
          props.onMake();
        }}
      />
      <Button
        variant="secondary"
        label="Not now"
        disabled={props.pending}
        onClick={() => {
          setUsing("skip");
          props.onSkip();
        }}
      />
    </section>
  );
}

function CodeStep(props: {
  readonly state: Extract<GateState, { step: "code" }>;
  readonly pending: boolean;
  readonly heading: (element: HTMLElement) => void;
  readonly mount: typeof mountCaptcha;
  readonly onSubmit: (code: string) => void;
  readonly onResend: (token: string | null) => void;
  readonly onOther: () => void;
}) {
  const [captcha, setCaptcha] = createSignal<Captcha | null>(null);
  const [wait, setWait] = createSignal(CODE_COOLDOWN_SECONDS);
  onMount(() => {
    const timer = setInterval(() => setWait((seconds) => Math.max(0, seconds - 1)), 1000);
    onCleanup(() => clearInterval(timer));
  });
  // A new code was sent: the wait begins again.
  createEffect(
    on(
      () => props.state.notice,
      () => setWait(CODE_COOLDOWN_SECONDS),
      { defer: true },
    ),
  );
  return (
    <form
      class="gate-form"
      aria-labelledby="gate-title"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit(String(new FormData(event.currentTarget).get("code") ?? ""));
      }}
    >
      <h1 id="gate-title" tabindex="-1" ref={props.heading}>
        Check your email
      </h1>
      <p>
        Enter the code we sent to <strong class="gate-address">{props.state.email}</strong>.
      </p>
      <Show when={props.state.error}>
        <Notice tone="problem" role="alert" title={props.state.error ?? ""} />
      </Show>
      <Show when={!props.state.error && props.state.notice}>
        <p role="status">{props.state.notice}</p>
      </Show>
      <PinField
        label="Code"
        name="code"
        count={6}
        otp
        onComplete={(code) => props.onSubmit(code)}
      />
      <CaptchaBox
        config={props.state.captcha}
        nonce={props.state.captchaNonce}
        mount={props.mount}
        set={setCaptcha}
      />
      <div class="gate-actions">
        <Button type="submit" label="Sign in" pending={props.pending} pendingLabel="Signing in…" />
        <Button
          variant="secondary"
          label={wait() > 0 ? `Send a new code (${wait()})` : "Send a new code"}
          disabled={wait() > 0}
          onClick={() => props.onResend(captcha()?.token() ?? null)}
        />
        <Button variant="quiet" label="Use a different email" onClick={props.onOther} />
      </div>
    </form>
  );
}

function WorkspacesStep(props: {
  readonly state: Extract<GateState, { step: "workspaces" }>;
  readonly pending: boolean;
  readonly heading: (element: HTMLElement) => void;
  readonly deletion: DeleteAccountController;
  readonly passkeys: PasskeysController;
  readonly onOpen: (id: string) => void;
  readonly onRestore: (id: string) => void;
  readonly onCreate: (name: string) => void;
  readonly onOther: () => void;
  readonly onEverywhere: () => void;
}) {
  const none = () => props.state.workspaces.length === 0;
  // The account's own settings are a page of their own, reached from the foot of the card, as most services do it.
  const [account, setAccount] = createSignal(false);
  // Going to a page or back moves focus to its heading, as each step of the card does.
  const heading = (element: HTMLElement) => {
    props.heading(element);
    queueMicrotask(() => element.focus());
  };
  return (
    <Show
      when={!account()}
      fallback={
        <AccountView
          state={props.state}
          heading={heading}
          deletion={props.deletion}
          passkeys={props.passkeys}
          onEverywhere={props.onEverywhere}
          onBack={() => setAccount(false)}
        />
      }
    >
      <section class="gate-form" aria-labelledby="gate-title">
        <h1 id="gate-title" tabindex="-1" ref={props.heading}>
          {none() ? "Create your workspace" : "Choose a workspace"}
        </h1>
        <Show when={props.state.error}>
          <Notice tone="problem" role="alert" title={props.state.error ?? ""} />
        </Show>
        <Show when={!none()}>
          <ul class="gate-list" aria-label="Your workspaces">
            <For each={props.state.workspaces}>
              {(workspace: WorkspaceSummary) => (
                <li>
                  <span class="gate-choice">
                    <span class="gate-choice-name">{workspace.name}</span>
                    <span class="gate-choice-role">{ROLE_WORDS[workspace.role]}</span>
                  </span>
                  <Show
                    when={workspace.state === "ready"}
                    fallback={
                      <Show
                        when={workspace.state === "deleting"}
                        fallback={<span role="status">Preparing…</span>}
                      >
                        <span class="gate-deleting">
                          <span>
                            Being deleted: its books are erased on {dayOf(workspace.deleteAfter)}.
                          </span>
                          <Show when={workspace.role === "owner"}>
                            <Button
                              size="sm"
                              variant="secondary"
                              label="Bring back"
                              aria-label={`Bring back ${workspace.name}`}
                              onClick={() => props.onRestore(workspace.id)}
                            />
                          </Show>
                        </span>
                      </Show>
                    }
                  >
                    <Button
                      size="sm"
                      label="Open"
                      aria-label={`Open ${workspace.name}`}
                      onClick={() => props.onOpen(workspace.id)}
                    />
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <form
          class={none() ? "gate-form" : "gate-form gate-section"}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            props.onCreate(String(new FormData(event.currentTarget).get("name") ?? ""));
          }}
        >
          <Show when={!none()}>
            <h2>New workspace</h2>
          </Show>
          <TextField
            label="Workspace name"
            hint="Usually your business's name."
            name="name"
            autocomplete="organization"
            maxlength={80}
            aria-required="true"
          />
          <Button
            type="submit"
            variant={none() ? "primary" : "secondary"}
            label="Create workspace"
            pending={props.pending}
            pendingLabel="Creating…"
          />
        </form>
        <Show when={props.state.waiting}>
          <p role="status">Preparing your workspace. This takes a few seconds.</p>
        </Show>
        <div class="gate-foot">
          <span class="gate-foot-who">{props.state.person.email}</span>
          <span class="gate-foot-links">
            <Button variant="quiet" size="sm" label="Account" onClick={() => setAccount(true)} />
            <Button variant="quiet" size="sm" label="Sign out" onClick={props.onOther} />
          </span>
        </div>
      </section>
    </Show>
  );
}

/** The account's settings: its passkeys, signing out of every browser, and deleting it. Here, and not in the application,
 * because a person with no workspace open (or none at all) has nowhere else to find them. */
function AccountView(props: {
  readonly state: Extract<GateState, { step: "workspaces" }>;
  readonly heading: (element: HTMLElement) => void;
  readonly deletion: DeleteAccountController;
  readonly passkeys: PasskeysController;
  readonly onEverywhere: () => void;
  readonly onBack: () => void;
}) {
  return (
    <section class="gate-form" aria-labelledby="gate-title">
      <h1 id="gate-title" tabindex="-1" ref={props.heading}>
        Account
      </h1>
      <p class="gate-address">{props.state.person.email}</p>
      <Show when={props.state.error}>
        <Notice tone="problem" role="alert" title={props.state.error ?? ""} />
      </Show>
      <PasskeysSection controller={props.passkeys} />
      <div class="gate-section">
        <h2>Sessions</h2>
        <Button
          variant="secondary"
          label="Sign out of every browser"
          onClick={props.onEverywhere}
        />
      </div>
      <DeleteAccountSection controller={props.deletion} address={props.state.person.email} />
      <Button variant="quiet" label="Back to workspaces" onClick={props.onBack} />
    </section>
  );
}

/** The person's passkeys, read when the account's page opens. Not drawn in a browser that cannot do passkeys: the
 * emailed code is always there. */
function PasskeysSection(props: { readonly controller: PasskeysController }) {
  const [state, setState] = createSignal<PasskeysState>(props.controller.state);
  const unsubscribe = props.controller.subscribe(setState);
  onCleanup(unsubscribe);
  onMount(() => {
    if (props.controller.available) void props.controller.load();
  });
  const ready = createMemo(() => {
    const current = state();
    return current.step === "ready" ? current : null;
  });
  const failed = createMemo(() => {
    const current = state();
    return current.step === "failed" ? current.message : null;
  });
  return (
    <Show when={props.controller.available}>
      <div class="gate-section">
        <h2>Passkeys</h2>
        <Show when={state().step === "loading"}>
          <p role="status">Reading your passkeys…</p>
        </Show>
        <Show when={failed()}>
          {(message) => <Notice tone="problem" role="alert" title={message()} />}
        </Show>
        <Show when={ready()}>
          {(current) => (
            <>
              <Show when={current().error}>
                <Notice tone="problem" role="alert" title={current().error ?? ""} />
              </Show>
              <Show when={!current().error && current().notice}>
                <p role="status">{current().notice}</p>
              </Show>
              <Show
                when={current().passkeys.length > 0}
                fallback={<p>Sign in with your face, your finger or your screen lock.</p>}
              >
                <ul class="gate-list" aria-label="Your passkeys">
                  <For each={current().passkeys}>
                    {(passkey) => (
                      <li>
                        <span class="gate-choice">
                          <span class="gate-choice-name">{passkey.name}</span>
                          <span class="gate-choice-role">
                            Added {formatDate(passkey.createdAt)}
                          </span>
                        </span>
                        <Button
                          size="sm"
                          variant="secondary"
                          label="Remove"
                          aria-label={`Remove passkey ${passkey.name}`}
                          disabled={current().busy !== null}
                          onClick={() => void props.controller.remove(passkey.id)}
                        />
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <Button
                variant="secondary"
                label="Add a passkey"
                pending={current().busy === "adding"}
                pendingLabel="Waiting for your device…"
                disabled={current().busy === "removing"}
                onClick={() => void props.controller.add()}
              />
            </>
          )}
        </Show>
      </div>
    </Show>
  );
}

/** Deleting the account: a button, and a dialog that asks for the address before it does anything. */
function DeleteAccountSection(props: {
  readonly controller: DeleteAccountController;
  readonly address: string;
}) {
  const [state, setState] = createSignal<DeleteAccountState>(props.controller.state);
  const unsubscribe = props.controller.subscribe(setState);
  onCleanup(unsubscribe);
  const [asking, setAsking] = createSignal(false);
  const [typed, setTyped] = createSignal("");
  const busy = createMemo(() => ["deleting", "done"].includes(state().step));
  const failure = createMemo(() => {
    const current = state();
    return current.step === "failed" ? current.message : null;
  });
  const blocked = createMemo(() => {
    const current = state();
    return current.step === "blocked" ? current.workspaces : null;
  });
  return (
    <div class="gate-section">
      <h2>Delete account</h2>
      <Button variant="danger" label="Delete account" onClick={() => setAsking(true)} />
      <Show when={asking()}>
        <Dialog
          open={true}
          role="alertdialog"
          title="Delete your account?"
          description="You'll be signed out everywhere and removed from every workspace. This can't be undone."
          closeOnInteractOutside={false}
          onOpenChange={(open) => {
            if (!open) {
              setAsking(false);
              setTyped("");
            }
          }}
          footer={
            <>
              <DialogClose {...buttonAttrs({ variant: "secondary" })}>Cancel</DialogClose>
              <Button
                variant="danger"
                label="Delete account"
                pending={busy()}
                pendingLabel="Deleting…"
                disabled={!sameAddress(typed(), props.address)}
                onClick={() => void props.controller.run(typed())}
              />
            </>
          }
        >
          <Show when={failure()}>
            {(message) => <Notice tone="problem" role="alert" title={message()} />}
          </Show>
          <Show when={blocked()}>
            {(workspaces) => (
              <Notice
                tone="problem"
                role="alert"
                title={
                  workspaces().length === 1
                    ? "You're the only owner of a workspace"
                    : `You're the only owner of ${workspaces().length} workspaces`
                }
              >
                <ul>
                  <For each={workspaces()}>
                    {(workspace) => (
                      <li>
                        <strong>{workspace.name}</strong>
                      </li>
                    )}
                  </For>
                </ul>
                <p>Make someone else an owner, or delete the workspace, first.</p>
              </Notice>
            )}
          </Show>
          <TextField
            label="Type your email to confirm"
            name="confirm"
            autocomplete="off"
            value={typed()}
            onInput={(event) => setTyped(event.currentTarget.value)}
          />
        </Dialog>
      </Show>
    </div>
  );
}
