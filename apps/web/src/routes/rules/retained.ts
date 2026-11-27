import { type Accessor, createSignal } from "solid-js";
import {
  ApplicationRequestError,
  type BrowserApplicationClient,
  type PendingRequest,
} from "../../application-client";
import { type ChartView, chartView } from "./chart.ts";

/** The chart, read once, as the Rules screens use it. */
export async function loadChart(client: BrowserApplicationClient): Promise<ChartView> {
  const list = await client.read("accounts.list", {}, { fresh: true });
  return chartView(list.accounts);
}

/** Until the chart has been read, accounts are named by what is known, which is nothing. */
export const unreadChart: ChartView = chartView([]);

export const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message ? cause.message : fallback;

/** A write whose reply was lost is not known to have happened, and sending it again as a new
 * request might do it twice. The client keeps the exact request, and this reads whether one is
 * waiting, so a screen can say so and offer to send the original again. */
export type Retained = {
  readonly pending: Accessor<PendingRequest | null>;
  /** Set when the kept request cannot be read; nothing is sent on its behalf. */
  readonly broken: Accessor<string | null>;
  readonly sync: () => void;
};

export function retained(client: BrowserApplicationClient, workflow: string): Retained {
  const [pending, setPending] = createSignal<PendingRequest | null>(null);
  const [broken, setBroken] = createSignal<string | null>(null);
  const sync = () => {
    try {
      setPending(client.pending(workflow));
      setBroken(null);
    } catch (cause) {
      setBroken(messageOf(cause, "A retained request is invalid."));
    }
  };
  return { pending, broken, sync };
}

/** The write failed for certain, or its result is unknown. Only the first is the person's to read
 * about now; the second is shown by the retained request. */
export const isUncertain = (cause: unknown): boolean =>
  cause instanceof ApplicationRequestError && cause.uncertain;

export const codeOf = (cause: unknown): string | null =>
  cause instanceof ApplicationRequestError ? cause.code : null;
