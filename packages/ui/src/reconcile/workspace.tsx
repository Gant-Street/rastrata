import { createMemo, createSignal, createUniqueId, For, onCleanup, onMount, Show } from "solid-js";
import { Button } from "../button";
import { Notice } from "../notice";
import { TextField } from "../text-field";
import { lineMatches } from "./format";
import { ReconcileLines } from "./lines";
import { ReconcileSummary } from "./summary";
import type {
  ReconcileAccountInfo,
  ReconcileFigures,
  ReconcileFinish,
  ReconcileLine,
  SaveState,
} from "./types";
import { words } from "./words";
import { formatMoneyAbsolute, isNegativeMoney } from "../format";

export type ReconcileWorkspaceProps = {
  account: ReconcileAccountInfo;
  figures: ReconcileFigures;
  lines: readonly ReconcileLine[];
  selected: ReadonlySet<string>;
  /** Exact counts and totals of the selected lines in each column, supplied by the parent. */
  columnTotals: {
    out: { count: number; total: string };
    in: { count: number; total: string };
  };
  state?: "ready" | "loading" | "error";
  saveState: SaveState;
  /** The books changed after the lines were read. */
  stale: boolean;
  /** Advisory notes from the service, shown before finishing. */
  warnings?: readonly string[];
  /** Freeze every control, for example while an original request must be resumed. */
  disabled?: boolean;
  finish: ReconcileFinish;
  onToggle: (ids: readonly string[], on: boolean) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  onEditStatement: () => void;
  onRefresh: () => void;
  onResume: () => void;
  onDiscard: () => void;
};

/** The reconcile screen's working area: the figures, a way to find a line, two columns of lines
 * to tick (money out and money in) and the one button that finishes. The parent owns the
 * selection, does the arithmetic and saves; this arranges it so that a person can do the whole
 * job from the keyboard. */
export function ReconcileWorkspace(props: ReconcileWorkspaceProps) {
  const uid = createUniqueId();
  const findId = `${uid}-find`;
  const hintId = `${uid}-finish-hint`;
  const [query, setQuery] = createSignal("");
  const [announcement, setAnnouncement] = createSignal("");
  let root: HTMLDivElement | undefined;

  const outAll = createMemo(() => props.lines.filter((line) => isNegativeMoney(line.amount)));
  const inAll = createMemo(() => props.lines.filter((line) => !isNegativeMoney(line.amount)));
  const outShown = createMemo(() => outAll().filter((line) => lineMatches(line, query())));
  const inShown = createMemo(() => inAll().filter((line) => lineMatches(line, query())));
  const kind = () => props.account.kind;
  const frozen = () => props.disabled === true || props.saveState === "uncertain";

  const onFindKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && query()) {
      event.preventDefault();
      setQuery("");
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const shown = [...outShown(), ...inShown()];
    if (shown.length === 0) {
      setAnnouncement(words.findNone);
      return;
    }
    if (shown.length === 1 && !frozen()) {
      const line = shown[0] as ReconcileLine;
      const on = !props.selected.has(line.id);
      props.onToggle([line.id], on);
      const what = `${formatMoneyAbsolute(line.amount)} ${line.description}`;
      setAnnouncement((on ? words.findTicked : words.findUnticked)(what));
      setQuery("");
      return;
    }
    root?.querySelector<HTMLInputElement>('tbody input[data-index="0"]')?.focus();
  };

  // "/" finds a line, the way it finds an entry in the journal register.
  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable='true'], dialog, [role='dialog']",
        )
      )
        return;
      event.preventDefault();
      document.getElementById(findId)?.focus();
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  const status = () => {
    if (props.saveState === "saving") return words.saving;
    if (props.saveState === "failed") return words.failed;
    if (props.saveState === "saved") return words.saved;
    return "";
  };

  return (
    <div class="rt-recon-workspace" ref={root}>
      <ReconcileSummary figures={props.figures} />
      <Show when={props.stale}>
        <Notice title={words.staleTitle} tone="review">
          <p>{words.staleBody}</p>
          <Button
            variant="secondary"
            label={words.refresh}
            disabled={props.saveState === "saving"}
            onClick={props.onRefresh}
          />
        </Notice>
      </Show>
      <Show when={props.saveState === "uncertain"}>
        <Notice title={words.uncertainTitle} tone="review" role="status">
          <p>{words.uncertainBody}</p>
          <Button label={words.resume} onClick={props.onResume} />
        </Notice>
      </Show>
      <Show when={(props.warnings ?? []).length > 0}>
        <Notice title={words.warningsTitle} tone="review">
          <ul>
            <For each={props.warnings}>{(warning) => <li>{warning}</li>}</For>
          </ul>
        </Notice>
      </Show>
      <div class="rt-recon-toolbar">
        <TextField
          id={findId}
          label={words.find}
          type="search"
          autocomplete="off"
          hint={words.findHint}
          value={query()}
          disabled={props.state === "loading" || props.state === "error"}
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={onFindKey}
        />
        <div class="rt-recon-toolbar-actions">
          <Button
            variant="secondary"
            label={words.selectEvery}
            disabled={frozen() || props.lines.length === 0}
            onClick={props.onSelectAll}
          />
          <Button
            variant="secondary"
            label={words.clearEvery}
            disabled={frozen() || props.figures.selectedCount === 0}
            onClick={props.onClearAll}
          />
          <Button
            variant="quiet"
            label={words.editStatement}
            disabled={frozen()}
            onClick={props.onEditStatement}
          />
          <Show when={!props.stale}>
            <Button
              variant="quiet"
              label={words.refresh}
              disabled={frozen() || props.saveState === "saving"}
              onClick={props.onRefresh}
            />
          </Show>
        </div>
      </div>
      <p class="rt-recon-save" role="status" data-state={props.saveState}>
        {status()}
        <Show when={query().trim() !== ""}>
          {" "}
          {words.findCount(outShown().length + inShown().length, props.lines.length)}
        </Show>
      </p>
      <div class="rt-recon-columns">
        <ReconcileLines
          title={words.moneyOut[kind()]}
          noun={words.noun.out[kind()]}
          lines={outShown()}
          totalCount={outAll().length}
          selected={props.selected}
          selectedCount={props.columnTotals.out.count}
          selectedTotal={props.columnTotals.out.total}
          disabled={frozen()}
          {...(props.state ? { state: props.state } : {})}
          onToggle={props.onToggle}
        />
        <ReconcileLines
          title={words.moneyIn[kind()]}
          noun={words.noun.in[kind()]}
          lines={inShown()}
          totalCount={inAll().length}
          selected={props.selected}
          selectedCount={props.columnTotals.in.count}
          selectedTotal={props.columnTotals.in.total}
          disabled={frozen()}
          {...(props.state ? { state: props.state } : {})}
          onToggle={props.onToggle}
        />
      </div>
      <p class="rt-hint">{words.keyboard}</p>
      <div class="rt-recon-actions">
        <Button
          label={words.finish}
          disabled={props.finish.disabled}
          aria-describedby={hintId}
          onClick={props.finish.onFinish}
        />
        <p id={hintId} class="rt-hint">
          {props.finish.hint}
        </p>
        <Button
          variant="quiet"
          label={words.discard}
          disabled={props.saveState === "saving"}
          onClick={props.onDiscard}
        />
      </div>
      <p class="rt-sr-only" role="status" aria-live="polite">
        {announcement()}
      </p>
    </div>
  );
}
