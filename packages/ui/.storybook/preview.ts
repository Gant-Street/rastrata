import { createDecorator, type Preview } from "storybook-solidjs-vite";
import "../src/styles.css";
import "../stories/workshop.css";

// Light is the default and the reference for baselines. Dark is a full peer theme; "system"
// follows the OS. Switch it from the toolbar, the page's own toggle, or ?globals=theme:dark.
const withTheme = createDecorator((Story, context) => {
  document.documentElement.dataset.theme = String(context.globals.theme ?? "light");
  return Story();
});

const preview: Preview = {
  decorators: [withTheme],
  globalTypes: {
    theme: {
      description: "Color theme",
      toolbar: {
        title: "Theme",
        icon: "contrast",
        dynamicTitle: true,
        items: [
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
          { value: "system", title: "System" },
        ],
      },
    },
  },
  // CI runs explicit axe scans; the panel remains available for manual review.
  // Avoid two axe runs racing over the same iframe.
  initialGlobals: { theme: "light", a11y: { manual: true } },
  parameters: {
    layout: "padded",
    controls: { expanded: true },
    a11y: { test: "error" },
    options: { storySort: { order: ["Start here", "Foundations", "Components", "Patterns"] } },
    docs: { toc: true },
  },
};
export default preview;
