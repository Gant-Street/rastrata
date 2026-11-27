import type { BookCommand, BookCommandResult, DurableBookAggregate } from "@rastrata/kernel";
import type { BookAuthorization, BookPermission } from "./book-authorization.ts";
import type {
  NativeLedgerHead,
  NativeOutcomePage,
  OutcomeDecoding,
} from "./native-ledger-repository.ts";

export type BookCredential = string | null | BookAuthorization;

export interface AuthorizationRevisionReceipt {
  readonly requestId: string;
  readonly actorId: string;
  readonly expectedRevision: string;
  readonly authorizationRevision: string;
}

/** Application-facing operations, independent of database/runtime implementation.
 * A resolved mutation acknowledges primary durability, not backup inclusion.
 * Implementations retain exact committed/rejected outcomes and enforce current
 * scope, actor, permission, authorization revision and writer fence at publication.
 * A pre-body capability check never substitutes for those operation-time checks.
 * Infrastructure failures reject the promise; they are not accounting rejections.
 * Disaster recovery and writer cutover are intentionally outside this port. */
export interface BookApplicationService {
  checkRequestAuthorization(
    credential: BookCredential,
    permission: BookPermission,
  ): Promise<BookAuthorization>;
  provision(
    credential: BookCredential,
    initial: DurableBookAggregate,
    command: BookCommand,
  ): Promise<{ readonly result: BookCommandResult; readonly outcomeSequence: string }>;
  execute(
    credential: BookCredential,
    command: BookCommand,
  ): Promise<{
    readonly value: {
      readonly result: BookCommandResult;
      readonly originalResult: BookCommandResult | null;
      readonly outcomeSequence: string | null;
    };
    readonly head: NativeLedgerHead;
  }>;
  /** A page of the stored outcomes after `after` (at most 16). `decoding` is how each is decoded: the
   * default proves every stored text is the canonical encoding of its payload; "stored" skips that
   * proof for a reader that compares the text with a canonical encoding itself or trusts the ledger's
   * chain over the stored bytes (see `OutcomeDecoding`). */
  outcomes(
    credential: BookCredential,
    after?: NativeLedgerHead | null,
    limit?: number,
    decoding?: OutcomeDecoding,
  ): Promise<NativeOutcomePage>;
  advanceAuthorization(
    credential: BookCredential,
    requestId: string,
    expectedRevision: string,
  ): Promise<AuthorizationRevisionReceipt>;
}
