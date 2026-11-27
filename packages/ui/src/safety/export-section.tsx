import { createUniqueId, For, Show } from "solid-js";
import { Button } from "../button";
import { countText, exactTime, relativeTime, sizeText } from "./format";
import { words } from "./words";
import type { ExportView, SafetyClock } from "./types";

/** The open export: what it is, a button to make one, the ones that exist and how to check or
 * rebuild one. The commands are shown as text because checking and rebuilding work on files, off the
 * service. */
export function ExportSection(props: {
  exports: readonly ExportView[];
  clock: SafetyClock;
  busy: boolean;
  running: boolean;
  onExport: () => void;
}) {
  const prefix = createUniqueId();
  return (
    <section class="rt-safe-export" aria-labelledby={`${prefix}-title`}>
      <h2 id={`${prefix}-title`}>{words.exportTitle}</h2>
      <p>{words.exportIntro}</p>
      <div>
        <Button
          label={words.exportNow}
          variant="secondary"
          pending={props.running}
          pendingLabel="Exporting…"
          disabled={props.busy && !props.running}
          aria-describedby={`${prefix}-hint`}
          onClick={props.onExport}
        />
        <p id={`${prefix}-hint`} class="rt-hint">
          {words.exportHint}
        </p>
      </div>
      <h3>{words.exportListTitle}</h3>
      <Show when={props.exports.length > 0} fallback={<p class="rt-hint">{words.exportEmpty}</p>}>
        <ul class="rt-safe-exports">
          <For each={props.exports}>
            {(item) => (
              <li>
                <span>
                  {exactTime(props.clock, item.createdAt)}{" "}
                  <small>({relativeTime(props.clock, item.createdAt)})</small>
                </span>
                <small>
                  {words.exportCounts(item.counts.journals, item.counts.accounts)} · ledger position{" "}
                  {countText(item.head.sequence, props.clock.locale)} · {sizeText(item.bytes)}
                </small>
                <bdi class="rt-safe-path">{item.location}</bdi>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <p class="rt-hint">{words.exportNotEncrypted}</p>
      <p>{words.exportCheck}</p>
      <pre class="rt-safe-code" tabindex="0">
        <code>shasum -a 256 -c SHA256SUMS</code>
      </pre>
      <p>{words.exportRebuild}</p>
      <pre class="rt-safe-code" tabindex="0">
        <code>rastrata import-export PATH_TO_EXPORT --to PATH_TO_NEW_DATABASE</code>
      </pre>
    </section>
  );
}

/** How to restore, said once and plainly: it is a command, with the service stopped. */
export function RestoreHelp() {
  return (
    <section class="rt-safe-restore" aria-labelledby="rt-safe-restore-title">
      <h2 id="rt-safe-restore-title">{words.restoreTitle}</h2>
      <p>{words.restoreBody}</p>
      <pre class="rt-safe-code" tabindex="0">
        <code>{words.restoreCommand}</code>
      </pre>
      <p class="rt-hint">{words.restoreAfter}</p>
    </section>
  );
}
