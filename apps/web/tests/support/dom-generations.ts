// A page load from nothing, for the screens' tests: Playwright's `goto` loads the application again, so whatever its
// modules held (the banking summary, the book's settings, the router) starts over. Bun keeps a module once it is
// loaded, so each load here is a new generation of the application's own code: a module of apps/web/src or
// packages/ui/src is loaded under `?g=<generation>`, and its imports of the same code are rewritten to carry the same
// generation, so the whole graph is new. Solid, the router library and the application package are shared, as a
// browser keeps them between loads too. A module is compiled once; a generation only runs it again.
import type { BunPlugin } from "bun";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { transformAsync } from "@babel/core";
import solid from "babel-preset-solid";

const repository = resolve(import.meta.dir, "../../../..");
const OWN = [resolve(repository, "apps/web/src"), resolve(repository, "packages/ui/src")];
const own = (path: string) => OWN.some((root) => path.startsWith(`${root}/`));

const state = globalThis as unknown as { __rastrataGeneration?: number };
state.__rastrataGeneration ??= 0;

/** The current generation, and the next one (a page load starts it). */
export const generation = () => state.__rastrataGeneration ?? 0;
export function nextGeneration(): number {
  state.__rastrataGeneration = generation() + 1;
  return generation();
}

/** The path a module of the application has in the current generation. */
export const versioned = (path: string, at = generation()) => `${path}?g=${at}`;

/** Changes when the compiler's settings below do, so an older output is not taken for a newer one. */
const PRESET = "solid-dom-1";
const compiled = new Map<string, Promise<string>>();
/** The compiler's output, kept on disk by the file's path, size and time: every worker and every run shares it. */
const CACHE = resolve(import.meta.dir, "../../.cache/dom-compiled");
mkdirSync(CACHE, { recursive: true });

async function compile(path: string): Promise<string> {
  const source = await Bun.file(path).text();
  if (!/\.[jt]sx$/.test(path)) return source;
  const stat = statSync(path);
  const key = new Bun.CryptoHasher("sha1")
    .update(`${path}\0${stat.size}\0${stat.mtimeMs}\0${PRESET}`)
    .digest("hex");
  const kept = join(CACHE, `${key}.js`);
  if (existsSync(kept)) return readFileSync(kept, "utf8");
  const code = await transpile(path, source);
  const partial = `${kept}.${process.pid}`;
  writeFileSync(partial, code);
  renameSync(partial, kept);
  return code;
}

async function transpile(path: string, source: string): Promise<string> {
  const result = await transformAsync(source, {
    filename: path,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
    presets: [[solid, { generate: "dom", hydratable: false, dev: false }]],
  });
  if (!result?.code) throw new Error(`Solid compilation produced no output: ${path}`);
  return result.code;
}

const SPECIFIER =
  /((?:^|[^\w$.])(?:import|export)\s[^"';]*?from\s*|(?:^|[^\w$.])import\s*\(\s*|(?:^|[^\w$.])import\s+)(["'])([^"']+)\2/g;

function rewrite(code: string, importer: string, at: number): string {
  return code.replace(SPECIFIER, (whole, head: string, quote: string, specifier: string) => {
    if (/\.(css|json|svg|png|woff2?)$/.test(specifier)) return whole;
    let target: string;
    try {
      target = Bun.resolveSync(specifier, dirname(importer));
    } catch {
      return whole;
    }
    if (!own(target)) return whole;
    return `${head}${quote}${versioned(target, at)}${quote}`;
  });
}

const ADAPTER = resolve(import.meta.dir, "../dom/support/playwright.ts");

export const generations: BunPlugin = {
  name: "rastrata-generations",
  setup(build) {
    // The helpers the browser tests and the screens' tests share import Playwright; on happy-dom that is the adapter.
    build.onLoad(
      { filter: /\/apps\/web\/tests\/support\/(?!dom-)[^/]+\.ts$/ },
      async ({ path }) => ({
        contents: (await Bun.file(path).text()).replace(
          /from\s*["']@playwright\/test["']/g,
          `from ${JSON.stringify(ADAPTER)}`,
        ),
        loader: "ts",
      }),
    );
    build.onLoad(
      { filter: /\/(apps\/web|packages\/ui)\/src\/.+\.[jt]sx?\?g=\d+$/ },
      async ({ path }) => {
        const [file, query] = path.split("?") as [string, string];
        const at = Number(query.slice(2));
        let code = compiled.get(file);
        if (!code) {
          code = compile(file);
          compiled.set(file, code);
        }
        return { contents: rewrite(await code, file, at), loader: "ts" };
      },
    );
  },
};
