import { createUniqueId, Show } from "solid-js";
import { Button } from "../button";
import { words } from "./words";
import type { JobKind } from "./types";

/**
 * The two things a person can do with a backup that is already made: check it, and test a restore. (Making
 * one is the page's own button, beside its title.) Each button is a real button with its explanation
 * under it, tied by `aria-describedby`. While any job runs the others wait (one job at a time) and say
 * why; the one this page started shows as pending. Nothing here starts work by itself.
 */
export function BackupActions(props: {
  /** A job is running, here or elsewhere. */
  busy: boolean;
  hasBackup: boolean;
  /** The job this page started, so its button shows as working. */
  running: JobKind | null;
  onVerify: () => void;
  onDrill: () => void;
}) {
  const prefix = createUniqueId();
  const waiting = (kind: JobKind) => props.busy && props.running !== kind;
  const unavailable = (needsBackup: boolean) => needsBackup && !props.hasBackup;
  return (
    <section class="rt-safe-actions" aria-labelledby={`${prefix}-title`}>
      <h2 id={`${prefix}-title`}>{words.actionsTitle}</h2>
      <ul>
        <li>
          <Button
            label={words.verify}
            variant="secondary"
            pending={props.running === "verify"}
            pendingLabel="Checking…"
            disabled={waiting("verify") || unavailable(true)}
            aria-describedby={`${prefix}-verify`}
            onClick={props.onVerify}
          />
          <p id={`${prefix}-verify`} class="rt-hint">
            {words.verifyHint}
          </p>
        </li>
        <li>
          <Button
            label={words.drill}
            variant="secondary"
            pending={props.running === "drill"}
            pendingLabel="Testing…"
            disabled={waiting("drill") || unavailable(true)}
            aria-describedby={`${prefix}-drill`}
            onClick={props.onDrill}
          />
          <p id={`${prefix}-drill`} class="rt-hint">
            {words.drillHint}
          </p>
        </li>
      </ul>
      <Show when={props.busy && props.running === null}>
        <p class="rt-hint" role="status">
          {words.busy}
        </p>
      </Show>
      <Show when={!props.hasBackup}>
        <p class="rt-hint">{words.needsBackup}</p>
      </Show>
    </section>
  );
}
