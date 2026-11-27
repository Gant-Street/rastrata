import { Show, type JSX } from "solid-js";
import { Button } from "../button";
import { Details, DetailsList } from "../kit/details";
import { entryWords } from "./entry-words";

export interface EntrySourceProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The stable ID of the event the entry records (a bank transaction, an invoice). */
  sourceId: string;
  /** What the event was, in the source's own words. */
  description: string;
  /** Where the evidence of it is, when the source said. */
  evidence: string;
  /** The record is being read. */
  busy?: boolean | undefined;
  /** Read the source's record: what the ledger holds for it, and the entries linked to it. Left out
   * when the record is already shown. */
  onInspect?: (() => void) | undefined;
  /** The record, once read. */
  children?: JSX.Element;
}

/** "Where this entry came from": the event an entry records (a bank transaction, an invoice), by which
 * the ledger refuses to book the same event twice. It is shown, under a disclosure, only when the
 * form is opened for a source (an entry's details lead here) or for a draft that carries one; an
 * entry typed by hand has no such fold. The facts are the source's own and are not edited here: the
 * ID, what happened, and where the evidence is. */
export function EntrySource(props: EntrySourceProps): JSX.Element {
  const w = entryWords.source;
  return (
    <div class="rt-entry-source-fold">
      <Details summary={w.summary} open={props.open} onOpenChange={props.onOpenChange}>
        <DetailsList
          items={[
            { label: w.sourceId, value: props.sourceId, mono: true, copy: true },
            { label: w.description, value: props.description },
            ...(props.evidence.trim() === "" ? [] : [{ label: w.evidence, value: props.evidence }]),
          ]}
        />
        <Show when={props.onInspect}>
          <div class="rt-entry-source-actions">
            <Button
              variant="secondary"
              size="sm"
              label={w.inspect}
              disabled={props.busy === true}
              onClick={() => props.onInspect?.()}
            />
          </div>
        </Show>
        {props.children}
      </Details>
    </div>
  );
}
