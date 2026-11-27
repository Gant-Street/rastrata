import { createSignal, onMount } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  ImportBalanceCheck,
  ImportDiagnostics,
  ImportLineTable,
  ImportReview,
  ImportSummary,
  type ImportPreviewData,
  type ImportSampleFilter,
} from "../../src";
import {
  agreeingPreview,
  amexPreview,
  arabicLines,
  blockedPreview,
  cardPreview,
  chaseLines,
  chasePreview,
  cutoverPreview,
  duplicatesPreview,
  errorsPreview,
  hostilePreview,
  longPreview,
  ofxPreview,
  presetOptions,
  unknownPreview,
} from "./fixtures";
import { Frame } from "./frame";

/** The whole review with its choices held in state, as the page holds them. */
function Review(props: {
  preview: ImportPreviewData;
  refreshing?: boolean;
  failed?: string;
  committing?: boolean;
  presetId?: string;
  /** Open the column editor, which a preview that was read without trouble leaves closed. */
  openColumns?: boolean;
}) {
  let frame: HTMLDivElement | undefined;
  onMount(() => {
    if (!props.openColumns) return;
    // The folds are buttons: open Details, then the column editor inside it, as a person would.
    for (const fold of [".rt-imp-review > .rt-details", ".rt-imp-columns"]) {
      frame
        ?.querySelector<HTMLButtonElement>(
          `${fold} > .rt-details-head > .rt-details-toggle[aria-expanded="false"]`,
        )
        ?.click();
    }
  });
  const [filter, setFilter] = createSignal<ImportSampleFilter>("all");
  const [page, setPage] = createSignal(1);
  const [startOn, setStartOn] = createSignal("");
  const [catchUp, setCatchUp] = createSignal(false);
  const [ignoreIds, setIgnoreIds] = createSignal(false);
  const [invertBalance, setInvertBalance] = createSignal(false);
  const [skipRows, setSkipRows] = createSignal(false);
  const [name, setName] = createSignal("");
  const [presetId, setPresetId] = createSignal(props.presetId ?? "");
  return (
    <div ref={frame}>
      <Frame>
        <ImportReview
          preview={props.preview}
          refreshing={props.refreshing}
          failed={props.failed}
          committing={props.committing}
          filter={filter()}
          page={page()}
          startOn={startOn()}
          catchUp={catchUp()}
          ignoreIds={ignoreIds()}
          invertBalance={invertBalance()}
          skipRows={skipRows()}
          resetKey="story"
          presets={presetOptions}
          presetId={presetId()}
          onPreset={setPresetId}
          save={{ name: name(), saving: false, onName: setName, onSave: () => {} }}
          onFilter={setFilter}
          onPage={setPage}
          onStartOn={setStartOn}
          onCatchUp={setCatchUp}
          onIgnoreIds={setIgnoreIds}
          onInvertBalance={setInvertBalance}
          onSkipRows={setSkipRows}
          onMapping={() => {}}
          onOfxAccount={() => {}}
          onCommit={() => {}}
          onStartOver={() => {}}
        />
      </Frame>
    </div>
  );
}

const meta = {
  title: "Lanes/Statements/Review",
  component: Review,
  args: { preview: chasePreview },
} satisfies Meta<typeof Review>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ChaseUnverifiedPreset: Story = {};
export const BooksAgreeWithTheStatement: Story = { args: { preview: agreeingPreview } };
export const UnknownColumns: Story = { args: { preview: unknownPreview } };
export const LayoutChosenByName: Story = {
  args: { preview: amexPreview, presetId: "amex-card", openColumns: true },
};
export const RowsThatCannotBeRead: Story = { args: { preview: errorsPreview } };
export const BlockedByTheDateOrder: Story = { args: { preview: blockedPreview } };
export const HostileText: Story = { args: { preview: hostilePreview } };
export const NothingNew: Story = { args: { preview: duplicatesPreview } };
export const StartDateAndOverlap: Story = { args: { preview: cutoverPreview } };
export const CreditCardWithFlippedSigns: Story = { args: { preview: cardPreview } };
export const OfxWithSeveralAccounts: Story = { args: { preview: ofxPreview } };
export const ManyLines: Story = { args: { preview: longPreview } };
export const Refreshing: Story = { args: { preview: chasePreview, refreshing: true } };
export const Committing: Story = { args: { preview: chasePreview, committing: true } };
export const PreviewFailed: Story = {
  args: {
    preview: chasePreview,
    failed: "The application could not be read. Nothing was imported.",
  },
};

export const Figures: Story = {
  render: () => (
    <Frame>
      <ImportSummary
        counts={chasePreview.counts}
        totals={chasePreview.totals}
        range={chasePreview.range}
      />
      <ImportBalanceCheck checks={agreeingPreview.balances} />
      <ImportBalanceCheck checks={chasePreview.balances} />
      <ImportBalanceCheck
        card
        checks={[
          {
            accountKey: "ofx:x",
            asOf: "2026-02-28",
            reported: "-1234.56",
            ledger: null,
            waiting: null,
            excluded: null,
            difference: null,
          },
        ]}
      />
      <ImportBalanceCheck checks={[]} />
    </Frame>
  ),
};

export const Problems: Story = {
  render: () => (
    <Frame>
      <ImportDiagnostics
        diagnostics={Array.from({ length: 14 }, (_, index) => ({
          severity:
            index < 2 ? ("error" as const) : index < 9 ? ("warning" as const) : ("info" as const),
          ...(index === 13 ? {} : { row: index + 2 }),
          message:
            index === 0
              ? 'Row skipped: the amount "abc" is not an amount'
              : index === 5
                ? 'The description "\\u001b[31mred" looks like markup'
                : `Something worth a look in this row (${index})`,
        }))}
        errors={2}
        warnings={7}
        infos={5}
      />
      <ImportDiagnostics diagnostics={[]} errors={0} warnings={0} infos={0} />
    </Frame>
  ),
};

function Table(props: {
  lines: readonly (typeof chaseLines)[number][];
  filter?: ImportSampleFilter;
  count?: number;
  loading?: boolean;
}) {
  return (
    <Frame>
      <ImportLineTable
        lines={props.lines}
        count={props.count ?? props.lines.length}
        page={1}
        pageSize={25}
        filter={props.filter ?? "all"}
        loading={props.loading}
        onFilter={() => {}}
        onPage={() => {}}
      />
    </Frame>
  );
}

export const LinesWithBalance: Story = { render: () => <Table lines={chaseLines} /> };
export const LinesFlaggedForText: Story = {
  render: () => <Table lines={hostilePreview.sample.lines} />,
};
export const LinesEmptyFilter: Story = { render: () => <Table lines={[]} filter="duplicate" /> };
export const LinesLoading: Story = { render: () => <Table lines={chaseLines} loading /> };
export const LinesRightToLeftText: Story = {
  render: () => (
    <Frame locale="ar">
      <ImportLineTable
        lines={arabicLines}
        count={2}
        page={1}
        pageSize={25}
        filter="all"
        onFilter={() => {}}
        onPage={() => {}}
      />
    </Frame>
  ),
};
