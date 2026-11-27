import { createEffect, createSignal, createUniqueId, For, Show } from "solid-js";
import { SelectField } from "../select-field";
import { CheckField } from "../accounting-controls";
import { Button } from "../button";
import { formatDateRange, formatFiguresInText, formatMoney, transactionsIn } from "../format";
import { Details } from "../kit";
import { Notice } from "../notice";
import { DateField } from "../date-field";
import { TextField } from "../text-field";
import { ImportDiagnostics } from "./diagnostics";
import { ImportLineTable } from "./line-table";
import { ImportMappingEditor } from "./mapping-editor";
import { ImportBalanceCheck, ImportSummary } from "./summary";
import type { ImportMapping, ImportPreviewData, PresetInfo, SampleFilter } from "./types";
import { words } from "./words";

/** The page's one decision point, in the order a person needs it: what was found, in one sentence; what
 * stands in the way, if anything does; the button; the first rows. How the file was read, its totals,
 * the balance check, the notes, the columns and the rarer options are under Details, which opens by
 * itself only when the columns need choosing. Everything shown is from the preview the service made of
 * the uploaded file; nothing has been imported. */
export function ImportReview(props: {
  preview: ImportPreviewData;
  /** A newer preview is being fetched; the figures shown may change. */
  refreshing?: boolean | undefined;
  /** Why the latest preview could not be had, when what is shown is the one before it. */
  failed?: string | undefined;
  filter: SampleFilter;
  page: number;
  startOn: string;
  catchUp: boolean;
  ignoreIds: boolean;
  invertBalance: boolean;
  skipRows: boolean;
  committing?: boolean | undefined;
  /** Identifies the file and account, so the column editor starts again for another one. */
  resetKey: string;
  /** The layouts a person may choose by name, for a file that does not say which bank it is from. */
  presets?: readonly PresetInfo[] | undefined;
  /** The layout the person chose, or empty while the file's own header decides. */
  presetId?: string | undefined;
  save?: {
    name: string;
    saving: boolean;
    message?: string | undefined;
    error?: string | undefined;
    onName: (name: string) => void;
    onSave: () => void;
  };
  onFilter: (filter: SampleFilter) => void;
  onPage: (page: number) => void;
  onStartOn: (date: string) => void;
  onCatchUp: (value: boolean) => void;
  onIgnoreIds: (value: boolean) => void;
  onInvertBalance: (value: boolean) => void;
  onSkipRows: (value: boolean) => void;
  onMapping: (mapping: ImportMapping) => void;
  onPreset?: ((presetId: string) => void) | undefined;
  onOfxAccount: (key: string) => void;
  onCommit: () => void;
  onStartOver: () => void;
}) {
  const uid = createUniqueId();
  const p = () => props.preview;
  const detection = () => {
    const how = p().detection.how;
    if (how === "preset" && p().detection.preset)
      return { text: words.presetNote(p().detection.preset?.name ?? "") };
    if (how === "profile") return { text: words.profileNote(p().detection.profile?.name ?? "") };
    if (how === "detected") return { text: words.detectedNote };
    if (how === "mapping") return { text: words.mappingNote };
    if (how === "ofx")
      return { text: words.ofxNote(p().ofx?.institution ?? "", p().ofx?.version ?? "") };
    return { text: words.noneNote };
  };
  const isCsv = () => p().format === "csv";
  const newCount = () => p().counts.new;
  const skippable = () => !p().valid && p().errors > 0 && p().counts.lines > 0 && p().skippable;
  const canImport = () => (p().valid || (skippable() && props.skipRows)) && !props.committing;
  const columnsOpen = () =>
    p().detection.how === "none" ||
    p().detection.how === "detected" ||
    (!p().valid && isCsv() && p().counts.lines === 0);
  // The column editor opens by itself when the columns were only guessed, and then stays as the
  // person leaves it: it never closes under them when the preview becomes valid.
  const [columnsShown, setColumnsShown] = createSignal(false);
  createEffect(() => {
    if (columnsOpen()) setColumnsShown(true);
  });
  const presetGroups = () => {
    const list = props.presets ?? [];
    return [
      { label: words.presetBanks, items: list.filter((item) => item.kind === "bank") },
      { label: words.presetCards, items: list.filter((item) => item.kind === "card") },
    ].filter((group) => group.items.length > 0);
  };
  const chosenPreset = () => props.presets?.find((item) => item.id === props.presetId);
  const multiple = () => (p().ofx?.accounts.length ?? 0) > 1;
  const card = () => p().account.role === "liability";

  const already = () => p().counts.duplicate + p().counts.overlap;
  /** The balance the file states, when it states one: the last thing the one sentence says. */
  const endsAt = () => {
    const reported = p().balances[0]?.reported;
    return reported === undefined ? "" : formatMoney(reported);
  };
  const found = () =>
    words.found({
      fresh: newCount(),
      already: already(),
      keptOut: p().counts.excluded,
      leftOut: p().counts.skipped,
      range: p().range.from
        ? formatDateRange(p().range.from ?? "", p().range.to ?? p().range.from ?? "")
        : "",
      endsAt: endsAt(),
    });
  const nothingToDo = () => newCount() === 0 && p().counts.excluded === 0;
  /** What stands in the way, or should be read before importing: never a note. */
  const troubles = () => p().diagnostics.filter((item) => item.severity !== "info");
  const notes = () => p().diagnostics.filter((item) => item.severity === "info");
  // Details opens by itself when the person has something to do in it (the columns were guessed or could
  // not be told apart), and then stays as they leave it.
  const [detailsShown, setDetailsShown] = createSignal(false);
  createEffect(() => {
    if (columnsOpen()) setDetailsShown(true);
  });

  return (
    <div class="rt-imp-review" aria-busy={props.refreshing ? true : undefined}>
      <Show when={props.failed}>
        <Notice title={words.previewFailed} tone="error" role="alert">
          {props.failed}
        </Notice>
      </Show>
      <Show when={props.refreshing}>
        <p class="rt-sr-only" role="status">
          {words.refreshing}
        </p>
      </Show>

      <Show when={multiple()}>
        <SelectField
          label={words.fileAccount}
          placeholder={words.chooseColumn}
          value={p().ofx?.selected ?? ""}
          items={(p().ofx?.accounts ?? []).map((account) => ({
            value: account.key,
            label: `${account.label} · ${account.count} ${account.count === 1 ? "transaction" : "transactions"}`,
          }))}
          onChange={props.onOfxAccount}
        />
      </Show>

      <Show when={p().counts.lines > 0}>
        <p class="rt-imp-found" data-facts>
          {found()}
        </p>
      </Show>

      <Show when={p().hints.length > 0}>
        <Notice title={words.hints} tone="review">
          <ul class="rt-imp-hints" data-facts>
            <For each={p().hints}>
              {(hint) => <li>{formatFiguresInText(transactionsIn(hint))}</li>}
            </For>
          </ul>
        </Notice>
      </Show>

      <Show when={troubles().length > 0}>
        <ImportDiagnostics
          diagnostics={troubles()}
          errors={p().errors}
          warnings={p().warnings}
          infos={0}
        />
      </Show>

      <div class="rt-imp-commit">
        <Show when={skippable()}>
          <CheckField
            label={words.skipRows(p().errors)}
            checked={props.skipRows}
            onChange={props.onSkipRows}
          />
        </Show>
        <div class="rt-imp-commit-actions">
          <Show when={p().counts.lines > 0 && !(p().valid && nothingToDo())}>
            <Button
              label={words.importButton(newCount())}
              pending={props.committing === true}
              pendingLabel={words.importing}
              disabled={!canImport() || nothingToDo()}
              onClick={props.onCommit}
            />
          </Show>
          <Button
            label={words.startOver}
            variant={p().counts.lines === 0 || (p().valid && nothingToDo()) ? "secondary" : "quiet"}
            disabled={props.committing === true}
            onClick={props.onStartOver}
          />
        </div>
      </div>

      <ImportLineTable
        lines={p().sample.lines}
        count={p().sample.count}
        page={props.page}
        pageSize={p().sample.pageSize}
        filter={props.filter}
        rows={p().errors > 0}
        loading={props.refreshing}
        onFilter={props.onFilter}
        onPage={props.onPage}
      />

      <Details
        summary={words.details}
        preview={words.detailsPreview(detection().text.replace(/\.$/, ""), isCsv())}
        open={detailsShown()}
        onOpenChange={setDetailsShown}
      >
        <div class="rt-imp-details">
          <section aria-labelledby={`${uid}-read`}>
            <h3 id={`${uid}-read`}>{words.readAs}</h3>
            <p class="rt-imp-read" data-facts>
              {detection().text}
            </p>
            <Show when={isCsv()}>
              <Details
                class="rt-imp-columns"
                flush
                summary={words.columnsTitle}
                open={columnsShown()}
                onOpenChange={setColumnsShown}
              >
                <Show when={props.onPreset && presetGroups().length > 0}>
                  <div class="rt-imp-preset">
                    <SelectField
                      label={words.presetTitle}
                      disabled={props.committing === true}
                      describedBy={chosenPreset() ? `${uid}-preset-hint` : undefined}
                      value={chosenPreset()?.id ?? ""}
                      items={[
                        {
                          value: "",
                          label:
                            p().detection.how === "mapping" ? words.presetMine : words.presetAuto,
                        },
                        ...presetGroups().flatMap((group) =>
                          group.items.map((preset) => ({
                            value: preset.id,
                            label: words.presetOption(preset.name, preset.verified),
                            group: group.label,
                          })),
                        ),
                      ]}
                      onChange={(value) => props.onPreset?.(value)}
                    />
                    <Show when={chosenPreset()}>
                      {(preset) => (
                        <p id={`${uid}-preset-hint`} class="rt-hint" data-facts>
                          {words.presetExpects(preset().summary)}
                        </p>
                      )}
                    </Show>
                  </div>
                </Show>
                <ImportMappingEditor
                  columns={p().columns}
                  mapping={p().mapping}
                  headerRow={p().mapping?.headerRow ?? p().detection.headerRow ?? 0}
                  resetKey={props.resetKey}
                  disabled={props.committing}
                  onChange={props.onMapping}
                />
                <Show when={props.save}>
                  {(save) => (
                    <div class="rt-imp-save">
                      <TextField
                        label={words.profileName}
                        value={save().name}
                        maxLength={80}
                        onInput={(event) => save().onName(event.currentTarget.value)}
                      />
                      <Button
                        label={words.saveProfile}
                        variant="secondary"
                        pending={save().saving}
                        pendingLabel={words.importing}
                        disabled={save().name.trim() === ""}
                        onClick={save().onSave}
                      />
                      <Show when={save().message}>
                        <p role="status" class="rt-hint">
                          {save().message}
                        </p>
                      </Show>
                      <Show when={save().error}>
                        <p role="alert" class="rt-error">
                          {save().error}
                        </p>
                      </Show>
                    </div>
                  )}
                </Show>
              </Details>
            </Show>
          </section>

          <Show when={p().counts.lines > 0}>
            <ImportSummary counts={p().counts} totals={p().totals} range={p().range} />
            <ImportBalanceCheck checks={p().balances} card={card()} />
          </Show>

          <Show when={notes().length > 0}>
            <ImportDiagnostics diagnostics={notes()} errors={0} warnings={0} infos={p().infos} />
          </Show>

          <Details class="rt-imp-options" flush summary={words.startOptions}>
            <div class="rt-imp-mapping-grid">
              <DateField
                label={words.startOn}
                hint={words.startOnHint}
                value={props.startOn}
                onChange={(value) => props.onStartOn(value)}
              />
              <div class="rt-imp-mapping-wide">
                <CheckField
                  label={words.catchUp}
                  checked={props.catchUp}
                  onChange={props.onCatchUp}
                />
                <p class="rt-hint">{words.catchUpHint}</p>
              </div>
              <Show when={p().format === "ofx"}>
                <div class="rt-imp-mapping-wide">
                  <CheckField
                    label={words.ignoreIds}
                    checked={props.ignoreIds}
                    onChange={props.onIgnoreIds}
                  />
                  <p class="rt-hint">{words.ignoreIdsHint}</p>
                </div>
                <div class="rt-imp-mapping-wide">
                  <CheckField
                    label={words.flipBalance}
                    checked={props.invertBalance}
                    onChange={props.onInvertBalance}
                  />
                  <p class="rt-hint">{words.flipBalanceHint}</p>
                </div>
              </Show>
            </div>
          </Details>
        </div>
      </Details>
    </div>
  );
}
