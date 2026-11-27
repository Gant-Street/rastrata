/** `journal.post`: a draft, its preparation and its commit in one request.
 *
 * A form that is already the review (the quick entry) used to send `drafts.create` or `drafts.save`,
 * `journal.prepare` and `operations.commit` one after the other, and a refused posting `drafts.recover`:
 * three or four requests, and in a host that keeps the book in a log three or four commits to the tail.
 * This runs the same steps in the same order by the same service calls, so the checks and the words are
 * theirs, and the whole is one request.
 *
 * Identity. The request has one, P. The posting is prepared and committed under `A`, derived from it, and
 * the draft and its reopening are retained under identities derived from it too, because an identity
 * belongs to one operation (`app_requests` and `app_actions` share one namespace, so P cannot be the
 * action). The whole is retained under P: the same request again returns the first answer, and P with other
 * input is `operation_identity_conflict`. Each step is also idempotent by its own identity, as the steps of
 * `inbox.post` are, so a request interrupted halfway (a book in a file; in a log the whole request is one
 * commit) resumes where it was and never repeats a step.
 *
 * What is an answer and what is an error. Once the draft is kept the caller must learn its id, or its next
 * try would make another draft. So an error the books or the service raise after that (a date outside the
 * calendar, a source claimed by another posting) is returned as `refusal`, with the code, message and
 * details its own operation would have given, beside the draft; only what happens before the draft is
 * kept (a malformed draft, a draft that has changed) is an error of the request, as it is for
 * `drafts.create` and `drafts.save`. A plan that is not valid is the plan, as `journal.prepare` answers it,
 * and nothing is committed. A posting the ledger refuses is the receipt, and the draft comes back reopened. */
import { describePrincipal, type ApplicationAccess } from "../../agent/principal.ts";
import type { JournalPostInput, PostRefusal } from "../../client-contracts.gen.ts";
import type { MutationReceipt, PreparedOperation, SavedDraft } from "../../contracts.ts";
import { ApplicationError } from "../../errors.ts";
import { deriveUuid } from "../../ingest/hash.ts";
import type { ApplicationService } from "../../service.ts";

/** What `journal.post` answers (the contract's `JournalPostResult`, in the service's own types). */
export interface PostOutcome {
  readonly draft: SavedDraft;
  readonly plan: PreparedOperation | null;
  readonly receipt: MutationReceipt | null;
  readonly refusal: PostRefusal | null;
}

/** The same JSON whatever the order of the keys: two drafts are the same if they say the same. */
function canonical(value: unknown): string {
  const sorted = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sorted);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, member]) => [key, sorted(member)]),
      );
    return item;
  };
  return JSON.stringify(sorted(value));
}

/** The words of `ApplicationHttp.requirePermission`, for the second permission this operation needs. */
function requireDraftPermission(access: ApplicationAccess): void {
  if (access.permissions.includes("draft")) return;
  throw new ApplicationError(
    "permission_denied",
    access.principal?.kind === "token"
      ? `This operation requires draft permission; this token grants ${access.permissions.join(", ") || "nothing"}`
      : "This operation requires draft permission",
    403,
  );
}

/** An error of the steps after the draft is kept, as the operation that raised it would have answered
 * it; null for one that is not the book's to explain (it propagates, as it would from that operation). */
function refusalOf(error: unknown): PostRefusal | null {
  const failure =
    error instanceof ApplicationError
      ? error
      : error instanceof Error && /^Draft changed/.test(error.message)
        ? new ApplicationError("draft_version_conflict", error.message, 409)
        : error instanceof TypeError
          ? new ApplicationError("invalid_input", error.message)
          : null;
  if (!failure) return null;
  return {
    code: failure.code,
    message: failure.message,
    details: failure.details.map((detail) => ({ path: detail.path, message: detail.message })),
    retryable: failure.retryable,
  };
}

export function postEntry(
  service: ApplicationService,
  access: ApplicationAccess,
  input: JournalPostInput,
  operationId: string,
): Promise<PostOutcome> {
  requireDraftPermission(access);
  if ((input.draftId === undefined) !== (input.expectedVersion === undefined))
    throw new ApplicationError(
      "invalid_input",
      "Request does not match the operation schema",
      400,
      [
        {
          path: input.draftId === undefined ? "input.draftId" : "input.expectedVersion",
          message: `Missing ${input.draftId === undefined ? "draftId" : "expectedVersion"}`,
        },
      ],
    );
  const by = describePrincipal(access.principal);
  return service.retainAsyncRequest(operationId, "journal.post", input, () =>
    run(service, input, operationId, by),
  );
}

async function run(
  service: ApplicationService,
  input: JournalPostInput,
  operationId: string,
  by: string,
): Promise<PostOutcome> {
  const posting = deriveUuid(["journal.post", operationId, "posting"]);

  // The draft. An error here is the request's: nothing was kept.
  let draft: SavedDraft = service.retainRequest(
    deriveUuid(["journal.post", operationId, "draft"]),
    "journal.post.draft",
    input,
    () => {
      if (input.draftId === undefined || input.expectedVersion === undefined)
        return service.createDraft(input.data);
      const held = service.draft(input.draftId);
      if (!held || held.version !== input.expectedVersion || held.status !== "draft")
        throw new ApplicationError(
          "draft_version_conflict",
          "Draft changed or is no longer editable",
          409,
        );
      // The same words again are not an edit: the version stays, as a dialog that did not change the form
      // does not save.
      return canonical(held.data) === canonical(input.data)
        ? held
        : service.saveDraft(held.id, held.version, input.data);
    },
  );

  // From here the caller holds a draft, and any error of the books comes back beside it.
  const stopped = (
    error: unknown,
    plan: PreparedOperation | null,
    receipt: MutationReceipt | null,
  ): PostOutcome => {
    const refusal = refusalOf(error);
    if (!refusal) throw error;
    return { draft, plan, receipt, refusal };
  };
  let plan: PreparedOperation;
  try {
    plan = await service.prepareDraft(draft.id, draft.version, posting, {
      by,
      operation: "journal.post",
    });
  } catch (error) {
    return stopped(error, null, null);
  }
  if (!plan.valid) return { draft, plan, receipt: null, refusal: null };

  let receipt: MutationReceipt;
  try {
    receipt = await service.commitAction(posting, plan.planHash, { by, operation: "journal.post" });
  } catch (error) {
    return stopped(error, plan, null);
  }
  if (receipt.disposition === "committed") {
    draft = service.draft(draft.id) ?? draft;
    return { draft, plan, receipt, refusal: null };
  }
  // The books turned the posting down: the draft is reopened so that a second try edits it.
  try {
    draft = await service.recoverDraft(
      draft.id,
      draft.version,
      posting,
      deriveUuid(["journal.post", operationId, "recover"]),
    );
  } catch (error) {
    return stopped(error, plan, receipt);
  }
  return { draft, plan, receipt, refusal: null };
}
