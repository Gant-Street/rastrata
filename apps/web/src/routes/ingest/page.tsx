import { InboxWorkspace, inboxWords, undoWords, useToast } from "@rastrata/ui";
import { createMemo, onMount } from "solid-js";
import { AppLink } from "../../app-link";
import { acceptMode, bookSettingsNow } from "../../book-settings";
import { capabilities } from "../../capabilities";
import { undoMessage } from "../entries/undo";
import { createInbox, type RecordedResult } from "./controller";
import { accountChoicesOf, bankingSummary } from "./summary";
import { VIEW_HREFS } from "./view";

/** Transactions, the view that waits for review: bank transactions from statements and connected
 * accounts, each with its category and Accept on its row. The page is wiring: the controller owns the
 * data and the work, and the workspace owns how it looks. The accounts the list can be narrowed to come
 * from the same banking summary Home's tiles read. */
export function InboxPage() {
  const toast = useToast();
  // Said once an action has gone through, with the way back: Undo reverses what was posted (a linked
  // entry, so the books keep the whole story) or returns what was only saved as a draft.
  const said = (result: RecordedResult) =>
    toast.show({
      message:
        result.kind === "posted"
          ? inboxWords.results.posted(result.count)
          : inboxWords.results.saved(result.count),
      action: {
        label: undoWords.action,
        onSelect: () => void takeBack(result.ids, result.kind === "saved"),
      },
    });
  const inbox = createInbox({
    acceptMode,
    settingsNow: () => bookSettingsNow().then(() => undefined),
    onDone: said,
  });
  /** Undo from the toast, a row or the pane: what came of it is a toast too, in the books' own words. */
  async function takeBack(ids: readonly string[], saved: boolean) {
    const summary = await inbox.undo(ids, saved);
    if (summary) toast.show(undoMessage(summary));
  }
  const banking = bankingSummary();
  // Show what is known at once and read again in the background, so the accounts are current.
  onMount(() => void banking.reload(2_000));
  const accountChoices = createMemo(() => accountChoicesOf(banking.tiles()));
  return (
    <InboxWorkspace
      state={inbox.state()}
      refreshing={inbox.refreshing()}
      counts={inbox.counts()}
      tab={inbox.tab()}
      onTab={inbox.setTab}
      filters={inbox.filters()}
      onFilters={inbox.setFilters}
      accountChoices={accountChoices()}
      sources={inbox.sources()}
      accounts={inbox.accounts()}
      items={inbox.items()}
      matching={inbox.matching()}
      suggestions={inbox.suggestions()}
      mode={inbox.mode()}
      page={inbox.page()}
      pageSize={inbox.pageSize}
      onPage={inbox.setPage}
      activeId={inbox.activeId()}
      onActive={inbox.setActive}
      pinned={inbox.pinned()}
      selected={inbox.selected()}
      allMatching={inbox.allMatching()}
      onToggle={inbox.toggle}
      onSelectMatching={inbox.selectMatching}
      onClearSelection={inbox.clearSelection}
      detail={inbox.detail()}
      onRetryDetail={inbox.retryDetail}
      actions={inbox.actions}
      onUndo={(ids) => void takeBack(ids, false)}
      busy={inbox.busy()}
      progress={inbox.progress()}
      note={inbox.note()}
      onDismissNote={inbox.dismissNote}
      uncertain={inbox.uncertain()}
      onResume={inbox.resume}
      onSaveSource={inbox.saveSource}
      onRetry={inbox.retry}
      // The view that is another page ("All") opens the way every page of the application does.
      renderViewLink={(view, extras) => (
        <AppLink href={view.href} class={extras.class}>
          {extras.children}
        </AppLink>
      )}
      links={{
        entry: (journalId) => `/journal/${encodeURIComponent(journalId)}`,
        reconciliation: (id) => `/reconcile/${encodeURIComponent(id)}`,
        item: (itemId) => `/inbox?item=${encodeURIComponent(itemId)}`,
        rule: (ruleId) => `/rules/${encodeURIComponent(ruleId)}`,
        newRule: (itemId) => `/rules/new?item=${encodeURIComponent(itemId)}`,
        importHref: "/import",
        rulesHref: "/rules",
        views: VIEW_HREFS,
        // A service that cannot keep a bank connection offers none.
        ...(capabilities().connections
          ? { connectHref: "/settings/bankfeed" }
          : capabilities().banks
            ? { connectHref: "/settings/banks" }
            : {}),
      }}
    />
  );
}
