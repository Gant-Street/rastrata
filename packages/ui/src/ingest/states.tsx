import { Show } from "solid-js";
import { Button, buttonAttrs } from "../button";
import { EmptyState } from "../kit";
import type { InboxCountsView, InboxTab } from "./types";
import { words } from "./words";

/** Why the list is empty: one sentence, and only what is true. A book with nothing imported says so; the
 * page's header already offers the import, so the one button here is the other way in (connect a bank,
 * where the service can keep a connection). "You are caught up" is said only when there were transactions
 * and every one has been decided, never for a book nobody has imported into, and never for a list a
 * filter emptied; it offers nothing, because what comes next (a statement, what is ready to post) is
 * already on the page. */
export function InboxEmpty(props: {
  tab: InboxTab;
  counts: InboxCountsView;
  /** A search or a filter is narrowing the list. */
  filtered: boolean;
  /** Where to connect a bank; absent where the service cannot keep a connection. */
  connectHref?: string | undefined;
  onClearFilters: () => void;
}) {
  return (
    <div class="rt-inbox-empty">
      <Show
        when={props.counts.total > 0}
        fallback={
          <EmptyState
            title={words.newBookTitle}
            {...(props.connectHref
              ? {
                  action: (
                    <a
                      {...buttonAttrs({ variant: "primary", size: "md" })}
                      href={props.connectHref}
                    >
                      {words.connectBank}
                    </a>
                  ),
                }
              : {})}
          >
            {props.connectHref ? words.newBookBody : words.newBookBodyImportOnly}
          </EmptyState>
        }
      >
        <Show
          when={!props.filtered}
          fallback={
            <EmptyState
              live
              title={words.noMatchesTitle}
              action={
                <Button
                  variant="secondary"
                  label={words.clearFilters}
                  onClick={props.onClearFilters}
                />
              }
            >
              {words.noMatchesBody}
            </EmptyState>
          }
        >
          <Show
            when={props.tab === "review"}
            fallback={<EmptyState live>{words.tabEmpty[props.tab]}</EmptyState>}
          >
            <EmptyState live title={words.caughtUpTitle}>
              {words.caughtUpBody}
            </EmptyState>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
