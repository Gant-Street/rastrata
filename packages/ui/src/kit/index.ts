// The UX kit: the shared pieces every screen is built from. Usage rules are in
// docs/reference/program/ux/kit.md; the package index re-exports this file.
export { TONES, toneOf, type LegacyTone, type Tone, type ToneName, type ToneNote } from "./tones";
export { ToneMarker } from "./tone-marker";
export { AccountPicker, type AccountOption, type AccountPickerProps } from "./account-picker";
export {
  accountOptions,
  foldText,
  groupedInOrder,
  matchAccounts,
  offeredAccounts,
  type AccountRowLike,
  type AccountWords,
} from "./accounts";
export { DateRangeField, type DateRangeFieldProps } from "./date-range-field";
export {
  calendarBounds,
  dateRangeProblem,
  defaultRange,
  describeDates,
  isUsableRange,
  presetOf,
  presetRange,
  RANGE_PRESETS,
  type DateRangeValue,
  type FiscalCalendar,
  type RangeDates,
  type RangePresetId,
  type RangeProblem,
} from "./date-range";
export {
  CopyValue,
  Details,
  DetailsList,
  type CopyTarget,
  type DetailsItem,
  type DetailsProps,
} from "./details";
export { writeToClipboard, type CopyResult } from "./copy";
export { EmptyState, type EmptyStateProps } from "./empty-state";
export { IndexList, type IndexEntry, type IndexLinkProps } from "./index-list";
export { Steps, type StepItem } from "./steps";
export { Prose, ProseCode } from "./prose";
export { FilterFold, FilterFoldButton, FilterFoldPanel } from "./filter-fold";
export { ListSearch } from "./list-search";
export {
  ToastProvider,
  useToast,
  type ToastAction,
  type ToastApi,
  type ToastOptions,
  type ToastProviderProps,
} from "./toast";
export { toastDuration, TOASTS_VISIBLE } from "./toast-options";
