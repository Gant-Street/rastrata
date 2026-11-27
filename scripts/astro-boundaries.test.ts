import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkAstroSource } from "./astro-boundaries";

async function check(source: string, symlink = false) {
  const root = mkdtempSync(join(tmpdir(), "rastrata-astro-boundary-"));
  try {
    for (const [file, text] of Object.entries({
      "apps/marketing/package.json": JSON.stringify({}),
      "apps/marketing/src/pages/index.astro": source,
      "apps/marketing/src/navigation.ts":
        "export const title = 'Navigation';\nexport const jsonLd = (value: unknown) => JSON.stringify(value);",
      "apps/marketing/src/components/Frame.astro": "<slot />",
      "apps/marketing/src/styles.css": "body { color: black; }",
      "apps/marketing/src/assets/shot.webp": "not really a picture",
      "apps/marketing/src/other/picture.png": "not really a picture",
      "apps/marketing/tests/secret.ts": "export const secret = true;",
      "packages/kernel/src/private.ts": "export const secret = true;",
    })) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    if (symlink)
      symlinkSync(
        join(root, "packages/kernel/src/private.ts"),
        join(root, "apps/marketing/src/escape.ts"),
      );
    await checkAstroSource(root, join(root, "apps/marketing/src/pages/index.astro"), source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("Astro composition admits local components, styles and checked script sources", async () => {
  await check(
    '---\nimport Frame from "../components/Frame.astro";\nimport "../styles.css";\n---\n<Frame><p>Static content</p></Frame><script src="../navigation.ts"></script>',
  );
});

for (const [name, source] of [
  ["kernel", '---\nimport { secret } from "@rastrata/kernel";\n---\n<p>{secret}</p>'],
  ["shared UI", '---\nimport { Button } from "@rastrata/ui";\n---\n<Button label="Test" />'],
  ["UI stylesheet", '---\nimport "@rastrata/ui/styles.css";\n---\n<p />'],
  ["Solid", '---\nimport { createSignal } from "solid-js";\n---\n<p />'],
  ["private UI", '---\nimport X from "@rastrata/ui/src/private";\n---\n<X />'],
  ["test fixture", '---\nimport { secret } from "../../tests/secret";\n---\n<p>{secret}</p>'],
  ["runtime builtin", '---\nimport fs from "node:fs";\n---\n<p />'],
  ["missing source", '---\nimport X from "./missing";\n---\n<X />'],
  ["frontmatter dynamic import", '---\nconst x = await import("@rastrata/kernel");\n---\n<p />'],
  ["template dynamic import", '<p>{await import("@rastrata/kernel")}</p>'],
  ["type import", '---\ntype X = import("@rastrata/kernel").X;\n---\n<p />'],
  ["require", '---\nconst x = require("node:fs");\n---\n<p />'],
  ["glob", '---\nconst x = import.meta.glob("../../**/*.ts");\n---\n<p />'],
  ["script element", '<script>import "@rastrata/kernel";</script>'],
  ["external script", '<script src="https://example.com/script.js"></script>'],
  ["raw HTML", '<div set:html={"<script></script>"} />'],
] as const) {
  test(`Astro boundary rejects ${name}`, async () => {
    await expect(check(source)).rejects.toThrow();
  });
}

test("Astro composition admits pictures from src/assets, through Astro's image module", async () => {
  await check(
    '---\nimport { Picture } from "astro:assets";\nimport shot from "../assets/shot.webp";\n---\n<Picture src={shot} alt="A screen" />',
  );
});

for (const [name, source] of [
  ["a picture outside src/assets", '---\nimport shot from "../other/picture.png";\n---\n<p />'],
  ["a raw import", '---\nimport shot from "../assets/shot.webp?raw";\n---\n<p />'],
  ["another Astro module", '---\nimport { getCollection } from "astro:content";\n---\n<p />'],
] as const) {
  test(`Astro boundary rejects ${name}`, async () => {
    await expect(check(source)).rejects.toThrow();
  });
}

test("Astro composition admits structured data through the one JSON helper", async () => {
  await check(
    '---\nimport { jsonLd } from "../navigation.ts";\n---\n<script type="application/ld+json" set:html={jsonLd({ name: "x" })} />',
  );
});

for (const [name, source] of [
  [
    "structured data written by hand",
    '<script type="application/ld+json" set:html={JSON.stringify({ name: "x" })} />',
  ],
  ["structured data with another type", '<script type="module" set:html={jsonLd({})} />'],
  [
    "structured data with a second attribute",
    '<script type="application/ld+json" defer set:html={jsonLd({})} />',
  ],
  ["raw HTML on an element of the page", "<div set:html={jsonLd({})} />"],
] as const) {
  test(`Astro boundary rejects ${name}`, async () => {
    await expect(check(source)).rejects.toThrow();
  });
}

test("Astro cannot follow a symlink out of site source", async () => {
  await expect(
    check('---\nimport { secret } from "../escape.ts";\n---\n<p />', true),
  ).rejects.toThrow("site source");
});
