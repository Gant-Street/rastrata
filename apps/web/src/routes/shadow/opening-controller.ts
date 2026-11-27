import type { ApplicationInputs, ApplicationOutputs } from "@rastrata/application/client-contracts";
import type { OpeningScreenProps } from "@rastrata/ui";
import { formatFiguresInText, formatMoney as readable, shadowWords as words } from "@rastrata/ui";
import { batch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { ApplicationRequestError, type BrowserApplicationClient } from "../../application-client";
import { createLoader } from "../../loader.ts";
import { lanes } from "../registry";
import { isNoBook } from "./no-book";
import { type OpeningHandoff, takeHandoff } from "./handoff";
import {
  balancesInput,
  chartRows,
  chosenIds,
  entryFigures,
  entrySections,
  entryView,
  type SectionText,
  fieldIds,
  issueViews,
  offsetChoices,
  offsetFor,
  readAmount,
  sourceViews,
  statementAccounts,
  tidy,
  valuesFromReview,
} from "./logic";

/** The workflows this screen retains writes under, so a lost reply is resumed, never repeated. */
export const CUTOVER_WORKFLOW = "shadow:cutover";
export const PLAN_WORKFLOW = "shadow:opening-plan";
export const COMMIT_WORKFLOW = "shadow:opening-commit";
const WORKFLOWS = [CUTOVER_WORKFLOW, PLAN_WORKFLOW, COMMIT_WORKFLOW] as const;

const PREVIEW_DELAY_MS = 300;
/** The most CSV text one request carries; the service limit is a little larger. */
const MAX_FILE_CHARACTERS = 100_000;

type Review = ApplicationOutputs["opening.review"];
type Plan = ApplicationOutputs["opening.plan"];
type State = ApplicationOutputs["cutover.get"];

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message ? cause.message : fallback;
const isUncertain = (cause: unknown): boolean =>
  cause instanceof ApplicationRequestError && cause.uncertain;
const isDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);
/** The amounts of a review as the table shows them: through the shared formatter. */
const shownValues = (review: Review): Record<string, string> =>
  Object.fromEntries(
    Object.entries(valuesFromReview(review)).map(([id, amount]) => [id, readable(amount)]),
  );

/** Everything the Opening balances screen holds: what the person has typed, what the service said
 * about it, and the writes. The screen renders; this decides. Nothing changes the books until
 * `post`, and `post` commits exactly the plan the person saw. */
export function createOpeningController(client: BrowserApplicationClient) {
  // Plain-signal reads: a read that is under way never suspends the page or drops the focus.
  const accounts = createLoader(() => client.read("accounts.list", {}));
  const cutoverRead = createLoader(() => client.read("cutover.get", {}));
  const calendar = createLoader(() => client.read("periods.list", {}));
  const state = cutoverRead.value;
  const chart = createMemo(() => chartRows(accounts.value()?.accounts ?? []));

  // ---- Step one ----
  const [date, setDateRaw] = createSignal("");
  const [dateError, setDateError] = createSignal("");
  const [chosen, setChosen] = createSignal<ReadonlySet<string>>(new Set());
  const [preview, setPreview] = createSignal<State | null>(null);
  const [previewing, setPreviewing] = createSignal(false);
  const [recording, setRecording] = createSignal(false);
  const [recordError, setRecordError] = createSignal("");
  let seeded = false;
  createEffect(() => {
    const loaded = state();
    if (!loaded || seeded) return;
    seeded = true;
    batch(() => {
      setDateRaw(loaded.cutover?.cutoverDate ?? "");
      setChosen(new Set(chosenIds(statementAccounts(loaded))));
    });
  });
  // Until a date is recorded, the field starts as the books' first day: that is the start date for
  // nearly everyone, and the person changes it only when they left their old system later. Only an
  // empty field nobody has typed in is filled.
  let typed = false;
  createEffect(() => {
    const began = calendar.value()?.calendar.booksBegan;
    const loaded = state();
    if (!seeded || typed || !loaded || loaded.cutover || !began || date() !== "") return;
    setDateRaw(began);
  });

  let previewToken = 0;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on([date, chosen], ([when, ids]) => {
      clearTimeout(previewTimer);
      const mine = ++previewToken;
      if (!isDate(when) || !seeded) {
        setPreview(null);
        setPreviewing(false);
        return;
      }
      setPreviewing(true);
      previewTimer = setTimeout(() => {
        client
          .read("cutover.get", { cutoverDate: when, accountIds: [...ids].sort() })
          .then(
            (data) => {
              if (mine === previewToken) setPreview(data);
            },
            () => {
              if (mine === previewToken) setPreview(null);
            },
          )
          .finally(() => {
            if (mine === previewToken) setPreviewing(false);
          });
      }, PREVIEW_DELAY_MS);
    }),
  );
  onCleanup(() => clearTimeout(previewTimer));

  const shown = createMemo(() => preview() ?? state() ?? null);
  const statementRows = createMemo(() => {
    const current = shown();
    if (!current) return [];
    return statementAccounts(current).map((account) => ({
      ...account,
      chosen: chosen().has(account.id),
    }));
  });
  const recorded = createMemo(() => {
    const cutover = state()?.cutover;
    return cutover
      ? { date: cutover.cutoverDate, recordedAt: cutover.recordedAt, by: cutover.by }
      : null;
  });
  const unchanged = createMemo(() => {
    const cutover = state()?.cutover;
    if (!cutover || cutover.cutoverDate !== date()) return false;
    const now = [...chosen()].sort();
    return (
      now.length === cutover.accountIds.length &&
      now.every((id, at) => id === [...cutover.accountIds].sort()[at])
    );
  });

  // ---- Step two ----
  const [values, setValues] = createSignal<Record<string, string>>({});
  const [offsetId, setOffsetId] = createSignal("");
  const [showProfitLoss, setShowProfitLoss] = createSignal(false);
  const [file, setFile] = createSignal<{ reading: boolean; message?: string; error?: string }>({
    reading: false,
  });
  const figures = createMemo(() => entryFigures(chart(), values(), offsetId()));
  const sectionText: SectionText = {
    assets: words.sectionAssets,
    liabilities: words.sectionLiabilities,
    equity: words.sectionEquity,
    profitLoss: words.sectionProfitLoss,
    profitLossHint: words.profitLossHint,
    amountProblem: words.amountProblem,
  };
  const sections = createMemo(() =>
    entrySections(chart(), values(), offsetId(), showProfitLoss(), sectionText),
  );
  const offsetNeeded = createMemo(() => offsetFor(chart(), offsetId()).problem);

  // ---- Step three ----
  const input = createMemo((): ApplicationInputs["opening.review"] => ({
    cutoverDate: date(),
    balances: balancesInput(chart(), values(), offsetId()),
    ...(offsetId() ? { offsetAccountId: offsetId() } : {}),
  }));
  const key = createMemo(() => JSON.stringify(input()));
  const [review, setReview] = createSignal<Review | null>(null);
  const [reviewKey, setReviewKey] = createSignal("");
  const [reviewing, setReviewing] = createSignal(false);
  const [plan, setPlan] = createSignal<Plan | null>(null);
  const [preparing, setPreparing] = createSignal(false);
  const [posting, setPosting] = createSignal(false);
  const [postError, setPostError] = createSignal("");
  // The entry was posted from this screen just now, as opposed to found already posted.
  const [justPosted, setJustPosted] = createSignal(false);
  const [pageError, setPageError] = createSignal("");

  const stale = createMemo(() => review() !== null && reviewKey() !== key());
  // A prepared plan belongs to the balances it was prepared from.
  createEffect(
    on(key, (now) => {
      if (plan() && reviewKey() !== now) setPlan(null);
    }),
  );

  // ---- Writes that were not confirmed ----
  const [pending, setPending] = createSignal<string | null>(null);
  const [resuming, setResuming] = createSignal(false);
  const syncPending = () => {
    try {
      setPending(WORKFLOWS.find((workflow) => client.pending(workflow) !== null) ?? null);
    } catch (cause) {
      setPageError(messageOf(cause, "A retained request is invalid."));
    }
  };
  onMount(syncPending);

  const reload = async () => {
    await Promise.all([cutoverRead.reload(), accounts.reload()]);
    setPreview(null);
  };

  async function record() {
    if (recording()) return;
    if (!isDate(date())) {
      setDateError(words.dateNeeded);
      return;
    }
    setDateError("");
    setRecordError("");
    setRecording(true);
    try {
      await client.write(
        "cutover.set",
        { cutoverDate: date(), accountIds: [...chosen()].sort() },
        CUTOVER_WORKFLOW,
      );
      seeded = true;
      await reload();
    } catch (cause) {
      if (!isUncertain(cause)) setRecordError(messageOf(cause, words.recordFailed));
    } finally {
      syncPending();
      setRecording(false);
    }
  }

  async function runReview() {
    if (reviewing()) return;
    setReviewing(true);
    setPageError("");
    const mine = key();
    try {
      const result = await client.read("opening.review", input());
      batch(() => {
        setReview(result);
        setReviewKey(mine);
        setPlan(null);
        setPostError("");
      });
    } catch (cause) {
      setPageError(messageOf(cause, "The entry could not be reviewed."));
    } finally {
      setReviewing(false);
    }
  }

  async function prepare() {
    if (preparing() || stale()) return;
    setPreparing(true);
    setPageError("");
    setPostError("");
    try {
      const result = await client.write("opening.plan", input(), PLAN_WORKFLOW);
      batch(() => {
        setPlan(result);
        setReview(result.review);
        setReviewKey(key());
      });
    } catch (cause) {
      if (!isUncertain(cause)) setPageError(messageOf(cause, "The entry could not be prepared."));
    } finally {
      syncPending();
      setPreparing(false);
    }
  }

  async function post() {
    const prepared = plan();
    if (!prepared || posting() || !prepared.plan.valid) return;
    setPosting(true);
    setPostError("");
    try {
      const receipt = await client.write(
        "operations.commit",
        { planId: prepared.plan.planId, planHash: prepared.plan.planHash },
        COMMIT_WORKFLOW,
      );
      if (receipt.disposition === "committed") {
        batch(() => {
          setPlan(null);
          setReview(null);
          setJustPosted(true);
        });
        await reload();
      } else
        setPostError(
          receipt.diagnostics.join("; ") || "The ledger refused the entry. Prepare it again.",
        );
    } catch (cause) {
      if (!isUncertain(cause)) setPostError(messageOf(cause, "The entry could not be posted."));
    } finally {
      syncPending();
      setPosting(false);
    }
  }

  async function resume() {
    const workflow = pending();
    if (!workflow || resuming()) return;
    setResuming(true);
    setPageError("");
    try {
      const original = client.pending(workflow);
      const completed = await client.resume(workflow);
      if (completed.name === "cutover.set") {
        seeded = true;
        await reload();
      } else if (completed.name === "opening.plan") {
        // Put the table back as the plan saw it, so the screen and the plan agree.
        const result = completed.data;
        const sent = original
          ? (JSON.parse(original.body).input as ApplicationInputs["opening.plan"])
          : null;
        batch(() => {
          if (sent) {
            setDateRaw(sent.cutoverDate);
            setOffsetId(sent.offsetAccountId ?? "");
          }
          setValues(shownValues(result.review));
          setPlan(result);
          setReview(result.review);
        });
        setReviewKey(key());
      } else if (completed.name === "operations.commit") {
        if (completed.data.disposition === "committed") {
          batch(() => {
            setPlan(null);
            setReview(null);
            setJustPosted(true);
          });
          await reload();
        } else
          setPostError(completed.data.diagnostics.join("; ") || "The ledger refused the entry.");
      }
    } catch (cause) {
      if (!isUncertain(cause)) setPageError(messageOf(cause, "The request could not be resumed."));
    } finally {
      syncPending();
      setResuming(false);
    }
  }

  async function importFile(chosenFile: File) {
    if (!isDate(date())) {
      setFile({
        reading: false,
        error: "Enter the start date first: the file is checked against it.",
      });
      return;
    }
    if (chosenFile.size > MAX_FILE_CHARACTERS * 3) {
      setFile({ reading: false, error: words.importTooLarge });
      return;
    }
    setFile({ reading: true });
    try {
      const text = await chosenFile.text();
      if (text.length > MAX_FILE_CHARACTERS) {
        setFile({ reading: false, error: words.importTooLarge });
        return;
      }
      if (text.includes("\u0000")) {
        setFile({ reading: false, error: words.importNotText });
        return;
      }
      const result = await client.read("opening.review", { cutoverDate: date(), csv: text });
      const problems = result.issues
        .filter(
          (issue) =>
            issue.severity === "error" &&
            (issue.row !== undefined || issue.code.startsWith("csv_")),
        )
        .map((issue) =>
          issue.row !== undefined ? `Row ${issue.row}: ${issue.message}` : issue.message,
        );
      batch(() => {
        setValues(shownValues(result));
        setReview(null);
        setPlan(null);
        setFile({
          reading: false,
          ...(result.lines.length > 0
            ? { message: words.importDone(result.lines.length, chosenFile.name.slice(0, 80)) }
            : {}),
          ...(problems.length > 0 ? { error: problems.slice(0, 8).join(" ") } : {}),
        });
      });
    } catch (cause) {
      setFile({ reading: false, error: messageOf(cause, words.importFailed) });
    }
  }

  // ---- Balances brought from the Xero screen ----
  // A trial balance read there waits in the tab's session storage for this screen, which fills the
  // table with it and says what to do next. Nothing is reviewed or posted by the hand-off.
  const brought = takeHandoff();
  let handedOff = false;
  async function applyHandoff(handoff: OpeningHandoff, cutoverDate: string | null) {
    if (cutoverDate === null) {
      setFile({ reading: false, error: words.handoffNeedsCutover });
      return;
    }
    setFile({ reading: true });
    try {
      const result = await client.read("opening.review", {
        cutoverDate,
        balances: [...handoff.balances],
      });
      batch(() => {
        setValues(shownValues(result));
        setReview(null);
        setPlan(null);
        setFile({
          reading: false,
          message: words.handoffDone(result.lines.length, handoff.asOf),
        });
      });
    } catch (cause) {
      setFile({ reading: false, error: messageOf(cause, words.handoffFailed) });
    }
  }
  createEffect(() => {
    const loaded = state();
    if (!brought || handedOff || !loaded || !accounts.value()) return;
    handedOff = true;
    void applyHandoff(brought, loaded.cutover?.cutoverDate ?? null);
  });

  const routes = () => lanes.flatMap((lane) => lane.routes);
  const hasRoute = (path: string) => routes().some((route) => route.path === path);
  const nextSteps = createMemo(() =>
    [
      { id: "import", href: "/import", title: words.nextImport },
      { id: "reconcile", href: "/reconcile", title: words.nextReconcile },
      { id: "checklist", href: "/periods", title: words.nextChecklist },
      // Close the books is a page of the application itself, so it is always there.
    ].filter((step) => step.id === "checklist" || hasRoute(step.href)),
  );

  /** Everything the screen takes, as one object. */
  const props = createMemo((): OpeningScreenProps => {
    const loaded = state();
    const failed = cutoverRead.error() !== undefined || accounts.error() !== undefined;
    const current = shown();
    const opening = loaded?.opening;
    const reviewed = review();
    const prepared = plan();
    return {
      state: failed ? "error" : loaded && accounts.value() ? "ready" : "loading",
      noBook: isNoBook(cutoverRead.error(), accounts.error()),
      onRetry: () => void reload(),
      focusTitle: true,
      uncertain: pending() ? { resuming: resuming() } : null,
      onResume: () => void resume(),
      opening: {
        status: (opening?.status ?? "none") as "none" | "planned" | "posted" | "reversed",
        ...(opening?.entryDate || opening?.cutoverDate
          ? { date: opening.entryDate ?? opening.cutoverDate }
          : {}),
        ...(opening?.byHand ? { byHand: true } : {}),
        ...(opening?.journalId
          ? { entryHref: `/journal/${encodeURIComponent(opening.journalId)}` }
          : {}),
      },
      cutover: {
        date: date(),
        dateError: dateError() || undefined,
        accounts: statementRows(),
        sources: current ? sourceViews(current) : [],
        previewing: previewing(),
        recorded: recorded(),
        locked: loaded?.locked ?? false,
        unchanged: unchanged(),
        pending: recording(),
        error: recordError() || undefined,
        // The notice that the date is fixed says what the service's note says: once, not twice.
        notes: loaded?.locked
          ? []
          : (current?.notes ?? []).map((note) => formatFiguresInText(note)),
        stripeNote: current?.stripe?.note ? formatFiguresInText(current.stripe.note) : undefined,
        onDate: (value) => {
          typed = true;
          setDateRaw(value);
          setDateError("");
        },
        onToggle: (id, isChosen) => {
          const next = new Set(chosen());
          if (isChosen) next.add(id);
          else next.delete(id);
          setChosen(next);
        },
        onSubmit: () => void record(),
      },
      balances: {
        sections: sections(),
        entered: figures().entered,
        totals: figures().totals,
        offset: figures().offset,
        offsetChoices: offsetChoices(chart()),
        offsetValue: offsetId(),
        offsetRequired: offsetNeeded(),
        file: file(),
        problems: figures().problems,
        anyEntered: figures().anyEntered,
        onInput: (id, value) => setValues({ ...values(), [id]: value }),
        onBlur: (id) => {
          const text = values()[id] ?? "";
          // An amount that reads is shown the way every screen shows an amount.
          const shown = readAmount(text).kind === "ok" ? readable(tidy(text)) : text;
          if (shown !== text) setValues({ ...values(), [id]: shown });
        },
        onToggleSection: () => setShowProfitLoss(!showProfitLoss()),
        onOffset: (value) => setOffsetId(value),
        onFile: (chosenFile) => void importFile(chosenFile),
        onClear: () => {
          batch(() => {
            setValues({});
            setReview(null);
            setPlan(null);
            setFile({ reading: false });
          });
        },
      },
      review: {
        stage: reviewing() ? "reviewing" : reviewed ? "reviewed" : "none",
        stale: stale(),
        entry: reviewed ? entryView(reviewed) : null,
        issues: reviewed ? issueViews(reviewed.issues, fieldIds(sections())) : [],
        valid: reviewed?.valid ?? false,
        onReview: () => void runReview(),
      },
      plan: {
        stage: preparing() ? "preparing" : prepared ? "prepared" : "none",
        entry: prepared ? entryView(prepared.review) : null,
        valid: prepared?.plan.valid ?? false,
        revision: prepared?.plan.bookRevision ?? "",
        hash: prepared?.plan.planHash ?? "",
        warnings: (prepared?.plan.warnings ?? []).map((warning) => warning.message),
        problems: (prepared?.plan.problems ?? []).map((problem) => problem.message),
        onPrepare: () => void prepare(),
      },
      error: pageError() || undefined,
      post: {
        pending: posting(),
        done: justPosted(),
        error: postError() || undefined,
        onPost: () => void post(),
      },
      nextSteps: nextSteps(),
    };
  });
  return { props };
}
