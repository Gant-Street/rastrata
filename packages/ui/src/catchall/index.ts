// Components for the catchall lane: what Close the books says when money collects in the account a book
// keeps for what fits nowhere else, changing the account of transactions that came from For review, and
// watching an account at month end. Export them here; the package index re-exports this file.
export { ChangeAccountDialog, type ChangeAccountDialogProps } from "./change-account-dialog";
export { CloseNotes } from "./close-notes";
export {
  canChangeAccount,
  closeNotes,
  doneSplit,
  isWatchKey,
  leftWords,
  moving,
  type NoteLinks,
  placeDetail,
  planSentence,
  WATCH_KEYS,
  type WatchKind,
  watchKind,
  watchOffer,
} from "./logic";
export type {
  ChangeAccountStage,
  ChecklistNoteView,
  CloseNote,
  MoveOutcome,
  MoveRow,
  PlaceKind,
} from "./types";
export { WatchAccountDialog, type WatchAccountDialogProps } from "./watch-account-dialog";
export { catchallWords } from "./words";
