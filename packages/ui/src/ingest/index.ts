// Components for the ingest lane: the Transactions page's view of what waits for review. Presentational:
// the web route owns the data and the work.
export { InboxWorkspace } from "./workspace";
export { InboxList, categoryText, type RowAction } from "./list";
export {
  acceptable,
  categorizable,
  categoryOf,
  effectOf,
  hasCategoryField,
  nameOfAccount,
  suggestedCategory,
  type Category,
  type CategoryKind,
} from "./category";
export { InboxDetail, type CategorizeChoice, type InboxLinks } from "./detail";
export {
  AccountSelect,
  CoveredChip,
  foldedCount,
  InboxFilterPanel,
  InboxSearch,
  narrowed,
  sourceKeyOf,
} from "./filters";
export {
  TransactionViews,
  transactionViews,
  type TransactionView,
  type TransactionViewHrefs,
  type ViewLinkExtras,
} from "./views";
export { SplitEditor, checkSplit, type SplitCheck, type SplitPart } from "./split-editor";
export {
  AcceptBar,
  InboxNote,
  InboxProgressBar,
  InboxSelectionBar,
  InboxUncertain,
  type BulkAbilities,
} from "./bulk";
export { CategorizeDialog, PostDialog, ReasonDialog, SourceDialog } from "./dialogs";
export { InboxEmpty } from "./states";
export {
  BankTileBand,
  type BankTileBandProps,
  type BankTileData,
  type BankTileLinks,
} from "./bank-tiles";
export { BankRows, bankReconcileId, type BankRowsProps } from "./bank-rows";
export type { AccountChoiceItem } from "./bank-tile-types";
export { parseAmount as parseInboxAmount } from "./cents";
export { words as inboxWords } from "./words";
export { emptyFilters as emptyInboxFilters } from "./types";
export type {
  AcceptMode,
  AccountOption as InboxAccountOption,
  InboxActionNote,
  InboxActions,
  InboxCountsView,
  InboxDetailView,
  InboxFilterState,
  InboxItemView,
  InboxLegView,
  InboxLineView,
  InboxProgress,
  InboxProposalView,
  InboxProvenanceView,
  InboxSourceView,
  InboxSplitInput,
  InboxStatus,
  InboxSuggestionView,
  InboxTab,
  InboxTarget,
} from "./types";
