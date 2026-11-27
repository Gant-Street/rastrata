import { For, Show } from "solid-js";
import { Notice } from "../notice";
import type { StripeKeyInfo } from "./types";
import { words } from "./words";

/** Where the service is given a Stripe key (one a person runs themselves): what to do when there is none, or the one
 * it has cannot be used. The key itself is never shown and there is no field to type one: it lives outside the app,
 * where only the owner can read it. A key that works is not spoken of: the payouts are there. */
export function StripeConnection(props: { keyInfo: StripeKeyInfo }) {
  const found = () => props.keyInfo.present && props.keyInfo.problem === null;
  return (
    <section class="rt-stripe-section" aria-labelledby="rt-stripe-connection">
      <h2 id="rt-stripe-connection">{words.connectionTitle}</h2>
      <Show when={props.keyInfo.problem}>
        <Notice title={words.keyUnusable} tone="error" role="alert">
          <bdi>{props.keyInfo.problem}</bdi>
        </Notice>
      </Show>
      <Show when={props.keyInfo.warning}>
        <Notice title={words.keyReview} tone="review">
          {props.keyInfo.warning}
        </Notice>
      </Show>
      <Show when={!found()}>
        <ol class="rt-stripe-how">
          <For each={words.howSteps}>{(step) => <li>{step}</li>}</For>
        </ol>
      </Show>
    </section>
  );
}
