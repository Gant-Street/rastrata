import type { BookSetup } from "@rastrata/application/client-contracts";
import {
  BookFacts,
  Button,
  monthName,
  Notice,
  PageHeader,
  PageSkeleton,
  settingsWords,
} from "@rastrata/ui";
import { formatDate } from "@rastrata/ui/format";
import { Show } from "solid-js";
import { AppLink } from "../../app-link";
import { BrowserApplicationClient } from "../../application-client";
import { currentAccount } from "../../boot";
import { createLoader } from "../../loader";
import { workspaceReadOnly } from "../../standing";
import { BusinessSettings } from "../entries/business-settings";
import { YearStartPanel } from "./year-start";

const words = settingsWords.business;

/** The day the books began: the day the setup names, else the first day of the first fiscal year (a
 * book made before the setup could say). The calendar may begin earlier. */
function booksBeganOf(setup: BookSetup): string {
  const month = String(setup.fiscalYearStartMonth ?? 1).padStart(2, "0");
  return setup.booksStartOn ?? `${setup.fiscalYear}-${month}-01`;
}

/** What was fixed when the book was created, as rows. Read-only. The business name is not among them: it
 * can be changed, so it is the first field of the form below these, which is the only place it is shown. */
export function factsOf(setup: BookSetup) {
  return [
    { label: words.fiscalYear, value: monthName(setup.fiscalYearStartMonth ?? 1) },
    { label: words.booksBegan, value: formatDate(booksBeganOf(setup)) },
    { label: words.method, value: setup.basis === "cash" ? words.cash : words.accrual },
    { label: words.currency, value: setup.currency },
    {
      label: words.periods,
      value: setup.periodModel === "quarterly" ? words.quarterly : words.monthly,
    },
  ];
}

/** Settings, Business: the facts of the book, and the theme (which used to be reachable only from the
 * footer). On a service with accounts its last line opens Workspace, where the books are exported and
 * the workspace is deleted. */
export function BusinessPage() {
  const client = new BrowserApplicationClient(window.localStorage);
  const book = createLoader(() => client.read("book.get", {}));
  // The calendar says whether the fiscal year can still be changed (until the first entry).
  const calendar = createLoader(() => client.read("periods.list", {}));
  return (
    <section aria-labelledby="business-title">
      <PageHeader titleId="business-title" title={words.title} />
      <Show
        when={book.value()}
        fallback={
          <Show
            when={book.error() !== undefined}
            fallback={<PageSkeleton shape="form" label={words.loading} />}
          >
            <Notice title={words.failed} tone="error" role="alert">
              <Button variant="secondary" label={words.retry} onClick={() => void book.reload()} />
            </Notice>
          </Show>
        }
      >
        {(context) => (
          <Show
            when={context().setup}
            fallback={
              <Notice title={words.none} tone="info">
                <p>{words.noneBody}</p>
              </Notice>
            }
          >
            {(setup) => (
              <>
                {/* What can be changed comes first (the name, how dates and lists read, what Accept does),
                    then what was fixed when the book was created. */}
                {/* Changing the name and the display settings needs `configure`: a person without it (an accountant, a member) is shown the book and told who changes it, and not a form that would be refused. */}
                <Show
                  when={context().permissions.includes("configure") && !workspaceReadOnly()}
                  fallback={
                    <Notice title={words.readOnly} tone="info">
                      <p>
                        {workspaceReadOnly()
                          ? "This workspace is read-only. Subscribe to change business settings."
                          : words.readOnlyBody}
                      </p>
                    </Notice>
                  }
                >
                  <BusinessSettings />
                </Show>
                <BookFacts
                  label={words.facts}
                  title={words.facts}
                  hint={words.factsHint}
                  facts={
                    context().permissions.includes("configure") && !workspaceReadOnly()
                      ? factsOf(setup())
                      : [{ label: words.name, value: setup().name }, ...factsOf(setup())]
                  }
                />
                <Show
                  when={
                    context().permissions.includes("configure") &&
                    !workspaceReadOnly() &&
                    calendar.value()?.calendar.canChangeYearStart
                  }
                >
                  <YearStartPanel
                    client={client}
                    month={setup().fiscalYearStartMonth ?? 1}
                    onChanged={() => {
                      void book.reload();
                      void calendar.reload();
                    }}
                  />
                </Show>
              </>
            )}
          </Show>
        )}
      </Show>
      <Show when={currentAccount()}>
        <p class="rt-settings-more">
          <AppLink href="/settings/workspace">{words.workspace}</AppLink>
        </p>
      </Show>
    </section>
  );
}
