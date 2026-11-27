/** A book of the kind the application made before the chain-head state commitment existed (the
 * install package built on 2026-10-06 and every older test book): the same book, chart and calendar,
 * created without the profile, so that its state hash re-encodes every journal and reading it back is
 * quadratic. `ApplicationService.setup` makes every new book with the profile, so a test or a bench that
 * needs the older kind swaps the starting record the service builds for the one without it.
 *
 * It reaches the service's ledger on purpose: this is test support. */
import { createBookState, type DurableBookAggregate } from "@rastrata/kernel";
import { LocalBookService } from "../../src/local.ts";
import type { ApplicationService } from "../../src/service.ts";
import { BULK_BOOK } from "./bulk-book.ts";

/** The starting record of the same book, made without the profile. */
export function withoutTheProfile(initial: DurableBookAggregate): DurableBookAggregate {
  const state = initial.state;
  const configuration = state.activeConfigurationSnapshot;
  return {
    protocol: initial.protocol,
    state: createBookState(
      state.identity,
      state.periods,
      state.admissionSnapshot,
      state.policies,
      state.quantizationPolicies,
      state.accountingPolicySnapshot.policies,
      configuration.effectiveAt,
    ),
  };
}

/** Set up `service` the way an older build did: its starting record is swapped for the one without the
 * profile while the book is provisioned, and put back afterwards. */
export async function setupLegacyBook(
  service: ApplicationService,
  setup: Parameters<ApplicationService["setup"]>[0] = BULK_BOOK,
): Promise<void> {
  const ledger = service.ledger as unknown as {
    provision: (...args: unknown[]) => Promise<unknown>;
  };
  const provision = ledger.provision.bind(ledger);
  ledger.provision = (credential: unknown, initial: unknown, activation: unknown) =>
    provision(credential, withoutTheProfile(initial as DurableBookAggregate), activation);
  try {
    await service.setup(setup);
  } finally {
    ledger.provision = provision;
  }
}

/** Open a local book at `path` and set it up as a legacy book. The caller closes it. */
export async function openLegacyBook(path: string): Promise<LocalBookService> {
  const service = await LocalBookService.open(path);
  await setupLegacyBook(service);
  return service;
}
