import { createUniqueId, Show } from "solid-js";
import { Button } from "../button";
import { BackupActions } from "./actions";
import { ExportSection, RestoreHelp } from "./export-section";
import { BackupFacts } from "./facts";
import { BackupJobProgress } from "./job";
import { BackupResult } from "./result";
import { BackupSettingsForm, type SettingsFormState } from "./settings-form";
import { BackupSummary, type SummaryState } from "./summary";
import { BackupTable } from "./table";
import { words } from "./words";
import type {
  BackupView,
  ExportView,
  JobKind,
  JobResultView,
  JobView,
  SafetyClock,
  SafetyStatusView,
  SettingsView,
} from "./types";
import { introParts } from "../intro";
import { PageHeader } from "../page-header";

export interface BackupsWorkspaceProps {
  state: SummaryState;
  status?: SafetyStatusView | undefined;
  backups: readonly BackupView[];
  unrecorded: readonly string[];
  exports: readonly ExportView[];
  clock: SafetyClock;
  /** The job in progress: one this page started, or one the service reports. */
  job: JobView | null;
  jobSource: "here" | "elsewhere";
  /** Which job this page is waiting on, for its button. */
  running: JobKind | null;
  /** The connection dropped while waiting; the job's outcome is not known. */
  uncertain: boolean;
  result: JobResultView | null;
  ownerAccess: boolean;
  settingsState: SettingsFormState;
  settingsError?: string | undefined;
  onRetry: () => void;
  onBackUp: () => void;
  onVerify: (backupId?: string) => void;
  onDrill: (backupId?: string) => void;
  onExport: () => void;
  onReconnect: () => void;
  onDismissResult: () => void;
  onSaveSettings: (values: SettingsView) => void;
}

/** The whole Backups and export screen, from data and callbacks. The route loads the data and wires
 * the callbacks; nothing here talks to the service, so every state of the screen is a story. */
export function BackupsWorkspace(props: BackupsWorkspaceProps) {
  const busy = () => props.job !== null || props.running !== null;
  const hint = createUniqueId();
  const intro = introParts(words.intro);
  return (
    <div class="rt-safe-workspace">
      <PageHeader
        titleId="backups-title"
        title={words.title}
        description={intro.line}
        actions={
          <Show when={props.state === "ready" && props.status}>
            <Button
              label={words.backUpNow}
              pending={props.running === "backup"}
              pendingLabel="Backing up…"
              disabled={busy() && props.running !== "backup"}
              aria-describedby={hint}
              onClick={props.onBackUp}
            />
            <span id={hint} class="rt-sr-only">
              {words.backUpNowHint}
            </span>
          </Show>
        }
      />
      <BackupSummary state={props.state} status={props.status} onRetry={props.onRetry} />
      <Show when={props.state === "ready" && props.status}>
        {(status) => (
          <>
            <Show when={props.job}>
              {(job) => (
                <BackupJobProgress
                  job={job()}
                  elsewhere={props.jobSource === "elsewhere"}
                  uncertain={props.uncertain}
                  onReconnect={props.onReconnect}
                />
              )}
            </Show>
            <Show when={!props.job && props.result}>
              {(result) => (
                <BackupResult
                  result={result()}
                  clock={props.clock}
                  onDismiss={props.onDismissResult}
                />
              )}
            </Show>
            <div class="rt-safe-columns">
              <BackupActions
                busy={busy()}
                hasBackup={status().backupCount > 0}
                running={props.running}
                onVerify={() => props.onVerify()}
                onDrill={() => props.onDrill()}
              />
              <BackupFacts status={status()} clock={props.clock} />
            </div>
            <BackupTable
              backups={props.backups}
              unrecorded={props.unrecorded}
              clock={props.clock}
              busy={busy()}
              onVerify={(id) => props.onVerify(id)}
              onDrill={(id) => props.onDrill(id)}
            />
            <ExportSection
              exports={props.exports}
              clock={props.clock}
              busy={busy()}
              running={props.running === "export"}
              onExport={props.onExport}
            />
            <BackupSettingsForm
              settings={status().settings}
              ownerAccess={props.ownerAccess}
              state={props.settingsState}
              error={props.settingsError}
              onSave={props.onSaveSettings}
            />
            <RestoreHelp />
          </>
        )}
      </Show>
    </div>
  );
}
