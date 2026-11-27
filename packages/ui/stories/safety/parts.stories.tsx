import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  BackupJobProgress,
  BackupSettingsForm,
  BackupTable,
  CheckList,
  ExportSection,
  type SettingsView,
  UiProvider,
} from "../../src";
import {
  clock,
  exportsList,
  failedChecks,
  manual,
  manyBackups,
  missing,
  neverChecked,
  newest,
  passedChecks,
  replayJob,
  settings,
  yesterday,
} from "./fixtures";

const Frame = (props: { children: import("solid-js").JSX.Element; locale?: string }) => (
  <UiProvider {...(props.locale ? { locale: props.locale } : {})}>
    <div class="rt-theme">{props.children}</div>
  </UiProvider>
);

const meta = {
  title: "Lanes/Safety/Parts",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const none = () => {};

// ---- A running job -----------------------------------------------------------------------------------

/** A replay: how far, how long, and an estimate that says it is one. */
export const JobReplaying: Story = {
  render: () => (
    <Frame>
      <BackupJobProgress job={replayJob} />
    </Frame>
  ),
};

/** A copy has a known size, so a percentage is honest; a replay's total is the ledger's length. */
export const JobCopying: Story = {
  render: () => (
    <Frame>
      <BackupJobProgress
        job={{
          kind: "backup",
          stage: "Making a working copy",
          done: 9_000_000,
          total: 17_300_000,
          elapsedMs: 800,
          remainingMs: null,
        }}
      />
    </Frame>
  ),
};

/** With nothing known yet, the bar is indeterminate and no estimate is invented. */
export const JobStarting: Story = {
  render: () => (
    <Frame>
      <BackupJobProgress
        job={{
          kind: "drill",
          stage: "Starting",
          done: null,
          total: null,
          elapsedMs: 300,
          remainingMs: null,
        }}
      />
    </Frame>
  ),
};

// ---- What was checked --------------------------------------------------------------------------------

export const ChecksPassed: Story = {
  render: () => (
    <Frame>
      <CheckList checks={passedChecks} />
    </Frame>
  ),
};

export const ChecksFailed: Story = {
  render: () => (
    <Frame>
      <CheckList checks={failedChecks} />
    </Frame>
  ),
};

// ---- The list ------------------------------------------------------------------------------------------

export const TableDefault: Story = {
  render: () => (
    <Frame>
      <BackupTable
        backups={[newest, yesterday, manual, missing, neverChecked]}
        clock={clock}
        onVerify={none}
        onDrill={none}
      />
    </Frame>
  ),
};

export const TableEmpty: Story = {
  render: () => (
    <Frame>
      <BackupTable backups={[]} clock={clock} />
    </Frame>
  ),
};

export const TableBusy: Story = {
  render: () => (
    <Frame>
      <BackupTable backups={[newest, yesterday]} clock={clock} busy />
    </Frame>
  ),
};

/** Sixty backups: ten are shown, the rest one button away, and the table scrolls inside itself. */
export const TableManyRows: Story = {
  render: () => (
    <Frame>
      <BackupTable backups={manyBackups(60)} clock={clock} />
    </Frame>
  ),
};

export const TableRightToLeft: Story = {
  render: () => (
    <Frame locale="ar">
      <BackupTable backups={[newest, manual]} clock={{ ...clock, locale: "ar" }} />
    </Frame>
  ),
};

// ---- Settings ------------------------------------------------------------------------------------------

export const SettingsDefault: Story = {
  render: () => (
    <Frame>
      <BackupSettingsForm settings={settings} ownerAccess state="idle" onSave={none} />
    </Frame>
  ),
};

/** Not the owner: every field is read-only and says why. */
export const SettingsReadOnly: Story = {
  render: () => (
    <Frame>
      <BackupSettingsForm settings={settings} ownerAccess={false} state="idle" onSave={none} />
    </Frame>
  ),
};

export const SettingsSaving: Story = {
  render: () => (
    <Frame>
      <BackupSettingsForm settings={settings} ownerAccess state="saving" onSave={none} />
    </Frame>
  ),
};

/** Invalid answers stay in the form; the summary takes focus and links to each field. Press Save
 * with a field cleared to see it. */
export const SettingsEdited: Story = {
  render: () => {
    const [saved, setSaved] = createSignal<SettingsView | null>(null);
    return (
      <Frame>
        <BackupSettingsForm
          settings={{ ...settings, keepDaily: 14 }}
          ownerAccess
          state={saved() ? "saved" : "idle"}
          onSave={setSaved}
        />
      </Frame>
    );
  },
};

// ---- Export -----------------------------------------------------------------------------------------------

export const ExportWithFiles: Story = {
  render: () => (
    <Frame>
      <ExportSection
        exports={exportsList}
        clock={clock}
        busy={false}
        running={false}
        onExport={none}
      />
    </Frame>
  ),
};

export const ExportEmpty: Story = {
  render: () => (
    <Frame>
      <ExportSection exports={[]} clock={clock} busy={false} running={false} onExport={none} />
    </Frame>
  ),
};

export const ExportRunning: Story = {
  render: () => (
    <Frame>
      <ExportSection exports={[]} clock={clock} busy running onExport={none} />
    </Frame>
  ),
};
