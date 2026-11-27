import { createUniqueId, For, type JSX, Show } from "solid-js";
import { Button } from "../button";
import { formatBytes, formatCount, formatFiguresInText } from "../format";
import { Details, DetailsList } from "../kit";
import { Notice } from "../notice";
import type { TaxPackView } from "./types";
import { words } from "./words";

/** A pack of files the service built: one button builds it, and then the page lists what is in it (each
 * file, what it is, how big), how final it is, and one button that saves it as a zip. Nothing is saved
 * until the person asks. What proves it (the book revision it was built from, the manifest's SHA-256 and
 * the SHA-256 of each file) is under "Pack details" at the foot, with a Copy button, as a report's is under
 * "Report details". What a pack leaves out is in its README and in Help, not on the page. The panel serves
 * the year-end pack and the accountant pack: the words that differ are given. */
export function TaxPackPanel(props: {
  heading: string;
  /** The page's own title already says the heading: it is kept for assistive technology and not drawn. */
  headingHidden?: boolean | undefined;
  buildLabel: string;
  buildingLabel: string;
  downloadLabel: string;
  state: "idle" | "building" | "ready" | "failed" | "stale";
  pack: TaxPackView | null;
  onBuild: () => void;
  onDownload: () => void;
  downloading?: boolean | undefined;
  /** Said politely after a download ("Saved rastrata-year-end-2026.zip."). */
  message?: string | undefined;
  failure?: string | undefined;
  /** Another way to get one of the files (the empty adjusting-entry template). */
  extra?: JSX.Element;
  /** Start with the pack details open (stories and tests). */
  detailsOpen?: boolean | undefined;
}) {
  const titleId = createUniqueId();
  const pack = () => props.pack;
  return (
    <section class="rt-tax-pack" aria-labelledby={titleId}>
      <h2 id={titleId} class={props.headingHidden ? "rt-sr-only" : undefined}>
        {props.heading}
      </h2>
      <div class="rt-tax-pack-actions">
        <Button
          variant={pack() ? "secondary" : "primary"}
          label={props.buildLabel}
          pending={props.state === "building"}
          pendingLabel={props.buildingLabel}
          onClick={props.onBuild}
        />
        <Show when={pack() && props.state !== "building"}>
          <Button
            variant="primary"
            label={props.downloadLabel}
            pending={props.downloading ?? false}
            onClick={props.onDownload}
          />
        </Show>
        {props.extra}
      </div>
      <p class="rt-hint" role="status" aria-live="polite">
        {props.message ?? ""}
      </p>
      <Show when={props.state === "failed"}>
        <Notice title={props.failure ?? words.packFailed} tone="problem" role="alert" />
      </Show>
      <Show when={props.state === "stale"}>
        <Notice title={words.packStale} tone="attention" role="status" />
      </Show>
      <Show when={pack()}>
        {(built) => (
          <div class="rt-tax-pack-built" data-stale={props.state === "stale" ? "" : undefined}>
            <p class="rt-tax-pack-facts" data-facts="">
              {words.packBuilt(formatCount(built().files.length))}
            </p>
            <section
              class="rt-table-scroll"
              tabindex={0}
              aria-label={words.tableScroll(props.heading)}
            >
              <table class="rt-table rt-tax-files">
                <thead>
                  <tr>
                    <th scope="col">{words.packFileColumn}</th>
                    <th scope="col">{words.packWhatColumn}</th>
                    <th scope="col" class="rt-number rt-tax-filecolumn">
                      {words.packSizeColumn}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <For each={built().files}>
                    {(file) => (
                      <tr>
                        <th scope="row">
                          <span class="rt-tax-path">{file.path}</span>
                        </th>
                        <td>
                          {file.description}
                          {/* On a phone the size sits under the description, so the two columns that matter
                              have the room. */}
                          <span class="rt-tax-filemeta">{formatBytes(file.bytes)}</span>
                        </td>
                        <td class="rt-number rt-tax-filecolumn">{formatBytes(file.bytes)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </section>
            <Show when={built().close}>
              {(close) => (
                <section class="rt-tax-final" data-state={close().state} data-facts="">
                  <h3>{words.packFinalTitle}</h3>
                  <p>{formatFiguresInText(close().statement)}</p>
                </section>
              )}
            </Show>
            <div class="rt-tax-pack-proof">
              <Details summary={words.packDetails} defaultOpen={props.detailsOpen ?? false}>
                <DetailsList
                  items={[
                    { label: words.packRevision, value: built().bookRevision },
                    {
                      label: words.packManifest,
                      value: built().manifestSha256,
                      mono: true,
                      copy: true,
                      copyLabel: words.packManifestName,
                    },
                  ]}
                />
                <div class="rt-tax-pack-hashes">
                  <Details summary={words.packFilesSummary}>
                    <section
                      class="rt-table-scroll"
                      tabindex={0}
                      aria-label={words.packFilesSummary}
                    >
                      <table class="rt-table">
                        <thead>
                          <tr>
                            <th scope="col">{words.packFileColumn}</th>
                            <th scope="col">{words.packHashColumn}</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={built().files}>
                            {(file) => (
                              <tr>
                                <th scope="row">
                                  <span class="rt-tax-path">{file.path}</span>
                                </th>
                                <td>
                                  <code class="rt-hash">{file.sha256}</code>
                                </td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </section>
                  </Details>
                </div>
              </Details>
            </div>
          </div>
        )}
      </Show>
    </section>
  );
}
