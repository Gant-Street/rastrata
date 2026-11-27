import { Button, Notice, registerActionsId, ReverseDialog, accountingWords } from "@rastrata/ui";
import { Show } from "solid-js";
import type { BrowserApplicationClient } from "../application-client";
import type { createReverseController } from "./reverse";

type Controller = ReturnType<typeof createReverseController>;

/** The dialog for one reversal, wired to its controller. It is on the Transactions list and on an
 * entry's page. `returnFocus` is where focus goes when it closes: the row's menu button on the list, the
 * Reverse button on the page. */
export function ReverseEntryDialog(props: {
  controller: Controller;
  client: BrowserApplicationClient;
  returnFocus?: (() => HTMLElement | null) | undefined;
}) {
  const c = props.controller;
  return (
    <Show when={c.target()}>
      {(target) => {
        // Read once: the dialog hands focus back after it has closed, when the target is already gone.
        const entryId = target().id;
        return (
          <ReverseDialog
            open
            label={target().label}
            description={target().description}
            entryDate={target().date}
            amount={target().amount}
            date={c.date()}
            onDate={c.setDate}
            reason={c.reason()}
            onReason={c.setReason}
            dateError={c.errors().date}
            reasonError={c.errors().reason}
            stage={c.stage()}
            warnings={c.warnings()}
            problems={c.problems()}
            error={c.error()}
            uncertain={c.pending() !== null}
            onResume={() => void c.resume()}
            onSubmit={() => void c.submit()}
            onConfirm={() => void c.confirm()}
            onCancel={c.cancel}
            returnFocus={
              props.returnFocus ?? (() => document.getElementById(registerActionsId(entryId)))
            }
          />
        );
      }}
    </Show>
  );
}

/** Said on a page while a reversal's request is retained and its dialog is not open (after a reload):
 * the request is resumed, never replaced. */
export function ReversalWaiting(props: { controller: Controller }) {
  const c = props.controller;
  const w = accountingWords.reverse;
  return (
    <Show when={c.pending() !== null && c.target() === null}>
      <Notice title={w.waitingTitle} tone="attention" role="status">
        <p>{w.retained}</p>
        <Button variant="secondary" label={w.resume} onClick={() => void c.resume()} />
      </Notice>
    </Show>
  );
}
