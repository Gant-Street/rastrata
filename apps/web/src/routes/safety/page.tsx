import { BackupsWorkspace } from "@rastrata/ui";
import { BrowserApplicationClient } from "../../application-client";
import { createBackupsController } from "./controller";

/** Backups and export. The route only creates the controller and hands its data and actions to the
 * workspace; every decision about what the screen says is in the components and the controller. */
export function BackupsPage() {
  const client = new BrowserApplicationClient(window.localStorage);
  const page = createBackupsController(client);
  return (
    <section class="rt-safe-page" aria-labelledby="backups-title">
      <BackupsWorkspace
        state={page.state()}
        status={page.statusView()}
        backups={page.backups()}
        unrecorded={page.unrecorded()}
        exports={page.exports()}
        clock={page.clock()}
        job={page.job()}
        jobSource={page.jobSource()}
        running={page.running()}
        uncertain={page.uncertain()}
        result={page.result()}
        ownerAccess={page.ownerAccess()}
        settingsState={page.settingsState()}
        settingsError={page.settingsError()}
        onRetry={page.retry}
        onBackUp={page.backUp}
        onVerify={page.verify}
        onDrill={page.drill}
        onExport={page.exportNow}
        onReconnect={page.reconnect}
        onDismissResult={page.dismiss}
        onSaveSettings={(values) => void page.saveSettings(values)}
      />
    </section>
  );
}
