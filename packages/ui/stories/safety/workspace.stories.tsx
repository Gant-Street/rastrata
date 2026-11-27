import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { BackupsWorkspace, type BackupsWorkspaceProps, UiProvider } from "../../src";
import {
  automaticFailed,
  backup,
  clock,
  drillFailed,
  exportsList,
  manual,
  manyBackups,
  missing,
  neverBackedUp,
  neverChecked,
  newest,
  passedChecks,
  replayJob,
  sameDisk,
  staleWarning,
  status,
  verificationFailed,
  yesterday,
} from "./fixtures";

const none = () => {};

const base: BackupsWorkspaceProps = {
  state: "ready",
  status: status({ warnings: [sameDisk] }),
  backups: [newest, yesterday, manual, missing, neverChecked],
  unrecorded: [],
  exports: exportsList,
  clock,
  job: null,
  jobSource: "here",
  running: null,
  uncertain: false,
  result: null,
  ownerAccess: true,
  settingsState: "idle",
  onRetry: none,
  onBackUp: none,
  onVerify: none,
  onDrill: none,
  onExport: none,
  onReconnect: none,
  onDismissResult: none,
  onSaveSettings: none,
};

const Frame = (props: { children: import("solid-js").JSX.Element; locale?: string }) => (
  <UiProvider {...(props.locale ? { locale: props.locale } : {})}>
    <div class="rt-theme">{props.children}</div>
  </UiProvider>
);

const meta = {
  title: "Lanes/Safety/Backups and export",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const page = (overrides: Partial<BackupsWorkspaceProps>): Story => ({
  render: () => (
    <Frame>
      <BackupsWorkspace {...base} {...overrides} />
    </Frame>
  ),
});

/** Backed up, checked and tested: the headline says so, and the only note is about the disk. */
export const Healthy: Story = page({});

/** The last verification is older than the warning time: a review notice, with what to do. */
export const NeedsAttention: Story = page({
  status: status({ warnings: [staleWarning, sameDisk] }),
});

/** A failed check and a failed automatic backup: the headline is the worst thing, with the reason. */
export const NotSafe: Story = page({
  status: status({
    latest: manual,
    latestVerified: yesterday,
    warnings: [verificationFailed, automaticFailed, staleWarning],
  }),
});

/** A new book: no backups, no restore test, nothing to check, and the way forward. */
export const NeverBackedUp: Story = page({
  status: status({
    latest: null,
    latestVerified: null,
    lastDrill: null,
    changesSinceLatest: null,
    backupCount: 0,
    automatic: {
      enabled: true,
      scheduler: "active",
      lastRunAt: null,
      lastRunOk: null,
      lastError: null,
    },
    warnings: [neverBackedUp],
  }),
  backups: [],
  exports: [],
});

export const Loading: Story = page({ state: "loading", status: undefined });
export const ReadFailed: Story = page({ state: "error", status: undefined });
export const Unavailable: Story = page({ state: "unavailable", status: undefined });
export const NoBook: Story = page({ state: "no-book", status: undefined });

/** A replay in progress: the stage, how far, how long, and an estimate called an estimate. The
 * buttons wait and say why. */
export const CheckingARunningVerification: Story = page({
  job: replayJob,
  running: "verify",
  status: status({ activeJob: replayJob }),
});

/** A job the automatic backups started: this page only watches it. */
export const JobFromElsewhere: Story = page({
  job: {
    kind: "backup",
    stage: "Copying the database",
    done: null,
    total: null,
    elapsedMs: 2_000,
    remainingMs: null,
  },
  jobSource: "elsewhere",
});

/** The connection dropped: the screen says the outcome is not known, and offers to ask again. */
export const ConnectionDropped: Story = page({
  job: replayJob,
  running: "verify",
  uncertain: true,
});

export const VerificationPassed: Story = page({
  result: {
    kind: "verify",
    state: "done",
    backupId: newest.id,
    passed: true,
    durationMs: 43_100,
    replayMs: 41_200,
    checks: passedChecks,
  },
});

export const BackupMade: Story = page({
  result: { kind: "backup", state: "done", backup: newest },
});

export const DrillFailed: Story = page({
  result: { kind: "drill", state: "done", drill: drillFailed },
});

export const JobFailed: Story = page({
  result: {
    kind: "backup",
    state: "failed",
    code: "backup_no_space",
    message:
      "There is not enough free space in /Volumes/Backup for a backup: about 17.3 MB is needed and 2.0 MB is free.",
  },
});

/** A long history and files that are not backups. The table keeps its own scroll. */
export const ManyBackups: Story = page({
  status: status({ backupCount: 60, warnings: [] }),
  backups: manyBackups(60),
  unrecorded: ["notes.sqlite", "20260101T000000Z-00000001-00000000.manifest.json"],
});

/** Settings are shown read-only when this connection is not the owner's. */
export const NotTheOwner: Story = page({ ownerAccess: false });

export const ArabicLayout: Story = {
  render: () => (
    <Frame locale="ar">
      <BackupsWorkspace {...base} />
    </Frame>
  ),
};

export const LongNames: Story = page({
  status: status({
    directory:
      "/Users/a-founder-with-a-very-long-account-name/Documents/Rastrata Books/Acme Holdings, Inc./backups/book-with-a-long-name",
  }),
  backups: [
    backup("20261003T151500Z-00001204-a1b2c3d4", "2026-10-03T15:15:00.000Z", {
      bytes: 5_400_000_000,
      head: { sequence: "1234567", bookRevision: "1234567", chainHash: "a".repeat(64) },
    }),
  ],
});

export const SettingsSaved: Story = page({ settingsState: "saved" });
export const SettingsFailed: Story = page({
  settingsState: "error",
  settingsError: "The settings could not be saved. Your settings have not changed.",
});
