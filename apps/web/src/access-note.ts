import { formatCount } from "@rastrata/ui/format";
import type { Role } from "./account";
import { ROLE_LABEL } from "./members-controller";

/** Who is signed in to a service with accounts, and as what in the workspace that is open. */
export interface Who {
  readonly email: string;
  readonly role?: Role | undefined;
}

/** What the footer says about who can use this service. It is read from the service itself (the
 * `ownerAccess` of `book.get`), so it is true of the one this page talks to: a locked service (the
 * installed one) says the owner lock is on. An open one (the development API) says nothing about it: the page
 * never calls itself a development build. Until the service has answered, or when it cannot, it claims nothing. */
export function accessNote(
  ownerAccess: "open" | "key" | undefined,
  /** Signed in to a hosted service with its session: it does not run on this computer. */
  signedIn = false,
  /** Who it is, on a service with accounts. */
  who?: Who,
): string {
  if (who) return `Signed in as ${who.email}${who.role ? ` · ${ROLE_LABEL[who.role]}` : ""}`;
  if (signedIn) return "Signed in as the owner";
  if (ownerAccess === "key") return "Runs on this computer only · The owner lock is on";
  return "";
}

/** What the service says, in GET /health, about reading the book it started on. The installed
 * service reads it once each time it starts, so the first page does not wait for it: until it has
 * finished the service answers, but whatever needs the book waits. */
export interface Warmup {
  /** Reading now. */
  readonly reading: boolean;
  /** About how many seconds are left; null before the first page of the book has been read. */
  readonly secondsLeft: number | null;
  /** Why the book could not be read, when it could not. */
  readonly failure: string | null;
}

export const notReading: Warmup = { reading: false, secondsLeft: null, failure: null };

/** "Reading your books, about 40 seconds": what the footer says while the service reads them. The
 * time is a guess and is worded as one; the command line says the same in the same words. */
export function readingNote(secondsLeft: number | null): string {
  if (secondsLeft === null) return "Reading your books";
  if (secondsLeft < 5) return "Reading your books, almost done";
  if (secondsLeft < 57.5)
    return `Reading your books, about ${formatCount(Math.round(secondsLeft / 5) * 5)} seconds`;
  if (secondsLeft < 90) return "Reading your books, about a minute";
  if (secondsLeft < 90 * 60)
    return `Reading your books, about ${formatCount(Math.round(secondsLeft / 60))} minutes`;
  return `Reading your books, about ${formatCount(Math.round(secondsLeft / 3600))} hours`;
}

/** What the footer says when the service is up but could not read the book. */
export const unreadableNote = "Your books could not be read: run rastrata doctor in a terminal";

/** The footer's line: what the service is doing about the book (when it is reading it, or could not),
 * then who can use it. */
export function footerNote(
  ownerAccess: "open" | "key" | undefined,
  warmup: Warmup = notReading,
  signedIn = false,
  who?: Who,
): string {
  const access = accessNote(ownerAccess, signedIn, who);
  const doing =
    warmup.failure !== null
      ? unreadableNote
      : warmup.reading
        ? readingNote(warmup.secondsLeft)
        : "";
  return [doing, access].filter(Boolean).join(" · ");
}
