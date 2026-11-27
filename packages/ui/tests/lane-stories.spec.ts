import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, type APIRequestContext, type Page, test } from "@playwright/test";
import axe from "axe-core";

declare global {
  interface Window {
    axe: typeof axe;
  }
}

// Every story titled "Lanes/<lane>/<name>" is swept automatically in both themes: it must render
// without runtime errors and pass the same automated accessibility scan as the design system.
// Lanes add stories under stories/<lane>/ and never edit a list. The sweep is one test per lane and
// theme (a lane's directory under stories/ names it), plus one for any lane story outside those
// directories, so the work runs in parallel, a failure names its lane, and no single test needs a
// quarter of an hour on a busy machine.
const storiesDirectory = join(import.meta.dir, "../stories");
const lanes = readdirSync(storiesDirectory)
  .filter((name) => statSync(join(storiesDirectory, name)).isDirectory())
  .sort();

async function sweep(
  page: Page,
  request: APIRequestContext,
  theme: "light" | "dark",
  wanted: (id: string) => boolean,
): Promise<void> {
  const index = await request.get("/index.json");
  const entries = (await index.json()).entries as Record<string, { type: string }>;
  const ids = Object.keys(entries)
    .filter((id) => entries[id]?.type === "story" && id.startsWith("lanes-") && wanted(id))
    .sort();
  test.skip(ids.length === 0, "No stories of this kind have landed yet");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const id of ids) {
    await page.goto(`/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}`);
    await expect(page.locator("#storybook-root > *").first()).toBeAttached();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.addScriptTag({ content: axe.source });
    const result = await page.evaluate(() =>
      window.axe.run(document.querySelector("#storybook-root") as HTMLElement, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      }),
    );
    expect(
      result.violations.map(({ id: rule, nodes }) => ({
        id: rule,
        targets: nodes.map((node) => node.target),
      })),
      `${id} (${theme})`,
    ).toEqual([]);
  }
  expect(errors).toEqual([]);
}

for (const theme of ["light", "dark"] as const) {
  for (const lane of lanes) {
    test(`lane stories render without runtime errors and pass the accessibility scan: ${lane} (${theme})`, async ({
      page,
      request,
    }) => {
      test.setTimeout(300_000);
      await sweep(page, request, theme, (id) => id.startsWith(`lanes-${lane}-`));
    });
  }
  test(`lane stories render without runtime errors and pass the accessibility scan: any other lane (${theme})`, async ({
    page,
    request,
  }) => {
    test.setTimeout(300_000);
    await sweep(
      page,
      request,
      theme,
      (id) => !lanes.some((lane) => id.startsWith(`lanes-${lane}-`)),
    );
  });
}
