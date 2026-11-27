import { toneOf, type Tone, type ToneName } from "./tones";

/** The one action a toast can carry: what it is called and what it does. "Undo" is the reason it exists. */
export interface ToastAction {
  readonly label: string;
  readonly onSelect: () => void;
}

export interface ToastOptions {
  /** One sentence, said once: "Posted 6 transactions." It is read out politely when it appears. */
  message: string;
  /** Default `calm`. A `problem` stays until it is dismissed, because a failure must not vanish before
   * it is read. */
  tone?: ToneName | undefined;
  action?: ToastAction | undefined;
  /** How long it stays, in milliseconds, unless the pointer or focus is on it. `0` keeps it until it is
   * dismissed. Left out, the tone and the action decide (see `toastDuration`). */
  timeoutMs?: number | undefined;
  /** Showing a toast with the id of one that is still there replaces it, so a message can change as the
   * work goes on ("Posting 6 transactions…" then "Posted 6 transactions. Undo"). */
  id?: string | undefined;
}

/** What `useToast()` gives a screen. */
export interface ToastApi {
  /** Show a toast, or queue it when three are already showing. Returns its id. */
  show(options: ToastOptions): string;
  /** Dismiss one toast; without an id, clear every toast and the queue at once. */
  dismiss(id?: string): void;
}

/** How many toasts are on screen at once. The rest wait in a queue and appear as room is made. */
export const TOASTS_VISIBLE = 3;

const BASE_MS: Readonly<Record<Tone, number>> = {
  calm: 5_000,
  info: 6_000,
  attention: 8_000,
  problem: Number.POSITIVE_INFINITY,
};
/** A toast with an action stays at least this long, because someone has to be able to reach the action:
 * with a keyboard that means Alt+T and then Tab. */
const WITH_ACTION_MS = 10_000;

/** How long a toast stays on screen, in milliseconds; `Infinity` until it is dismissed. Hovering or
 * focusing a toast pauses the clock, so this is the time left to read it, not a deadline. */
export function toastDuration(
  tone: Tone,
  hasAction: boolean,
  timeoutMs?: number | undefined,
): number {
  if (timeoutMs !== undefined)
    return timeoutMs > 0 && Number.isFinite(timeoutMs) ? timeoutMs : Number.POSITIVE_INFINITY;
  const base = BASE_MS[tone];
  return hasAction ? Math.max(base, WITH_ACTION_MS) : base;
}

/** The toast's own type, as the toast machine knows it. Tones are ours; the machine has its own names and
 * ranks the queue by them (a problem with an action goes first). */
export function machineType(tone: Tone): "info" | "warning" | "error" {
  return tone === "problem" ? "error" : tone === "attention" ? "warning" : "info";
}

export interface ToastPlan {
  readonly tone: Tone;
  readonly duration: number;
  readonly type: "info" | "warning" | "error";
}

/** Everything a toast's options decide, in one pure place that a test can read. */
export function planToast(options: ToastOptions): ToastPlan {
  const tone = toneOf(options.tone, "calm");
  return {
    tone,
    duration: toastDuration(tone, options.action !== undefined, options.timeoutMs),
    type: machineType(tone),
  };
}
