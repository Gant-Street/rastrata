import { expect, type Page, test } from "@playwright/test";

// The layout that lets a page's work start within 220 px of the header: the page's one action sits beside
// the title, and on a phone the action sits under the description. A page has no explanation of itself:
// the footer's Help link opens its how-to. Measured on the shell lane's stories
// (stories/uxshell/page-header.stories.tsx), in every browser.
const story = (name: string) => `/iframe.html?id=lanes-uxshell-pageheader--${name}&viewMode=story`;

async function boxes(page: Page) {
  const box = async (selector: string) => {
    const found = await page.locator(selector).first().boundingBox();
    if (!found) throw new Error(`${selector} has no box`);
    return found;
  };
  return {
    title: await box(".rt-page-title"),
    description: await box(".rt-page-description"),
    action: await box(".rt-page-actions"),
  };
}

const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

test("on a wide page the action is beside the title, and the page has no explanation of itself", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(story("with-action"));
  const { title, action } = await boxes(page);
  // The action starts on the title's row and well to the right of it.
  expect(action.y).toBeLessThan(title.y + title.height);
  expect(action.x).toBeGreaterThan(title.x + 200);
  await expect(page.getByText("How this works")).toHaveCount(0);
});

test("on a phone the action is under the description and nothing scrolls sideways", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(story("with-action"));
  const { title, description, action } = await boxes(page);
  expect(action.y).toBeGreaterThanOrEqual(description.y + description.height - 1);
  expect(action.y).toBeGreaterThan(title.y + title.height);
  expect(await sideways(page)).toBe(false);
});

test("a long title and description wrap inside the page, on a phone and on a wide page", async ({
  page,
}) => {
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(story("long-content"));
    expect(await sideways(page), `${width} px wide`).toBe(false);
  }
});
