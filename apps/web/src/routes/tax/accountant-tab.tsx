import type { ApplicationOutputs } from "@rastrata/application/client-contracts";
import { Button, TaxAdjustmentsImport, TaxPackPanel, taxWords, zipFiles } from "@rastrata/ui";
import { type Accessor, createSignal } from "solid-js";
import { ApplicationRequestError, type BrowserApplicationClient } from "../../application-client";
import {
  ADJUSTMENTS_TEMPLATE,
  MAX_ADJUSTMENT_BYTES,
  MAX_ADJUSTMENT_CHARACTERS,
} from "./controller";
import { saveBytes, saveCsv } from "./download";
import { failureText } from "./failure";

type Pack = ApplicationOutputs["taxAccountant.build"];
type Preview = ApplicationOutputs["taxAdjustments.preview"];
type Imported = ApplicationOutputs["taxAdjustments.import"];

const IMPORT_WORKFLOW = "tax:adjustments";

/** Working with an accountant: send them the books (the chart, every journal with where it came from, the
 * statements and an empty template), and bring their adjusting entries back in. An import only saves drafts
 * for the owner to review in the Journal: nothing is posted. The file is read here as text, shown as a
 * preview with every problem and its row, and imported only when the person presses the button. */
export function AccountantTab(props: {
  client: BrowserApplicationClient;
  year: Accessor<number | undefined>;
  bookRevision: Accessor<string | undefined>;
}) {
  // ---- The pack going out ------------------------------------------------------------------------
  const [pack, setPack] = createSignal<Pack | null>(null);
  const [packPhase, setPackPhase] = createSignal<"idle" | "building" | "failed">("idle");
  const [packFailure, setPackFailure] = createSignal<string | undefined>();
  const [downloading, setDownloading] = createSignal(false);
  const [downloadingCpa, setDownloadingCpa] = createSignal(false);
  const [packMessage, setPackMessage] = createSignal("");
  const packState = () => {
    if (packPhase() === "building") return "building" as const;
    if (packPhase() === "failed" && !pack()) return "failed" as const;
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
    setPackPhase("building");
    setPackFailure(undefined);
    setPackMessage("");
    try {
      setPack(await props.client.read("taxAccountant.build", { taxYear }));
      setPackPhase("idle");
    } catch (cause) {
      setPackFailure(failureText(cause, taxWords.packFailed));
      setPackPhase("failed");
    }
  }

  function downloadPack() {
    const built = pack();
    if (!built) return;
    setDownloading(true);
    try {
      const bytes = zipFiles(
        built.folder,
        built.files.map((file) => ({ path: file.path, content: file.content })),
      );
      setPackMessage(
        taxWords.packSaved(saveBytes(`${built.folder}.zip`, "application/zip", bytes)),
      );
    } catch (cause) {
      setPackMessage(failureText(cause, taxWords.packFailed));
    } finally {
      setDownloading(false);
    }
  }

  async function downloadCpaPacket() {
    const taxYear = props.year();
    if (taxYear === undefined || downloadingCpa()) return;
    setDownloadingCpa(true);
    setPackFailure(undefined);
    setPackMessage("");
    try {
      const built = await props.client.read("taxCpaPacket.build", { taxYear });
      const bytes = zipFiles(
        built.folder,
        built.files.map((file) => ({ path: file.path, content: file.content })),
      );
      setPackMessage(
        taxWords.packSaved(saveBytes(`${built.folder}.zip`, "application/zip", bytes)),
      );
    } catch (cause) {
      setPackFailure(failureText(cause, taxWords.cpaPacketFailed));
    } finally {
      setDownloadingCpa(false);
    }
  }

  const downloadTemplate = () =>
    setPackMessage(
      taxWords.packSaved(
        saveCsv("adjusting-entries-template.csv", "text/csv; charset=utf-8", ADJUSTMENTS_TEMPLATE),
      ),
    );

  // ---- The adjusting entries coming back ---------------------------------------------------------
  const [phase, setPhase] = createSignal<
    "idle" | "checking" | "checked" | "importing" | "imported" | "failed"
  >("idle");
  const [file, setFile] = createSignal<{ name: string; size: number; text: string } | null>(null);
  const [preview, setPreview] = createSignal<Preview | null>(null);
  const [imported, setImported] = createSignal<Imported | null>(null);
  const [problem, setProblem] = createSignal<string | undefined>();
  // A write whose reply was lost is uncertain, never repeated silently and never shown as done: the request
  // the browser kept is resumed on purpose.
  const retained = () => {
    try {
      return props.client.pending(IMPORT_WORKFLOW) !== null;
    } catch {
      return false;
    }
  };
  const [uncertain, setUncertain] = createSignal(retained());

  /** Read the file and ask the service what importing it would do. Nothing is saved. */
  async function choose(chosen: File) {
    setProblem(undefined);
    setImported(null);
    setPreview(null);
    if (chosen.size > MAX_ADJUSTMENT_BYTES) {
      setFile({ name: chosen.name, size: chosen.size, text: "" });
      setProblem(taxWords.fileTooLarge);
      setPhase("failed");
      return;
    }
    setPhase("checking");
    let text: string;
    try {
      text = await chosen.text();
    } catch {
      setFile({ name: chosen.name, size: chosen.size, text: "" });
      setProblem(taxWords.fileUnreadable);
      setPhase("failed");
      return;
    }
    setFile({ name: chosen.name, size: chosen.size, text });
    if (text.length > MAX_ADJUSTMENT_CHARACTERS) {
      setProblem(taxWords.fileTooLarge);
      setPhase("failed");
      return;
    }
    await check(text, chosen.name);
  }

  async function check(text: string, name: string) {
    setPhase("checking");
    try {
      setPreview(await props.client.read("taxAdjustments.preview", { csv: text, fileName: name }));
      setPhase("checked");
    } catch (cause) {
      setProblem(failureText(cause, taxWords.fileUnreadable));
      setPhase("failed");
    }
  }

  async function importFile() {
    const chosen = file();
    const shown = preview();
    if (!chosen || !shown) return;
    setProblem(undefined);
    setPhase("importing");
    try {
      const done = await props.client.write(
        "taxAdjustments.import",
        { csv: chosen.text, fileName: chosen.name, previewHash: shown.previewHash },
        IMPORT_WORKFLOW,
      );
      setImported(done);
      setUncertain(false);
      setPhase("imported");
    } catch (cause) {
      if (cause instanceof ApplicationRequestError && cause.code === "adjustment_preview_changed") {
        setProblem(taxWords.importStale);
        await check(chosen.text, chosen.name);
        return;
      }
      if (cause instanceof ApplicationRequestError && cause.uncertain) setUncertain(true);
      setProblem(
        cause instanceof ApplicationRequestError && cause.uncertain
          ? taxWords.importUncertain
          : failureText(cause, taxWords.importFailed),
      );
      setPhase(file() && preview() ? "checked" : "idle");
    }
  }

  /** Send the request the browser kept, exactly as it was. */
  async function resume() {
    setProblem(undefined);
    setPhase("importing");
    try {
      const done = await props.client.resume(IMPORT_WORKFLOW);
      if (done.name === "taxAdjustments.import") {
        setImported(done.data);
        setUncertain(false);
        setPhase("imported");
      }
    } catch (cause) {
      setProblem(failureText(cause, taxWords.importFailed));
      setPhase(file() && preview() ? "checked" : "idle");
    }
  }

  return (
    <div class="rt-tax-accountant">
      <TaxPackPanel
        heading={taxWords.accountantSendTitle}
        buildLabel={taxWords.accountantBuild}
        buildingLabel={taxWords.accountantBuilding}
        downloadLabel={taxWords.accountantDownload}
        state={packState()}
        pack={pack()}
        onBuild={() => void build()}
        onDownload={downloadPack}
        downloading={downloading()}
        message={packMessage()}
        failure={packFailure()}
        extra={
          <>
            <Button
              variant="secondary"
              label={taxWords.cpaPacketDownload}
              pending={downloadingCpa()}
              pendingLabel={taxWords.cpaPacketBuilding}
              onClick={() => void downloadCpaPacket()}
            />
            <Button
              variant="quiet"
              label={taxWords.accountantTemplate}
              onClick={downloadTemplate}
            />
          </>
        }
      />
      <section class="rt-tax-pack" aria-labelledby="tax-bring-title">
        <h2 id="tax-bring-title">{taxWords.accountantBringTitle}</h2>
        <TaxAdjustmentsImport
          state={phase()}
          {...(file() ? { fileName: file()?.name, fileSize: file()?.size } : {})}
          preview={preview()}
          imported={imported()}
          {...(problem() ? { error: problem() } : {})}
          journalHref="/journal"
          uncertain={uncertain()}
          onResume={() => void resume()}
          onFile={(chosen) => void choose(chosen)}
          onImport={() => void importFile()}
        />
      </section>
    </div>
  );
}
