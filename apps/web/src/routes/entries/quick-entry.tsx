import type { PreparedOperation, SavedDraft } from "@rastrata/application/client-contracts";
import {
  QuickEntryDialog,
  quickDraft,
  quickPostedSentence,
  quickWords,
  useToast,
  type QuickAccount,
  type QuickKind,
  type QuickPreset,
  type QuickValues,
} from "@rastrata/ui";
import { useNavigate } from "@tanstack/solid-router";
import { createSignal, onMount } from "solid-js";
import {
  ApplicationRequestError,
  type ApplicationCompletion,
  BrowserApplicationClient,
} from "../../application-client";
import { createLoader } from "../../loader";
import { quickAccounts } from "./chart";
import { forPeople } from "./messages";
import { startingDate } from "../journal-date";
import { postQuickEntry, quickPostOutcome, type QuickPostOutcome } from "./quick-post";

/** One retained write at a time for these dialogs: a lost reply is resumed, never repeated. A Post is one
 * write (`journal.post`: the draft, its preparation and its commit in one request); saving a draft is one. */
const WORKFLOW = "quick-entry";

/** The chart as the dialogs need it (see `quickAccounts`). */
async function loadChart(client: BrowserApplicationClient): Promise<readonly QuickAccount[]> {
  const [chart, sources] = await Promise.all([
    client.read("accounts.list", {}),
    // A caller that may not read the Inbox still gets a chart: the tags alone mark its banks.
    client.read("inbox.sources", {}).catch(() => null),
  ]);
  const mapped = new Set(
    (sources?.sources ?? []).flatMap((source) =>
      source.ledgerAccountId ? [source.ledgerAccountId] : [],
    ),
  );
  return quickAccounts(chart.accounts, mapped);
}

/** Spend money, Receive money or Transfer, as the dialog the shell opens from "+ New". The page is wiring:
 * the form, the preview and the words are `QuickEntryDialog`'s; this reads the chart and the calendar, and
 * posts through the draft, prepare and commit path every entry takes, in one request. */
export function QuickEntry(props: {
  kind: QuickKind;
  /** Given, the form has the switch for its kind, and this is told when the person changes it. */
  onKind?: (kind: QuickKind) => void;
  preset?: QuickPreset;
  open: boolean;
  onClose: () => void;
}) {
  const client = new BrowserApplicationClient(window.localStorage);
  const navigate = useNavigate();
  const toast = useToast();
  const chart = createLoader(() => loadChart(client));
  const calendar = createLoader(() => client.read("periods.list", {}));
  const [pending, setPending] = createSignal<"post" | "draft" | undefined>(undefined);
  const [error, setError] = createSignal("");
  const [uncertain, setUncertain] = createSignal(false);
  // The draft this dialog holds once it has saved one, so a second try edits it and never adds another.
  let held: SavedDraft | null = null;
  let lastValues: QuickValues | null = null;

  const today = () => {
    const read = calendar.value()?.calendar;
    return read
      ? startingDate({
          opening: false,
          today: read.today,
          firstFiscalDay: read.firstDate,
          calendar: read,
        })
      : undefined;
  };

  onMount(() => {
    try {
      setUncertain(client.pending(WORKFLOW) !== null);
    } catch {
      setUncertain(true);
    }
  });

  const draftData = (values: QuickValues) => quickDraft(props.kind, values, chart.value() ?? []);

  async function ensureDraft(values: QuickValues): Promise<SavedDraft> {
    const data = draftData(values);
    if (!held) held = await client.write("drafts.create", { data }, WORKFLOW);
    else if (JSON.stringify(held.data) !== JSON.stringify(data))
      held = await client.write(
        "drafts.save",
        { draftId: held.id, expectedVersion: held.version, data },
        WORKFLOW,
      );
    return held;
  }

  async function run(action: "post" | "draft", work: () => Promise<void>) {
    if (pending()) return;
    setPending(action);
    setError("");
    try {
      await work();
    } catch (cause) {
      if (cause instanceof ApplicationRequestError && cause.uncertain) setUncertain(true);
      setError(cause instanceof Error ? forPeople(cause.message) : quickWords.postRefused);
    } finally {
      try {
        setUncertain(client.pending(WORKFLOW) !== null);
      } catch {
        setUncertain(true);
      }
      setPending(undefined);
    }
  }

  function saveDraft(values: QuickValues) {
    lastValues = values;
    void run("draft", async () => {
      const draft = await ensureDraft(values);
      toast.show({
        message: quickWords.draftSaved,
        action: {
          label: quickWords.openDraft,
          onSelect: () =>
            void navigate({ to: "/journal/new", search: { draft: draft.id } as never }),
        },
      });
      props.onClose();
    });
  }

  async function finish(values: QuickValues, plan: PreparedOperation) {
    const entry = plan.effects.journals[0]?.id;
    toast.show({
      message: quickPostedSentence(props.kind, values, chart.value() ?? []),
      ...(entry
        ? {
            action: {
              label: quickWords.viewEntry,
              onSelect: () =>
                void navigate({ to: "/journal/$entryId", params: { entryId: entry } }),
            },
          }
        : {}),
    });
    props.onClose();
  }

  /** What a Post came to: the dialog holds the draft it left, and says what a person should read. `values`
   * are the form the Post was made from, and are null when the reply was reached after a reload, when only
   * the plain sentence can be said. */
  async function conclude(values: QuickValues | null, outcome: QuickPostOutcome) {
    held = outcome.draft;
    switch (outcome.kind) {
      case "stopped":
        // Thrown to `run`, which shows it.
        throw outcome.error;
      case "invalid":
        setError(
          forPeople(
            outcome.plan.problems[0]?.message ??
              outcome.plan.diagnostics[0] ??
              quickWords.postRefused,
          ),
        );
        return;
      case "refused":
        // The books turned the posting down: the draft was reopened, so a second try edits it.
        setError(
          forPeople(
            outcome.receipt.problems[0]?.message ??
              outcome.receipt.diagnostics[0] ??
              quickWords.postRefused,
          ),
        );
        return;
      case "posted":
        if (values) await finish(values, outcome.plan);
        else {
          toast.show({ message: quickWords.postedPlain });
          props.onClose();
        }
    }
  }

  function post(values: QuickValues) {
    lastValues = values;
    void run("post", async () => {
      await conclude(values, await postQuickEntry(client, WORKFLOW, draftData(values), held));
    });
  }

  function resume() {
    void run(lastValues ? "post" : "draft", async () => {
      const completion: ApplicationCompletion = await client.resume(WORKFLOW);
      switch (completion.name) {
        case "journal.post":
          // The reply to a Post was lost and the retained request has been sent again: it answers as the
          // first would have.
          await conclude(lastValues, quickPostOutcome(completion.data));
          break;
        case "drafts.create":
        case "drafts.save":
        case "drafts.recover":
          held = completion.data;
          break;
        case "operations.commit":
          if (completion.data.disposition === "committed") {
            toast.show({
              message: lastValues
                ? quickPostedSentence(props.kind, lastValues, chart.value() ?? [])
                : quickWords.postedPlain,
            });
            props.onClose();
          } else {
            // The books had turned the posting down before the reply was lost: say why, and a new Post
            // starts from the form again.
            const refusal = completion.data;
            setError(
              forPeople(
                refusal.problems[0]?.message ?? refusal.diagnostics[0] ?? quickWords.postRefused,
              ),
            );
          }
          break;
        default:
          break;
      }
    });
  }

  return (
    <QuickEntryDialog
      kind={props.kind}
      onKind={props.onKind}
      open={props.open}
      onClose={props.onClose}
      accounts={chart.value()}
      failed={chart.error() !== undefined}
      onRetry={() => void chart.reload()}
      today={today()}
      pending={pending()}
      error={error() || undefined}
      uncertain={uncertain()}
      onResume={resume}
      preset={props.preset}
      onPost={post}
      onSaveDraft={saveDraft}
    />
  );
}
