import { expect, test } from "@playwright/test";

// An Ark combobox inside an Ark dialog, from the keyboard: focus stays in the dialog, a choice is made and
// shown, a disabled option cannot be chosen, and Escape closes the list first and the dialog second, with
// focus back on the button that opened it. It was `/checks` in the web application (a scaffold page); it is
// a story now (stories/uxshell/nested-controls.stories.tsx) so the application has no page that exists only
// to be tested. It runs in all three browsers.
const story = "/iframe.html?id=lanes-uxshell-nestedcontrols--default&viewMode=story";

test("nested Ark controls preserve keyboard focus, selection and Escape order", async ({
  page,
  browserName,
}) => {
  await page.goto(story);
  const trigger = page.getByRole("button", { name: "Choose an account", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Choose an account", exact: true });
  await expect(dialog).toBeVisible();
  // macOS WebKit defaults to text-field-only Tab navigation. Option-Tab is Safari's documented
  // navigation through all controls; Linux uses plain Tab.
  const modifier = browserName === "webkit" && process.platform === "darwin" ? "Alt+" : "";
  for (const direction of [`${modifier}Tab`, `${modifier}Shift+Tab`]) {
    for (let step = 0; step < 5; step++) {
      await page.keyboard.press(direction);
      await expect
        .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
        .toBe(true);
    }
  }
  const input = page.getByRole("combobox", { name: "Account", exact: true });
  await input.fill("Sales");
  await input.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Sales", exact: true })).toBeVisible();
  await input.press("Enter");
  await expect(
    page.getByRole("status", { name: "Selected account", includeHidden: true }),
  ).toHaveText("sales");
  // Selection closes asynchronously; wait for that transition before starting a new query so its input
  // update cannot race the selected-label update.
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect(input).toHaveValue("Sales");
  await input.press("ArrowDown");
  await expect(page.getByRole("listbox")).toBeVisible();
  await input.fill("Archived");
  await input.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Archived account", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await input.press("Enter");
  await expect(
    page.getByRole("status", { name: "Selected account", includeHidden: true }),
  ).not.toHaveText("archived");
  await input.fill("Cash");
  await input.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Cash", exact: true })).toBeVisible();
  await input.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(dialog).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});
