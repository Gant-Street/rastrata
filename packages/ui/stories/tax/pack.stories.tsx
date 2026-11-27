import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Button, TaxPackPanel, taxWords } from "../../src";
import { Frame } from "./frame";
import { pack } from "./fixtures";

const meta = {
  title: "Lanes/Tax/Year-end pack",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => undefined;
const common = {
  heading: taxWords.packTitle,
  buildLabel: taxWords.packBuild,
  buildingLabel: taxWords.packBuilding,
  downloadLabel: taxWords.packDownload,
  onBuild: noop,
  onDownload: noop,
} as const;

export const PackNotBuilt: Story = {
  name: "Pack: not built yet",
  render: () => (
    <Frame>
      <TaxPackPanel {...common} state="idle" pack={null} />
    </Frame>
  ),
};

export const PackBuilding: Story = {
  name: "Pack: building",
  render: () => (
    <Frame>
      <TaxPackPanel {...common} state="building" pack={null} />
    </Frame>
  ),
};

export const PackReady: Story = {
  name: "Pack: built, every file with what it is and its size, the proof closed under Pack details",
  render: () => (
    <Frame>
      <TaxPackPanel
        {...common}
        state="ready"
        pack={pack}
        message="Saved rastrata-year-end-2026.zip."
      />
    </Frame>
  ),
};

export const PackReadyWithDetailsOpen: Story = {
  name: "Pack: Pack details open, the book revision, the manifest's SHA-256 and each file's",
  render: () => (
    <Frame>
      <TaxPackPanel {...common} state="ready" pack={pack} detailsOpen />
    </Frame>
  ),
};

export const PackStale: Story = {
  name: "Pack: the books changed since it was built",
  render: () => (
    <Frame>
      <TaxPackPanel {...common} state="stale" pack={pack} />
    </Frame>
  ),
};

export const PackFailed: Story = {
  name: "Pack: could not be built",
  render: () => (
    <Frame>
      <TaxPackPanel
        {...common}
        state="failed"
        pack={null}
        failure="This range is outside the book's fiscal calendar."
      />
    </Frame>
  ),
};

export const PackWithExtra: Story = {
  name: "Pack: with another way to get a file",
  render: () => (
    <Frame>
      <TaxPackPanel
        {...common}
        heading={taxWords.accountantSendTitle}
        buildLabel={taxWords.accountantBuild}
        buildingLabel={taxWords.accountantBuilding}
        downloadLabel={taxWords.accountantDownload}
        state="ready"
        pack={pack}
        extra={<Button variant="quiet" label={taxWords.accountantTemplate} onClick={noop} />}
      />
    </Frame>
  ),
};
