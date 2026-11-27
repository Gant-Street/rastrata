import type { Reconciliation } from "@rastrata/application/client-contracts";
import type { SaveState } from "@rastrata/ui";
import { createMemo, createSignal, onCleanup } from "solid-js";
import { ApplicationRequestError, BrowserApplicationClient } from "../../application-client";
import { centsOf, columnTotals, figuresFor } from "./figures";

/** Everything a draft reconciliation needs on the screen: the lines the service returned, the
 * ticks the person has made (shown at once, in exact cents), and how those ticks get saved.
 *
 * Saving works by difference. After a pause, the controller compares the ticks on screen with the
 * ticks the service last confirmed and sends only what changed (or "all" and "none" when a
 * thousand lines move at once), one request at a time, each under the draft's version and a
 * retained identity. If a reply is lost the controller stops and says so: it never resends under
 * a new identity, and it never shows an unconfirmed tick as saved. */
export function createDraft(id: string, initial?: Reconciliation) {
  const client = new BrowserApplicationClient(window.localStorage);
  const key = `reconcile:${id}`;
  const [draft, setDraft] = createSignal<Reconciliation | null>(null);
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [loadState, setLoadState] = createSignal<"loading" | "ready" | "error">("loading");
  const [saveState, setSaveState] = createSignal<SaveState>("saved");
  const [notice, setNotice] = createSignal("");
  let confirmed: ReadonlySet<string> = new Set();
  let version = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | null = null;
  let lastProgress: { difference: string; selectedCount: number } | null = null;
  onCleanup(() => clearTimeout(timer));

  const cents = createMemo(() => centsOf(draft()?.lines ?? []));
  const figures = createMemo(() => {
    const view = draft();
    return view ? figuresFor(view, cents(), selected()) : null;
  });
  const totals = createMemo(() => columnTotals(draft()?.lines ?? [], cents(), selected()));

  function apply(view: Reconciliation) {
    const ids = new Set(view.lines.filter((line) => line.selected).map((line) => line.postingId));
    version = view.version;
    confirmed = ids;
    lastProgress = null;
    setDraft(view);
    setSelected(ids);
  }

  const retained = () => {
    try {
      return client.pending(key) !== null;
    } catch {
      return true;
    }
  };

  async function load() {
    setLoadState((state) => (state === "ready" ? state : "loading"));
    try {
      apply(await client.read("reconcile.get", { id }));
      setLoadState("ready");
      setSaveState(retained() ? "uncertain" : "saved");
    } catch {
      setLoadState("error");
    }
  }

  /** A write that did not succeed. A lost reply is uncertain; anything else is a plain
   * refusal, after which the screen shows what the service actually holds. */
  async function failed(cause: unknown) {
    if (cause instanceof ApplicationRequestError && cause.uncertain) {
      setSaveState("uncertain");
      return;
    }
    setNotice(
      cause instanceof Error
        ? `Your last change was not saved: ${cause.message}`
        : "Your last change was not saved.",
    );
    await load();
    setSaveState(retained() ? "uncertain" : "saved");
  }

  function flush(): Promise<void> {
    running ??= (async () => {
      try {
        for (;;) {
          const view = draft();
          if (!view) return;
          const local = selected();
          const add = [...local].filter((postingId) => !confirmed.has(postingId));
          const remove = [...confirmed].filter((postingId) => !local.has(postingId));
          if (add.length === 0 && remove.length === 0) break;
          const input: { reset?: "all" | "none"; select?: string[]; deselect?: string[] } =
            local.size === view.lines.length && add.length > 500
              ? { reset: "all" }
              : local.size === 0 && remove.length > 500
                ? { reset: "none" }
                : {
                    ...(add.length ? { select: add.slice(0, 500) } : {}),
                    ...(remove.length ? { deselect: remove.slice(0, 500) } : {}),
                  };
          const result = await client.write(
            "reconcile.setCleared",
            { id, expectedVersion: version, ...input },
            key,
          );
          version = result.version;
          lastProgress = { difference: result.difference, selectedCount: result.selectedCount };
          if (input.reset === "all") confirmed = new Set(view.lines.map((line) => line.postingId));
          else if (input.reset === "none") confirmed = new Set();
          else {
            const next = new Set(confirmed);
            for (const postingId of input.select ?? []) next.add(postingId);
            for (const postingId of input.deselect ?? []) next.delete(postingId);
            confirmed = next;
          }
        }
        setSaveState("saved");
        // The screen's difference and the service's must agree to the cent.
        const progress = lastProgress;
        const mine = figures();
        if (
          progress &&
          mine &&
          (progress.difference !== mine.difference || progress.selectedCount !== selected().size)
        ) {
          setNotice(
            `The service reports a difference of ${progress.difference} and this screen ${mine.difference}. The reconciliation was reloaded from the service.`,
          );
          await load();
        }
      } catch (cause) {
        await failed(cause);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  function queueFlush() {
    setSaveState((state) => (state === "uncertain" ? state : "saving"));
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), 150);
  }

  async function settle() {
    clearTimeout(timer);
    await flush();
  }

  /** Run a write for the caller to report on. A lost reply stops the screen (resume is the only
   * way forward); any other failure is the caller's to show, and the screen stays as it was. */
  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      const result = await work();
      setSaveState("saved");
      return result;
    } catch (cause) {
      setSaveState(
        cause instanceof ApplicationRequestError && cause.uncertain ? "uncertain" : "saved",
      );
      throw cause;
    }
  }

  if (initial) {
    apply(initial);
    setLoadState("ready");
    setSaveState(retained() ? "uncertain" : "saved");
  } else void load();

  return {
    draft,
    selected,
    figures,
    totals,
    loadState,
    saveState,
    notice,
    dismissNotice: () => setNotice(""),
    load,
    toggle(ids: readonly string[], on: boolean) {
      if (saveState() === "uncertain" || !draft()) return;
      setSelected((current) => {
        const next = new Set(current);
        for (const postingId of ids) {
          if (on) next.add(postingId);
          else next.delete(postingId);
        }
        return next;
      });
      queueFlush();
    },
    setAll(on: boolean) {
      const view = draft();
      if (saveState() === "uncertain" || !view) return;
      setSelected(new Set<string>(on ? view.lines.map((line) => line.postingId) : []));
      queueFlush();
    },
    /** Resend the retained request exactly as it was, then show what the service holds. */
    async resume() {
      try {
        await client.resume(key);
      } catch (cause) {
        await failed(cause);
        return;
      }
      await load();
    },
    /** Correct the statement, or (with the same values) refresh the lines from the books. */
    async restate(statementDate: string, statementBalance: string) {
      await settle();
      if (saveState() !== "saved") return;
      setSaveState("saving");
      await guarded(async () => {
        apply(
          await client.write(
            "reconcile.setStatement",
            { id, expectedVersion: version, statementDate, statementBalance },
            key,
          ),
        );
      });
    },
    async finish(): Promise<Reconciliation> {
      await settle();
      if (saveState() !== "saved") throw new Error("Your last change is not saved yet.");
      return guarded(() =>
        client.write("reconcile.complete", { id, expectedVersion: version }, key),
      );
    },
    async discard() {
      await settle();
      if (saveState() !== "saved") throw new Error("Your last change is not saved yet.");
      await guarded(() => client.write("reconcile.discard", { id, expectedVersion: version }, key));
    },
  };
}
