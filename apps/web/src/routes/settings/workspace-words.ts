/** The words of Settings, Workspace (workspace.tsx). */
export const workspaceWords = {
  title: "Workspace",
  notHere: "There is no workspace here",
  notHereBody:
    "This copy of Rastrata holds one set of books for one person, on this computer. Workspaces are on the hosted service.",
  loading: "Reading the workspace…",
  failed: "The workspace could not be read",
  retry: "Try again",
  exportTitle: "Export your books",
  exportBody: "Everything in your books as one file you can keep and open without Rastrata.",
  exportOnlyOwners: "Only an owner or an administrator can export the books.",
  exportAction: "Export your books",
  exportMaking: "Making the export…",
  exportReading: "Reading the books…",
  exportFetching: "Fetching the file…",
  exportStage: (stage: string, percent: number | null) =>
    percent === null ? `${stage}…` : `${stage}… ${percent}%`,
  exportDone: (name: string) => `Your books were exported. The file ${name} is in your downloads.`,
  exportAgain: "Export again",
  deleteTitle: "Delete this workspace",
  deleteBody:
    "For thirty days you can bring them back from the list of your workspaces; after that they are erased.",
  deleteOnlyOwners: "Only an owner can delete the workspace.",
  deleteLabel: (name: string) => `Type "${name}" to confirm`,
  deleteAction: "Delete this workspace",
  deleting: "Deleting…",
};
