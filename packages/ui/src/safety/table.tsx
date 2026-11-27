import { createSignal, createUniqueId, For, Show } from "solid-js";
import { Button } from "../button";
import { CheckList } from "./checks";
import { countText, exactTime, relativeTime, sizeText } from "./format";
import { words } from "./words";
import type { BackupView, SafetyClock } from "./types";
import { Details } from "../kit/details";

/** Newest backups shown before "show all": a person looks at the last few, and a long history is
 * one button away. */
const PREVIEW = 10;

function CheckCell(props: { backup: BackupView; clock: SafetyClock }) {
  const verification = () => props.backup.verification;
  return (
    <Show
      when={props.backup.fileState === "present"}
      fallback={<span data-state="missing">{words.checkLine.missing}</span>}
    >
      <Show when={verification()} fallback={<span>{words.checkLine.never}</span>}>
        {(found) => (
          <>
            <Details
              class={`rt-safe-row-details${found().passed ? "" : " rt-safe-row-failed"}`}
              plain
              flush
              defaultOpen={!found().passed}
              summary={
                <>
                  {found().passed ? words.checkLine.passed : words.checkLine.failed},{" "}
                  {relativeTime(props.clock, found().verifiedAt)}
                </>
              }
            >
              <CheckList checks={found().checks} />
            </Details>
          </>
        )}
      </Show>
    </Show>
  );
}

/**
 * The backups, newest first. Each row says how it was made, how big it is, how far the ledger had got
 * and whether it has been checked, with the checks one disclosure away (open by default when one
 * failed). A row's actions are real buttons that name their backup. Money is not shown here; sizes
 * and positions are tabular. The table scrolls inside its own container on a narrow screen.
 */
export function BackupTable(props: {
  backups: readonly BackupView[];
  unrecorded?: readonly string[];
  clock: SafetyClock;
  /** A job is running: the row actions wait. */
  busy?: boolean;
  onVerify?: (id: string) => void;
  onDrill?: (id: string) => void;
}) {
  const titleId = createUniqueId();
  const [all, setAll] = createSignal(false);
  const shown = () => (all() ? props.backups : props.backups.slice(0, PREVIEW));
  return (
    <section class="rt-safe-list" aria-labelledby={titleId}>
      <h2 id={titleId}>{words.listTitle}</h2>
      <Show
        when={props.backups.length > 0}
        fallback={
          <div class="rt-safe-empty">
            <p>
              <strong>{words.listEmpty}</strong>
            </p>
            <p class="rt-hint">{words.listEmptyBody}</p>
          </div>
        }
      >
        <section
          class="rt-table-scroll"
          aria-label={words.scrollLabel}
          // The region scrolls sideways on a narrow screen, so a keyboard user must be able to focus it.
          tabindex="0"
        >
          <table class="rt-table rt-safe-table">
            <caption class="rt-sr-only">{words.caption}</caption>
            <thead>
              <tr>
                <th scope="col">{words.colMade}</th>
                <th scope="col">{words.colWhy}</th>
                <th scope="col" class="amount">
                  {words.colSize}
                </th>
                <th scope="col" class="amount" title={words.positionHelp}>
                  {words.colPosition}
                </th>
                <th scope="col">{words.colCheck}</th>
                <th scope="col">{words.colActions}</th>
              </tr>
            </thead>
            <tbody>
              <For each={shown()}>
                {(backup) => (
                  <tr data-state={backup.fileState}>
                    <th scope="row">
                      <span>{exactTime(props.clock, backup.createdAt)}</span>
                      <small>{relativeTime(props.clock, backup.createdAt)}</small>
                    </th>
                    <td>{words.reasonLabel(backup.reason)}</td>
                    <td class="amount">{sizeText(backup.bytes)}</td>
                    <td class="amount">{countText(backup.head.sequence, props.clock.locale)}</td>
                    <td>
                      <CheckCell backup={backup} clock={props.clock} />
                    </td>
                    <td>
                      <div class="rt-safe-row-actions">
                        <Button
                          label="Check"
                          size="sm"
                          variant="secondary"
                          disabled={props.busy === true || backup.fileState === "missing"}
                          aria-label={words.verifyRow(relativeTime(props.clock, backup.createdAt))}
                          onClick={() => props.onVerify?.(backup.id)}
                        />
                        <Button
                          label="Test restore"
                          size="sm"
                          variant="secondary"
                          disabled={props.busy === true || backup.fileState === "missing"}
                          aria-label={words.drillRow(relativeTime(props.clock, backup.createdAt))}
                          onClick={() => props.onDrill?.(backup.id)}
                        />
                      </div>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </section>
        <Show when={props.backups.length > PREVIEW}>
          <Button
            label={all() ? words.showFewer : words.showAll(props.backups.length)}
            variant="quiet"
            aria-expanded={all()}
            onClick={() => setAll(!all())}
          />
        </Show>
      </Show>
      <Show when={(props.unrecorded?.length ?? 0) > 0}>
        <div class="rt-safe-unrecorded">
          <h3>{words.unrecordedTitle}</h3>
          <p class="rt-hint">{words.unrecordedBody}</p>
          <ul>
            <For each={props.unrecorded ?? []}>
              {(name) => (
                <li>
                  <bdi class="rt-safe-path">{name}</bdi>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
    </section>
  );
}
