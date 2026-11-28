import type { ApplicationInputs, ApplicationOutputs } from "@rastrata/application/client-contracts";
import { Button, TaxPackPanel, taxWords, zipFiles, type TaxFormId } from "@rastrata/ui";
import { type Accessor, createSignal } from "solid-js";
import type { BrowserApplicationClient } from "../../application-client";
import type { MealsPercent } from "./controller";
import { saveBytes } from "./download";
import { failureText } from "./failure";

type Pack = ApplicationOutputs["taxPack.build"];

/** The year-end pack: the year's statements, the worksheet, the 1099 vendor list and the sales tax summary
 * where they exist, a README and a manifest. The service builds the files; this saves them as one zip, on this
 * machine, when the person asks. A pack built from an older version of the books is shown as stale and never
 * as current. */
export function PackTab(props: {
  client: BrowserApplicationClient;
  year: Accessor<number | undefined>;
  form: Accessor<TaxFormId | null>;
  meals: Accessor<MealsPercent>;
  /** The revision of the books as the page last read them. */
  bookRevision: Accessor<string | undefined>;
}) {
  const [pack, setPack] = createSignal<Pack | null>(null);
  const [phase, setPhase] = createSignal<"idle" | "building" | "failed">("idle");
  const [failure, setFailure] = createSignal<string | undefined>();
  const [downloading, setDownloading] = createSignal(false);
  const [downloadingCpa, setDownloadingCpa] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const state = () => {
    if (phase() === "building") return "building" as const;
    if (phase() === "failed" && !pack()) return "failed" as const;
    const built = pack();
    if (!built) return "idle" as const;
    const revision = props.bookRevision();
    return built.taxYear !== props.year() ||
      (revision !== undefined && revision !== built.bookRevision)
      ? ("stale" as const)
      : ("ready" as const);
  };

  async function build() {
    const taxYear = props.year();
    if (taxYear === undefined) return;
    const form = props.form();
    const input: ApplicationInputs["taxPack.build"] = {
      taxYear,
      ...(form ? { form } : {}),
      ...(form === null || form === "scheduleC" ? { mealsPercent: props.meals() } : {}),
    };
    setPhase("building");
    setFailure(undefined);
    setMessage("");
    try {
      setPack(await props.client.read("taxPack.build", input));
      setPhase("idle");
    } catch (cause) {
      setFailure(failureText(cause, taxWords.packFailed));
      setPhase("failed");
    }
  }

  function download() {
    const built = pack();
    if (!built) return;
    setDownloading(true);
    try {
      const bytes = zipFiles(
        built.folder,
        built.files.map((file) => ({ path: file.path, content: file.content })),
      );
      setMessage(taxWords.packSaved(saveBytes(`${built.folder}.zip`, "application/zip", bytes)));
    } catch (cause) {
      setMessage(failureText(cause, taxWords.packFailed));
    } finally {
      setDownloading(false);
    }
  }

  async function downloadCpaPacket() {
    const taxYear = props.year();
    if (taxYear === undefined || downloadingCpa()) return;
    const form = props.form();
    const input: ApplicationInputs["taxCpaPacket.build"] = {
      taxYear,
      ...(form ? { form } : {}),
      ...(form === null || form === "scheduleC" ? { mealsPercent: props.meals() } : {}),
    };
    setDownloadingCpa(true);
    setFailure(undefined);
    setMessage("");
    try {
      const built = await props.client.read("taxCpaPacket.build", input);
      const bytes = zipFiles(
        built.folder,
        built.files.map((file) => ({ path: file.path, content: file.content })),
      );
      setMessage(taxWords.packSaved(saveBytes(`${built.folder}.zip`, "application/zip", bytes)));
    } catch (cause) {
      setFailure(failureText(cause, taxWords.cpaPacketFailed));
    } finally {
      setDownloadingCpa(false);
    }
  }

  return (
    <TaxPackPanel
      heading={taxWords.packTitle}
      headingHidden
      buildLabel={taxWords.packBuild}
      buildingLabel={taxWords.packBuilding}
      downloadLabel={taxWords.packDownload}
      state={state()}
      pack={pack()}
      onBuild={() => void build()}
      onDownload={download}
      downloading={downloading()}
      message={message()}
      failure={failure()}
      extra={
        <Button
          variant="secondary"
          label={taxWords.cpaPacketDownload}
          pending={downloadingCpa()}
          pendingLabel={taxWords.cpaPacketBuilding}
          onClick={() => void downloadCpaPacket()}
        />
      }
    />
  );
}
