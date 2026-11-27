// The application's style sheet for the screens' tests (tests/dom): built as the application's build builds it
// (Tailwind reads the sources for the classes they use), without the fonts, into .cache/dom.css. happy-dom then lays
// nothing out but knows what each element's style is, so what CSS hides is hidden and text reads as a browser reads
// it. Built again only when a style sheet or a source is newer than the copy; `bun run gate` builds it before the
// screens run, and a test file builds it itself when there is none.
import { mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";

const web = resolve(import.meta.dir, "..");
export const DOM_CSS = join(web, ".cache/dom.css");

function newest(directory: string): number {
  let latest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) latest = Math.max(latest, newest(path));
    else if (/\.(css|tsx?)$/.test(entry.name)) latest = Math.max(latest, statSync(path).mtimeMs);
  }
  return latest;
}

export function domCssIsCurrent(): boolean {
  try {
    const built = statSync(DOM_CSS).mtimeMs;
    return (
      built >= newest(join(web, "src")) && built >= newest(resolve(web, "../../packages/ui/src"))
    );
  } catch {
    return false;
  }
}

export async function buildDomCss(): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(web, "src/styles.css")],
    plugins: [tailwind],
    target: "browser",
    minify: true,
  });
  if (!result.success) throw new AggregateError(result.logs, "The style sheet could not be built");
  const css = (await result.outputs.find((output) => output.path.endsWith(".css"))?.text()) ?? "";
  mkdirSync(join(web, ".cache"), { recursive: true });
  // Written beside and moved into place, so a test that reads it never reads half of it.
  const partial = `${DOM_CSS}.${process.pid}`;
  writeFileSync(partial, css.replace(/@font-face\s*\{[^}]*\}/g, ""));
  renameSync(partial, DOM_CSS);
}

if (import.meta.main) {
  if (!domCssIsCurrent()) await buildDomCss();
}
