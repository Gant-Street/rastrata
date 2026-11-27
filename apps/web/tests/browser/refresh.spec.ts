import { expect, test } from "@playwright/test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("TSX and CSS refresh, compilation errors and route errors are visible in an isolated copy", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const original = resolve(import.meta.dir, "../..");
  const sandbox = await mkdtemp(join(tmpdir(), "rastrata-web-refresh-"));
  const workspace = join(sandbox, "apps/web");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await mkdir(workspace, { recursive: true });
    for (const name of [
      "src",
      "tooling",
      "index.html",
      "favicon.svg",
      "bunfig.toml",
      "package.json",
      "tsconfig.json",
    ]) {
      await cp(join(original, name), join(workspace, name), { recursive: true });
    }
    await cp(resolve(original, "../../tsconfig.base.json"), join(sandbox, "tsconfig.base.json"));
    await symlink(join(original, "node_modules"), join(workspace, "node_modules"));
    child = Bun.spawn([process.execPath, "tooling/dev.ts"], {
      cwd: workspace,
      env: { ...process.env, PORT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    let output = "";
    const ready = (async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Development server exited: ${output}`);
        output += new TextDecoder().decode(chunk.value);
        const url = output.match(/Rastrata: (http:\/\/\S+)/)?.[1];
        if (url) return url;
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const url = await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Development server startup timed out")), 10_000);
      }),
    ]).finally(() => clearTimeout(timer));
    // Drain logs so a failing build cannot block on a full output pipe.
    const stdout = (async () => {
      while (!(await reader.read()).done) {
        /* Drain the existing reader. */
      }
    })();
    const stderr = new Response(child.stderr as ReadableStream<Uint8Array>).text();
    await page.goto(url);
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
    const homePath = join(workspace, "src/routes/home.tsx");
    const home = await readFile(homePath, "utf8");
    await writeFile(
      homePath,
      home.replaceAll("title={homeWords.title}", 'title="A refreshed workspace."'),
    );
    await expect(page.getByRole("heading", { name: "A refreshed workspace." })).toBeVisible();
    const cssPath = join(workspace, "src/styles.css");
    const css = await readFile(cssPath, "utf8");
    // !important: the page header sets its own letter spacing on a class, which an element rule would lose to.
    await writeFile(cssPath, `${css}\nh1 { letter-spacing: 7px !important; }\n`);
    await expect(page.locator("h1")).toHaveCSS("letter-spacing", "7px");
    await writeFile(homePath, "export function Home() { return <main>; }");
    await expect(page.getByText(/Unterminated JSX contents/)).toBeVisible();
    await writeFile(homePath, home);
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
    await writeFile(
      homePath,
      'export function Home() { throw new Error("Synthetic route failure"); }',
    );
    await expect(page.getByRole("heading", { name: "Unable to open this page" })).toBeVisible();
    child.kill();
    await child.exited;
    await Promise.all([stdout, stderr]);
  } finally {
    child?.kill();
    if (child) await child.exited;
    await rm(sandbox, { recursive: true, force: true });
  }
});
