import { transformAsync } from "@babel/core";
import solid from "babel-preset-solid";
import type { BunPlugin } from "bun";

export function solidPlugin(development: boolean): BunPlugin {
  return {
    name: "rastrata-solid",
    setup(build) {
      build.onLoad({ filter: /\.[jt]sx$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        const transformed = await transformAsync(source, {
          filename: path,
          babelrc: false,
          configFile: false,
          parserOpts: { plugins: ["typescript", "jsx"] },
          presets: [[solid, { generate: "dom", hydratable: false, dev: development }]],
        });
        if (!transformed?.code) throw new Error(`Solid compilation produced no output: ${path}`);
        // Bun strips remaining TypeScript after Solid has compiled JSX.
        return { contents: transformed.code, loader: "ts" };
      });
    },
  };
}

export default solidPlugin(true);
