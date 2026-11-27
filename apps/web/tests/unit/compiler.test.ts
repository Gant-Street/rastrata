import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { solidPlugin } from "../../tooling/solid-plugin";

test("Solid TSX uses the same typed compilation path in development and production", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rastrata-solid-compiler-"));
  try {
    const entry = join(directory, "entry.tsx");
    await Bun.write(
      entry,
      "interface Props { label: string }; export const App = (props: Props) => <main>{props.label}</main>;",
    );
    for (const development of [true, false]) {
      const result = await Bun.build({
        entrypoints: [entry],
        target: "browser",
        external: ["solid-js/web", "solid-js"],
        plugins: [solidPlugin(development)],
      });
      expect(result.success).toBe(true);
      const code = await result.outputs[0]?.text();
      expect(code).toContain("solid-js/web");
      expect(code).not.toContain("react/jsx-runtime");
      expect(code).not.toContain("interface Props");
    }
    await Bun.write(entry, "export const App = () => <main>;");
    await expect(
      Bun.build({ entrypoints: [entry], target: "browser", plugins: [solidPlugin(false)] }),
    ).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// This exercises a real build alongside the other workspace suites under Turbo.
test("the production build emits static assets, no dev runtime or private environment values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rastrata-web-build-"));
  try {
    const script = resolve(import.meta.dir, "../../tooling/build.ts");
    const runner = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import {buildWeb} from ${JSON.stringify(script)}; await buildWeb(${JSON.stringify(directory)});`,
      ],
      {
        cwd: resolve(import.meta.dir, "../.."),
        env: { ...process.env, RASTRATA_PRIVATE_CANARY: "private-canary-must-not-ship-769db" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exit, stdout, stderr] = await Promise.all([
      runner.exited,
      new Response(runner.stdout).text(),
      new Response(runner.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    const report = JSON.parse(stdout) as {
      assets: { file: string; bytes: number; gzipBytes: number }[];
    };
    expect(report.assets.some((asset) => asset.file.endsWith(".js"))).toBe(true);
    expect(report.assets.some((asset) => asset.file.endsWith(".css"))).toBe(true);
    // The style sheet is what the first paint waits for: it holds the Latin face of each typeface and no other font, and the faces of the other scripts are files the page registers
    // (packages/ui/tooling/fonts.ts), each in the build under the address the page asks for.
    const sheet = report.assets.find((asset) => asset.file.endsWith(".css"));
    expect(sheet?.gzipBytes ?? Number.POSITIVE_INFINITY).toBeLessThan(200_000);
    const styles = await Bun.file(join(directory, sheet?.file ?? "missing")).text();
    expect(styles.match(/url\(data:font\/woff2/g)?.length ?? 0).toBe(2);
    expect(styles).not.toContain("/assets/fonts/");
    const faces = report.assets.filter((asset) => asset.file.startsWith("assets/fonts/"));
    expect(faces).toHaveLength(11);
    for (const face of faces)
      expect(await Bun.file(join(directory, face.file)).exists()).toBe(true);
    const html = await Bun.file(join(directory, "index.html")).text();
    for (const reference of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
      const asset = reference[1];
      expect(asset).toBeDefined();
      expect(await Bun.file(join(directory, asset ?? "missing")).exists()).toBe(true);
    }
    // The page's first lines are two inline scripts, the saved theme and the requests for what the page needs first (index.html), whole as written and ahead of the styles and
    // the page's own script: the pod allows each by its hash (apps/api/src/web.ts), so a build that changed or dropped one would be a page that is blocked or goes without.
    const inline = [...html.matchAll(/<script(?![^>]*\ssrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
      (match) => match[1] ?? "",
    );
    expect(inline).toHaveLength(2);
    expect(inline[0]).toContain("rastrata-theme");
    expect(inline[1]).toContain('fetch("/health"');
    expect(inline[1]).toContain('fetch("/auth/workspace-token"');
    expect(inline[1]).toContain("__rastrataEarly");
    expect(html.indexOf("__rastrataEarly")).toBeLessThan(html.indexOf('<link rel="stylesheet"'));
    expect(html.indexOf("__rastrataEarly")).toBeLessThan(html.indexOf('<script type="module"'));
    // What a page waits for before it draws is the script it names and the files that script imports, which the page asks the browser to fetch with it (`modulepreload`).
    const waitedFor = async (page: string) => {
      const markup = await Bun.file(join(directory, page)).text();
      const named = [...markup.matchAll(/<script[^>]*\ssrc="\/([^"#]+)"/g)].map(
        (match) => match[1],
      );
      const imported = [
        ...markup.matchAll(/<link rel="modulepreload"[^>]*\shref="\/([^"#]+)"/g),
      ].map((match) => match[1]);
      const files = [...named, ...imported].filter((file): file is string => file !== undefined);
      const texts = await Promise.all(files.map((file) => Bun.file(join(directory, file)).text()));
      const sizes = files.map((file) => report.assets.find((asset) => asset.file === file));
      return {
        named,
        files,
        text: texts.join("\n"),
        bytes: sizes.reduce((sum, asset) => sum + (asset?.bytes ?? 0), 0),
        gzipBytes: sizes.reduce((sum, asset) => sum + (asset?.gzipBytes ?? 0), 0),
      };
    };
    const everything = report.assets
      .filter((asset) => asset.file.endsWith(".js"))
      .reduce((sum, asset) => sum + asset.bytes, 0);
    // The application's first script is what the first draw waits for, and it is small because every screen but Home is a file of its own (src/routes/screen.ts), fetched when it is first
    // wanted and ahead of that when the page is idle (src/preload.ts): the shell, Home and what they share, in 250 kB compressed. (It was 564 kB when the page was one file; the budget is
    // docs/reference/program/performance.md, "The critical script".)
    const application = await waitedFor("index.html");
    expect(application.named).toHaveLength(1);
    expect(application.gzipBytes).toBeLessThan(250_000);
    // Each screen is its own file: a build that put them back in one would have fewer, and a first script near the whole.
    const scripts = report.assets.filter((asset) => asset.file.endsWith(".js"));
    expect(scripts.length).toBeGreaterThan(60);
    expect(application.bytes).toBeLessThan(everything / 2);
    // The page a hosted service sends to a browser with no session: it names its own script and the styles, what it waits for is a small part of the application's, and none of the
    // application's screens or requests is in it.
    const signin = await Bun.file(join(directory, "signin.html")).text();
    expect([...signin.matchAll(/<script[^>]*\ssrc="([^"#]+)"/g)]).toHaveLength(1);
    for (const reference of signin.matchAll(/(?:src|href)="([^"#]+)"/g))
      expect(await Bun.file(join(directory, reference[1] ?? "missing")).exists()).toBe(true);
    const page = await waitedFor("signin.html");
    // 275 kB since Ark's pin input (the code's boxes) joined it, about 10 kB.
    expect(page.bytes).toBeLessThan(275_000);
    expect(page.gzipBytes).toBeLessThan(100_000);
    expect(page.bytes).toBeLessThan(everything / 4);
    for (const mark of ["Opening your book", "Page not found", "journal.list", "book.get"])
      expect(page.text, mark).not.toContain(mark);
    expect(page.text).toContain("Owner key");
    for (const asset of report.assets) {
      const code = await Bun.file(join(directory, asset.file)).text();
      expect(code).not.toContain("private-canary-must-not-ship-769db");
      expect(code).not.toContain("/_bun/client");
      expect(code).not.toContain("sourceMappingURL");
      expect(code).not.toContain("babel-preset-solid");
      expect(asset.bytes).toBeGreaterThan(0);
      expect(asset.gzipBytes).toBeGreaterThan(0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
