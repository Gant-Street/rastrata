import { createUniqueId, onMount, Show } from "solid-js";
import { Button } from "../button";
import { TriangleAlert } from "../icons";
import { CheckList } from "./checks";
import { durationText, exactTime, sizeText } from "./format";
import { words } from "./words";
import type { JobResultView, SafetyClock } from "./types";

const passed = (result: JobResultView): boolean | null =>
  result.state === "failed"
    ? false
    : result.kind === "verify"
      ? result.passed
      : result.kind === "drill"
        ? result.drill.passed
        : null;

const title = (result: JobResultView): string => {
  if (result.state === "failed") return words.jobFailed(result.message);
  switch (result.kind) {
    case "backup":
      return words.resultBackup;
    case "verify":
      return result.passed ? words.resultVerifyPassed : words.resultVerifyFailed;
    case "drill":
      return result.drill.passed ? words.resultDrillPassed : words.resultDrillFailed;
    case "export":
      return words.resultExport;
  }
};

/**
 * What a finished job found. It takes focus when it appears, because the person asked for it and
 * is waiting for it: a keyboard or screen-reader user lands on the answer, which is announced by the
 * move itself rather than by a live region that would read the whole list again. A failure or a
 * check that did not pass says what to do next.
 */
export function BackupResult(props: {
  result: JobResultView;
  clock: SafetyClock;
  onDismiss?: () => void;
}) {
  const titleId = createUniqueId();
  let heading: HTMLHeadingElement | undefined;
  onMount(() => queueMicrotask(() => heading?.focus()));
  const ok = () => passed(props.result) !== false;
  return (
    <section class="rt-safe-result" data-tone={ok() ? "info" : "error"} aria-labelledby={titleId}>
      <h2 id={titleId} tabindex="-1" ref={(element) => (heading = element)}>
        <Show when={!ok()}>
          <TriangleAlert class="rt-safe-summary-icon" aria-hidden="true" />
        </Show>
        {title(props.result)}
      </h2>
      {(() => {
        const result = props.result;
        if (result.state === "failed") return <p class="rt-hint">{words.nextAfterFail}</p>;
        if (result.kind === "backup")
          return (
            <p>
              {exactTime(props.clock, result.backup.createdAt)} · {sizeText(result.backup.bytes)} ·{" "}
              {words.reasonLabel(result.backup.reason)}. Check it next: a backup that has not been
              checked may not restore.
            </p>
          );
        if (result.kind === "export")
          return (
            <>
              <p>{words.resultExportBody(result.export.location)}</p>
              <p class="rt-hint">{words.exportNotEncrypted}</p>
            </>
          );
        if (result.kind === "verify")
          return (
            <>
              <p>
                {result.replayMs !== null
                  ? words.replayTook(durationText(result.replayMs))
                  : durationText(result.durationMs)}
              </p>
              <CheckList checks={result.checks} />
              <Show when={!result.passed}>
                <p class="rt-hint">{words.nextAfterFail}</p>
              </Show>
            </>
          );
        return (
          <>
            <p>
              {words.testCompared(result.drill.accountsCompared, result.drill.changesSince)}.{" "}
              {result.drill.replayMs !== null
                ? words.replayTook(durationText(result.drill.replayMs))
                : ""}
            </p>
            <CheckList checks={result.drill.checks} />
            <Show when={result.drill.mismatches.length > 0}>
              <p>
                {result.drill.mismatches.length} account balance
                {result.drill.mismatches.length === 1 ? "" : "s"} differ:{" "}
                {result.drill.mismatches
                  .slice(0, 5)
                  .map(
                    (item) => `${item.accountId} (yours ${item.live}, restored ${item.restored})`,
                  )
                  .join("; ")}
                .
              </p>
            </Show>
            <Show when={!result.drill.passed}>
              <p class="rt-hint">{words.nextAfterFail}</p>
            </Show>
          </>
        );
      })()}
      <Button label={words.dismiss} variant="quiet" onClick={() => props.onDismiss?.()} />
    </section>
  );
}
