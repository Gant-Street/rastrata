import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { convertToTSX, parse } from "@astrojs/compiler";
import { parseSync } from "@swc/core";

function walk(value: unknown, visit: (node: Record<string, unknown>) => void) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  const node = value as Record<string, unknown>;
  visit(node);
  for (const child of Object.values(node)) walk(child, visit);
}

/** Pictures the site's build turns into its sizes and formats. They are imported from `src/assets`, and
 * only through Astro's own image module, so every picture on a page is a file in the repository. */
const SITE_IMAGE = /\.(?:png|jpe?g|webp|avif|svg)$/;
const IMAGE_MODULE = "astro:assets";

/** Astro files compose the independent public site. Keep their imports explicit;
 * normal TS/TSX dependencies continue through dependency-cruiser's full graph. */
export async function checkAstroSource(root: string, file: string, source: string) {
  const siteSource = realpathSync(resolve(root, "apps/marketing/src"));
  const inside = (path: string) => path.startsWith(`${siteSource}/`);
  const fail = (reason: string): never => {
    throw new Error(`${relative(root, file)}: ${reason}`);
  };
  if (!inside(realpathSync(file))) fail("Astro source is supported only in apps/marketing/src");

  const { ast, diagnostics } = await parse(source, { position: true });
  if (diagnostics.some((item) => item.severity === 1)) fail("Invalid Astro syntax");
  // The one place a page may carry its own text: structured data for search engines, a script that is
  // data and never runs. It is written as `<script type="application/ld+json" set:html={jsonLd(...)} />`
  // and nothing else: the helper turns a value into JSON and escapes what could end the element.
  const structuredData = new Set<unknown>();
  walk(ast, (node) => {
    if (node.type === "element" && node.name === "script") {
      const attributes = node.attributes as { name: string; kind: string; value: string }[];
      const type = attributes.find((attribute) => attribute.name === "type");
      const html = attributes.find((attribute) => attribute.name === "set:html");
      if (
        attributes.length === 2 &&
        type?.kind === "quoted" &&
        type.value === "application/ld+json" &&
        html?.kind === "expression" &&
        /^\s*jsonLd\(/.test(html.value)
      ) {
        structuredData.add(html);
        return;
      }
      const src = attributes.find((attribute) => attribute.name === "src");
      if (attributes.length !== 1 || src?.kind !== "quoted" || !src.value.endsWith(".ts")) {
        return fail(
          "Client scripts must reference a local checked .ts file with a plain src attribute",
        );
      }
      checkImport(src.value);
    }
    if (node.type === "attribute" && node.name === "set:html" && !structuredData.has(node)) {
      fail("Raw HTML injection is outside the static site boundary policy");
    }
  });

  function checkImport(specifier: string) {
    if (specifier === IMAGE_MODULE) return;
    if (!specifier.startsWith(".")) fail(`Unsupported Astro import: ${specifier}`);
    const target = resolve(dirname(file), specifier);
    const resolved = [target, `${target}.ts`, `${target}/index.ts`].find(
      (path) => existsSync(path) && statSync(path).isFile(),
    );
    if (!resolved) return fail(`Unresolved Astro import: ${specifier}`);
    const path = realpathSync(resolved);
    const picture = SITE_IMAGE.test(path) && path.startsWith(`${siteSource}/assets/`);
    if (
      !inside(path) ||
      !(picture || /\.(astro|ts|css)$/.test(path)) ||
      /\.(test|spec)\.[^/]+$|\/(test|tests|spec|__tests__)\//.test(path)
    ) {
      fail(`Astro imports must stay in site source: ${specifier}`);
    }
  }

  // Use the official compiler's TSX representation to inspect template expressions
  // as well as frontmatter. No generated files enter the workspace or runtime build.
  const { code } = await convertToTSX(source, {
    filename: file,
    includeScripts: false,
    includeStyles: false,
  });
  const module = parseSync(code, { syntax: "typescript", tsx: true });
  walk(module, (node) => {
    if (
      ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(
        String(node.type),
      )
    ) {
      const from = node.source as { value?: string } | undefined;
      if (from?.value) checkImport(from.value);
    }
    if (node.type === "TsImportType") {
      const argument = node.argument as { value: string };
      // convertToTSX emits this AstroGlobal type itself.
      if (argument.value !== "astro") checkImport(argument.value);
    }
    if (
      node.type === "Import" ||
      node.type === "TsImportEqualsDeclaration" ||
      node.type === "MetaProperty"
    ) {
      fail(
        "Use static imports in Astro; dynamic imports and module loaders belong in checked TypeScript",
      );
    }
    if (
      node.type === "Identifier" &&
      ["require", "eval", "Function"].includes(String(node.value))
    ) {
      fail("Runtime module loaders and evaluated code are not allowed in Astro");
    }
  });
}
