import type { StripeAppNotice } from "@rastrata/ui";
import { type Accessor, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import type { Account } from "../../account";
import {
  type BookLink,
  noticeOf,
  StripeAppController,
  type StripeAppState,
} from "../../stripe-app-controller";

/** Where Stripe is connected with the button: whom Rastrata reads, how far it has got, and the three things an owner can do about it (connect, read now, disconnect), for the page to
 * draw. The connection is read again every few seconds while a reading is under way, and the page is told when one has finished so that it reads the books again. */
export interface StripeApp {
  readonly state: Accessor<StripeAppState>;
  readonly ready: Accessor<Extract<StripeAppState, { step: "ready" }> | null>;
  /** What Stripe sent the person back with, said once. */
  readonly told: Accessor<StripeAppNotice | null>;
  connect(): void;
  readNow(): void;
  askToStop(): void;
  keepReading(): void;
  stop(): void;
}

const returnedWith = (): string | null => new URL(window.location.href).searchParams.get("connect");

export function useStripeApp(options: {
  readonly account: Account;
  /** What the book says of the connection, read with every look at it. */
  readonly link: () => BookLink | null;
  /** A reading has finished (or the connection changed): read the books again. */
  readonly onChanged: () => void;
}): StripeApp {
  // Made once: the page talks to the one controller it listens to.
  const controller = new StripeAppController({
    control: options.account,
    link: options.link,
    go: (address) => window.location.assign(address),
  });
  const [state, setState] = createSignal<StripeAppState>(controller.state);
  onCleanup(controller.subscribe(setState));

  // What Stripe sent the person back with is said once, and then forgotten, so that a reload does not say it again.
  const [told, setTold] = createSignal(noticeOf(returnedWith()));
  onMount(() => {
    if (returnedWith() !== null) {
      const address = new URL(window.location.href);
      address.searchParams.delete("connect");
      window.history.replaceState(window.history.state, "", address.toString());
    }
    void controller.load();
  });

  const ready = () => {
    const current = state();
    return current.step === "ready" ? current : null;
  };

  // A reading is waiting or under way: look again every few seconds, and when it is done tell the page.
  createEffect(
    on(
      () => ready()?.view.reading === true,
      (reading, was) => {
        if (was === true && !reading) options.onChanged();
        if (!reading) return;
        const timer = setTimeout(() => void controller.load(), 3000);
        onCleanup(() => clearTimeout(timer));
      },
    ),
  );
  // Connected or disconnected by a change the person made: the books have something new to say.
  createEffect(
    on(
      () => ready()?.view.stage,
      (stage, was) => {
        if (was !== undefined && stage !== was) options.onChanged();
      },
    ),
  );

  return {
    state,
    ready,
    told,
    connect: () => {
      setTold(null);
      void controller.connect();
    },
    readNow: () => {
      setTold(null);
      void controller.readNow().then(() => {
        // A short reading can be over before the connection is looked at again: it then says nothing is under way, the effect above saw no reading end, and the books have
        // something new to show. One still under way is told of when it ends.
        if (ready()?.view.reading === false) options.onChanged();
      });
    },
    askToStop: () => controller.askToStop(),
    keepReading: () => controller.keepReading(),
    stop: () => {
      setTold(null);
      void controller.stop();
    },
  };
}
