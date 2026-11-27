/** Where this computer keeps the tools the scripts spawn: Go (the command line, the generated Go client and gofmt) and
 * Node (Biome's launcher). They are put on PATH when they are there, so a script works from a shell that has not. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function toolPath(): string {
  const extra = [
    join(homedir(), "sdk/go1.27.3/bin"),
    join(homedir(), ".nvm/versions/node/v26.12.1/bin"),
  ].filter(existsSync);
  return [...extra, process.env.PATH ?? ""].join(":");
}
