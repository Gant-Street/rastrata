import { booksFirstDay } from "../../calendar/setup.ts";
import type { ApplicationService } from "../../service.ts";
import { addDays } from "../../stripe/dates.ts";
import { recordedCutoverDate } from "../shadow/cutover-date.ts";
import { type StripeRuntime, todayOf } from "./runtime.ts";
import { type StripeSettings, defaultSettings, parseSettings } from "./settings.ts";
import type { StripeStore } from "./store.ts";

/** The first day to import from when the owner has not chosen one: the cutover date when one is
 * recorded (the day the books move to Rastrata, so Stripe's history and the Inbox start together),
 * else the day the books begin (the first day of the first fiscal year when the setup names none,
 * which is not the start of the calendar for a book that starts early). A cutover date that has not
 * come cannot be used, because a first day may not be later than tomorrow. */
export function firstDay(
  service: ApplicationService,
  setup: Parameters<typeof booksFirstDay>[0],
  today: string,
): string {
  const cutover = recordedCutoverDate(service);
  return cutover !== null && cutover <= addDays(today, 1) ? cutover : booksFirstDay(setup);
}

/** The settings Stripe is read with: what the owner saved, else the defaults, which are right for nearly every book (the first day above, sales tax as Stripe reports it, each role's
 * account from the chart's role keys, and the time zone of the Stripe account once the first reading has learned it). Nothing is asked of a person before Stripe can be read: connecting it
 * is enough, and what a book really cannot know (an account for a role its chart does not name) is the one thing that is asked. `saved` says which of the two these are. Null for a book
 * that is not set up. */
export function settingsInUse(
  service: ApplicationService,
  store: StripeStore,
  runtime: StripeRuntime,
): { readonly settings: StripeSettings; readonly saved: boolean } | null {
  const saved = parseSettings(store.settingsBody());
  if (saved) return { settings: saved, saved: true };
  const setup = service.setupState();
  if (!setup) return null;
  const zone = store.connection().timeZone;
  return {
    settings: {
      ...defaultSettings(firstDay(service, setup, todayOf(runtime))),
      ...(zone ? { timeZone: zone } : {}),
    },
    saved: false,
  };
}
