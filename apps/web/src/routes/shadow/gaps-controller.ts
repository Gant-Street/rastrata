import type { GapFilter, GapKind, GapsScreenProps } from "@rastrata/ui/shadow/types";
import { batch, createMemo, createSignal, onMount } from "solid-js";
import { ApplicationRequestError, type BrowserApplicationClient } from "../../application-client";
import { createLoader } from "../../loader.ts";
import { isNoBook } from "./no-book";
import { gapViews, stableGaps } from "./xero-logic";

/** The workflows this screen retains writes under, so a lost reply is resumed, never repeated. */
export const GAP_ADD_WORKFLOW = "shadow:gap-add";
export const GAP_UPDATE_WORKFLOW = "shadow:gap-update";
const WORKFLOWS = [GAP_ADD_WORKFLOW, GAP_UPDATE_WORKFLOW] as const;

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message ? cause.message : fallback;
const isUncertain = (cause: unknown): boolean =>
  cause instanceof ApplicationRequestError && cause.uncertain;

/** The gap log: the list the service holds, a form to add a gap, and closing or reopening one. The
 * screen renders; this decides. A gap is closed only with a note, which the service also requires. */
export function createGapsController(client: BrowserApplicationClient) {
  const keepSame = stableGaps();
  const [filter, setFilterRaw] = createSignal<GapFilter>("open");
  const list = createLoader(() => client.read("gaps.list", { status: filter() }));

  const [title, setTitle] = createSignal("");
  const [detail, setDetail] = createSignal("");
  const [kind, setKind] = createSignal<GapKind>("other");
  const [titleError, setTitleError] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const [added, setAdded] = createSignal(false);
  const [addError, setAddError] = createSignal("");

  const [busyId, setBusyId] = createSignal<number | null>(null);
  const [actionError, setActionError] = createSignal<{ id: number; message: string } | null>(null);
  const [pageError, setPageError] = createSignal("");

  const [pending, setPending] = createSignal<string | null>(null);
  const [resuming, setResuming] = createSignal(false);
  const syncPending = () => {
    try {
      setPending(WORKFLOWS.find((workflow) => client.pending(workflow) !== null) ?? null);
    } catch {
      setPending(null);
    }
  };
  onMount(syncPending);

  function setFilter(next: GapFilter) {
    if (next === filter()) return;
    setFilterRaw(next);
    void list.reload();
  }

  async function add() {
    if (adding()) return;
    if (title().trim() === "") {
      setTitleError("Give the gap a title.");
      return;
    }
    setTitleError("");
    setAddError("");
    setAdded(false);
    setAdding(true);
    try {
      await client.write(
        "gaps.add",
        {
          title: title().trim(),
          kind: kind(),
          ...(detail().trim() !== "" ? { detail: detail().trim() } : {}),
        },
        GAP_ADD_WORKFLOW,
      );
      batch(() => {
        setTitle("");
        setDetail("");
        setKind("other");
        setAdded(true);
      });
      await list.reload();
    } catch (cause) {
      if (!isUncertain(cause)) setAddError(messageOf(cause, "The gap could not be added."));
    } finally {
      syncPending();
      setAdding(false);
    }
  }

  async function update(id: number, status: "open" | "closed", resolution?: string) {
    if (busyId() !== null) return;
    setBusyId(id);
    setActionError(null);
    try {
      await client.write(
        "gaps.update",
        { id, status, ...(resolution !== undefined ? { resolution } : {}) },
        GAP_UPDATE_WORKFLOW,
      );
      await list.reload();
    } catch (cause) {
      if (!isUncertain(cause))
        setActionError({ id, message: messageOf(cause, "That gap could not be changed.") });
    } finally {
      syncPending();
      setBusyId(null);
    }
  }

  async function resume() {
    const workflow = pending();
    if (!workflow || resuming()) return;
    setResuming(true);
    setPageError("");
    try {
      const completed = await client.resume(workflow);
      if (completed.name === "gaps.add") setAdded(true);
      await list.reload();
    } catch (cause) {
      if (!isUncertain(cause)) setPageError(messageOf(cause, "The request could not be resumed."));
    } finally {
      syncPending();
      setResuming(false);
    }
  }

  const gapList = createMemo(() => {
    const read = list.value();
    return read ? keepSame(gapViews(read)) : [];
  });
  const props = createMemo(
    (): GapsScreenProps => ({
      state: list.error() !== undefined ? "error" : list.value() ? "ready" : "loading",
      noBook: isNoBook(list.error()),
      onRetry: () => void list.reload(),
      focusTitle: true,
      ...(pageError() ? { error: pageError() } : {}),
      uncertain: pending() ? { resuming: resuming() } : null,
      onResume: () => void resume(),
      filter: filter(),
      counts: { open: list.value()?.open ?? 0, closed: list.value()?.closed ?? 0 },
      onFilter: setFilter,
      gaps: gapList(),
      busyId: busyId(),
      actionError: actionError(),
      onClose: (id, resolution) => void update(id, "closed", resolution),
      onReopen: (id) => void update(id, "open"),
      add: {
        title: title(),
        detail: detail(),
        kind: kind(),
        ...(titleError() ? { titleError: titleError() } : {}),
        pending: adding(),
        done: added(),
        ...(addError() ? { error: addError() } : {}),
        onTitle: (value) =>
          batch(() => {
            setTitle(value);
            setTitleError("");
            setAdded(false);
          }),
        onDetail: setDetail,
        onKind: setKind,
        onSubmit: () => void add(),
      },
    }),
  );
  return { props };
}
