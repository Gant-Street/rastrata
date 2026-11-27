/** Every string rendered on the Plugins screen, in one place.
 * Plain American English, concise, zero screen-in-sentence references, zero fine print. */

export const words = {
  title: "Plugins",
  lead: "External connectors that bring transactions into your books.",
  empty: "Bring in transactions from banks, payment processors, and custom tools.",
  emptyMember: "An owner can install and configure plugins.",
  installButton: "Install a plugin",
  loading: "Loading plugins…",
  unavailableTitle: "Plugins could not be loaded",
  unavailableBody: "Your books were not changed.",
  tryAgain: "Try again",

  // Empty state quickstart command
  cliInstallLabel: "Or install from the command line",
  cliInstallCommand: "rastrata plugin install ./plugin-stripe",
  cliSyncCommand: (pluginId: string) => `rastrata plugin sync ./plugin-${pluginId}`,
  copyCommand: "Copy",
  commandCopied: "Copied",

  // Plugin block header & actions
  paused: "Paused",
  updated: (when: string) => `Updated ${when}`,
  actionsFor: (name: string) => `Actions for ${name}`,
  actionConfigure: "Configure",
  actionTokens: "Access tokens",
  actionPause: "Pause",
  actionResume: "Resume",
  actionRemove: "Remove",

  // Attention rows (orange cell only when something needs the person)
  needAccounts: (names: string) => `Choose an account for ${names}.`,
  chooseAccounts: "Choose accounts",
  syncProblem: (source: string, message: string) => `${source}: ${message}`,

  // Summary rows above the Options fold
  columns: {
    source: "Source",
    account: "Account in books",
    updated: "Last synced",
  },
  unassignedAccount: "Not linked yet",
  clearingNote: (accountLabel: string, days: number) =>
    `Matches bank deposits through ${accountLabel} within ${days} ${days === 1 ? "day" : "days"}.`,
  waitingFirstSync: "Ready for its first sync.",

  // Options fold
  optionsTitle: "Options",
  rolesHeading: "Accounts",
  optional: "Optional",
  fromChart: (label: string) => `From chart: ${label}`,
  noAccount: "Choose an account",
  roleNeedsAccount: "Choose an account.",
  accountsHeading: "Linked accounts",
  sourceKeyLabel: "Source key",
  sourceKeyPlaceholder: "bank:checking_01",
  ledgerAccountLabel: "Account in books",
  startDateLabel: "Start date",
  addAccount: "Add account",
  removeRow: "Remove",
  settingsHeading: "Settings",
  domainsLabel: "Allowed outbound hosts",
  domainsNone: "None (offline only)",
  save: "Save",
  saving: "Saving…",
  saved: "Saved",
  saveFailed: "Could not save changes",

  // Install dialog
  installTitle: "Install a plugin",
  installDescription:
    "Paste a plugin manifest to inspect its outbound hosts and accounts before installing.",
  manifestLabel: "Manifest JSON",
  manifestHint: "Only the manifest is stored. Provider API keys stay on your computer.",
  manifestFileLabel: "Load manifest file",
  previewName: "Plugin",
  previewHosts: "Outbound hosts",
  previewRoles: "Accounts",
  previewAuth: "Authentication",
  installSubmit: "Install",
  installing: "Installing…",
  cancel: "Cancel",
  installFailed: "Could not install plugin",

  // Remove confirmation dialog
  removeTitle: (name: string) => `Remove ${name}?`,
  removeBody:
    "Access tokens for this plugin are revoked right away. Archived records and posted entries stay in your books.",
  keepPlugin: "Keep it",
  confirmRemove: "Remove plugin",
  removing: "Removing…",

  // Access tokens dialog
  tokensTitle: (name: string) => `${name} access tokens`,
  tokensDescription:
    "Each token can only check status and send transactions for this plugin. It cannot read reports or post entries.",
  tokenLabel: "Label",
  tokenLabelPlaceholder: "Laptop sync",
  tokenExpiry: "Expires in",
  expiryChoices: [
    { value: "30", label: "30 days" },
    { value: "90", label: "90 days" },
    { value: "365", label: "365 days" },
  ] as const,
  createToken: "Create token",
  creatingToken: "Creating…",
  tokenRevealNotice: "Copy this token now. It will not be shown again.",
  tokensEmpty: "No access tokens yet.",
  tokensLoading: "Loading tokens…",
  tokenCreated: (when: string) => `Created ${when}`,
  tokenExpires: (when: string) => `Expires ${when}`,
  tokenLastUsed: (when: string) => `Last used ${when}`,
  tokenRevoked: "Revoked",
  tokenExpired: "Expired",
  revokeToken: "Revoke",
  revokingToken: "Revoking…",
  close: "Done",
} as const;
