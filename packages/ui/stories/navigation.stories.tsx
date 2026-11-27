import { createSignal, For } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Breadcrumbs, Notice, SelectField, Tabs } from "../src";
import { Catalog, Specimen } from "./catalog";
import { Pager } from "./pager";

function Navigation() {
  const [page, setPage] = createSignal(1);
  const [section, setSection] = createSignal("Journal");
  const books = [
    { label: "North Workshop", value: "North Workshop" },
    {
      label: "North Workshop · International operations and subsidiaries",
      value: "North Workshop · International operations and subsidiaries",
    },
  ];
  return (
    <Catalog
      section="04 / Navigation"
      title="Know where you are."
      description="The book, the section, the current view. Navigation describes your place without competing with the work."
    >
      <Specimen
        title="Book & breadcrumbs"
        note="Book identity remains explicit. Long names wrap; they are not silently replaced by an ambiguous abbreviation."
      >
        <div class="rt-stack">
          <SelectField label="Book" items={books} defaultValue="North Workshop" />
          <Breadcrumbs items={[{ label: "Accounting", href: "#journal" }, { label: "Journal" }]} />
        </div>
      </Specimen>
      <Specimen
        title="Local navigation"
        note="A specimen, not a finalized application sitemap. The selected section is communicated without color alone."
      >
        <div class="catalog-shell">
          <nav class="catalog-sidebar" aria-label="Accounting sections">
            <For each={["Journal", "Accounts", "Reports", "Settings"]}>
              {(name) => (
                <a
                  href={`#${name.toLowerCase()}`}
                  aria-current={section() === name ? "page" : undefined}
                  onClick={() => setSection(name)}
                >
                  {name}
                </a>
              )}
            </For>
          </nav>
          <div id="journal">
            <h2>{section()}</h2>
            <p class="rt-hint">North Workshop · Book navigation preview</p>
            <Notice title="Your context stays visible">
              Book identity and the current section should remain clear when moving between tasks.
            </Notice>
          </div>
        </div>
      </Specimen>
      <Specimen
        title="Tabs"
        note="Arrow keys move between related views. Tabs do not replace primary navigation."
      >
        <Tabs
          label="Entry views"
          items={[
            { value: "all", label: "All entries", content: "All entries in this period." },
            {
              value: "draft",
              label: "Drafts",
              content: "Drafts have not been posted to your books.",
            },
            {
              value: "posted",
              label: "Posted",
              content: "Posted entries form part of your accounting record.",
            },
          ]}
        />
      </Specimen>
      <Specimen
        title="Pagination"
        note="Keep the current page visible and disable unavailable directions."
      >
        <Pager count={73} page={page()} pageSize={20} onPageChange={setPage} />
      </Specimen>
    </Catalog>
  );
}
export default {
  title: "Patterns/Navigation",
  component: Navigation,
  parameters: {
    layout: "fullscreen",
    options: { showPanel: false },
    controls: { disable: true },
  },
} satisfies Meta<typeof Navigation>;
export const Review: StoryObj<typeof Navigation> = {};
