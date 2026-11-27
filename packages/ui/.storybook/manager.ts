import { addons } from "storybook/manager-api";
import { create } from "storybook/theming/create";
import { logoSvg, MASTER } from "../src/brand/logo-geometry";

// The workshop frame is part of the design: Inter, the five masters, square corners, the logo.
const wordmark = logoSvg("wordmark", MASTER.black);

const theme = create({
  base: "light",
  brandTitle: "rastrata workshop",
  brandUrl: "./",
  brandTarget: "_self",
  brandImage: `data:image/svg+xml;utf8,${encodeURIComponent(wordmark)}`,

  colorPrimary: "#ff6600",
  colorSecondary: "#0b3d91",

  appBg: "#ffffff",
  appContentBg: "#ffffff",
  appPreviewBg: "#ffffff",
  appHoverBg: "#f2f2f2",
  appBorderColor: "#000000",
  appBorderRadius: 0,

  fontBase: '"Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif',
  fontCode: 'ui-monospace, "SF Mono", Menlo, monospace',

  textColor: "#000000",
  textInverseColor: "#ffffff",
  textMutedColor: "#5c5c5c",

  barBg: "#ffffff",
  barTextColor: "#000000",
  barHoverColor: "#0b3d91",
  barSelectedColor: "#0b3d91",

  buttonBg: "#ffffff",
  buttonBorder: "#000000",
  booleanBg: "#ffffff",
  booleanSelectedBg: "#000000",

  inputBg: "#ffffff",
  inputBorder: "#000000",
  inputTextColor: "#000000",
  inputBorderRadius: 0,
});

addons.setConfig({
  theme,
  sidebar: { showRoots: true },
  toolbar: { zoom: { hidden: false } },
});
