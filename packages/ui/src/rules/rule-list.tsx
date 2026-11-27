import { Switch } from "@ark-ui/solid/switch";
import { createEffect, createMemo, createSignal, createUniqueId, For, on, Show } from "solid-js";
import { PageSkeleton } from "../skeleton";
import { Button } from "../button";
import { ArrowDown, ArrowUp } from "../icons";
import { Details, EmptyState } from "../kit";
import { Notice, Status } from "../notice";
import type { RulesLoadState, RuleRow } from "./types";
import { words } from "./words";
import { DateValue } from "../date-value";
import { formatCount } from "../format";

type Direction = "up" | "down";

const sameIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, at) => id === right[at]);

const author = (by: RuleRow["madeBy"]) =>
  by.kind === "agent" ? words.madeByAgent(by.name) : words.madeByPerson;

/** The rules in the order they are tried: the first enabled rule that matches a transaction decides, so
 * the order is the point of the screen. Each row says its name, when it applies and what it then suggests
 * in words, how often it was used, and has a switch. It is an ordered list a person can change from the
 * keyboard (Alt with the arrow keys on any control in a row, or the move buttons) and from a pointer, and
 * every move is announced. The rows stay in place while their data changes, so a move or a switch never
 * throws away what has focus. How each rule is doing (matched, decided, overridden) is measured by the
 * service over the transactions waiting in For review and posted lately; it is under "Performance" in the
 * row, and until it arrives the cell says so. */
export function RuleList(props: {
  rows: readonly RuleRow[];
  state?: RulesLoadState | undefined;
  /** Whether the counts beside each rule are measured, being measured, or could not be. */
  usage?: "ready" | "loading" | "unavailable" | undefined;
  days: number;
  newHref: string;
  /** A change to the order is being saved: the moves wait for it. */
  saving?: boolean | undefined;
  /** The rule being switched on or off. */
  busyId?: string | null | undefined;
  onMove: (id: string, direction: Direction) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onRetry?: (() => void) | undefined;
}) {
  const hintId = createUniqueId();
  const listId = createUniqueId();
  const byId = createMemo(() => new Map(props.rows.map((row) => [row.id, row] as const)));
  const ids = createMemo(() => props.rows.map((row) => row.id), [], { equals: sameIds });
  const [announcement, setAnnouncement] = createSignal("");
  let restore: { id: string; direction: Direction } | null = null;

  const moveId = (id: string, direction: Direction) => `${listId}-${id}-${direction}`;
  const focusMove = () => {
    if (!restore) return;
    const wanted = document.getElementById(moveId(restore.id, restore.direction));
    const other = document.getElementById(
      moveId(restore.id, restore.direction === "up" ? "down" : "up"),
    );
    const target =
      wanted instanceof HTMLButtonElement && !wanted.disabled
        ? wanted
        : other instanceof HTMLButtonElement && !other.disabled
          ? other
          : null;
    restore = null;
    target?.focus();
  };
  // Moving a row moves its nodes, and a moved node loses focus; hand it back once the order has
  // changed on the page.
  createEffect(on(ids, focusMove, { defer: true }));

  function move(id: string, direction: Direction) {
    if (props.saving) return;
    const at = ids().indexOf(id);
    const to = direction === "up" ? at - 1 : at + 1;
    if (at < 0 || to < 0 || to >= ids().length) return;
    restore = { id, direction };
    setAnnouncement(words.moved(byId().get(id)?.name ?? "", to + 1, ids().length));
    props.onMove(id, direction);
    // A move that changes nothing on the page (the order was refused) still returns focus.
    queueMicrotask(() => {
      if (restore && restore.id === id) focusMove();
    });
  }

  return (
    <section class="rt-rules-list" aria-label={words.listLabel}>
      <Show
        when={props.state !== "loading" && props.state !== "error"}
        fallback={
          props.state === "error" ? (
            <Notice title={words.listFailedTitle} tone="error" role="alert">
              <p>{words.listFailedBody}</p>
              <Show when={props.onRetry}>
                <Button variant="secondary" label={words.retry} onClick={() => props.onRetry?.()} />
              </Show>
            </Notice>
          ) : (
            <PageSkeleton shape="table" label={words.listLoading} />
          )
        }
      >
        <Show
          when={props.rows.length > 0}
          fallback={<EmptyState title={words.listEmptyTitle}>{words.listEmptyBody}</EmptyState>}
        >
          <p class="rt-sr-only" role="status" aria-live="polite">
            {props.saving ? words.savingOrder : announcement()}
          </p>
          <div class="rt-table-scroll">
            <table class="rt-table rt-rules-table" aria-describedby={hintId}>
              <caption class="rt-sr-only">{words.listLabel}</caption>
              <thead>
                <tr>
                  <th scope="col">{words.columnOrder}</th>
                  <th scope="col">{words.columnRule}</th>
                  <th scope="col">{words.columnWhen}</th>
                  <th scope="col">{words.columnThen}</th>
                  <th scope="col" class="amount">
                    {words.columnUsed}
                  </th>
                  <th scope="col">{words.columnSwitch}</th>
                </tr>
              </thead>
              <tbody>
                <For each={ids()}>
                  {(id, position) => (
                    <Show when={byId().get(id)}>
                      {(row) => (
                        <tr
                          data-enabled={row().enabled ? "true" : "false"}
                          onKeyDown={(event) => {
                            if (!event.altKey || event.ctrlKey || event.metaKey) return;
                            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                            event.preventDefault();
                            move(id, event.key === "ArrowUp" ? "up" : "down");
                          }}
                        >
                          <td class="rt-rules-order">
                            <span class="rt-rules-position">{position() + 1}</span>
                            <span class="rt-rules-move">
                              <Button
                                id={moveId(id, "up")}
                                iconOnly
                                variant="quiet"
                                size="sm"
                                label={words.moveUp(row().name)}
                                icon={<ArrowUp />}
                                disabled={position() === 0}
                                aria-disabled={props.saving ? true : undefined}
                                onClick={() => move(id, "up")}
                              />
                              <Button
                                id={moveId(id, "down")}
                                iconOnly
                                variant="quiet"
                                size="sm"
                                label={words.moveDown(row().name)}
                                icon={<ArrowDown />}
                                disabled={position() === ids().length - 1}
                                aria-disabled={props.saving ? true : undefined}
                                onClick={() => move(id, "down")}
                              />
                            </span>
                          </td>
                          <th scope="row" class="rt-rules-name" data-then={row().does}>
                            <a href={row().href}>
                              <bdi>{row().name}</bdi>
                            </a>
                            <small>
                              {author(row().madeBy)} · <DateValue value={row().changedOn} />
                            </small>
                            <Show when={row().note}>
                              <small class="rt-rules-note">
                                <bdi>{row().note}</bdi>
                              </small>
                            </Show>
                            <Show when={row().problems.length > 0}>
                              <span class="rt-rules-problems">
                                <Status tone="review">{words.stateAttention}</Status>
                                <ul>
                                  <For each={row().problems.slice(0, 2)}>
                                    {(problem) => (
                                      <li>
                                        <bdi>{problem}</bdi>
                                      </li>
                                    )}
                                  </For>
                                  <Show when={row().problems.length > 2}>
                                    <li>{words.moreProblems(row().problems.length - 2)}</li>
                                  </Show>
                                </ul>
                              </span>
                            </Show>
                          </th>
                          <td class="rt-rules-when">
                            <bdi>{row().when}</bdi>
                            <Show when={row().scopeNote}>
                              <small>
                                <bdi>{words.scopeLine(row().scopeNote ?? "")}</bdi>
                              </small>
                            </Show>
                          </td>
                          <td class="rt-rules-then">
                            <bdi>{row().does}</bdi>
                          </td>
                          <td class="amount rt-rules-used">
                            <Show
                              when={row().usage}
                              fallback={
                                <span
                                  class="rt-rules-unmeasured"
                                  title={
                                    props.usage === "loading"
                                      ? words.usageLoading
                                      : words.usageUnavailable
                                  }
                                >
                                  <span aria-hidden="true">–</span>
                                  <span class="rt-sr-only">
                                    {props.usage === "loading"
                                      ? words.usageLoading
                                      : words.usageUnavailable}
                                  </span>
                                </span>
                              }
                            >
                              {(usage) => (
                                <>
                                  {words.usedCount(usage().matched)}
                                  <Details summary={words.performance}>
                                    <dl class="rt-rules-performance">
                                      <div>
                                        <dt>{words.columnMatched}</dt>
                                        <dd>{formatCount(usage().matched)}</dd>
                                      </div>
                                      <div>
                                        <dt>{words.columnDecided}</dt>
                                        <dd>{formatCount(usage().decided)}</dd>
                                      </div>
                                      <div>
                                        <dt>{words.columnOverridden}</dt>
                                        <dd>{formatCount(usage().overridden)}</dd>
                                      </div>
                                      <div>
                                        <dt>{words.lastMatchedLabel}</dt>
                                        <dd>
                                          <Show when={usage().lastMatchedOn} fallback={words.never}>
                                            {(date) => <DateValue value={date()} />}
                                          </Show>
                                        </dd>
                                      </div>
                                    </dl>
                                    <p class="rt-hint">{words.usageLegend(props.days)}</p>
                                  </Details>
                                </>
                              )}
                            </Show>
                          </td>
                          <td class="rt-rules-state">
                            <Switch.Root
                              class="rt-rules-switch"
                              checked={row().enabled}
                              // The other rows wait while one is saved; the one just used stays enabled so it
                              // keeps focus (a disabled control hands focus back to the page).
                              disabled={
                                props.busyId !== null &&
                                props.busyId !== undefined &&
                                props.busyId !== id
                              }
                              onCheckedChange={(detail) => {
                                if (props.busyId !== null && props.busyId !== undefined) return;
                                props.onToggle(id, detail.checked);
                              }}
                            >
                              <Switch.Control class="rt-rules-switch-control">
                                <Switch.Thumb class="rt-rules-switch-thumb" />
                              </Switch.Control>
                              <Switch.Label class="rt-rules-switch-label">
                                <span aria-hidden="true">
                                  {row().enabled ? words.stateOn : words.stateOff}
                                </span>
                                <span class="rt-sr-only">{words.switchName(row().name)}</span>
                              </Switch.Label>
                              <Switch.HiddenInput role="switch" />
                            </Switch.Root>
                          </td>
                        </tr>
                      )}
                    </Show>
                  )}
                </For>
              </tbody>
            </table>
          </div>
          <p class="rt-hint" id={hintId}>
            {words.reorderHint}
          </p>
        </Show>
      </Show>
    </section>
  );
}
