import { createUniqueId, For, type JSX, Show } from "solid-js";
import { FileField } from "../file-field";
import { Button, buttonAttrs } from "../button";
import { FieldError } from "../field";
import { formatBytes, formatCount, formatDate, formatFiguresInText } from "../format";
import { Money } from "../money";
import { Notice, Status } from "../notice";
import type {
  TaxAdjustmentEntryView,
  TaxAdjustmentImportedView,
  TaxAdjustmentPreviewView,
  TaxAdjustmentProblemView,
  TaxAdjustmentStatus,
} from "./types";
import { words } from "./words";

const STATUS_WORD: Record<TaxAdjustmentStatus, string> = {
  new: words.statusNew,
  already_imported: words.statusAlready,
  conflict: words.statusConflict,
  invalid: words.statusInvalid,
};

/** One problem with where it is: the row, the entry and the column, then what is wrong in plain words.
 * The words quote the file's own text, which is data and never an instruction. */
function Problem(props: { problem: TaxAdjustmentProblemView }) {
  return (
    <li class="rt-tax-problem" data-severity={props.problem.severity}>
      <Status tone={props.problem.severity === "error" ? "error" : "review"}>
        {props.problem.severity === "error" ? words.problemError : words.problemWarning}
      </Status>{" "}
      <strong>
        {words.problemWhere(props.problem.row, props.problem.entry, props.problem.column)}
      </strong>
      : {formatFiguresInText(props.problem.message)}
    </li>
  );
}

function EntryRow(props: { entry: TaxAdjustmentEntryView; journalHref: string }) {
  const entry = () => props.entry;
  // The status is in its own column, and on a phone under the entry instead (the column is hidden there), so
  // the figures keep the room.
  const status = () => (
    <>
      <Status
        tone={
          entry().status === "new" || entry().status === "already_imported" ? "neutral" : "error"
        }
      >
        {STATUS_WORD[entry().status]}
      </Status>
      <Show when={entry().draft}>
        {(draft) => (
          <small>
            <a href={props.journalHref}>{words.draftLink(entry().entry)}</a>
            <span class="rt-sr-only">, {draft().status}</span>
          </small>
        )}
      </Show>
    </>
  );
  return (
    <tbody class="rt-tax-entry" data-status={entry().status}>
      <tr>
        <th scope="row">
          <strong>{entry().entry}</strong>
          <small>{entry().narration}</small>
          <span class="rt-tax-statusinline">{status()}</span>
        </th>
        <td class="rt-tax-datecell">{entry().date ? formatDate(entry().date as string) : "—"}</td>
        <td class="rt-tax-statuscolumn">{status()}</td>
        <td class="rt-number">
          <Money value={entry().debit} />
        </td>
        <td class="rt-number">
          <Money value={entry().credit} />
        </td>
      </tr>
      <For each={entry().lines}>
        {(line) => (
          <tr class="rt-tax-entryline">
            <td colspan="2">
              <span class="rt-tax-lineaccount">
                <span class="rt-code">{line.account}</span> {line.accountName ?? ""}
              </span>
            </td>
            <td class="rt-tax-statuscolumn" />
            <td class="rt-number">{line.debit !== "0.00" ? <Money value={line.debit} /> : null}</td>
            <td class="rt-number">
              {line.credit !== "0.00" ? <Money value={line.credit} /> : null}
            </td>
          </tr>
        )}
      </For>
      <Show when={entry().problems.length > 0}>
        <tr class="rt-tax-entryproblems">
          <td colspan="5">
            <ul class="rt-tax-problems">
              <For each={entry().problems}>{(problem) => <Problem problem={problem} />}</For>
            </ul>
          </td>
        </tr>
      </Show>
    </tbody>
  );
}

/** What importing a file would do, entry by entry: its lines, its status, and every problem with its place.
 * Nothing here has been saved. */
export function TaxAdjustmentsPreview(props: {
  preview: TaxAdjustmentPreviewView;
  journalHref: string;
}) {
  const titleId = createUniqueId();
  const counts = () => props.preview.counts;
  const blocked = () =>
    !props.preview.canImport &&
    (counts().invalid > 0 ||
      counts().conflict > 0 ||
      props.preview.problems.some((p) => p.severity === "error"));
  return (
    <section class="rt-tax-preview" aria-labelledby={titleId}>
      <h3 id={titleId}>{words.previewTitle}</h3>
      <p class="rt-tax-previewcounts">
        {words.previewCounts(counts().entries, counts().lines)}{" "}
        <Show when={counts().new > 0}>
          <Status>{words.previewNew(counts().new)}</Status>{" "}
        </Show>
        <Show when={counts().alreadyImported > 0}>
          <Status>{words.previewAlready(counts().alreadyImported)}</Status>{" "}
        </Show>
        <Show when={counts().conflict > 0}>
          <Status tone="error">{words.previewConflict(counts().conflict)}</Status>{" "}
        </Show>
        <Show when={counts().invalid > 0}>
          <Status tone="error">{words.previewInvalid(counts().invalid)}</Status>
        </Show>
      </p>
      <Show when={props.preview.problems.length > 0}>
        <ul class="rt-tax-problems">
          <For each={props.preview.problems}>{(problem) => <Problem problem={problem} />}</For>
        </ul>
      </Show>
      <Show when={blocked()}>
        <Notice title={words.previewBlocked} tone="error" role="status" />
      </Show>
      <Show when={!blocked() && !props.preview.canImport && counts().entries > 0}>
        <p class="rt-hint">{words.previewNothingNew}</p>
      </Show>
      <Show when={props.preview.entries.length > 0}>
        <section
          class="rt-table-scroll"
          tabindex={0}
          aria-label={words.tableScroll(words.previewTitle)}
        >
          <table class="rt-table rt-tax-entrytable">
            <thead>
              <tr>
                <th scope="col">{words.entryColumn}</th>
                <th scope="col">{words.entryDate}</th>
                <th scope="col" class="rt-tax-statuscolumn">
                  {words.entryStatus}
                </th>
                <th scope="col" class="rt-number">
                  {words.lineDebit}
                </th>
                <th scope="col" class="rt-number">
                  {words.lineCredit}
                </th>
              </tr>
            </thead>
            <For each={props.preview.entries}>
              {(entry) => <EntryRow entry={entry} journalHref={props.journalHref} />}
            </For>
          </table>
        </section>
      </Show>
    </section>
  );
}

/** Choose an accountant's file, see what importing it would do, and import it as drafts. Choosing a file
 * checks it at once; nothing is saved until the person presses Import, and an import saves drafts only:
 * nothing is posted. A file that cannot be read, a file that is too large and a refusal from the service
 * are each said, and every answer stays. */
export function TaxAdjustmentsImport(props: {
  state: "idle" | "checking" | "checked" | "importing" | "imported" | "failed";
  fileName?: string | undefined;
  fileSize?: number | undefined;
  preview: TaxAdjustmentPreviewView | null;
  imported: TaxAdjustmentImportedView | null;
  /** What is wrong with the file or the request, in words. */
  error?: string | undefined;
  journalHref: string;
  onFile: (file: File) => void;
  onImport: () => void;
  /** An import was sent and its reply was lost: its result is not known. */
  uncertain?: boolean | undefined;
  onResume?: (() => void) | undefined;
  /** The empty template, as another way to start. */
  extra?: JSX.Element;
}) {
  const uid = createUniqueId();
  const busy = () => props.state === "checking" || props.state === "importing";
  const newCount = () => props.preview?.counts.new ?? 0;
  return (
    <div class="rt-tax-adjustments">
      <Show when={props.uncertain}>
        <Notice title={words.importUncertainTitle} tone="review" role="status">
          <p>{words.importUncertainBody}</p>
          <Button
            variant="primary"
            label={words.importResume}
            pending={props.state === "importing"}
            pendingLabel={words.importing}
            onClick={() => props.onResume?.()}
          />
        </Notice>
      </Show>
      <FileField
        class="rt-tax-filepick"
        label={words.fileLabel}
        labelClass="rt-tax-filepick-label"
        // The page's one main button builds the pack; what a chosen file leads to (Import) is the next.
        button={words.fileChoose}
        accept=".csv,.tsv,.txt,text/csv,text/plain"
        disabled={busy()}
        invalid={Boolean(props.error)}
        describedBy={`${uid}-hint${props.error ? ` ${uid}-error` : ""}`}
        onFile={(file) => props.onFile(file)}
        actionsClass="rt-tax-filepick-actions"
        lead={() => (
          <p id={`${uid}-hint`} class="rt-hint">
            {words.fileHint}
          </p>
        )}
        beside={props.extra}
      >
        <Show when={props.fileName}>
          <p class="rt-tax-filename">
            {props.fileName}
            <Show when={props.fileSize !== undefined}> ({formatBytes(props.fileSize ?? 0)})</Show>
          </p>
        </Show>
        <Show when={props.state === "checking"}>
          <p class="rt-hint" role="status">
            {words.fileChecking}
          </p>
        </Show>
        <Show when={props.error}>
          <FieldError id={`${uid}-error`}>{props.error}</FieldError>
        </Show>
      </FileField>
      <Show when={props.state !== "imported" ? props.preview : null}>
        {(preview) => (
          <>
            <TaxAdjustmentsPreview preview={preview()} journalHref={props.journalHref} />
            <Show when={preview().canImport}>
              <div class="rt-tax-importactions">
                <Button
                  variant="primary"
                  label={words.importButton(newCount())}
                  pending={props.state === "importing"}
                  pendingLabel={words.importing}
                  disabled={busy()}
                  onClick={props.onImport}
                />
                <p class="rt-hint">{preview().notice}</p>
              </div>
            </Show>
          </>
        )}
      </Show>
      <Show when={props.state === "imported" && props.imported}>
        {(done) => (
          <section class="rt-tax-imported" role="status">
            <h3>{words.imported(done().created.length)}</h3>
            <p>{words.importedNext}</p>
            <ul>
              <For each={done().created}>{(created) => <li>{created.entry}</li>}</For>
            </ul>
            <Show when={done().skipped.length > 0}>
              <p class="rt-hint">
                {words.previewAlready(done().skipped.length)} ({formatCount(done().skipped.length)})
              </p>
            </Show>
            <p>
              <a {...buttonAttrs({ variant: "secondary", size: "sm" })} href={props.journalHref}>
                {words.openJournal}
              </a>
            </p>
          </section>
        )}
      </Show>
    </div>
  );
}
