import { Match, Show, Switch } from "solid-js";
import { PageSkeleton } from "../skeleton";
import { Button } from "../button";
import { EmptyState } from "../kit/empty-state";
import { Notice } from "../notice";
import { PageHeader } from "../page-header";
import { Pager } from "../pager";
import { ChangeList } from "./change-list";
import { ChangesFilters } from "./filters";
import { emptyKind, groupByDay, type MarkVerdict, markVerdict, unreadSources } from "./logic";
import { ChangesNotes, UnreadNotice } from "./notes";
import { ReviewBar } from "./review-bar";
import { ChangesSummary } from "./summary";
import type { ChangeListView, ChangesLoad, LookState, SubjectView } from "./types";
import { type ChangesScreenState, filtersActive } from "./url-state";
import { words } from "./words";

/** While a newer list is being read the one on the screen cannot be marked as looked at: the choices
 * are already the new ones, and the list is not. */
const NOT_NOW: MarkVerdict = { ok: false, reason: "nothing" };

export interface ChangesWorkspaceProps {
  load: ChangesLoad;
  /** A newer list is being read while the one on the screen stays. */
  busy?: boolean | undefined;
  list: ChangeListView | undefined;
  /** Why the last read failed, in words. */
  failure?: string | undefined;
  state: ChangesScreenState;
  /** The viewer's day, `YYYY-MM-DD`, for "Today" and "Yesterday". */
  today: string;
  /** A zone to read times in; the viewer's own when left out. */
  timeZone?: string | undefined;
  look: LookState;
  /** Takes the title, so the page can move focus to it when it opens. */
  titleRef?: ((element: HTMLHeadingElement) => void) | undefined;
  onChange: (patch: Partial<ChangesScreenState>) => void;
  onClear: () => void;
  onRetry: () => void;
  onReload: () => void;
  onLook: () => void;
  /** Where a change's own page is, or nothing. The screen has no addresses of its own. */
  hrefFor: (subject: SubjectView) => string | undefined;
}

/** Changes: one list of what changed in the books, who made it and when, newest first, with the person's
 * statement that they have looked at it. Nothing here changes a figure or asks for approval: a change in
 * the list has already happened. */
export function ChangesWorkspace(props: ChangesWorkspaceProps) {
  return (
    <div class="rt-changes" aria-busy={props.busy ? true : undefined}>
      <PageHeader
        title={words.title}
        titleId="changes-title"
        {...(props.titleRef === undefined ? {} : { titleRef: props.titleRef })}
        description={words.description}
      />
      <ChangesFilters
        state={props.state}
        actors={props.list?.actors ?? []}
        caller={props.list?.caller}
        onChange={props.onChange}
      />
      <Show when={props.load === "failed"}>
        <Notice title={words.failedTitle} tone="problem" role="alert">
          <Show when={props.failure}>
            <p>{props.failure}</p>
          </Show>
          <p>{words.failedBody}</p>
          <Button
            type="button"
            label={words.retry}
            variant="secondary"
            size="sm"
            onClick={() => props.onRetry()}
          />
        </Notice>
      </Show>
      <Switch>
        <Match when={props.list}>{(list) => <Loaded {...props} list={list()} />}</Match>
        <Match when={props.load === "loading"}>
          <PageSkeleton shape="table" label={words.loading} />
        </Match>
      </Switch>
    </div>
  );
}

function Loaded(props: ChangesWorkspaceProps & { list: ChangeListView }) {
  const unread = () => unreadSources(props.list).filter((source) => source.name !== "review");
  const groups = () => groupByDay(props.list.changes, props.today, props.timeZone);
  const pastTheEnd = () => props.list.changes.length === 0 && props.list.count > 0;
  const empty = () => props.list.count === 0;
  return (
    <div class="rt-changes-body" data-stale={props.load === "failed" ? "" : undefined}>
      <ChangesSummary
        list={props.list}
        timeZone={props.timeZone}
        busy={props.busy}
        onReload={props.onReload}
      />
      <Show when={unread().length > 0}>
        <UnreadNotice sources={unread()} />
      </Show>
      <ReviewBar
        verdict={props.busy ? NOT_NOW : markVerdict(props.list, props.state)}
        look={props.look}
        lastReview={props.list.lastReview}
        asOf={props.list.asOf}
        caller={props.list.caller}
        timeZone={props.timeZone}
        onLook={props.onLook}
        onReload={props.onReload}
        onClear={props.onClear}
        onFromLastLook={() => props.onChange({ since: "look" })}
      />
      <Show when={empty()}>
        <Empty {...props} />
      </Show>
      <Show when={pastTheEnd()}>
        <EmptyState
          title={words.pastEnd.title}
          live
          action={
            <Button
              type="button"
              label={words.pastEnd.action}
              variant="secondary"
              onClick={() => props.onChange({ page: 1 })}
            />
          }
        >
          {words.pastEnd.body}
        </EmptyState>
      </Show>
      <Show when={props.list.changes.length > 0}>
        <ChangeList
          groups={groups()}
          caller={props.list.caller}
          timeZone={props.timeZone}
          hrefFor={props.hrefFor}
        />
      </Show>
      <Show when={props.list.count > props.list.pageSize}>
        <Pager
          count={props.list.count}
          page={props.list.page}
          pageSize={props.list.pageSize}
          onPageChange={(page) => props.onChange({ page })}
        />
      </Show>
      <ChangesNotes list={props.list} timeZone={props.timeZone} />
    </div>
  );
}

function Empty(props: ChangesWorkspaceProps & { list: ChangeListView }) {
  const kind = () => emptyKind(props.list, props.state);
  return (
    <Switch>
      <Match when={kind() === "filtered"}>
        <EmptyState
          title={words.emptyFiltered.title}
          live
          action={
            filtersActive(props.state) ? (
              <Button
                type="button"
                label={words.clear}
                variant="secondary"
                onClick={() => props.onClear()}
              />
            ) : undefined
          }
        >
          {words.emptyFiltered.body}
        </EmptyState>
      </Match>
      <Match when={kind() === "after-look"}>
        <EmptyState
          title={words.emptyAfterLook.title}
          live
          action={
            <Button
              type="button"
              label={words.emptyAfterLook.action}
              variant="secondary"
              onClick={() => props.onChange({ since: "all" })}
            />
          }
        >
          {words.emptyAfterLook.body}
        </EmptyState>
      </Match>
      <Match when={kind() === "window"}>
        <EmptyState
          title={words.emptyWindow.title}
          live
          action={
            <Button
              type="button"
              label={words.emptyWindow.action}
              variant="secondary"
              onClick={() => props.onChange({ since: "all" })}
            />
          }
        >
          {words.emptyWindow.body}
        </EmptyState>
      </Match>
      <Match when={kind() === "book"}>
        <EmptyState title={words.emptyBook.title} live>
          {words.emptyBook.body}
        </EmptyState>
      </Match>
    </Switch>
  );
}
