import {
  accountingWords,
  Button,
  DateValue,
  Details,
  DetailsList,
  formatInstant,
  isZeroMoney,
  listAccountLabel,
  Money,
  moneySum,
  Notice,
  PageHeader,
  PageSkeleton,
  plainNarration,
  Status,
  useToast,
  useUi,
} from "@rastrata/ui";
import type { ApplicationOutputs } from "@rastrata/application/client-contracts";
import { useParams } from "@tanstack/solid-router";
import { createSignal, For, Show } from "solid-js";
import { AppLink } from "../app-link";
import { BrowserApplicationClient } from "../application-client";
import { createKeyedLoader, createLoader } from "../loader";
import { createReverseController } from "./reverse";
import { ReversalWaiting, ReverseEntryDialog } from "./reverse-dialog";
import { describeFailure, Failure } from "./reports/failure";

type Correction = NonNullable<ApplicationOutputs["journal.get"]["correction"]>;

export function JournalDetailPage() {
  const ui = useUi();
  const toast = useToast();
  const w = accountingWords.entry;
  const params = useParams({ strict: false });
  const scope = new URLSearchParams(window.location.search);
  const client = new BrowserApplicationClient(window.localStorage);
  // A pinned revision only when the address names one (the list pins the revision it was read at). A
  // report's population (its as-of date and fingerprint, and the start of its range when that was not the
  // fiscal year's first day) verifies that this entry belongs to the figures the reader came from.
  const [pinned, setPinned] = createSignal<string | undefined>(scope.get("revision") ?? undefined);
  const reportScoped = Boolean(scope.get("asOf") && scope.get("population"));
  const detailQuery = () => {
    const query = new URLSearchParams();
    const revision = pinned();
    if (revision) query.set("revision", revision);
    for (const key of ["asOf", "population", "reportFrom"])
      if (scope.get(key)) query.set(key, scope.get(key) as string);
    return query;
  };
  // A loader, not a resource: a read never suspends the page (see loader.ts).
  const entry = createKeyedLoader(
    () => params().entryId,
    (id) =>
      client.read("journal.get", {
        journalId: id,
        ...(pinned() ? { revision: pinned() as string } : {}),
        ...(reportScoped
          ? {
              asOf: scope.get("asOf") as string,
              populationHash: scope.get("population") as string,
              ...(scope.get("reportFrom") ? { reportFrom: scope.get("reportFrom") as string } : {}),
            }
          : {}),
      }),
  );
  /** The entry the address names, and never another one that was read before it. */
  const named = () => {
    const value = entry.value();
    return value && value.id === params().entryId ? value : undefined;
  };
  const periods = createLoader(() => client.read("periods.list", {}));
  const entryNumber = (sequence: string) => ui.messages.register.entryNumber(sequence);

  /** What the reversal dialog says of this entry. */
  const target = () => {
    const current = named();
    return current
      ? {
          id: current.id,
          label: entryNumber(current.postingSequence),
          description: current.narration,
          date: current.date,
          amount: moneySum(current.lines.map((line) => line.debit)),
        }
      : undefined;
  };
  const reverse = createReverseController({
    periods: periods.value,
    lookup: (journalId) => {
      const current = target();
      return current && current.id === journalId ? current : undefined;
    },
    onReversed: async () => {
      // The page was read at an earlier revision. From here it follows the book, so it can show the
      // reversal that was just posted.
      if (pinned()) {
        setPinned(undefined);
        const url = new URL(window.location.href);
        url.searchParams.delete("revision");
        window.history.replaceState(window.history.state, "", url);
      }
      await Promise.all([entry.reload(), periods.reload()]);
      toast.show({ message: w.reversedToast });
    },
  });
  /** A reversal is of an entry no reversal has linked, seen as the book stands now: a page pinned to an
   * older revision (a report's, or the list's as it was read) does not know of a reversal made since. */
  const reversible = () => {
    const current = named();
    const head = periods.value()?.bookRevision;
    return (
      current !== undefined &&
      head !== undefined &&
      !reportScoped &&
      current.correction === null &&
      current.viewedAtRevision === head
    );
  };

  return (
    <section class="app-journal-detail rt-acct-page" aria-labelledby="entry-title">
      <PageHeader
        titleId="entry-title"
        title={named() ? entryNumber(named()?.postingSequence ?? "") : w.titleWhileLoading}
        status={
          <Show when={named()}>
            <Status>{ui.messages.status.Posted ?? "Posted"}</Status>
          </Show>
        }
        description={
          named()
            ? plainNarration(
                named()?.narration ?? "",
                named()?.id ?? "",
                named()?.correction ? [named()?.correction as Correction] : [],
                entryNumber,
              )
            : undefined
        }
        actions={
          <Show when={reversible()}>
            <Button
              id="reverse-entry"
              variant="secondary"
              label={w.reverse}
              onClick={() => {
                const found = target();
                if (found) reverse.begin(found);
              }}
            />
          </Show>
        }
      />
      <ReversalWaiting controller={reverse} />
      <Show
        when={!(named() === undefined && entry.loading())}
        fallback={<PageSkeleton shape="statement" label={w.loading} />}
      >
        <Show
          when={entry.error() === undefined}
          fallback={
            // A report that is older than the book, a calendar and a missing book have states of their
            // own; any other failure is this entry not opening.
            <Show
              when={describeFailure(entry.error()).state === "failed"}
              fallback={<Failure error={entry.error()} retry={() => void entry.reload()} />}
            >
              <Notice title={w.failedTitle} tone="problem" role="alert">
                <Show when={describeFailure(entry.error()).detail}>
                  {(detail) => <p>{detail()}</p>}
                </Show>
                <p>{w.failedBody}</p>
                <Button variant="secondary" label={w.retry} onClick={() => void entry.reload()} />{" "}
                <AppLink href="/journal">{w.backToList}</AppLink>
              </Notice>
            </Show>
          }
        >
          <Show
            when={named()}
            fallback={
              <Notice title={w.noBookTitle}>
                <p>{w.noBookBody}</p>
              </Notice>
            }
          >
            {(current) => (
              <>
                <p class="entry-facts">
                  <DateValue value={current().date} /> · <bdi>{current().currency}</bdi>
                </p>
                <ReverseEntryDialog
                  controller={reverse}
                  client={client}
                  returnFocus={() => document.getElementById("reverse-entry")}
                />
                <Show when={current().correction}>
                  {(link) => {
                    const reversedBy = () => link().originalJournalId === current().id;
                    const otherId = () =>
                      reversedBy() ? link().correctionJournalId : link().originalJournalId;
                    const otherNumber = () =>
                      reversedBy()
                        ? link().correctionPostingSequence
                        : link().originalPostingSequence;
                    return (
                      <p class="entry-correction">
                        {reversedBy() ? `${w.reversedBy} ` : `${w.reversal} `}
                        <AppLink
                          href={`/journal/${encodeURIComponent(otherId())}?${detailQuery().toString()}`}
                        >
                          {otherNumber() ? entryNumber(otherNumber() as string) : w.otherEntry}
                        </AppLink>
                      </p>
                    );
                  }}
                </Show>
                <section class="report-scroll" tabindex="0" aria-label={w.linesLabel}>
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">{w.columnAccount}</th>
                        <th scope="col">{w.columnDebit}</th>
                        <th scope="col">{w.columnCredit}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={current().lines}>
                        {(line) => (
                          <tr>
                            <th scope="row">
                              <bdi>{listAccountLabel(line.name ?? line.account, line.code)}</bdi>
                            </th>
                            <td>
                              <Show when={!isZeroMoney(line.debit)}>
                                <Money value={line.debit} />
                              </Show>
                            </td>
                            <td>
                              <Show when={!isZeroMoney(line.credit)}>
                                <Money value={line.credit} />
                              </Show>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                    <tfoot>
                      <tr>
                        <th scope="row">{w.total}</th>
                        <td>
                          <Money value={moneySum(current().lines.map((line) => line.debit))} />
                        </td>
                        <td>
                          <Money value={moneySum(current().lines.map((line) => line.credit))} />
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </section>
                <div class="entry-details">
                  <Details summary={w.detailsSummary}>
                    <DetailsList
                      items={[
                        { label: w.revision, value: current().bookRevision, mono: true },
                        { label: w.sequence, value: current().postingSequence },
                        { label: w.viewedAt, value: current().viewedAtRevision, mono: true },
                        { label: w.recorded, value: formatInstant(current().recordedAt) },
                      ]}
                    />
                    <Show when={current().source}>
                      {(source) => (
                        <section aria-label={w.sourceLabel}>
                          <DetailsList
                            items={[
                              { label: w.sourceEvent, value: source().id, mono: true, copy: true },
                              {
                                label: w.sourceFingerprint,
                                value: source().contentHash,
                                mono: true,
                                copy: true,
                              },
                            ]}
                          />
                          <p>
                            <AppLink
                              href={`/journal/new?source=${encodeURIComponent(source().id)}`}
                            >
                              {w.inspectSource}
                            </AppLink>
                          </p>
                        </section>
                      )}
                    </Show>
                  </Details>
                </div>
              </>
            )}
          </Show>
        </Show>
      </Show>
    </section>
  );
}
