import { Button, Notice, PageHeader, PageSkeleton } from "@rastrata/ui";
import { type Accessor, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import {
  type BillingController as Controller,
  BillingController,
  type BillingPageState,
  type BillingPageView,
} from "../../billing-controller";
import { currentAccount } from "../../boot";
import { BILLING_UPDATED_EVENT } from "../../standing";
import { billingWords as words } from "./words";

/** Settings, Billing: how the workspace stands as to its trial and subscription, and, for an owner, subscribing on Stripe's page and managing the subscription in Stripe's portal. It exists only
 * where the service charges for workspaces; a page opened by its address elsewhere says so. */
export function BillingPage() {
  const account = currentAccount();
  return (
    <section aria-labelledby="billing-title">
      <PageHeader titleId="billing-title" title={words.title} />
      <Show
        when={account}
        fallback={
          <Notice title={words.notHere} tone="info">
            <p>{words.notHereBody}</p>
          </Notice>
        }
      >
        {(present) => {
          // Made once: the page talks to the one controller it listens to.
          const controller = new BillingController({
            control: present(),
            go: (address) => window.location.assign(address),
            onChanged: () => window.dispatchEvent(new CustomEvent(BILLING_UPDATED_EVENT)),
          });
          return <BillingBody controller={controller} />;
        }}
      </Show>
    </section>
  );
}

function BillingBody(props: { readonly controller: Controller }) {
  const [state, setState] = createSignal<BillingPageState>(props.controller.state);
  const unsubscribe = props.controller.subscribe(setState);
  onCleanup(unsubscribe);
  onMount(() => {
    // Stripe's page sends the person back with `?checkout=done&session=…` (or `?checkout=cancelled`): the controller asks the control plane how it went, and the address is cleaned.
    const query = new URLSearchParams(window.location.search);
    const checkout = query.get("checkout");
    if (checkout === null) return void props.controller.load();
    const session = query.get("session");
    window.history.replaceState(window.history.state, "", window.location.pathname);
    void props.controller.returned({ checkout, session });
  });
  const view = createMemo<BillingPageView | null>(() => {
    const current = state();
    return current.step === "ready" ? current.view : null;
  });
  const problem = () => {
    const current = state();
    return current.step === "problem" ? current.message : null;
  };
  return (
    <>
      <Show when={state().step === "loading"}>
        <PageSkeleton shape="statement" label={words.loading} />
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
  readonly view: Accessor<BillingPageView>;
  readonly controller: Controller;
}) {
  const view = props.view;
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

      <section class="rt-settings-block billing-standing" aria-labelledby="billing-standing">
        <h2 id="billing-standing">{view().headline}</h2>
        <Show when={view().detail}>{(detail) => <p>{detail()}</p>}</Show>
        <Show when={view().coverage}>
          {(coverage) => <p class="billing-coverage">{coverage()}</p>}
        </Show>
      </section>

      <Show when={view().canSubscribe && view().prices}>
        {(prices) => (
          <section class="rt-settings-block" aria-labelledby="billing-subscribe">
            <h2 id="billing-subscribe">{words.subscribeTitle}</h2>
            <p>{words.subscribeBody}</p>
            <div class="billing-plans">
              <Button
                label={words.subscribe(prices().month)}
                pending={busy()}
                pendingLabel={words.opening}
                onClick={() => void act(() => props.controller.startCheckout("month"))}
              />
              <Button
                variant="secondary"
                label={words.subscribe(prices().year)}
                pending={busy()}
                pendingLabel={words.opening}
                onClick={() => void act(() => props.controller.startCheckout("year"))}
              />
            </div>
            <Show when={prices().note}>{(note) => <p class="billing-note">{note()}</p>}</Show>
          </section>
        )}
      </Show>

      <Show when={view().canManage}>
        <section class="rt-settings-block" aria-labelledby="billing-manage">
          <h2 id="billing-manage">{words.manageTitle}</h2>
          <p>{words.manageBody}</p>
          <Button
            variant="secondary"
            label={words.manage}
            pending={busy()}
            pendingLabel={words.opening}
            onClick={() => void act(() => props.controller.manage())}
          />
        </section>
      </Show>

      <Show
        when={
          view().available &&
          !view().isBillingOwner &&
          (view().state === "trialing" ||
            view().state === "read_only" ||
            view().state === "past_due")
        }
      >
        <p>{words.onlyOwner}</p>
      </Show>
    </>
  );
}
