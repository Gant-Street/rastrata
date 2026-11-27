import { SearchPalette, type SearchGroupView, type SearchHitView } from "@rastrata/ui";
import { type Accessor, createEffect, createSignal, on, onCleanup } from "solid-js";
import type { BrowserApplicationClient } from "../application-client";
import type { SearchHit, SearchSource } from "../routes/registry";
import { SearchSession, type SourceResult } from "./engine";

/** The Search dialog with the application's sources behind it. It owns the question, asks the sources
 * through a `SearchSession` (debounced, abortable) while the dialog is open, and hands the chosen result
 * to the shell, which knows how to go there or open a dialog. */
export function SearchHost(props: {
  open: Accessor<boolean>;
  setOpen: (open: boolean) => void;
  sources: readonly SearchSource[];
  client: BrowserApplicationClient;
  onChoose: (hit: SearchHit) => void;
}) {
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<readonly SourceResult[]>([]);
  const session = new SearchSession({
    sources: props.sources,
    client: props.client,
    onChange: setResults,
  });
  // Opening starts from nothing typed (the list of pages and actions); closing stops every read.
  createEffect(
    on(props.open, (open) => {
      if (open) {
        setQuery("");
        session.ask("");
      } else {
        session.close();
      }
    }),
  );
  onCleanup(() => session.close());

  const groups = (): readonly SearchGroupView[] =>
    results().map((result) => ({
      id: result.id,
      label: result.label,
      state: result.state,
      hits: result.hits,
    }));
  const find = (group: SearchGroupView, hit: SearchHitView): SearchHit | undefined =>
    results()
      .find((result) => result.id === group.id)
      ?.hits.find((candidate) => candidate.id === hit.id);

  return (
    <SearchPalette
      open={props.open()}
      onOpenChange={props.setOpen}
      query={query()}
      onQuery={(next) => {
        setQuery(next);
        session.ask(next);
      }}
      groups={groups()}
      onChoose={(group, view) => {
        const hit = find(group, view);
        props.setOpen(false);
        if (hit) props.onChoose(hit);
      }}
    />
  );
}
