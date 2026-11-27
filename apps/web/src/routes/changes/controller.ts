import type { ChangeList, ChangeReview } from "@rastrata/application/client-contracts";
import { markVerdict } from "@rastrata/ui/changes/logic";
import type { ChangesLoad, LookState, SubjectView } from "@rastrata/ui/changes/types";
import {
  type ChangesScreenState,
  parseState,
  queryOf,
  sameState,
  stateSearch,
} from "@rastrata/ui/changes/url-state";
import { createMemo, createSignal, onMount } from "solid-js";
import { ApplicationRequestError, type BrowserApplicationClient } from "../../application-client";
import { createKeyedLoader } from "../../loader";

/** The workflow "I have looked at these" is retained under, so a lost reply or a reload reaches the same
 * request and never records a second look. */
export const LOOK_WORKFLOW = "changes:review";

/** Where a change's own page is. A rule that was deleted, an agent key and a person lead to the page that
 * lists them, which is always there; an entry, an account and a reconciliation lead to their own. */
export function hrefFor(subject: SubjectView): string | undefined {
  switch (subject.kind) {
    case "journal":
      return `/journal/${encodeURIComponent(subject.id)}`;
    case "account":
      return `/ledger?accountId=${encodeURIComponent(subject.id)}`;
    case "rule":
      return "/rules";
    case "period":
    case "calendar":
      return "/periods";
    case "reconciliation":
      return `/reconcile/${encodeURIComponent(subject.id)}`;
    case "token":
      return "/settings/agent";
    case "member":
      return "/settings/members";
    case "book":
      return undefined;
  }
}

/** What a failed attempt to say "I have looked at these" is, for the person: a reply that was lost is not
 * known either way; a newer look, a list with a part missing and a refusal each have their own words; and
 * anything else is a failure that recorded nothing. */
export function lookStateOf(cause: unknown): LookState {
  if (!(cause instanceof ApplicationRequestError)) return { kind: "failed" };
  switch (cause.code) {
    case "review_out_of_date":
      return { kind: "stale" };
    case "review_incomplete":
      return { kind: "incomplete" };
    case "permission_denied":
    case "review_needs_a_person":
      return { kind: "denied" };
  }
  // The client calls a request it kept "uncertain" when its reply did not arrive or the service said to
  // try again: either way it is not known whether the look was recorded.
  return cause.uncertain ? { kind: "uncertain" } : { kind: "failed" };
}

/** The moment a list was first read at: every page of the same list is read at it. */
export interface Pin {
  readonly revision: string;
  readonly asOf: string;
}

export const pinOf = (list: Pick<ChangeList, "revision" | "asOf">): Pin => ({
  revision: list.revision,
  asOf: list.asOf,
});

/** What is asked of the service and the moment it is asked for: a new request for each change of the
 * choices, of the page or of "read again". */
interface Request {
  readonly state: ChangesScreenState;
  readonly pin: Pin | undefined;
  readonly nonce: number;
}

/** What a look is once the list is read again: a look under way, or one whose answer is not known, is still
 * that (the page never forgets one it has not heard the end of); anything else is over. */
const settled = (now: LookState): LookState =>
  now.kind === "saving" || now.kind === "uncertain" ? now : { kind: "idle" };

/** The choices that make a different list. Moving between pages of one list is not one. */
const sameList = (left: ChangesScreenState, right: ChangesScreenState): boolean =>
  sameState({ ...left, page: 1 }, { ...right, page: 1 });

/**
 * Everything the Changes page holds: the choices (kept in the address), the list read for them, the moment
 * it was read at, and where saying "I have looked at these" stands. The page renders; this decides.
 *
 * A page of a list is read at the revision and instant the first page was read at, so it does not shift
 * while it is read. Choosing something else, or "read again", reads the newest. "I have looked at these"
 * covers exactly the list that was on the screen (its revision and instant), so a change made while the
 * person was reading stays new. It is retained before it is sent, and sent again with the same identity
 * until the service answers, so a lost reply is never a second look.
 */
export function createChangesController(client: BrowserApplicationClient, today: string) {
  const first = parseState(window.location.search);
  let nonce = 0;
  let pin: Pin | undefined;
  const [request, setRequest] = createSignal<Request>({ state: first, pin: undefined, nonce });
  const [look, setLook] = createSignal<LookState>({ kind: "idle" });

  const list = createKeyedLoader(request, async (asked) => {
    const answer = await client.read("changes.list", queryOf(asked.state, today, asked.pin));
    // The first page of a list names the moment it was read at; the others are read at that moment.
    if (asked.pin === undefined && asked.nonce === nonce) pin = pinOf(answer);
    return answer;
  });

  const state = createMemo(() => request().state);
  const busy = () => list.loading() && list.value() !== undefined;
  const load = (): ChangesLoad =>
    list.error() !== undefined ? "failed" : list.value() === undefined ? "loading" : "ready";

  const ask = (next: ChangesScreenState, keepPin: boolean) => {
    nonce += 1;
    if (!keepPin) pin = undefined;
    setRequest({ state: next, pin: keepPin ? pin : undefined, nonce });
    const address = `${window.location.pathname}${stateSearch(next)}`;
    if (address !== `${window.location.pathname}${window.location.search}`)
      window.history.replaceState(window.history.state, "", address);
  };

  /** A choice was made. Anything but the page starts a new list at the first page. */
  const change = (patch: Partial<ChangesScreenState>) => {
    const current = request().state;
    const next: ChangesScreenState = {
      ...current,
      ...patch,
      page: "page" in patch ? Math.max(1, patch.page ?? 1) : 1,
    };
    if (sameState(next, current)) return;
    const samePages = sameList(next, current);
    if (!samePages || look().kind === "saved") setLook(settled);
    ask(next, samePages && pin !== undefined);
  };

  const clear = () => change({ who: "", what: "", text: "" });

  /** Read the newest list for the same choices. */
  const readAgain = () => {
    setLook(settled);
    ask({ ...request().state }, false);
  };

  onMount(() => {
    // A look that was sent and not answered, before this page opened: it is checked, not repeated.
    try {
      if (client.pending(LOOK_WORKFLOW) !== null) setLook({ kind: "uncertain" });
    } catch {
      // A kept request that cannot be read sends nothing; the page says nothing it does not know.
    }
  });

  /** Say "I have looked at these" about the list that is on the screen. */
  const markLooked = async () => {
    const current = look();
    if (current.kind === "saving") return;
    const seen = list.value();
    const waiting = current.kind === "uncertain";
    if (
      !waiting &&
      (seen === undefined || list.loading() || !markVerdict(seen, request().state).ok)
    )
      return;
    setLook({ kind: "saving" });
    try {
      // A look that was sent and not answered is sent again as it was; a new one covers this list.
      const review: ChangeReview =
        waiting || seen === undefined
          ? ((await client.resume(LOOK_WORKFLOW)).data as ChangeReview)
          : await client.write(
              "changes.review",
              { upToRevision: seen.revision, upToAt: seen.asOf },
              LOOK_WORKFLOW,
            );
      setLook({ kind: "saved", at: review.upToAt });
      // The list that starts after the look is what is next.
      ask({ ...request().state, page: 1 }, false);
    } catch (cause) {
      setLook(lookStateOf(cause));
    }
  };

  return {
    state,
    list: list.value,
    load,
    busy,
    failure: () => {
      const error = list.error();
      return error instanceof Error && error.message !== "" ? error.message : undefined;
    },
    look,
    today,
    change,
    clear,
    readAgain,
    markLooked,
  };
}
