import { expect, test } from "@playwright/test";
import axe from "axe-core";

declare global {
  interface Window {
    axe: typeof axe;
  }
}

const foundation = "foundations-typography-color-density--review";
const stories = [
  foundation,
  "foundations-typography-color-density--compact",
  "components-button--primary",
  "components-button--secondary",
  "components-button--disabled",
  "components-text-field--default",
  "components-text-field--invalid",
  "components-text-field--disabled",
  "components-text-field--read-only",
  "patterns-dialog--keyboard-review",
  "start-here-workshop--review",
  "foundations-system-rules--review",
  "foundations-logo--review",
  "components-button--quiet",
  "components-button--destructive",
  "components-button--pending",
  "components-button--with-icon",
  "components-button--icon-only",
  ...[
    "review",
    "right-to-left",
    "loading-accounts",
    "failed-accounts",
    "disabled-account",
    "account-hierarchy",
    "unavailable-account",
    "long-content",
    "controlled-fields",
  ].map((name) => `components-forms--${name}`),
  ...[
    "review",
    "validation-recovery",
    "posting",
    "unknown-outcome",
    "rejected",
    "confirmed",
    "permission-denied",
  ].map((name) => `components-feedback--${name}`),
  "components-overlays--review",
  "patterns-navigation--review",
  ...[
    "review",
    "compact",
    "loading",
    "refreshing",
    "empty",
    "failed",
    "draft-save-recovery",
    "unknown-save",
    "split-entry",
    "right-to-left",
  ].map((name) => `patterns-register--${name}`),
  ...["review", "unbalanced", "posted"].map((name) => `patterns-journal--${name}`),
  "patterns-report--review",
];

for (const theme of ["light", "dark"] as const) {
  test(`all review stories render without runtime errors and pass the automated accessibility scan (${theme})`, async ({
    page,
    request,
  }) => {
    // Fifty pages in one test: allow a slow shared runner, not just a fast laptop.
    test.setTimeout(180_000);
    const index = await request.get("/index.json");
    const entries = (await index.json()).entries as Record<string, { type: string }>;
    expect(
      Object.keys(entries)
        // Lane stories (titled "Lanes/...") are swept by tests/lane-stories.spec.ts, so this
        // list stays the design system's own and lanes never edit it.
        .filter((id) => entries[id]?.type === "story" && !id.startsWith("lanes-"))
        .sort(),
    ).toEqual([...stories].sort());
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const id of stories) {
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
        result.violations.map(({ id, nodes }) => ({
          id,
          targets: nodes.map((node) => node.target),
        })),
        `${id} (${theme})`,
      ).toEqual([]);
    }
    expect(errors).toEqual([]);
  });
}

test("Controls update Solid typography and density while preserving the color code", async ({
  page,
}) => {
  await page.goto(`/?path=/story/${foundation}`);
  const preview = page.frameLocator("#storybook-preview-iframe");
  await expect(preview.getByRole("heading", { name: "Make the numbers clear." })).toBeVisible();
  await page.getByRole("radio", { name: "compact", exact: true }).check();
  await expect(preview.locator("main tbody td").first()).toHaveCSS("padding-top", "8px");
  await expect(preview.locator("main h1")).toHaveCSS("font-family", /Inter Variable/);
  await page.getByRole("slider").fill("18");
  await expect(preview.locator("main")).toHaveCSS("font-size", "18px");
  await expect(preview.getByRole("button", { name: "Save draft" })).toHaveCSS(
    "background-color",
    "rgb(0, 0, 0)",
  );
  await expect(preview.locator("main")).toHaveCount(1);
  await expect(preview.getByRole("textbox", { name: "Reference" })).toHaveCount(1);
});

test("field states preserve strings and expose labels, descriptions and errors", async ({
  page,
}) => {
  await page.goto("/iframe.html?id=components-text-field--default&viewMode=story");
  const field = page.getByRole("textbox", { name: "Reference", exact: true });
  await field.fill("9007199254740993.123456789");
  await expect(field).toHaveValue("9007199254740993.123456789");
  await expect(field).toHaveAccessibleDescription(
    "Use a reference that helps you find this entry.",
  );
  await page.goto("/iframe.html?id=components-text-field--invalid&viewMode=story");
  const invalid = page.getByRole("textbox", { name: "Reference", exact: true });
  await expect(invalid).toHaveAttribute("aria-invalid", "true");
  // The label does not say "(required)" (the founder, 2026-10-27: "not a normal pattern"); the field itself still says so.
  await expect(invalid).toHaveAttribute("required", "");
  await expect(invalid).toHaveAccessibleDescription(/Enter a reference\./);
  await page.goto("/iframe.html?id=components-text-field--read-only&viewMode=story");
  await expect(field).toHaveAttribute("readonly", "");
  await expect(field).toHaveValue("JRN-2026-0042");
  await page.goto("/iframe.html?id=components-text-field--disabled&viewMode=story");
  await expect(field).toBeDisabled();
});

test("Ark dialog traps keyboard focus and restores it on Escape", async ({ page, browserName }) => {
  await page.goto("/iframe.html?id=patterns-dialog--keyboard-review&viewMode=story");
  const trigger = page.getByRole("button", { name: "Edit reference", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Edit reference", exact: true });
  await expect(dialog).toBeVisible();
  const modifier = browserName === "webkit" && process.platform === "darwin" ? "Alt+" : "";
  for (const key of [`${modifier}Tab`, `${modifier}Shift+Tab`]) {
    for (let count = 0; count < 4; count++) {
      await page.keyboard.press(key);
      await expect
        .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
        .toBe(true);
    }
  }
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(
    async () =>
      (await window.axe.run(document.querySelector('[role="dialog"]') as HTMLElement)).violations,
  );
  expect(violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("foundation review fits a narrow viewport without document overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/iframe.html?id=${foundation}&viewMode=story`);
  await expect(page.getByRole("heading", { name: "Make the numbers clear." })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByRole("textbox", { name: "Reference" })).toBeVisible();
});

test("Inter loads locally, preserves tabular digits and ships its license", async ({
  page,
  request,
}) => {
  const fonts: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("inter-") && response.url().endsWith(".woff2") && response.ok()) {
      fonts.push(response.url());
    }
  });
  await page.goto(`/iframe.html?id=${foundation}&viewMode=story`);
  await expect(page.locator("main h1")).toBeVisible();
  const result = await page.evaluate(async () => {
    await document.fonts.ready;
    const loaded = [...document.fonts].some(
      (font) => font.family.includes("Inter Variable") && font.status === "loaded",
    );
    const widths = ["111111.11", "888888.88"].map((text) => {
      const span = document.createElement("span");
      span.className = "amount";
      span.style.display = "inline-block";
      span.textContent = text;
      document.querySelector("main")?.append(span);
      const width = span.getBoundingClientRect().width;
      span.remove();
      return width;
    });
    return { loaded, widths };
  });
  expect(result.loaded).toBe(true);
  expect(result.widths[0]).toBeGreaterThan(0);
  expect(result.widths[0]).toBeCloseTo(result.widths[1] ?? 0, 2);
  expect(fonts.length).toBeGreaterThan(0);
  for (const url of fonts) expect(new URL(url).origin).toBe(new URL(page.url()).origin);
  const license = await request.get("/licenses/inter.txt");
  expect(license.ok()).toBe(true);
  expect(await license.text()).toContain("SIL OPEN FONT LICENSE Version 1.1");
});

for (const theme of ["light", "dark"] as const) {
  test(`base palette meets text, control-boundary and focus contrast requirements (${theme})`, async ({
    page,
  }) => {
    await page.goto(`/iframe.html?id=${foundation}&viewMode=story&globals=theme:${theme}`);
    await expect(page.locator("main h1")).toBeVisible();
    const colors = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is required to resolve sRGB color mixtures");
      const probe = document.createElement("span");
      document.body.append(probe);
      const resolved = (name: string) => {
        probe.style.color = `var(--rt-${name})`;
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = getComputedStyle(probe).color;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      const colors = Object.fromEntries(
        [
          "white",
          "black",
          "penguin-orange",
          "nasa-blue",
          "railway-red",
          "workspace",
          "surface",
          "text",
          "muted",
          "border",
          "accent",
          "accent-hover",
          "action",
          "action-hover",
          "action-active",
          "on-action",
          "success",
          "warning",
          "warning-surface",
          "error",
          "error-surface",
          "hover",
          "pressed",
          "disabled-surface",
          "selection",
        ].map((name) => [name, resolved(name)]),
      );
      probe.remove();
      return colors;
    });
    expect(colors.white).toEqual([255, 255, 255]);
    expect(colors.black).toEqual([0, 0, 0]);
    expect(colors["penguin-orange"]).toEqual([255, 102, 0]);
    expect(colors["nasa-blue"]).toEqual([11, 61, 145]);
    expect(colors["railway-red"]).toEqual([235, 0, 0]);
    const luminance = (rgb: number[]) => {
      expect(rgb).toHaveLength(3);
      const channels = rgb.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return (
        (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722
      );
    };
    const contrast = (foreground: string, background: string, minimum: number) => {
      const a = luminance(colors[foreground] ?? []);
      const b = luminance(colors[background] ?? []);
      expect(
        (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        `${foreground} on ${background}`,
      ).toBeGreaterThanOrEqual(minimum);
    };
    for (const background of ["workspace", "surface"]) {
      for (const foreground of [
        "text",
        "muted",
        "accent",
        "accent-hover",
        "success",
        ...(theme === "light" ? ["warning"] : []),
        "error",
      ])
        contrast(foreground, background, 4.5);
      for (const foreground of ["border", "accent"]) contrast(foreground, background, 3);
    }
    for (const background of ["action", "action-hover", "action-active"])
      contrast("on-action", background, 4.5);
    contrast("warning", "warning-surface", 4.5);
    for (const background of ["hover", "pressed", "selection"]) contrast("text", background, 4.5);
    contrast("muted", "disabled-surface", 4.5);
    contrast("error", "error-surface", 4.5);

    const button = page.getByRole("button", { name: "Save draft" });
    await button.focus();
    await expect(button).toHaveCSS("outline-style", "solid");
    await expect(button).toHaveCSS("outline-width", "2px");
    await button.hover();
    await button.evaluate((element) =>
      Promise.all(element.getAnimations().map((animation) => animation.finished)),
    );
    const hovered = await button.evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.mouse.down();
    await expect
      .poll(() => button.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(hovered);
    await page.mouse.up();
  });
}

test("entry preview gives honest local feedback and resets without a backend", async ({ page }) => {
  await page.goto(`/iframe.html?id=${foundation}&viewMode=story`);
  const reference = page.getByRole("textbox", { name: "Reference" });
  await reference.fill("Monthly review");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: /\S/ })).toHaveText(
    "Draft saved in this preview only. Reloading clears it.",
  );
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(reference).toHaveValue("September adjustments");
  await expect(page.getByRole("status").filter({ hasText: /\S/ })).toHaveText("Preview reset.");
});
