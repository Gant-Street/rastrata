import type { ApplicationOutputs, PeriodList } from "@rastrata/application/client-contracts";
import {
  type AccountView,
  chartWords,
  newAccountRequest,
  newAccountTags,
  type EditAccountValues,
  type NewAccountValues,
  suggestCode,
  type TagChange,
  taxLineOptions,
  type TaxFormChoice,
  useToast,
} from "@rastrata/ui";
import { type Accessor, createMemo, createSignal } from "solid-js";
import { createPostingWorkflow } from "../../posting-workflow";
import { openedForDisplay } from "../account-opened";

type AccountList = ApplicationOutputs["accounts.list"];

/** The two drawers of the Chart of accounts, "New account" and "Edit account", and the one retained request
 * behind them. The form is the review: a request is prepared when the person presses the button, and when
 * the ledger has nothing to say it is committed from the same click; a warning or a refusal is read in the
 * drawer first. Every write is retained before it is sent, so a lost reply is resumed after a reload and
 * never repeated. */
export function createAccountDrawers(options: {
  /** The chart as read: `null` when no book is connected yet, undefined before the first read. */
  chart: Accessor<AccountList | null | undefined>;
  taxForms: Accessor<readonly TaxFormChoice[]>;
  /** The chart was changed: read it again. */
  reload: () => Promise<void>;
  /** Save the tags of an account that was just added (the ledger adds an account and its tags separately). */
  saveTags: (accountId: string, change: TagChange) => Promise<boolean>;
  /** Why the last tag save failed, if it did. */
  tagError: () => string;
  /** The periods, for the calendar a date must fall in. */
  periods?: Accessor<PeriodList | undefined>;
  /** An account was added (and its tags saved, or not): the screen that opened the drawer may want it chosen. */
  created?: (account: AccountList["accounts"][number]) => void;
}) {
  const w = chartWords;
  const toast = useToast();
  const [mode, setMode] = createSignal<"" | "create" | "edit">("");
  const blank = (): NewAccountValues => ({
    name: "",
    kind: "expense",
    code: "",
    parentId: "",
    effectiveOn: "",
    cashFlowClass: "",
    taxLine: "",
    roleKey: "",
  });
  const [values, setValues] = createSignal<NewAccountValues>(blank());
  const [codeTyped, setCodeTyped] = createSignal(false);
  const [editing, setEditing] = createSignal<AccountView | null>(null);
  const [edits, setEdits] = createSignal<EditAccountValues>({
    name: "",
    close: false,
    effectiveOn: "",
  });
  const [phase, setPhase] = createSignal<"idle" | "working">("idle");
  // The tags typed for the account being added, kept until its commit so they can be applied.
  const [pendingTags, setPendingTags] = createSignal<{
    code: string;
    effectiveOn: string;
    tags: ReturnType<typeof newAccountTags>;
  } | null>(null);
  // The element that opened the drawer: where focus returns when it closes.
  const [opener, setOpener] = createSignal<string | null>(null);

  const rows = () => options.chart()?.accounts ?? [];
  const suggested = (kind = values().kind) => suggestCode(rows(), kind);
  const today = () => options.chart()?.suggestedEffectiveOn ?? "";

  const finish = () => {
    setMode("");
    setEditing(null);
    setValues(blank());
    setCodeTyped(false);
    setPendingTags(null);
    setPhase("idle");
  };

  const workflow = createPostingWorkflow(
    "accounts",
    async (receipt) => {
      await options.reload();
      if (receipt.disposition !== "committed") return;
      if (mode() === "create") {
        const tags = pendingTags();
        const added = values();
        const label = `${added.code.trim()} ${added.name.trim()}`;
        let message: string = w.added(label);
        const code = (tags?.code ?? added.code.trim()).toLowerCase();
        const created = rows().find((account) => account.code.toLowerCase() === code);
        if (tags && Object.keys(tags.tags).length > 0) {
          const saved = created
            ? await options.saveTags(created.id, { effectiveOn: tags.effectiveOn, tags: tags.tags })
            : false;
          if (!saved) message = w.addedTagsLost(label, options.tagError());
        }
        if (created) options.created?.(created);
        toast.show({
          message,
          ...(message.includes("not saved") ? { tone: "attention" as const } : {}),
        });
      } else if (mode() === "edit") {
        const target = editing();
        const label = target ? `${target.code} ${edits().name.trim() || target.name}` : "";
        toast.show({ message: edits().close ? w.closedToast(label) : w.changed(label) });
      } else {
        // A commit resumed after a reload: nothing remembers which account it was for.
        toast.show({ message: w.savedPlain });
      }
      finish();
    },
    (request) => {
      // A request resumed after a reload: open the drawer it belongs to, with what was asked.
      if (request.name === "accounts.prepareCreate") {
        setMode("create");
        setValues({
          ...blank(),
          name: request.input.name,
          code: request.input.code,
          kind: request.input.role as NewAccountValues["kind"],
          parentId: request.input.parentId ?? "",
          effectiveOn: request.input.effectiveOn,
        });
        setCodeTyped(true);
      } else if (request.name === "accounts.prepareChange") {
        setMode("edit");
        const account = rows().find((row) => row.id === request.input.accountId);
        if (account) {
          setEditing(viewOf(account, options.periods?.()?.calendar.booksBegan));
        }
        setEdits({
          name: request.input.name,
          close: request.input.close,
          effectiveOn: request.input.effectiveOn,
        });
      }
    },
    { chain: true },
  );

  const stage = createMemo(() =>
    phase() === "working" ? "working" : workflow.plan() ? "review" : "compose",
  );
  const warnings = () => (workflow.plan()?.warnings ?? []).map((warning) => warning.message);
  const problems = () => {
    const plan = workflow.plan();
    return plan && !plan.valid ? [...plan.diagnostics] : [];
  };

  function openNew(from: string, prefill: { name?: string; kind?: NewAccountValues["kind"] } = {}) {
    if (workflow.blocked() && mode() === "") return;
    workflow.discard();
    setOpener(from);
    const kind = prefill.kind ?? "expense";
    setValues({
      ...blank(),
      name: prefill.name ?? "",
      kind,
      code: suggested(kind),
      effectiveOn: today(),
    });
    setCodeTyped(false);
    setPendingTags(null);
    setMode("create");
  }

  function change(patch: Partial<NewAccountValues>) {
    setValues((previous) => {
      const next = { ...previous, ...patch };
      if (patch.code !== undefined) setCodeTyped(true);
      // A new kind offers the code of its own range, unless the person typed one.
      if (patch.kind !== undefined && !codeTyped()) next.code = suggested(patch.kind);
      // The tax lines an income account may carry are not an expense account's: a new type starts with none.
      if (patch.kind !== undefined && patch.kind !== previous.kind) next.taxLine = "";
      return next;
    });
  }

  async function submitNew() {
    if (phase() === "working" || workflow.blocked()) return;
    const typed = values();
    setPendingTags({
      code: typed.code.trim(),
      effectiveOn: typed.effectiveOn,
      tags: newAccountTags(typed),
    });
    setPhase("working");
    try {
      await workflow.prepare("accounts.prepareCreate", newAccountRequest(typed));
    } finally {
      setPhase("idle");
    }
  }

  /** Open the drawer that renames or closes an account; `from` is the id of the control that opened it, which
   * gets focus back. */
  function openEdit(account: AccountView, from: string) {
    if (workflow.blocked() && mode() === "") return;
    workflow.discard();
    setOpener(from);
    setEditing(account);
    setEdits({ name: account.name, close: false, effectiveOn: today() });
    setMode("edit");
  }

  async function submitEdit() {
    const target = editing();
    if (!target || phase() === "working" || workflow.blocked()) return;
    const typed = edits();
    setPhase("working");
    try {
      await workflow.prepare("accounts.prepareChange", {
        accountId: target.id,
        name: typed.name.trim(),
        close: typed.close,
        effectiveOn: typed.effectiveOn,
      });
    } finally {
      setPhase("idle");
    }
  }

  /** Commit a plan whose warnings the person has read. */
  async function confirm() {
    if (phase() === "working") return;
    setPhase("working");
    try {
      await workflow.commit();
    } finally {
      setPhase("idle");
    }
  }

  function cancel() {
    if (phase() === "working") return;
    workflow.discard();
    finish();
  }

  return {
    mode,
    values,
    change,
    editing,
    edits,
    setEdits: (patch: Partial<EditAccountValues>) =>
      setEdits((previous) => ({ ...previous, ...patch })),
    stage,
    warnings,
    problems,
    suggested,
    taxChoices: (role: string) =>
      taxLineOptions(options.taxForms(), role).map(({ value, label }) => ({ value, label })),
    openNew,
    openEdit,
    submitNew,
    submitEdit,
    confirm,
    cancel,
    opener,
    resume: workflow.resume,
    pending: workflow.pending,
    busy: workflow.busy,
    blocked: workflow.blocked,
    /** What went wrong when there is no plan to read. */
    error: () => (workflow.plan() ? "" : workflow.error()),
  };
}

/** An account row as the table's views are made (see `views` in the page). */
function viewOf(
  account: AccountList["accounts"][number],
  booksBegan: string | null | undefined,
): AccountView {
  return {
    id: account.id,
    code: account.code,
    name: account.name,
    role: account.role,
    parentCode: null,
    openedOn: openedForDisplay(account.openedOn, booksBegan),
    closedOn: account.closedOn,
    balance: account.balance,
    tags: {},
  };
}
