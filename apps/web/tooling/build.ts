import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import tailwind from "bun-plugin-tailwind";
import { fontDirectory, fontFiles } from "./fonts";
import { writeHelp } from "./help";
import { solidPlugin } from "./solid-plugin";

const root = resolve(import.meta.dir, "..");
export async function buildWeb(outdir = resolve(root, "dist")) {
  // Never delete a caller-selected directory. Require an empty artifact destination.
  await mkdir(outdir, { recursive: true });
  if ((await readdir(outdir)).length) throw new Error(`Build output must be empty: ${outdir}`);
  const result = await Bun.build({
    // The application, and the sign-in page a hosted service sends in its place to a browser with no session.
    entrypoints: [resolve(root, "index.html"), resolve(root, "signin.html")],
    root,
    outdir,
    target: "browser",
    publicPath: "/",
    // Every screen but Home is a file of its own, fetched when it is first wanted (src/routes/screen.ts), and what the screens and the two pages share is a file both ask for.
    splitting: true,
    minify: true,
    sourcemap: "none",
    env: "disable",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [solidPlugin(false), tailwind],
    naming: {
      entry: "[name].[ext]",
      chunk: "assets/[name]-[hash].[ext]",
      asset: "assets/[name]-[hash].[ext]",
    },
  });
  if (!result.success) throw new AggregateError(result.logs, "Frontend build failed");
  // A file the bundler left empty (what only types and constants that nothing uses came to) is named by no page and no script: it is not shipped.
  const empty = result.outputs.filter((output) => output.size === 0);
  for (const output of empty) await rm(output.path, { force: true });
  const outputs = result.outputs.filter((output) => output.size > 0);
  await Bun.write(
    resolve(outdir, "licenses/inter.txt"),
    Bun.file(new URL(import.meta.resolve("@rastrata/ui/inter-license"))),
  );
  await Bun.write(
    resolve(outdir, "licenses/jetbrains-mono.txt"),
    Bun.file(new URL(import.meta.resolve("@rastrata/ui/jetbrains-mono-license"))),
  );
  // Help: each topic as a small file the reader fetches when the topic is opened (tooling/help.ts).
  await writeHelp(outdir);
  // The fonts the style sheet leaves as files: each face of a script that is not Latin, fetched by a page only when a character needs it (packages/ui/tooling/fonts.ts).
  const fonts = fontFiles();
  for (const font of fonts) {
    await mkdir(fontDirectory(outdir, font.url), { recursive: true });
    await Bun.write(resolve(outdir, `.${font.url}`), Bun.file(font.from));
  }
  const assets = await Promise.all([
    ...outputs.map(async (output) => ({
      file: output.path.slice(outdir.length + 1),
      bytes: output.size,
      gzipBytes: gzipSync(await output.arrayBuffer(), { level: 9 }).length,
    })),
    ...fonts.map(async (font) => {
      const bytes = new Uint8Array(await Bun.file(font.from).arrayBuffer());
      return {
        file: font.url.slice(1),
        bytes: bytes.length,
        gzipBytes: gzipSync(bytes, { level: 9 }).length,
      };
    }),
  ]);
  console.info(JSON.stringify({ assets }, null, 2));
  return assets;
}

if (import.meta.main) {
  // Only the scaffold's generated output is cleaned, never a caller-selected path.
  await rm(resolve(root, "dist"), { recursive: true, force: true });
  await buildWeb();
}
