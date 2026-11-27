import type { ApplicationInputs } from "@rastrata/application/client-contracts";
import type { PayeeSubject } from "@rastrata/ui/payees/types";
import type { PayeesScreenState } from "@rastrata/ui/payees/url-state";

/** What the By payee screen asks of the service, and the small pure helpers around it, so the page is wiring
 * and these are held by tests. Nothing here reads a clock or the page. */

/** The dates every read of the screen shares. */
export interface Shared {
  readonly asOf: string;
  readonly from: string;
  /** A book revision the address pinned, when a link asked for one. */
  readonly revision?: string | undefined;
}

const pinned = (shared: Shared) =>
  shared.revision !== undefined ? { revision: shared.revision } : {};

/** The report: the dates, the side to list and the page of payees. The defaults are left out, so the
 * request is as small as the address. */
export function totalsInput(
  state: PayeesScreenState,
  shared: Shared,
): ApplicationInputs["payees.totals"] {
  return {
    asOf: shared.asOf,
    from: shared.from,
    ...pinned(shared),
    ...(state.direction !== "both" ? { direction: state.direction } : {}),
    ...(state.page !== 1 ? { page: state.page } : {}),
  };
}

/** What a row of the report is made of: exactly one thing to read, named the way the service names it. */
export function subjectInput(
  subject: PayeeSubject,
): Pick<ApplicationInputs["payees.get"], "payeeId" | "unnamed" | "ambiguous" | "noPayee"> {
  switch (subject.kind) {
    case "payee":
      return { payeeId: subject.payeeId };
    case "unnamed":
      return { unnamed: subject.key };
    case "ambiguous":
      return { ambiguous: subject.key };
    case "no_payee":
      return { noPayee: subject.why };
  }
}

export function detailInput(
  subject: PayeeSubject,
  shared: Shared,
  page: number,
): ApplicationInputs["payees.get"] {
  return {
    ...subjectInput(subject),
    asOf: shared.asOf,
    from: shared.from,
    ...pinned(shared),
    ...(page !== 1 ? { page } : {}),
  };
}

/** Reading a payee on its own, to change it: one transaction is enough, since only the payee is wanted. */
export function payeeInput(payeeId: string, shared: Shared): ApplicationInputs["payees.get"] {
  return { payeeId, asOf: shared.asOf, from: shared.from, ...pinned(shared), pageSize: 1 };
}

/** What some words would find, in the dates on screen. For a payee being changed, its own transactions are
 * the ones it keeps or loses. */
export function testInput(
  words: readonly string[],
  shared: Shared,
  payeeId?: string,
): ApplicationInputs["payees.test"] {
  return {
    words,
    asOf: shared.asOf,
    from: shared.from,
    ...pinned(shared),
    ...(payeeId !== undefined ? { payeeId } : {}),
  };
}

/** The request that names or changes a payee. A change names the version it changes, so a payee changed
 * since the form was opened is refused and not overwritten. */
export function saveInput(
  fields: { name: string; words: readonly string[]; note: string; retired: boolean },
  changing: { id: string; version: number } | null,
): ApplicationInputs["payees.save"] {
  return {
    name: fields.name,
    words: [...fields.words],
    note: fields.note,
    ...(changing
      ? { payeeId: changing.id, expectedVersion: changing.version, retired: fields.retired }
      : {}),
  };
}

/** The retained write's name: one pending save per payee, and one for a payee being named. */
export const saveWorkflow = (changing: { id: string } | null): string =>
  `payees:save:${changing ? changing.id : "new"}`;

/** Where one of the entries is. */
export const entryHref = (journalId: string): string => `/journal/${encodeURIComponent(journalId)}`;

/** Where the 1099 vendors of a year are. */
export const vendorsHref = (taxYear: number | undefined): string =>
  taxYear === undefined ? "/tax?tab=vendors" : `/tax?tab=vendors&year=${taxYear}`;

/** A file name for a download that cannot carry anything but plain characters, whatever the service said. */
export function safeDownloadName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  return cleaned === "" ? "download" : cleaned.slice(0, 120);
}

/** Where this screen opens a payee for some dates: what the 1099 tab links to. The payee is the vendor's own
 * id, so the link opens the same one. */
export function payeeHref(payeeId: string, from: string, to: string): string {
  const query = new URLSearchParams({ from, to, payee: payeeId });
  return `/reports/payees?${query.toString()}`;
}
