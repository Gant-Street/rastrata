import { Collapsible } from "@ark-ui/solid/collapsible";
import { For, type JSX, Show } from "solid-js";
import { isWatchKey } from "../catchall/logic";
import { catchallWords } from "../catchall/words";
import { buttonAttrs } from "../button";
import { formatCount } from "../format";
import { ChevronRight } from "../icons";
import { Money } from "../money";
import type { ChartGroup, ChartGroupId } from "./chart-logic";
import type { AccountView } from "./chart-types";
import { type ChartMessageOverrides, mergeChartMessages } from "./messages";

export interface ChartGroupsProps {
  groups: readonly ChartGroup[];
  /** What a kind adds up to: the sum of its accounts' balances, as the service's decimal text. */
  total: (group: ChartGroup) => string;
  /** The kinds that are open. */
  open: readonly ChartGroupId[];
  onToggle: (id: ChartGroupId, open: boolean) => void;
  /** The kinds whose quiet accounts (a zero balance, closed) are listed too. */
  full: readonly ChartGroupId[];
  onFull: (id: ChartGroupId, full: boolean) => void;
  /** A search is narrowing the chart: every kind with a match is open and shows every match, and none
   * is counted away under its kind. */
  searching?: boolean | undefined;
  /** Where an account's name leads: the account's own page, where it is renamed, closed and tagged. */
  accountHref: (account: AccountView) => string;
  messages?: ChartMessageOverrides;
}

/**
 * The chart of accounts, folded by kind: Assets, Liabilities, Equity, Income, Expenses, each a line with
 * how many accounts it has and what they add up to. An open kind lists the accounts that hold something
 * (a row is the name, which is the link to the account, and its balance: nothing else); the ones with a
 * zero balance and the closed ones are counted under it and shown when asked for. Each fold is a disclosure (Ark's Collapsible), so
 * Tab, Enter and Space do what they do everywhere. Balances are the service's exact decimal strings.
 */
export function ChartGroups(props: ChartGroupsProps): JSX.Element {
  const m = () => mergeChartMessages(props.messages).accounts;
  const all = () => props.full;
  const isOpen = (group: ChartGroup) => props.searching === true || props.open.includes(group.id);
  const showsAll = (group: ChartGroup) =>
    props.searching === true || all().includes(group.id) || group.holding.length === 0;
  const listed = (group: ChartGroup) => (showsAll(group) ? group.accounts : group.holding);
  return (
    <div class="rt-chart-groups">
      <For each={props.groups}>
        {(group) => (
          <Collapsible.Root
            class="rt-chart-group"
            data-group={group.id}
            lazyMount
            open={isOpen(group)}
            onOpenChange={(detail) => props.onToggle(group.id, detail.open)}
          >
            <Collapsible.Trigger class="rt-chart-group-head" disabled={props.searching === true}>
              <ChevronRight aria-hidden="true" class="rt-chart-group-chevron" />
              <span class="rt-chart-group-name">
                {m().groups[group.id]}{" "}
                <span class="rt-chart-group-count">
                  <span aria-hidden="true">({formatCount(group.accounts.length)})</span>
                  <span class="rt-sr-only">{m().groupCount(group.accounts.length)}</span>
                </span>
              </span>
              <span class="rt-chart-group-total">
                <Money value={props.total(group)} />
              </span>
            </Collapsible.Trigger>
            <Collapsible.Content class="rt-chart-group-body">
              <table class="rt-chart-group-table">
                <caption class="rt-sr-only">{m().groups[group.id]}</caption>
                <thead class="rt-sr-only">
                  <tr>
                    <th scope="col">{m().columnAccount}</th>
                    <th scope="col">{m().columnBalance}</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={listed(group)}>
                    {(account) => (
                      <tr data-closed={account.closedOn ? "" : undefined}>
                        <th scope="row" class="rt-chart-group-account">
                          <a href={props.accountHref(account)}>
                            <bdi>{account.name}</bdi>
                          </a>
                          <Show when={account.closedOn}>
                            <small class="rt-chart-note">
                              {m().closed(account.closedOn as string)}
                            </small>
                          </Show>
                          <Show when={isWatchKey(account.tags.roleKey)}>
                            <small class="rt-chart-note">{catchallWords.watch.note}</small>
                          </Show>
                        </th>
                        <td class="amount">
                          <Money value={account.balance} />
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
              <Show
                when={props.searching !== true && group.holding.length > 0 && group.rest.length > 0}
              >
                <p class="rt-chart-group-rest">
                  <Show when={!all().includes(group.id)}>
                    <span>{m().restCount(group.rest.length)}</span>
                  </Show>
                  <button
                    type="button"
                    {...buttonAttrs({ variant: "secondary", size: "sm" })}
                    aria-expanded={all().includes(group.id)}
                    onClick={() => props.onFull(group.id, !all().includes(group.id))}
                  >
                    {all().includes(group.id)
                      ? m().restHide(group.rest.length)
                      : m().restShow(group.rest.length)}
                  </button>
                </p>
              </Show>
            </Collapsible.Content>
          </Collapsible.Root>
        )}
      </For>
    </div>
  );
}
