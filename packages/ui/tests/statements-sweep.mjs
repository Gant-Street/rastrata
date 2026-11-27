// A focused accessibility sweep and screenshot run for the statements lane's stories, in both
// themes. The repository's own sweep (tests/lane-stories.spec.ts) runs every lane story; this runs
// only ours, against a Storybook dev server, so it is quick enough to run while building.
//
//   bun packages/ui/tests/statements-sweep.mjs [port] [--shots dir]
import { chromium } from "@playwright/test";
import axe from "axe-core";
import { mkdirSync } from "node:fs";

const port = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : "7106";
const shotsAt = process.argv.indexOf("--shots");
const shots = shotsAt === -1 ? null : process.argv[shotsAt + 1];
const only =
  process.argv.indexOf("--only") === -1 ? null : process.argv[process.argv.indexOf("--only") + 1];
if (shots) mkdirSync(shots, { recursive: true });

const base = `http://127.0.0.1:${port}`;
const index = await (await fetch(`${base}/index.json`)).json();
const ids = Object.keys(index.entries)
  .filter((id) => index.entries[id].type === "story" && id.startsWith("lanes-statements-"))
  .filter((id) => !only || id.includes(only))
  .sort();
console.log(`${ids.length} statements stories`);

const browser = await chromium.launch();
let failures = 0;
for (const theme of ["light", "dark"]) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const id of ids) {
    await page.goto(`${base}/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}`);
    await page.waitForSelector("#storybook-root > *", { state: "attached" });
    await page.addScriptTag({ content: axe.source });
    const result = await page.evaluate(() =>
      window.axe.run(document.querySelector("#storybook-root"), {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      }),
    );
    if (result.violations.length > 0) {
      failures++;
      console.log(`FAIL ${id} (${theme})`);
      for (const violation of result.violations)
        console.log(
          `  ${violation.id}: ${violation.nodes
            .slice(0, 2)
            .map((node) => node.target.join(" "))
            .join(
              " | ",
            )} :: ${violation.nodes[0]?.failureSummary?.split("\n").slice(0, 2).join(" ")}`,
        );
    }
    if ((shots && theme === "light") || (shots && /review-|result-/.test(id)))
      await page.screenshot({ path: `${shots}/${id}-${theme}.png`, fullPage: true });
  }
  if (errors.length > 0) {
    failures++;
    console.log(`runtime errors (${theme}):`, errors.slice(0, 5));
  }
  await context.close();
}
await browser.close();
console.log(failures === 0 ? "all stories pass in both themes" : `${failures} problems`);
process.exit(failures === 0 ? 0 : 1);
