import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

const directory = resolve(import.meta.dir, "..");
const mode = process.argv[2];
const executable = process.env.GO_BIN ?? "go";
const run = async (args: string[]) => {
  const process = Bun.spawn([executable, ...args], {
    cwd: directory,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...Bun.env, GOTOOLCHAIN: "local" },
  });
  const status = await process.exited;
  if (status !== 0) throw new Error(`go ${args[0]} failed (${status}); use Go from .go-version`);
};
if (!Bun.which(executable))
  throw new Error(
    "Go is required. Install the version in .go-version or set GO_BIN to its executable.",
  );
switch (mode) {
  case "build":
    mkdirSync(resolve(directory, "dist"), { recursive: true });
    await run(["build", "-trimpath", "-o", "dist/rastrata", "./cmd/rastrata"]);
    break;
  case "check": {
    const format = Bun.spawnSync([process.env.GOFMT_BIN ?? "gofmt", "-l", "cmd", "internal"], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (format.exitCode !== 0 || format.stdout.byteLength > 0)
      throw new Error(`Go formatting failed: ${new TextDecoder().decode(format.stdout)}`);
    await run(["vet", "./..."]);
    break;
  }
  case "test":
    await run(["test", "-race", "./..."]);
    break;
  case "run":
    await run(["run", "./cmd/rastrata", ...process.argv.slice(3)]);
    break;
  default:
    throw new Error("Use build, check, test or run");
}
