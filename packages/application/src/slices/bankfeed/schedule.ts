import { ApplicationError } from "../../errors.ts";
import type { ApplicationAccess } from "../../agent/principal.ts";
import type { ApplicationService } from "../../service.ts";
import { bankfeedRuntime } from "./runtime.ts";
import { type BankfeedStore, type RunRow, bankfeedStore } from "./store.ts";
import { runBankfeedSync } from "./sync.ts";

/** The optional daily sync of an installed service. It is **off until the owner turns it on**
 * (`bankfeed.settings`), runs at the owner's chosen local time (a minute other than :00 is kinder to
 * the Bridge, which "gets more traffic at the top of the hour"), and spends the same request budget
 * as any other way of asking: it can never make the Bridge disable the access.
 *
 * Rules, all tested with an injected clock:
 *  - Not before the chosen time of day, and at most two attempts in a local day: the second only after
 *    a failure that may be temporary (the Bridge unreachable, the service interrupted), and only after
 *    two hours. A refusal (the access disabled, payment required) is never tried again by itself: it
 *    needs the owner.
 *  - Never while the Bridge has asked Rastrata to slow down, with nothing connected, or with nothing
 *    linked: there is nothing to ask.
 *  - A pause because the day's budget is spent counts as the day's attempt: asking again would only
 *    spend what is left.
 *  - It runs as the owner who turned it on, with `read` and `draft` (the weight of a manual sync), and
 *    the run is recorded with the trigger `scheduled`, so the screen says it was automatic. */

export const MAX_ATTEMPTS_PER_DAY = 2;
export const RETRY_AFTER_MS = 2 * 60 * 60 * 1000;
/** Failures that may clear by themselves. */
const TEMPORARY = new Set(["bankfeed_unavailable", "bankfeed_interrupted", "bankfeed_sync_failed"]);

export interface Attempt {
  readonly startedAt: string;
  readonly disposition: RunRow["disposition"];
  readonly errorCode: string | null;
}

/** "06:17" as minutes after local midnight, or null. */
export function minutesOf(text: string): number | null {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(text);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** The local midnight that starts the local day of `now`. */
export const localMidnight = (now: Date): Date =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate());

/** Whether a scheduled sync is due, from the owner's settings and the attempts already made today
 * (scheduled runs since local midnight, oldest first). Pure: the clock is passed in. */
export function isDue(input: {
  readonly enabled: boolean;
  readonly dailyAt: string;
  readonly now: Date;
  readonly today: readonly Attempt[];
}): boolean {
  if (!input.enabled) return false;
  const at = minutesOf(input.dailyAt);
  if (at === null) return false;
  if (input.now.getHours() * 60 + input.now.getMinutes() < at) return false;
  if (input.today.length === 0) return true;
  if (input.today.length >= MAX_ATTEMPTS_PER_DAY) return false;
  const last = input.today.at(-1);
  if (last?.disposition !== "failed" || !TEMPORARY.has(last.errorCode ?? "")) return false;
  return input.now.getTime() - Date.parse(last.startedAt) >= RETRY_AFTER_MS;
}

export type ScheduledOutcome =
  | {
      readonly ran: false;
      readonly reason: "off" | "not_due" | "nothing_to_do" | "busy" | "paused";
    }
  | { readonly ran: true; readonly disposition: RunRow["disposition"]; readonly newLines: number };

function attemptsToday(store: BankfeedStore, now: Date): Attempt[] {
  const since = localMidnight(now).toISOString();
  return store
    .runs(20)
    .filter((run) => run.trigger === "scheduled" && run.startedAt >= since)
    .reverse()
    .map((run) => ({
      startedAt: run.startedAt,
      disposition: run.disposition,
      errorCode: run.errorCode,
    }));
}

/** One look at whether a sync is due, and the sync if it is. It reads as many calls of the sync as it
 * takes (each within its own time budget), never more than twenty. It never throws: a failure is
 * recorded where the screen reads it. */
export async function runScheduledSync(
  service: ApplicationService,
  now: Date = new Date(),
): Promise<ScheduledOutcome> {
  const store = bankfeedStore(service);
  const runtime = bankfeedRuntime(service);
  const settings = store.settings();
  if (!settings.dailySync) return { ran: false, reason: "off" };
  if (!service.setupState()) return { ran: false, reason: "nothing_to_do" };
  if (!isDue({ enabled: true, dailyAt: settings.dailyAt, now, today: attemptsToday(store, now) }))
    return { ran: false, reason: "not_due" };
  const paused = store.connection().pausedUntil;
  if (paused !== null && Date.parse(paused) > now.getTime())
    return { ran: false, reason: "paused" };
  if (runtime.credentials.read() === null || store.links().length === 0)
    return { ran: false, reason: "nothing_to_do" };

  const access: ApplicationAccess = { bookId: service.bookId, permissions: ["read", "draft"] };
  let newLines = 0;
  let disposition: RunRow["disposition"] = "complete";
  try {
    for (let call = 0; call < 20; call++) {
      const operationId = crypto.randomUUID();
      const outcome = await runBankfeedSync(
        { service, access, operationId },
        { trigger: "scheduled", budgetSeconds: 60 },
        operationId,
      );
      newLines += outcome.run.newLines;
      disposition = outcome.run.disposition;
      if (!outcome.more) break;
    }
  } catch (error) {
    // Another sync is running: this is not an attempt and nothing was recorded.
    if (error instanceof ApplicationError && error.code === "bankfeed_sync_running")
      return { ran: false, reason: "busy" };
    // Anything else was recorded by the run itself, as a failed scheduled run.
    return { ran: true, disposition: "failed", newLines };
  }
  return { ran: true, disposition, newLines };
}
