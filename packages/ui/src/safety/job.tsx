import { createMemo, createUniqueId, Show } from "solid-js";
import { Button } from "../button";
import { Progress } from "../progress";
import { durationText, percent } from "./format";
import { words } from "./words";
import type { JobView } from "./types";

/**
 * A job in progress, told honestly: what it is doing now, how far it has got when that is known, how
 * long it has run, and an estimate of what is left only when there is enough progress to draw one,
 * always called an estimate. A replay costs about a second for every thousand entries, and much more
 * for a book made by an earlier version, whose cost grows with the square of its progress; the screen
 * does not know which book it is, so the note says both and the service's estimate (which does) says
 * what is left. Nothing here invents a percentage: with no known total the bar is indeterminate.
 *
 * Screen readers hear the stage when it changes and the progress every tenth, not every tick.
 */
export function BackupJobProgress(props: {
  job: JobView;
  /** Started by the automatic backups or the command line, not by this page. */
  elsewhere?: boolean;
  /** The connection dropped and the job's outcome is not known. */
  uncertain?: boolean;
  onReconnect?: () => void;
}) {
  const titleId = createUniqueId();
  const pct = () => percent(props.job.done, props.job.total);
  const announcement = createMemo(() => {
    const tenth = pct() === null ? "" : `, ${Math.floor((pct() ?? 0) / 10) * 10} percent`;
    return `${words.jobTitle(props.job.kind)}: ${props.job.stage}${tenth}`;
  });
  const replaying = () => /replay/i.test(props.job.stage);
  return (
    <section class="rt-safe-job" aria-labelledby={titleId} aria-busy={!props.uncertain}>
      <h2 id={titleId}>{words.jobTitle(props.job.kind)}</h2>
      <Progress label={props.job.stage || words.jobStarting} value={pct()} showValue />
      <p class="rt-safe-job-line">
        <Show when={props.job.done !== null && props.job.total !== null}>
          <span>{words.jobProgress(props.job.done ?? 0, props.job.total ?? 0)}</span>
        </Show>
        <span>{words.jobElapsed(durationText(props.job.elapsedMs))}</span>
        <Show when={props.job.remainingMs !== null}>
          <span>{words.jobRemaining(durationText(props.job.remainingMs ?? 0))}</span>
        </Show>
      </p>
      <p class="rt-hint">{props.elsewhere ? words.jobFromElsewhere : words.jobStays}</p>
      <Show when={replaying() || props.job.kind === "verify" || props.job.kind === "drill"}>
        <p class="rt-hint">{words.jobReplayNote}</p>
      </Show>
      <Show when={props.uncertain}>
        <p role="alert" class="rt-safe-job-uncertain">
          {words.jobUncertain}
        </p>
        <Button label={words.reconnect} variant="secondary" onClick={() => props.onReconnect?.()} />
      </Show>
      <p class="rt-sr-only" role="status" aria-live="polite">
        {announcement()}
      </p>
    </section>
  );
}
