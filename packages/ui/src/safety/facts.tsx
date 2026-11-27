import { createUniqueId, Show } from "solid-js";
import { durationText, exactTime, relativeTime, sizeText } from "./format";
import { words } from "./words";
import type { SafetyClock, SafetyStatusView } from "./types";

/** The few facts that say where the books stand: the newest backup, the newest verified one, the
 * last restore test, whether the automatic ones run, and where the files are. */
export function BackupFacts(props: { status: SafetyStatusView; clock: SafetyClock }) {
  const titleId = createUniqueId();
  const status = () => props.status;
  const when = (iso: string) =>
    `${exactTime(props.clock, iso)} (${relativeTime(props.clock, iso)})`;
  return (
    <section class="rt-safe-facts" aria-labelledby={titleId}>
      <h2 id={titleId}>{words.factsTitle}</h2>
      <dl>
        <div>
          <dt>{words.newestBackup}</dt>
          <dd>
            <Show when={status().latest} fallback={words.none}>
              {(latest) => (
                <>
                  <span>{when(latest().createdAt)}</span>
                  <small>
                    {words.reasonLabel(latest().reason)} · {sizeText(latest().bytes)}
                    <Show when={status().changesSinceLatest !== null}>
                      {" · "}
                      {words.changesSince(status().changesSinceLatest as number)}
                    </Show>
                  </small>
                </>
              )}
            </Show>
          </dd>
        </div>
        <div>
          <dt>{words.lastVerified}</dt>
          <dd>
            <Show when={status().latestVerified} fallback={words.none}>
              {(verified) => (
                <>
                  <span>
                    {verified().verification
                      ? when(verified().verification?.verifiedAt ?? "")
                      : words.none}
                  </span>
                  <small>
                    {words.backupMade(relativeTime(props.clock, verified().createdAt))}
                    <Show when={verified().verification?.replayMs != null}>
                      {" · "}
                      {words.replayTook(durationText(verified().verification?.replayMs ?? 0))}
                    </Show>
                  </small>
                </>
              )}
            </Show>
          </dd>
        </div>
        <div>
          <dt>{words.lastRestoreTest}</dt>
          <dd>
            <Show when={status().lastDrill} fallback={words.neverTested}>
              {(drill) => (
                <>
                  <span>
                    {drill().passed
                      ? words.testPassed(relativeTime(props.clock, drill().ranAt))
                      : words.testFailed(relativeTime(props.clock, drill().ranAt))}
                  </span>
                  <small>
                    {words.testCompared(drill().accountsCompared, drill().changesSince)}
                    <Show when={drill().replayMs != null}>
                      {" · "}
                      {words.replayTook(durationText(drill().replayMs ?? 0))}
                    </Show>
                  </small>
                </>
              )}
            </Show>
          </dd>
        </div>
        <div>
          <dt>{words.automatic}</dt>
          <dd>
            <span>
              {!status().settings.enabled
                ? words.autoOff
                : status().automatic.scheduler === "not_running"
                  ? words.autoNotRunning
                  : words.autoOn(status().settings.intervalHours)}
            </span>
            <Show when={status().automatic.lastRunAt}>
              {(at) => (
                <small>
                  {words.lastRun(
                    relativeTime(props.clock, at()),
                    status().automatic.lastRunOk === true,
                  )}
                </small>
              )}
            </Show>
          </dd>
        </div>
        <div>
          <dt>{words.folder}</dt>
          <dd>
            <bdi class="rt-safe-path">{status().directory}</bdi>
            <small>{words.folderNote}</small>
          </dd>
        </div>
      </dl>
    </section>
  );
}
