import { createMemo, For, type JSX, Show } from "solid-js";
import { Button } from "../button";
import { Details, ToneMarker } from "../kit";
import { Notice } from "../notice";
import { ReportBusy } from "../reports/report-state";
import { groupChecks, type TaxCheckItem } from "./logic";
import type { TaxCheckView } from "./types";
import { words } from "./words";

type RenderLink = (href: string, children: JSX.Element) => JSX.Element;

/** A fact about the figures that is true of every book on most days and that nobody can act on. */
const NEVER_SAID: ReadonlySet<string> = new Set(["year_not_ended"]);

/** The orange rows: acting on one would change the figures on the page. A mark, what it found, said
 * once, and a link that names what it fixes. */
function AttentionItem(props: { item: TaxCheckItem; link: RenderLink }) {
  return (
    <li class="rt-tax-check" data-severity="attention" data-check={props.item.key}>
      <span class="rt-tax-check-marker">
        <ToneMarker tone="attention" />
      </span>
      <div>
        <p class="rt-tax-check-detail">{props.item.detail}</p>
        <Show when={props.item.href}>
          <p class="rt-tax-check-fix">{props.link(props.item.href as string, props.item.fix)}</p>
        </Show>
      </div>
    </li>
  );
}

/** One line of good practice: done, not done yet, or not known. Grey: it is the person's to do when they
 * like, and nothing about the figures changes when they do. */
function CalmItem(props: { item: TaxCheckItem; link: RenderLink }) {
  const state = () =>
    props.item.status === "ok" ? "done" : props.item.status === "unknown" ? "unknown" : "todo";
  return (
    <li class="rt-tax-check" data-severity="calm" data-state={state()} data-check={props.item.key}>
      <span class="rt-tax-check-marker" aria-hidden="true">
        <Show when={state() === "done"}>
          <ToneMarker tone="calm" announce={false} />
        </Show>
        <Show when={state() === "unknown"}>?</Show>
      </span>
      <div>
        <p class="rt-tax-check-title">
          <strong>{props.item.title}</strong>
          <span class="rt-tax-check-status">
            {state() === "done"
              ? words.checkDone
              : state() === "unknown"
                ? words.checkUnknown
                : words.checkNotYet}
          </span>
        </p>
        <p class="rt-tax-check-detail">{props.item.detail}</p>
        <Show when={props.item.href}>
          <p class="rt-tax-check-fix">{props.link(props.item.href as string, props.item.fix)}</p>
        </Show>
      </div>
    </li>
  );
}

/** What to know before a year's figures are relied on, sorted by what it asks of the person.
 *
 * - **Orange** rows are the ones where acting would change the figures on the page (transactions still
 *   waiting for review are not in them). Nothing else is orange, so a normal book shows none, and a new
 *   book is not a list of warnings.
 * - **Notes** are facts about the figures (the form is an early release, the books start part-way):
 *   plain text under the choices, not a warning. That the year is not over is not said: everyone knows,
 *   and nobody can act on it. A screen leaves out the notes that belong to another (`omitNotes`).
 * - **Good practice** (closed months, reconciled accounts, decided 1099 vendors) is grey, behind a line
 *   that says how much of it is done.
 *
 * Every link names what it fixes. A check that could not be made is never shown as done. The list holds
 * its place while it is read again, and says when the read failed. What it says is the book's own state,
 * so the page's budget of instruction does not count it (`data-facts`). */
export function TaxChecks(props: {
  checks: readonly TaxCheckView[];
  /** The tax year the checks are about, said in their sentences. */
  year: number;
  state: "ready" | "loading" | "error";
  onRetry?: (() => void) | undefined;
  /** A link for a check's fix, so the application can use its router. */
  renderLink?: RenderLink | undefined;
  /** Start with the good practice open (stories and tests). */
  goodPracticeOpen?: boolean | undefined;
  /** Notes this screen does not say: the form's draft status belongs where the form is chosen. */
  omitNotes?: readonly string[] | undefined;
}) {
  const groups = createMemo(() => groupChecks(props.checks, props.year));
  const notes = () =>
    groups().notes.filter(
      (item) => !NEVER_SAID.has(item.key) && !props.omitNotes?.includes(item.key),
    );
  const link: RenderLink = (href, children) =>
    props.renderLink ? props.renderLink(href, children) : <a href={href}>{children}</a>;
  return (
    <section class="rt-tax-checks" aria-label={words.checksRegion} data-facts="">
      <Show when={props.state === "error" && props.checks.length === 0}>
        <Notice title={words.checksFailed} tone="problem" role="alert">
          <Show when={props.onRetry}>
            <Button variant="secondary" label={words.retry} onClick={() => props.onRetry?.()} />
          </Show>
        </Notice>
      </Show>
      <Show when={props.state === "loading" && props.checks.length === 0}>
        <p class="rt-hint" role="status">
          {words.checksLoading}
        </p>
      </Show>
      <Show when={props.state === "error" && props.checks.length > 0}>
        <Notice title={words.checksStale} tone="info" role="status">
          <Show when={props.onRetry}>
            <Button variant="secondary" label={words.retry} onClick={() => props.onRetry?.()} />
          </Show>
        </Notice>
      </Show>
      <Show when={props.checks.length > 0}>
        <ReportBusy busy={props.state === "loading"}>
          <Show when={groups().attention.length > 0}>
            <ul class="rt-tax-checklist rt-tax-attention">
              <For each={groups().attention}>
                {(item) => <AttentionItem item={item} link={link} />}
              </For>
            </ul>
          </Show>
          <Show when={notes().length > 0}>
            <ul class="rt-tax-about" aria-label={words.notesLabel}>
              <For each={notes()}>
                {(item) => (
                  <li data-check={item.key}>
                    <p>{item.detail}</p>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={groups().calm.length > 0}>
            <div class="rt-tax-goodpractice">
              <Details
                summary={words.goodPractice}
                preview={words.goodPracticeDone(groups().done, groups().calm.length)}
                defaultOpen={props.goodPracticeOpen ?? false}
              >
                <ul class="rt-tax-checklist">
                  <For each={groups().calm}>{(item) => <CalmItem item={item} link={link} />}</For>
                </ul>
              </Details>
            </div>
          </Show>
        </ReportBusy>
      </Show>
    </section>
  );
}
