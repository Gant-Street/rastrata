import type { StorybookConfig } from "storybook-solidjs-vite";

const config: StorybookConfig = {
  stories: ["../stories/**/*.stories.tsx"],
  staticDirs: ["../public"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y"],
  framework: { name: "storybook-solidjs-vite", options: {} },
  core: { disableTelemetry: true },
  async viteFinal(config) {
    // The workshop has no public environment configuration or API credentials.
    return { ...config, envDir: false, envPrefix: "RASTRATA_STORYBOOK_PUBLIC_" };
  },
};
export default config;
