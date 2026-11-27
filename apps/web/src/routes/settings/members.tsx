import {
  Button,
  buttonAttrs,
  Dialog,
  DialogClose,
  Notice,
  PageHeader,
  PageSkeleton,
  SelectField,
  Status,
} from "@rastrata/ui";
import { TextField } from "@rastrata/ui/text-field";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  Index,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { Role } from "../../account";
import { currentAccount, START_PATH } from "../../boot";
import {
  MembersController,
  type MembersState,
  type MembersView,
  type MemberRow,
  ROLE_ALLOWS,
  ROLE_LABEL,
} from "../../members-controller";
import { membersWords as words } from "./members-words";

/** Settings, Members: who can open the open workspace and as what, with the few things an owner or an administrator does about that. It exists only on a service with accounts; a
 * page opened by its address on any other says that it is not here. */
export function MembersPage() {
  const account = currentAccount();
  return (
    <section aria-labelledby="members-title">
      <PageHeader titleId="members-title" title={words.title} />
      <Show
        when={account}
        fallback={
          <Notice title={words.notHere} tone="info">
            <p>{words.notHereBody}</p>
          </Notice>
        }
      >
        {(present) => {
          // Made once: a prop written as an expression is read each time it is used, and the page must talk to the one controller it listens to.
          const controller = new MembersController({
            account: present(),
            go: (path) => window.location.assign(path),
            forget: () => present().select(null),
            startPath: START_PATH,
          });
          return <MembersBody controller={controller} />;
        }}
      </Show>
    </section>
  );
}

const roleItems = (roles: readonly Role[]) =>
  roles.map((role) => ({ value: role, label: ROLE_LABEL[role] }));

/** What the controller says, drawn. The list is not made again when it is read again (every few seconds while someone is being added): a row keeps its place and its focus, and
 * the form for an invitation keeps what was typed in it. */
function MembersBody(props: { readonly controller: MembersController }) {
  const [state, setState] = createSignal<MembersState>(props.controller.state);
  const unsubscribe = props.controller.subscribe(setState);
  onCleanup(unsubscribe);
  onMount(() => void props.controller.load());
  const step = createMemo(() => state().step);
  const view = createMemo<MembersView | null>(() => {
    const current = state();
    return current.step === "ready" ? current.view : null;
  });
  const problem = () => {
    const current = state();
    return current.step === "problem" ? current.message : null;
  };

  // Someone who is being put into the books: look again every few seconds.
  createEffect(() => {
    if (!view()?.waiting) return;
    const timer = setTimeout(() => void props.controller.refresh(), 3000);
    onCleanup(() => clearTimeout(timer));
  });

  return (
    <>
      <Show when={step() === "loading"}>
        <PageSkeleton shape="table" label={words.loading} />
      </Show>
      <Show when={step() === "left"}>
        <p role="status">{words.left}</p>
      </Show>
      <Show when={problem()}>
        {(message) => (
          <Notice title={words.failed} tone="problem" role="alert">
            <p>{message()}</p>
            <Button
              variant="secondary"
              label={words.retry}
              onClick={() => void props.controller.load()}
            />
          </Notice>
        )}
      </Show>
      <Show when={view()}>{(ready) => <Ready view={ready} controller={props.controller} />}</Show>
    </>
  );
}

function Ready(props: {
  readonly view: Accessor<MembersView>;
  readonly controller: MembersController;
}) {
  const view = props.view;
  const [asking, setAsking] = createSignal<MemberRow | null>(null);
  const [busy, setBusy] = createSignal(false);

  async function act(work: () => Promise<unknown>) {
    if (busy()) return;
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Show when={view().error}>
        {(message) => <Notice title={message()} tone="problem" role="alert" />}
      </Show>
      <Show when={!view().error && view().notice}>
        {(message) => <Notice title={message()} tone="calm" role="status" />}
      </Show>

      <section class="rt-settings-block" aria-labelledby="members-people">
        <h2 id="members-people">{words.people}</h2>
        <ul class="members-list" aria-label={words.peopleCaption(view().workspace.name)}>
          <Index each={view().members}>
            {(row) => (
              <li class="members-row">
                <div class="members-who">
                  <span>{row().email}</span>
                  <Show when={row().you}>
                    <small>{words.you}</small>
                  </Show>
                  <Show when={!row().ready}>
                    <small>
                      <Status tone="calm">{words.joining}</Status>
                    </small>
                  </Show>
                </div>
                <div class="members-role">
                  <Show
                    when={row().roles.length > 0}
                    fallback={<span>{ROLE_LABEL[row().role]}</span>}
                  >
                    <SelectField
                      label={words.roleOf(row().email)}
                      items={roleItems(row().roles)}
                      value={row().role}
                      disabled={busy()}
                      onChange={(role) =>
                        void act(() => props.controller.setRole(row().userId, role as Role))
                      }
                    />
                  </Show>
                </div>
                <div class="members-actions">
                  <Show when={row().canRemove}>
                    <Button
                      variant="secondary"
                      size="sm"
                      label={row().you ? words.leave : words.remove}
                      aria-label={row().you ? words.leave : words.removeNamed(row().email)}
                      disabled={busy()}
                      onClick={() => setAsking(row())}
                    />
                  </Show>
                </div>
              </li>
            )}
          </Index>
        </ul>
        <Show when={view().soleOwner}>
          <p>{words.soleOwner}</p>
        </Show>
      </section>

      <Show when={view().inviteAs.length > 0}>
        <InviteForm view={view} busy={busy} controller={props.controller} act={act} />
      </Show>

      <Show when={view().invitations.length > 0}>
        <section class="rt-settings-block" aria-labelledby="members-waiting">
          <h2 id="members-waiting">{words.waiting}</h2>
          <ul class="members-list" aria-label={words.waitingCaption}>
            <Index each={view().invitations}>
              {(invitation) => (
                <li class="members-row" data-kind="invitation">
                  <div class="members-who">
                    <span>{invitation().email}</span>
                    <small>
                      {ROLE_LABEL[invitation().role]} · {words.expiresUntil(invitation().expiresAt)}
                    </small>
                  </div>
                  <div class="members-actions">
                    <Button
                      variant="secondary"
                      size="sm"
                      label={words.revoke}
                      aria-label={words.revokeNamed(invitation().email)}
                      disabled={busy()}
                      onClick={() => void act(() => props.controller.revoke(invitation().id))}
                    />
                  </div>
                </li>
              )}
            </Index>
          </ul>
        </section>
      </Show>

      <Show when={asking()}>
        {(row) => (
          <Dialog
            open={true}
            role="alertdialog"
            title={row().you ? words.leaveTitle : words.removeTitle(row().email)}
            description={row().you ? words.leaveBody(view().workspace.name) : words.removeBody}
            onOpenChange={(open) => {
              if (!open) setAsking(null);
            }}
            footer={
              <>
                <DialogClose {...buttonAttrs({ variant: "secondary" })}>{words.keep}</DialogClose>
                <Button
                  label={row().you ? words.leave : words.remove}
                  pending={busy()}
                  onClick={() =>
                    void act(async () => {
                      await props.controller.remove(row().userId);
                      setAsking(null);
                    })
                  }
                />
              </>
            }
          />
        )}
      </Show>
    </>
  );
}

function InviteForm(props: {
  readonly view: Accessor<MembersView>;
  readonly busy: Accessor<boolean>;
  readonly controller: MembersController;
  readonly act: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const [email, setEmail] = createSignal("");
  const [role, setRole] = createSignal<Exclude<Role, "owner">>("member");
  // A role the person may no longer give (their own changed while the page was open) is not kept.
  const allowed = () => props.view().inviteAs;
  const chosen = () => (allowed().includes(role()) ? role() : (allowed()[0] ?? "member"));
  return (
    <section class="rt-settings-block" aria-labelledby="members-invite">
      <h2 id="members-invite">{words.invite}</h2>
      <p>{words.inviteBody}</p>
      <form
        class="members-invite"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void props.act(async () => {
            if (await props.controller.invite(email(), chosen())) setEmail("");
          });
        }}
      >
        <TextField
          label={words.emailLabel}
          type="email"
          name="email"
          autocomplete="off"
          value={email()}
          onInput={(event) => setEmail(event.currentTarget.value)}
        />
        <SelectField
          label={words.roleLabel}
          items={roleItems(allowed())}
          value={chosen()}
          hint={ROLE_ALLOWS[chosen()]}
          onChange={(value) => setRole(value as Exclude<Role, "owner">)}
        />
        <Button
          type="submit"
          label={words.sendInvitation}
          pending={props.busy()}
          pendingLabel={words.sending}
        />
      </form>
    </section>
  );
}
