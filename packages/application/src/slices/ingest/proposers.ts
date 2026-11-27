/** The proposer registry: how rules, the classifier, the Stripe payout matcher and the built-in
 * transfer and journal matchers hand suggestions to the Inbox.
 *
 * A proposer only suggests. It is a pure, deterministic function of an item and the context it is
 * given, and nothing it returns is posted: a person (or an agent with the grant) turns a proposal
 * into a draft, and the draft goes through prepare and commit like any other entry.
 *
 * Registration is code, not book state, so it is one module-level table filled when a slice's
 * module loads (the same way `slices/catalog.ts` lists slices). Anything that belongs to one book,
 * such as the rules a person wrote, is read by `create(service)` when the pipeline starts a
 * proposing run. A run calls `create` once and uses that one snapshot for every item.
 *
 *   registerProposer({
 *     name: "rules",
 *     create: (service) => { const rules = loadRules(service.store); return { name: "rules", propose } },
 *     revision: (service) => rulesHash(service.store),
 *   });
 *
 * `revision` is how stored proposals learn they are stale: it returns a string that changes
 * whenever anything the proposer reads changes (a hash of the rules, a version of the model). The
 * Inbox compares the combined revision with the one it last proposed under and re-proposes the
 * open items when they differ, so a lane never has to tell the pipeline "my rules changed". */
import type { Proposer } from "../../ingest-types.ts";
import type { ApplicationService } from "../../service.ts";

export interface ProposerRegistration {
  /** Lower case words, digits, dots, dashes and underscores, for example "rules", "classifier",
   * "stripe.payouts". Unique across the program; registering a name twice with a different
   * registration is a programming error and throws. */
  readonly name: string;
  /** Build the proposer for one proposing run. May read the book's product state (through
   * `service.store`) to take a snapshot. Must not write, and must not call the ledger. */
  create(service: ApplicationService): Proposer;
  /** A string that changes whenever anything `create` would read changes. Keep it cheap: it is
   * called before every Inbox read. Omit it when the proposer's output only depends on the item. */
  revision?(service: ApplicationService): string;
  /** Bring what `create` reads up to date, once at the start of a proposing run that a reader began
   * (For review listed, opened or summarised) and that has open items, before `revision` is asked.
   * The one place in a run a proposer may write its own product state: a classifier that learns from
   * the book learns again here when the book or the Inbox's decisions have moved on, so the
   * suggestions the reader is about to see reflect them. A run that a change began (a line accepted,
   * a batch posted) does not call it, so a run of changes does not pay for it on every call; the next
   * reader does. It must not touch the books themselves. A failure is swallowed: the run goes on with
   * what the proposer has. */
  prepare?(service: ApplicationService): Promise<void> | void;
  /** True for a proposer of last resort: it is asked only for a line that no other proposer made a
   * usable suggestion for, after all of them have been asked. The starter list of common merchants
   * is one: a book that has a rule, a learned suggestion or a match for a line is never shown the
   * list's guess beside it. */
  readonly fallback?: boolean;
}

const NAME = /^[a-z][a-z0-9._-]{0,63}$/;
const registrations = new Map<string, ProposerRegistration>();
let version = 0;

/** Add a proposer. Returns a function that removes it again, for tests. Registering the very same
 * registration object twice is harmless; a different one under a taken name throws. */
export function registerProposer(registration: ProposerRegistration): () => void {
  if (typeof registration?.name !== "string" || !NAME.test(registration.name))
    throw new TypeError(
      `Proposer names are lower case words, digits, dots, dashes and underscores: ${String(registration?.name)}`,
    );
  if (typeof registration.create !== "function")
    throw new TypeError(`Proposer ${registration.name} needs a create function`);
  const existing = registrations.get(registration.name);
  if (existing && existing !== registration)
    throw new Error(`Proposer ${registration.name} is already registered`);
  if (!existing) {
    registrations.set(registration.name, registration);
    version++;
  }
  return () => {
    if (registrations.get(registration.name) === registration) {
      registrations.delete(registration.name);
      version++;
    }
  };
}

/** Every registered proposer, in name order so results never depend on module load order. */
export function registeredProposers(): readonly ProposerRegistration[] {
  return [...registrations.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

/** Changes whenever a proposer is added or removed. */
export function proposerRegistryVersion(): number {
  return version;
}
