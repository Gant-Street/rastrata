import { Show } from "solid-js";
import { Button } from "../button";
import { FilterFoldButton, FilterFoldPanel } from "../kit/filter-fold";
import { ListSearch } from "../kit/list-search";
import { SelectField } from "../select-field";
import { DateField } from "../date-field";
import type { AccountChoiceItem } from "./bank-tile-types";
import { emptyFilters, type InboxFilterState, type InboxSourceView } from "./types";
import { words } from "./words";

export const sourceKeyOf = (source: { provider: string; accountKey: string }): string =>
  `${source.provider}\u0000${source.accountKey}`;

const EVERY_ACCOUNT = "every-account";
const EVERY = "every";

/** What the fold holds, apart from the order: a change to one of these narrows the list. */
const FOLDED: readonly (keyof InboxFilterState)[] = ["from", "to", "source"];

/** Whether anything narrows the list besides the account (a scope, chosen beside the search) and the order. */
export const narrowed = (filters: InboxFilterState): boolean =>
  (Object.keys(emptyFilters) as (keyof InboxFilterState)[]).some(
    (key) => key !== "sort" && key !== "account" && filters[key] !== emptyFilters[key],
  );

/** How many of the folded filters are on, for the number on the Filter button. */
export const foldedCount = (filters: InboxFilterState): number =>
  FOLDED.filter((key) => filters[key] !== emptyFilters[key]).length +
  (filters.sort !== emptyFilters.sort ? 1 : 0);

/** The account the list is narrowed to: one select, "All accounts" first. The page shows it only when
 * more than one account has transactions, because a choice of one is no choice. */
export function AccountSelect(props: {
  accounts: readonly AccountChoiceItem[];
  value: string;
  onChange: (key: string) => void;
  disabled?: boolean;
}) {
  return (
    <div class="rt-inbox-account-select">
      <SelectField
        hideLabel
        label={words.accountsLabel}
        value={props.value === "" ? EVERY_ACCOUNT : props.value}
        disabled={props.disabled ?? false}
        items={[
          { value: EVERY_ACCOUNT, label: words.allAccounts },
          ...props.accounts.map((account) => ({ value: account.key, label: account.label })),
        ]}
        onChange={(value) => props.onChange(value === EVERY_ACCOUNT ? "" : value)}
      />
    </div>
  );
}

/** The search box, with the quiet button at its end that opens the less common filters. Everything is a
 * filter on the server, so a "select all matching" and a bulk action mean exactly what the list shows.
 * It sits inside a `FilterFold`, which owns the button's state. */
export function InboxSearch(props: {
  filters: InboxFilterState;
  disabled?: boolean;
  onChange: (patch: Partial<InboxFilterState>) => void;
  searchRef?: (element: HTMLInputElement) => void;
}) {
  return (
    <search class="rt-inbox-search-row" aria-label={words.filtersLabel}>
      <ListSearch
        label={words.search}
        placeholder={words.searchPlaceholder}
        hint={words.searchHint}
        value={props.filters.text}
        inputRef={props.searchRef}
        disabled={props.disabled}
        onInput={(text) => props.onChange({ text })}
      >
        <FilterFoldButton count={foldedCount(props.filters)} />
      </ListSearch>
    </search>
  );
}

/** What the Filter button opens: the order, the dates and which file or connection a transaction came
 * from. A line above it says when only the transactions a payout books are showing. */
export function InboxFilterPanel(props: {
  filters: InboxFilterState;
  sources: readonly InboxSourceView[];
  disabled?: boolean;
  /** Names the provider account of a source; falls back to the provider's own key. */
  sourceLabel: (source: InboxSourceView) => string;
  onChange: (patch: Partial<InboxFilterState>) => void;
  /** Open the settings of the provider account the list is narrowed to. */
  onSourceSettings?: (source: InboxSourceView) => void;
}) {
  const chosenSource = () =>
    props.sources.find((source) => sourceKeyOf(source) === props.filters.source);
  return (
    <FilterFoldPanel class="rt-inbox-filter-more">
      <SelectField
        label={words.sort}
        value={props.filters.sort}
        disabled={props.disabled ?? false}
        items={(Object.keys(words.sorts) as (keyof typeof words.sorts)[]).map((key) => ({
          value: key,
          label: words.sorts[key],
        }))}
        onChange={(value) => props.onChange({ sort: value as InboxFilterState["sort"] })}
      />
      <DateField
        label={words.from}
        value={props.filters.from}
        onChange={(value) => props.onChange({ from: value })}
      />
      <DateField
        label={words.to}
        value={props.filters.to}
        onChange={(value) => props.onChange({ to: value })}
      />
      <SelectField
        label={words.source}
        value={props.filters.source === "" ? EVERY : props.filters.source}
        disabled={props.disabled ?? false}
        items={[
          { value: EVERY, label: words.anySource },
          ...props.sources.map((source) => ({
            value: sourceKeyOf(source),
            label: props.sourceLabel(source),
          })),
        ]}
        onChange={(value) => props.onChange({ source: value === EVERY ? "" : value })}
      />
      <div class="rt-inbox-filter-clear">
        <Show when={props.onSourceSettings && chosenSource()}>
          {(source) => (
            <Button
              variant="quiet"
              size="sm"
              label={words.sourceDialogTitle}
              onClick={() => props.onSourceSettings?.(source())}
            />
          )}
        </Show>
        <Show when={foldedCount(props.filters) > 0}>
          <Button
            variant="quiet"
            size="sm"
            label={words.clearFilters}
            disabled={props.disabled ?? false}
            onClick={() =>
              props.onChange({
                ...emptyFilters,
                text: props.filters.text,
                account: props.filters.account,
                coveredBy: props.filters.coveredBy,
              })
            }
          />
        </Show>
      </div>
    </FilterFoldPanel>
  );
}

/** Says that only the transactions one payout books are showing, with the way back to the list. */
export function CoveredChip(props: { coveredBy: string; onClear: () => void }) {
  return (
    <p class="rt-inbox-chip" role="status">
      <span>
        {words.onlyCovered} <bdi>{props.coveredBy}</bdi>
      </span>
      <Button variant="quiet" size="sm" label={words.clearCovered} onClick={props.onClear} />
    </p>
  );
}
