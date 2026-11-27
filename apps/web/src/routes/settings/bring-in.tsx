import { IndexList, type IndexLinkProps, PageHeader, settingsWords } from "@rastrata/ui";
import { For, type JSX } from "solid-js";
import { AppLink } from "../../app-link";

const words = settingsWords.bringIn;

const link = (props: IndexLinkProps): JSX.Element => <AppLink {...props} />;

/** Settings, Bring in your books: one page with every way books from before come in. Starting from a
 * date, past years, and the three steps of a move from Xero, each a link to the page that does it. The
 * pages keep their addresses (/opening, /settings/history, /xero, /tie-out, /gaps), Search finds each by
 * its own name, and the address that used to list Xero's three steps (/settings/move) opens this page. */
export function BringInPage() {
  const groups = [
    { id: "date", label: words.groups.date, entries: [{ ...words.opening, href: "/opening" }] },
    {
      id: "history",
      label: words.groups.history,
      entries: [{ ...words.history, href: "/settings/history" }],
    },
    {
      id: "xero",
      label: words.groups.xero,
      entries: [
        { ...words.xeroImport, href: "/xero" },
        { ...words.xeroCompare, href: "/tie-out" },
        { ...words.xeroCheck, href: "/gaps" },
      ],
    },
  ];
  return (
    <section aria-labelledby="bring-in-title">
      <PageHeader titleId="bring-in-title" title={words.title} />
      <div class="rt-report-index">
        <For each={groups}>
          {(group) => (
            <section aria-labelledby={`bring-in-${group.id}`}>
              <h2 id={`bring-in-${group.id}`} class="rt-report-index-title">
                {group.label}
              </h2>
              <IndexList label={group.label} link={link} entries={group.entries} />
            </section>
          )}
        </For>
      </div>
    </section>
  );
}
